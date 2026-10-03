/* =============================================================================
   notify.js
   Reminders for bills coming due. Deliberately only bills: they have a date
   and an amount, so "Electricity — £62.10, due tomorrow" is a sentence worth
   interrupting for. Spend has no due date to remind you about, and savings
   goals don't either.

   What this can and cannot do, stated plainly because the platform decides it:
   a static site with no backend can't run a job at 7am tomorrow, and push
   needs a server to push from. So there is no scheduled background delivery.
   What there is: the app checks when you close it, when you open it again, and
   on a slow timer while it's open — which covers the real case here, someone
   picking up their phone, seeing a reminder, and paying the bill.

   Notifications are also only delivered when the app is *in the background*.
   Waking up to a system notification for something you're already looking at is
   noise, and every screen that matters already says what's overdue.
   ============================================================================= */

const NOTIFY_ENABLED_KEY = 'sorted-notify-enabled';
const NOTIFY_LEAD_KEY = 'sorted-notify-lead';
const NOTIFY_SEEN_KEY = 'sorted-notify-seen';

// How far ahead of the due date to speak up. 0 means "on the day".
const NOTIFY_LEADS = [
  { value: 0, label: 'On the day' },
  { value: 1, label: '1 day before' },
  { value: 3, label: '3 days before' },
  { value: 7, label: '1 week before' }
];
const DEFAULT_NOTIFY_LEAD = 1;

function notifySupported() {
  return typeof Notification !== 'undefined';
}

function isNotifyEnabled() {
  return localStorage.getItem(NOTIFY_ENABLED_KEY) === 'true';
}

function setNotifyEnabled(on) {
  if (on) localStorage.setItem(NOTIFY_ENABLED_KEY, 'true');
  else localStorage.removeItem(NOTIFY_ENABLED_KEY);
  // Turning them off forgets what has already been said, so re-enabling later
  // doesn't sit silent waiting for yesterday's reminders to come round again.
  if (!on) localStorage.removeItem(NOTIFY_SEEN_KEY);
}

function getNotifyLeadDays() {
  const raw = Number(localStorage.getItem(NOTIFY_LEAD_KEY));
  return NOTIFY_LEADS.some((l) => l.value === raw) ? raw : DEFAULT_NOTIFY_LEAD;
}

function setNotifyLeadDays(days) {
  const n = Number(days);
  if (!NOTIFY_LEADS.some((l) => l.value === n)) return;
  localStorage.setItem(NOTIFY_LEAD_KEY, String(n));
  // A different lead time means a different set of bills is now in range, so
  // the "already said this" memory has to start over.
  localStorage.removeItem(NOTIFY_SEEN_KEY);
}

// Which bills we've already mentioned today. Keyed by bill id and stamped with
// the date, so a bill is announced once a day rather than on every foreground
// transition, and a long-open tab doesn't repeat itself.
function notifySeen() {
  try {
    const raw = localStorage.getItem(NOTIFY_SEEN_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    return {};
  }
}

function markNotified(id, today) {
  const seen = notifySeen();
  seen[id] = today;
  // Keep it from growing without bound on a device with a long history.
  const keys = Object.keys(seen);
  if (keys.length > 200) for (const k of keys.slice(0, keys.length - 200)) delete seen[k];
  localStorage.setItem(NOTIFY_SEEN_KEY, JSON.stringify(seen));
}

function billNotificationText(bill, days) {
  if (days < 0) {
    const n = Math.abs(days);
    return `${bill.title} — ${currency(bill.amount)}, ${n} day${n === 1 ? '' : 's'} overdue`;
  }
  if (days === 0) return `${bill.title} — ${currency(bill.amount)}, due today`;
  return `${bill.title} — ${currency(bill.amount)}, due in ${days} day${days === 1 ? '' : 's'}`;
}

// The check. Silent unless there is something new worth saying.
async function checkBillNotifications() {
  if (!isNotifyEnabled() || !notifySupported()) return 0;
  if (Notification.permission !== 'granted') return 0;
  // Only when the app isn't in front of you — see the note at the top.
  if (document.visibilityState === 'visible') return 0;

  const today = localISO();
  const lead = getNotifyLeadDays();
  let sent = 0;

  try {
    for (const bill of await getAll('due')) {
      if (!bill.dueDate) continue;
      // A paid bill stays in Bills now rather than being deleted, so without
      // this it would remind you about rent you have already paid — and keep
      // doing it, every day, because its date never rolls forward again.
      if (bill.paid === true) continue;
      const days = daysUntil(bill.dueDate);
      // Anything overdue is in range whatever the lead time, because a negative
      // number is always <= lead. Nothing further forward than the lead is.
      if (days > lead) continue;
      if (notifySeen()[bill.id] === today) continue;

      const n = new Notification('Sorted — bill due', {
        body: billNotificationText(bill, days),
        tag: 'sorted-bill-' + bill.id,   // one notification per bill, not a pile
        icon: 'static/icons/icon-192.png',
        badge: 'static/icons/icon-192.png'
      });
      n.onclick = () => {
        try { window.focus(); } catch (err) { /* focus can be refused */ }
        navigate('due');
        n.close();
      };
      markNotified(bill.id, today);
      sent++;
    }
  } catch (err) {
    // A failed notification must never take the app down with it.
    return sent;
  }

  return sent;
}

// Ask for permission, and turn the setting on only if it was actually granted.
// Returning the outcome lets Settings say what happened instead of silently
// showing a switch that does nothing.
async function enableNotifications() {
  if (!notifySupported()) return 'unsupported';
  if (Notification.permission === 'granted') {
    setNotifyEnabled(true);
    return 'on';
  }
  if (Notification.permission === 'denied') return 'denied';
  let result;
  try {
    result = await Notification.requestPermission();
  } catch (err) {
    return 'denied';
  }
  if (result === 'granted') {
    setNotifyEnabled(true);
    return 'on';
  }
  return 'denied';
}

function disableNotifications() {
  setNotifyEnabled(false);
}

function initNotifications() {
  if (!isNotifyEnabled() || !notifySupported() || Notification.permission !== 'granted') return;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) checkBillNotifications();
  });
  // Hourly while the app sits open: enough to catch a bill added earlier the
  // same day, cheap enough not to matter.
  setInterval(() => { if (document.hidden) checkBillNotifications(); }, 60 * 60 * 1000);
  // One check on launch, in case the app was opened and closed without ever
  // going hidden in between.
  checkBillNotifications();
}
