/* =============================================================================
   notify.js
   Three reminders, all local, all on the device:

     bills     — something is due, or already overdue
     spending  — nothing has been recorded today
     savings   — nothing has gone into a goal for a while

   Two delivery paths, because the platform decides what's possible.

   On Android the Capacitor LocalNotifications plugin schedules real alarms, so
   these arrive whether or not Sorted has been opened — which is the only version
   of a reminder that's any use. They're inexact on purpose: SCHEDULE_EXACT_ALARM
   needs its own user grant on Android 12+ and Play only allows it to
   alarm-clock apps, and "you haven't recorded today's spending" does not need to
   land on the minute.

   In a browser there is no way to run a job at 8pm tomorrow, so the same checks
   run when the app is opened or backgrounded, and only then. That's stated in
   the settings rather than glossed over.

   Scheduling is rebuilt from scratch each time (cancelAll, then schedule what
   currently applies) rather than tracked id by id. The set of pending
   notifications is small and entirely derivable from the database, so
   reconciling is simpler than remembering what was last scheduled and when —
   and it can't drift out of step with the data the way an incremental version
   can.
   ============================================================================= */

const NOTIFY_ENABLED_KEY = 'sorted-notify-enabled';
const NOTIFY_LEAD_KEY = 'sorted-notify-lead';
const NOTIFY_SEEN_KEY = 'sorted-notify-seen';
const NOTIFY_SPEND_KEY = 'sorted-notify-spend';
const NOTIFY_SPEND_TIME_KEY = 'sorted-notify-spend-time';
const NOTIFY_GOAL_KEY = 'sorted-notify-goal';
const NOTIFY_GOAL_CADENCE_KEY = 'sorted-notify-goal-cadence';
const NOTIFY_GOAL_LAST_KEY = 'sorted-notify-goal-last';
// Which permission state, if any, has already been explained to the reader. See
// reportReminderOutcome() — this exists so a blocked notice is said once rather
// than on every tap.
const NOTIFY_BLOCKED_KEY = 'sorted-notify-blocked';

// Android requires a channel from API 26, and a notification with no channel is
// silently dropped.
// Marks a notification as not needing an exact alarm.
//
// This is the other half of not holding SCHEDULE_EXACT_ALARM, and it is not
// optional. The plugin defaults `isExactNotification` to **true**, and its
// schedule() then does this:
//
//   if (any notification wants an exact alarm && Android 12+ && we may not
//       schedule exact alarms) -> open "Alarms and reminders" in Settings
//
// So without this flag on every notification, the first schedule() of every app
// launch throws the user out of the app and into Android's settings, and the app
// is unreachable until they go back. That is not a subtle degradation: it made
// 2.30.0 unopenable.
//
// With it false the plugin goes straight to setAndAllowWhileIdle, which is what
// we have always said we wanted and what dropping the permission was for.
const INEXACT = { isExactNotification: false };

// The status bar icon, by resource name: the plugin looks it up in res/drawable.
// Without this the launcher icon is used, and Android tints that into a
// featureless white blob — it is a rounded square with a background layer, and
// neither means anything in a monochrome slot.
const NOTIF_ICON = 'ic_stat_sorted';

const NOTIFY_CHANNEL_ID = 'sorted-reminders';
// Bill reminders go out in the morning; the two nudges use a time you choose,
// because "remind me to record spending" at 9am is a different sentence.
// How far apart two reminders may be before Android can be relied on to show
// them as two reminders. Inexact alarms set for the same moment are delivered
// in one batch, and a batch is read as a single event.
const NUDGE_GAP_MS = 30 * 60 * 1000;

const NOTIFY_BILL_HOUR = 9;

const NOTIFY_LEADS = [
  { value: 0, label: 'On the day' },
  { value: 1, label: '1 day before' },
  { value: 3, label: '3 days before' },
  { value: 7, label: '1 week before' }
];
const DEFAULT_NOTIFY_LEAD = 1;

// A nudge about unrecorded spending is easy to resent and hard to be glad about,
// so the time is a choice rather than a constant.
const NOTIFY_TIMES = [
  { value: '18:00', label: '6pm' },
  { value: '19:00', label: '7pm' },
  { value: '20:00', label: '8pm' },
  { value: '21:00', label: '9pm' },
  { value: '22:00', label: '10pm' }
];
const DEFAULT_NOTIFY_TIME = '20:00';

// How long a goal can go untouched before it is worth mentioning, and how often
// after that. A daily nudge about saving is nagging, a monthly one is barely a
// reminder, and the right answer depends entirely on the person — so it's a
// choice rather than a constant.
const NOTIFY_GOAL_CADENCES = [
  { value: 'daily', label: 'Daily', days: 1 },
  { value: 'weekly', label: 'Weekly', days: 7 },
  { value: 'monthly', label: 'Monthly', days: 30 },
];
const DEFAULT_NOTIFY_GOAL_CADENCE = 'weekly';

function notifySupported() {
  if (notifyIsNative()) return true;
  return typeof Notification !== 'undefined';
}

// Forced off by tests so the browser path can be exercised without a browser
// and the native path without a device. Null in normal use.
let NOTIFY_FORCE_WEB = null;

function notifyIsNative() {
  if (NOTIFY_FORCE_WEB !== null) return !NOTIFY_FORCE_WEB;
  return !!(window.Capacitor
    && typeof window.Capacitor.isNativePlatform === 'function'
    && window.Capacitor.isNativePlatform());
}

// Registered on first use, like the Filesystem and Share plugins, so a browser
// that never gets here never registers it.
let notifyCapPlugin = null;
function notifyCap() {
  if (notifyCapPlugin) return notifyCapPlugin;
  // Failing with a sentence rather than a TypeError, because this is the whole
  // difference between "Sorted's reminders are switched off" and "Sorted is
  // broken and here is an internal function name you can do nothing with".
  //
  // `registerPlugin` lives on the window only when Capacitor's runtime has been
  // loaded. The Android build injects native-bridge.js, which is a different
  // file and does not provide it, and the CLI does not copy the runtime into
  // webDir — so an app that does not load capacitor.js has a window.Capacitor
  // that answers isNativePlatform() perfectly and then throws here.
  const reg = window.Capacitor && window.Capacitor.registerPlugin;
  if (typeof reg !== 'function') {
    throw new Error('This build is missing the Capacitor runtime, so reminders cannot work.');
  }
  notifyCapPlugin = reg.call(window.Capacitor, 'LocalNotifications');
  return notifyCapPlugin;
}

// ---------------------------------------------------------------- settings

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

function isSpendNudgeEnabled() {
  return localStorage.getItem(NOTIFY_SPEND_KEY) === 'true';
}

function setSpendNudgeEnabled(on) {
  if (on) localStorage.setItem(NOTIFY_SPEND_KEY, 'true');
  else localStorage.removeItem(NOTIFY_SPEND_KEY);
  if (!on) localStorage.removeItem(NOTIFY_SPEND_TIME_KEY);
}

function getNotifyTime() {
  const raw = localStorage.getItem(NOTIFY_SPEND_TIME_KEY);
  return NOTIFY_TIMES.some((t) => t.value === raw) ? raw : DEFAULT_NOTIFY_TIME;
}

function setNotifyTime(value) {
  if (!NOTIFY_TIMES.some((t) => t.value === value)) return;
  localStorage.setItem(NOTIFY_SPEND_TIME_KEY, value);
}

function isGoalNudgeEnabled() {
  return localStorage.getItem(NOTIFY_GOAL_KEY) === 'true';
}

function setGoalNudgeEnabled(on) {
  if (on) localStorage.setItem(NOTIFY_GOAL_KEY, 'true');
  else localStorage.removeItem(NOTIFY_GOAL_KEY);
}

function goalNudgeCadence() {
  const raw = localStorage.getItem(NOTIFY_GOAL_CADENCE_KEY);
  const found = NOTIFY_GOAL_CADENCES.find((c) => c.value === raw);
  return found || NOTIFY_GOAL_CADENCES.find((c) => c.value === DEFAULT_NOTIFY_GOAL_CADENCE);
}

function setGoalNudgeCadence(value) {
  if (!NOTIFY_GOAL_CADENCES.some((c) => c.value === value)) return;
  localStorage.setItem(NOTIFY_GOAL_CADENCE_KEY, value);
}

// When each goal last went up. A goal stores its current figure and nothing
// else, so "has this been topped up lately" can't be answered from the database
// — there's no history of contributions to read. This records the date the app
// first saw one, which means the savings nudge starts counting from install
// rather than from the beginning of time. localStorage rather than the database
// because it is a running note to ourselves, not something anyone exports.
function goalTopUpDates() {
  try {
    const raw = localStorage.getItem(NOTIFY_GOAL_LAST_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    return {};
  }
}

function noteGoalTopUp(id, iso) {
  const seen = goalTopUpDates();
  seen[id] = iso;
  const keys = Object.keys(seen);
  if (keys.length > 200) for (const k of keys.slice(0, keys.length - 200)) delete seen[k];
  localStorage.setItem(NOTIFY_GOAL_LAST_KEY, JSON.stringify(seen));
}

// Called after a goal is saved. Only counts as a top-up when the figure went
// up: editing a target or a category is not putting money in.
function noteGoalSaves(items) {
  const today = localISO();
  for (const goal of items) {
    if (!goal || !goal.id) continue;
    if (typeof goal.current === 'number' && goal.current > 0) {
      const before = goalTopUpDates()[goal.id];
      // Once a day at most, so opening the goal twice doesn't reset the clock.
      if (before !== today) noteGoalTopUp(goal.id, today);
    }
  }
}

// ---------------------------------------------------------------- wording

function billNotificationText(bill, days) {
  if (days < 0) {
    const n = Math.abs(days);
    return `${bill.title} — ${currency(bill.amount)}, ${n} day${n === 1 ? '' : 's'} overdue`;
  }
  if (days === 0) return `${bill.title} — ${currency(bill.amount)}, due today`;
  return `${bill.title} — ${currency(bill.amount)}, due in ${days} day${days === 1 ? '' : 's'}`;
}

// ---------------------------------------------------------------- helpers

// The next time of day hh:mm strictly after `from`. Used for every scheduled
// reminder so that one whose moment has already passed today rolls to tomorrow
// rather than firing immediately or being dropped.
function nextTimeOfDay(hhmm, from) {
  const [h, m] = String(hhmm || DEFAULT_NOTIFY_TIME).split(':').map(Number);
  const at = new Date(from);
  at.setHours(Number.isFinite(h) ? h : 20, Number.isFinite(m) ? m : 0, 0, 0);
  if (at <= from) at.setDate(at.getDate() + 1);
  return at;
}

function daysBetween(a, b) {
  return Math.round((a - b) / 86400000);
}

async function recordedToday(storeName) {
  const today = localISO();
  const rows = await getAll(storeName);
  return rows.some((r) => String(r.date || '').slice(0, 10) === today);
}

// Called once at startup. A goal that predates this feature has never been
// observed being topped up, and "never seen" has to mean something other than
// "stale" or it would fire on every single launch — but leaving it unobserved
// forever would leave the nudge permanently inert for exactly the people whose
// goals already exist. So the clock starts here: everyone is stamped as seen
// today, and the nudge becomes live seven days later if nothing has gone in.
async function observeGoalsOnce() {
  const goals = await getAll('savings');
  if (goals.length === 0) return;
  const dates = goalTopUpDates();
  const today = localISO();
  let added = false;
  for (const goal of goals) {
    if (!goal.id || dates[goal.id]) continue;
    dates[goal.id] = today;
    added = true;
  }
  if (added) localStorage.setItem(NOTIFY_GOAL_LAST_KEY, JSON.stringify(dates));
}

// Whether any goal has been topped up inside the reminder window.
async function goalsTouchedRecently() {
  const goals = await getAll('savings');
  if (goals.length === 0) return { any: false, recent: true };
  const dates = goalTopUpDates();
  const today = localISO();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - goalNudgeCadence().days);
  const cutoffISO = localISO(cutoff);
  const recent = goals.some((g) => {
    const seen = dates[g.id];
    // Never seen one means it was there before this feature could know, so
    // give it the benefit of the doubt rather than nagging about it all day.
    if (!seen) return true;
    return String(seen).slice(0, 10) >= cutoffISO;
  });
  return { any: true, recent, count: goals.length, today };
}

// ---------------------------------------------------------------- scheduling

async function notifyPermissionGranted() {
  if (notifyIsNative()) {
    // Re-checked rather than trusting the cache: the user can change this in
    // Android settings while the app is closed, and a stale 'granted' would
    // schedule alarms the system silently drops.
    const perm = await notificationPermission(false);
    return perm.state === 'granted';
  }
  return typeof Notification !== 'undefined' && Notification.permission === 'granted';
}

async function ensureChannel() {
  const cap = notifyCap();
  try {
    const existing = await cap.listChannels();
    const ids = (existing.channels || []).map((c) => c.id);
    if (ids.indexOf(NOTIFY_CHANNEL_ID) !== -1) return;
  } catch (err) {
    // Fall through and create it anyway; a failed list is not a reason to skip
    // the channel, and a duplicate create is harmless.
  }
  try {
    await cap.createChannel({
      id: NOTIFY_CHANNEL_ID,
      name: 'Reminders',
      description: 'Bills due, spending not yet recorded, and savings goals going untouched.'
    });
  } catch (err) { /* nothing to do; the schedule below will report the truth */ }
}

// Android ids are 32-bit ints, and the plugin keys pending alarms by them. The
// two nudges get fixed ids; bills are numbered by position in a stable ordering
// so the same bill keeps its slot between runs.
const NOTIFY_ID_SPEND = 900001;
const NOTIFY_ID_GOAL = 900002;
const NOTIFY_ID_BILL_BASE = 1000;

function billSlotId(billId, ordered) {
  const index = ordered.findIndex((b) => b.id === billId);
  return NOTIFY_ID_BILL_BASE + (index < 0 ? 900 : index);
}

// Everything that should be pending right now, rebuilt from scratch.
async function planReminders() {
  const now = new Date();
  const plan = { bills: [], spend: null, goals: null, time: getNotifyTime() };

  if (isNotifyEnabled()) {
    const lead = getNotifyLeadDays();
    const outstanding = (await getAll('due'))
      .filter((b) => b.dueDate && b.paid !== true)
      .filter((b) => daysUntil(b.dueDate) <= lead)
      // Oldest first, so slot numbering is stable rather than depending on
      // whatever order IndexedDB happened to return.
      .sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)));

    for (const bill of outstanding) {
      const days = daysUntil(bill.dueDate);
      // The intended moment is `lead` days before the due date. When that's
      // already gone by — including for anything overdue — the next morning is
      // the earliest sensible replacement.
      const dueOn = new Date(String(bill.dueDate) + 'T00:00:00');
      const intended = new Date(dueOn);
      intended.setDate(intended.getDate() - lead);
      intended.setHours(NOTIFY_BILL_HOUR, 0, 0, 0);
      const at = intended > now ? intended : nextTimeOfDay(NOTIFY_BILL_HOUR + ':00', now);
      plan.bills.push({ bill, days, at });
    }
  }

  if (isSpendNudgeEnabled()) {
    const recorded = await recordedToday('spend');
    if (!recorded) plan.spend = nextTimeOfDay(plan.time, now);
  }

  if (isGoalNudgeEnabled()) {
    const g = await goalsTouchedRecently();
    if (g.any && !g.recent) {
      let at = nextTimeOfDay(plan.time, now);
      // Only when it would land on the spending nudge's own instant. Both use
      // the same chosen time, so with nothing recorded and no goal topped up
      // they were scheduled for the identical millisecond — which on a phone
      // means one alarm batch, two notifications posted microseconds apart, and
      // the status bar showing whichever arrived last. Reported on-device as
      // "the Spending notification came through with the Goals message": it had
      // not, there had simply never been room for both. Apart, they arrive as
      // two separate things.
      if (plan.spend && at.getTime() === plan.spend.getTime()) {
        at = new Date(at.getTime() + NUDGE_GAP_MS);
      }
      plan.goals = at;
    }
  }

  return plan;
}

async function scheduleAllReminders() {
  if (!notifyIsNative()) return 0;
  if (!(await notifyPermissionGranted())) return 0;

  const cap = notifyCap();
  await ensureChannel();

  // Cancel first, unconditionally. Whatever was pending was planned from data
  // that has since moved on — a bill got paid, a spend got recorded — and the
  // honest set is the one in front of us.
  try { await cap.cancelAll(); } catch (err) { return 0; }

  const plan = await planReminders();
  const notifications = [];

  const ordered = plan.bills.map((b) => b.bill);
  for (const entry of plan.bills) {
    notifications.push({
      id: billSlotId(entry.bill.id, ordered),
      title: 'Sorted — bill due',
      body: billNotificationText(entry.bill, entry.days),
      channelId: NOTIFY_CHANNEL_ID,
      ...INEXACT,
      icon: NOTIF_ICON,
      schedule: { at: entry.at, allowWhileIdle: false },
      extra: { page: 'due', billId: entry.bill.id }
    });
  }
  if (plan.spend) {
    notifications.push({
      id: NOTIFY_ID_SPEND,
      title: 'Sorted — nothing recorded today',
      body: 'Anything you spent today? A minute now saves guessing later.',
      channelId: NOTIFY_CHANNEL_ID,
      ...INEXACT,
      icon: NOTIF_ICON,
      schedule: { at: plan.spend, allowWhileIdle: false },
      extra: { page: 'spend' }
    });
  }
  if (plan.goals) {
    notifications.push({
      id: NOTIFY_ID_GOAL,
      title: 'Sorted — nothing going in',
      body: `No goal has been topped up in ${goalNudgeCadence().days} days.`,
      channelId: NOTIFY_CHANNEL_ID,
      ...INEXACT,
      icon: NOTIF_ICON,
      schedule: { at: plan.goals, allowWhileIdle: false },
      extra: { page: 'savings' }
    });
  }

  // Put the test reminder back. Everything pending was just cancelled, and the
  // rebuild has no reason to include it, so without this it survives only until
  // the next foreground — which on a phone is almost immediately. Also the
  // reason the plan being empty must not short-circuit: a test reminder on its
  // own still has something to schedule.
  const testAt = testReminderAt();
  if (testAt && testAt.getTime() > Date.now()) {
    notifications.push(testReminderBody(testAt));
  } else if (testAt) {
    localStorage.removeItem(NOTIFY_TEST_AT_KEY);
  }

  if (notifications.length === 0) return 0;
  try {
    await cap.schedule({ notifications });
  } catch (err) {
    return 0;
  }
  return notifications.length;
}

// A read-only view of what's actually pending, for Settings to show rather than
// telling the user reminders are on when three of them silently failed.
async function pendingReminders() {
  if (!notifyIsNative()) return [];
  if (!(await notifyPermissionGranted())) return [];
  try {
    const res = await notifyCap().getPending();
    return (res.notifications || []).map((n) => ({
      id: n.id, title: n.title, body: n.body,
      at: n.schedule && n.schedule.at ? new Date(n.schedule.at) : null
    }));
  } catch (err) {
    return [];
  }
}

// A reminder in a minute, through exactly the same path as a real one.
//
// Waiting for a bill reminder to come round tells you very little: it conflates
// the permission, the channel, the alarm and the notification itself, so a
// failure in any of them looks the same. This exercises all four in about a
// minute, and it is the only way to find out whether the phone is delivering
// anything at all without editing real data to make something due.
//
// Scheduled rather than posted directly, on purpose: a test that bypassed
// `schedule()` would prove nothing about the part most likely to be broken. It
// carries its own id, so it can neither be mistaken for a real reminder nor be
// wiped by the next rebuild of the schedule, and nothing marks it as seen —
// tapping it goes nowhere in particular.
const NOTIFY_ID_TEST = 900900;
// A different id from the armed test: one is an alarm, this one has already fired,
// and neither should be mistaken for the other in the pending list.
const NOTIFY_ID_SHOW = 900901;
// When the test reminder is due. Held here rather than nowhere because
// `scheduleAllReminders` cancels everything and rebuilds from the plan, and the
// test is not part of the plan — so without somewhere to remember it, putting
// the phone down and picking it up again would silently cancel the very thing
// you were waiting for. That is what actually happened.
const NOTIFY_TEST_AT_KEY = 'sorted-notify-test-at';

function testReminderAt() {
  const t = Date.parse(localStorage.getItem(NOTIFY_TEST_AT_KEY) || '');
  return Number.isFinite(t) ? new Date(t) : null;
}

function testReminderBody(at) {
  return {
    id: NOTIFY_ID_TEST,
    title: 'Sorted — test reminder',
    body: 'This arrived on its own, with nothing due.',
    channelId: NOTIFY_CHANNEL_ID,
    ...INEXACT,
    icon: NOTIF_ICON,
    // allowWhileIdle, unlike a real reminder. This one exists precisely so that
    // you can put the phone in your pocket and wait, and an alarm that will not
    // fire while the screen is off defeats the entire point of pressing the
    // button.
    schedule: { at: at, allowWhileIdle: true },
    extra: { page: 'dashboard' }
  };
}

async function sendTestReminder(btn) {
  if (!notifyIsNative()) {
    return { ok: false, error: 'Testing a scheduled reminder needs the phone build' };
  }
  if (!(await notifyPermissionGranted())) {
    return { ok: false, error: 'Notifications are not allowed for Sorted yet' };
  }
  const cap = notifyCap();
  await ensureChannel();
  // Five minutes, not one. The alarm is *inexact*, and being inexact is
  // deliberate — see inexactAlarmNote() — so a minute is not a promise the
  // system has made. On a phone that batches background work, "about a minute"
  // can honestly mean most of an afternoon, and a test that lies about when it
  // will arrive is worse than one that admits it.
  const at = new Date(Date.now() + 5 * 60 * 1000);
  localStorage.setItem(NOTIFY_TEST_AT_KEY, at.toISOString());
  try {
    await cap.schedule({ notifications: [testReminderBody(at)] });
  } catch (err) {
    localStorage.removeItem(NOTIFY_TEST_AT_KEY);
    return { ok: false, error: 'The phone refused it: ' + String((err && err.message) || err) };
  }
  if (btn) btn.textContent = 'Armed';
  return { ok: true, at: at.toISOString(), inexact: true };
}

// Shows a notification immediately, rather than arming an alarm for later.
//
// The alarm is inexact, so "did the alarm work?" cannot be answered on any
// timescale a person will sit and watch. This answers the other half straight
// away — permission, channel and rendering — because the plugin fires a schedule
// whose moment has already passed in-process instead of going through
// AlarmManager. Between the two controls every part is covered: this proves the
// notification can be shown at all, and the pending list proves the alarm was
// accepted.
async function showTestNotificationNow() {
  if (!notifyIsNative()) {
    return { ok: false, error: 'Showing a notification needs the phone build' };
  }
  if (!(await notifyPermissionGranted())) {
    return { ok: false, error: 'Notifications are not allowed for Sorted yet' };
  }
  const cap = notifyCap();
  await ensureChannel();
  const past = new Date(Date.now() - 2000);
  try {
    await cap.schedule({
      notifications: [{
        id: NOTIFY_ID_SHOW,
        title: 'Sorted — notifications are on',
        body: 'If you can read this, the rest will arrive.',
        channelId: NOTIFY_CHANNEL_ID,
        ...INEXACT,
        icon: NOTIF_ICON,
        schedule: { at: past, allowWhileIdle: true },
        extra: { page: 'dashboard' }
      }]
    });
  } catch (err) {
    return { ok: false, error: 'The phone refused it: ' + String((err && err.message) || err) };
  }
  return { ok: true };
}

// Why a reminder may be late, stated once, where it is being waited for.
function inexactAlarmNote() {
  return 'Sorted does not ask for permission to wake exactly on the minute, so '
    + 'reminders are inexact: they arrive near the time, not on it. That is right '
    + 'for "Rent is due Thursday" and wrong for anything you are watching the '
    + 'clock for.';
}

// ---------------------------------------------------------------- web path

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
  const keys = Object.keys(seen);
  if (keys.length > 200) for (const k of keys.slice(0, keys.length - 200)) delete seen[k];
  localStorage.setItem(NOTIFY_SEEN_KEY, JSON.stringify(seen));
}

function fireNow(title, body, page, tag) {
  let n;
  try {
    n = new Notification(title, {
      body,
      tag,
      icon: 'static/icons/icon-192.png',
      badge: 'static/icons/icon-192.png'
    });
  } catch (err) {
    return false;
  }
  n.onclick = () => {
    try { window.focus(); } catch (err) { /* focus can be refused */ }
    if (page) navigate(page);
    n.close();
  };
  return true;
}

// The browser fallback: check on the way out and on the way back in, and only
// while in the background. There's no such thing as firing at a chosen hour
// here, and the settings say so.
async function checkBillNotifications() {
  if (notifyIsNative()) return 0;      // the alarm does this instead
  if (!isNotifyEnabled() || !notifySupported()) return 0;
  if (Notification.permission !== 'granted') return 0;
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
      if (fireNow('Sorted — bill due', billNotificationText(bill, days), 'due',
                  'sorted-bill-' + bill.id)) {
        markNotified(bill.id, today);
        sent++;
      }
    }

    if (isSpendNudgeEnabled() && !(await recordedToday('spend'))) {
      const key = 'spend-' + today;
      if (notifySeen()[key] !== today) {
        if (fireNow('Sorted — nothing recorded today',
                    'Anything you spent today? A minute now saves guessing later.',
                    'spend', key)) {
          markNotified(key, today);
          sent++;
        }
      }
    }

    if (isGoalNudgeEnabled()) {
      const g = await goalsTouchedRecently();
      const key = 'goal-' + today;
      if (g.any && !g.recent && notifySeen()[key] !== today) {
        if (fireNow('Sorted — nothing going in',
                    `No goal has been topped up in ${goalNudgeCadence().days} days.`,
                    'savings', key)) {
          markNotified(key, today);
          sent++;
        }
      }
    }
  } catch (err) {
    // A failed notification must never take the app down with it.
    return sent;
  }

  return sent;
}

// ---------------------------------------------------------------- permission

// Ask for permission, and turn the setting on only if it was actually granted.
// Returning the outcome lets Settings say what happened instead of silently
// showing a switch that does nothing.
// The permission, asked for and reported honestly.
//
// This used to be one try/catch around requestPermissions() that turned any
// failure — a missing plugin, a rejected bridge call, anything — into the string
// 'denied', and the toast then said "Notifications are blocked for Sorted". It
// was reporting a user's refusal it had never been told about, so the real
// reason could never be found from the outside. Every outcome is now a real
// value from the platform, and "unavailable" is a separate answer from "denied".
//
// The re-check after the request matters too. On Android 13+ the plugin answers
// with NotificationManager.areNotificationsEnabled() — the app's notification
// switch in system settings — which is not the same thing as the runtime
// permission, and is false for reasons the permission screen can't fix.
let notifyPermissionCache = null;

// What the phone last reported as pending. Read once when Settings opens rather
// than on every render, because it is a bridge call and Settings is repainted
// every time a switch moves.
let notifyPendingCache = null;

async function loadPendingReminders() {
  notifyPendingCache = await pendingReminders();
  return notifyPendingCache;
}

async function notificationPermission(request) {
  if (!notifyIsNative()) {
    if (typeof Notification === 'undefined') {
      return { state: 'unavailable', detail: 'no Notification API' };
    }
    if (!request) return { state: Notification.permission, detail: 'web' };
    try {
      const asked = await Notification.requestPermission();
      return { state: asked || Notification.permission, detail: 'web' };
    } catch (err) {
      return { state: 'unavailable', detail: String((err && err.message) || err) };
    }
  }

  const cap = notifyCap();
  try {
    // Already granted? Don't ask at all. Asking again is at best a no-op and on
    // some versions re-prompts.
    const before = await cap.checkPermissions();
    if (before && before.display === 'granted') {
      return { state: 'granted', detail: 'already granted' };
    }
    // A refusal is an answer, and asking again does not change it — the only
    // thing that does is the phone's own settings screen, which is exactly what
    // the message tells them to go and use. So once a check has come back
    // denied, this stops requesting and only re-checks.
    //
    // Re-checking is not redundant: the user may have been and gone and turned
    // notifications on, and the reminder is meant to start working by itself the
    // moment they have.
    const knownDenied = notifyPermissionCache
      && notifyPermissionCache.state === 'denied'
      && before.display === 'denied';
    let asked = null;
    if (request && !knownDenied) {
      asked = await cap.requestPermissions();
    }
    // Trust the re-check over the request's own answer: the two can disagree,
    // and the re-check is what the scheduler itself will act on.
    const after = await cap.checkPermissions();
    const state = (after && after.display)
      || (asked && asked.display)
      || 'unknown';
    return { state, detail: 'asked', asked: asked && asked.display };
  } catch (err) {
    // A plugin that isn't wired up is not a user who said no.
    const detail = String((err && err.message) || err);
    console.error('Notification permission check failed:', detail);
    return { state: 'unavailable', detail };
  }
}

// What to say about a permission state. On Android "denied" almost always means
// the app's notification switch is off rather than a refusal, and the remedy is
// a system-settings screen, not a second tap here.
function permissionMessage(state) {
  if (state === 'granted') return { ok: true, text: '' };
  if (state === 'unavailable') {
    return { ok: false, text: 'Notifications are not available in this build' };
  }
  if (state === 'prompt' || state === 'prompt-with-rationale') {
    return { ok: false, text: 'Sorted still needs permission to post notifications' };
  }
  return {
    ok: false,
    text: notifyIsNative()
      ? 'Turn on notifications for Sorted in your phone settings'
      : 'Notifications are blocked for this site'
  };
}

// Switching ONE reminder on.
//
// Order matters more than anything else here, and getting it wrong is what
// made this take four releases to fix:
//
//   1. record the choice
//   2. repaint
//   3. THEN talk to the platform
//
// The flag used to be written first but the repaint came after the permission
// request, and on Android that request puts a system dialog on screen. The whole
// handler was awaiting, so the switch did not repaint until you switched tabs —
// which is exactly the symptom reported. A settings control must never have its
// own repaint queued behind a bridge call that may block on a dialog, may be
// slow, or may never answer.
//
// Permission is asked for afterwards and reported afterwards. If it can't be had
// the reminder stays on and keeps trying, picking itself up the moment Android
// grants it.
async function turnReminderOn(kind) {
  if (kind === 'bills') setNotifyEnabled(true);
  else if (kind === 'spend') setSpendNudgeEnabled(true);
  else if (kind === 'goal') setGoalNudgeEnabled(true);
  renderPage();
  return settleReminder(kind);
}

// Everything after the repaint. Isolated in its own function so that no
// rejection, hang or slow bridge call can reach back and stop the view from
// having already shown what the user asked for.
async function settleReminder(kind) {
  try {
    const perm = await notificationPermission(true);
    notifyPermissionCache = perm;
    await scheduleAllReminders();
    return perm;
  } catch (err) {
    // A failure here is a reminder that isn't scheduled yet, not a setting that
    // wasn't recorded. Say so rather than pretending the whole thing worked.
    console.error('Could not settle reminder:', err);
    return { state: 'unknown', detail: String((err && err.message) || err) };
  }
}

// Kept because the old call sites and any saved habit may still reach for it.
// It now only handles bills.
async function enableNotifications() {
  const perm = await turnReminderOn('bills');
  return perm.state === 'granted' ? 'on' : perm.state;
}

async function disableNotifications() {
  setNotifyEnabled(false);
}

async function disableNudge(kind) {
  if (kind === 'spend') setSpendNudgeEnabled(false);
  else if (kind === 'goal') setGoalNudgeEnabled(false);
  await scheduleAllReminders();
}

const REMINDER_LABELS = { bills: 'Bill reminders', spend: 'Spending reminders', goal: 'Savings reminders' };

async function toggleBillsReminders() {
  if (isNotifyEnabled()) {
    setNotifyEnabled(false);
    renderPage();
    await scheduleAllReminders();
    return;
  }
  // turnReminderOn records the flag and repaints before anything is awaited.
  const perm = await turnReminderOn('bills');
  reportReminderOutcome('bills', perm);
}

async function toggleNudge(kind) {
  const on = kind === 'spend' ? isSpendNudgeEnabled() : isGoalNudgeEnabled();
  if (on) {
    if (kind === 'spend') setSpendNudgeEnabled(false);
    else if (kind === 'goal') setGoalNudgeEnabled(false);
    renderPage();
    await scheduleAllReminders();
    return;
  }
  const perm = await turnReminderOn(kind);
  reportReminderOutcome(kind, perm);
}

// Says what happened, and how long it stays up. A permission problem that
// vanishes after three and a half seconds is a permission problem you can't act
// on — so the one that matters is left long enough to read, and the Settings
// line keeps it on screen afterwards.
//
// The blocked notice is said once per blocked run, not once per tap. "Turn on
// notifications for Sorted in your phone settings" appeared every single time a
// reminder was switched on, which is the least useful possible form of a
// message about something the reader cannot fix from here: after the first time
// it is not information, it is an obstacle between them and the switch they
// were trying to move. It comes back if the state ever changes, and it goes for
// good once notifications are allowed.
function reportReminderOutcome(kind, perm) {
  const name = REMINDER_LABELS[kind] || 'Reminders';
  if (perm.state === 'granted') {
    // Allowed at last: forget we ever said otherwise, so if it is blocked again
    // later the reason is explained rather than assumed to be known.
    localStorage.removeItem(NOTIFY_BLOCKED_KEY);
    showToast(`${name} on`);
    return;
  }
  if (localStorage.getItem(NOTIFY_BLOCKED_KEY) === perm.state) return;
  localStorage.setItem(NOTIFY_BLOCKED_KEY, perm.state);
  showToast(`${permissionMessage(perm.state).text}`, 8000);
}

async function changeNotifyTime(value) {
  setNotifyTime(value);
  await scheduleAllReminders();
}

// ---------------------------------------------------------------- lifecycle

function initNotifications() {
  if (!notifyIsNative()) {
    // Browser: the foreground check, as before.
    if (!isNotifyEnabled() || !notifySupported() || Notification.permission !== 'granted') return;
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) checkBillNotifications();
    });
    setInterval(() => { if (document.hidden) checkBillNotifications(); }, 60 * 60 * 1000);
    checkBillNotifications();
    return;
  }

  if (!notifySupported()) return;

  // A tapped notification should land on the page it was about. The listener is
  // registered once, and it only navigates — it never touches data.
  try {
    notifyCap().addListener('localNotificationActionPerformed', (action) => {
      const page = action && action.notification && action.notification.extra
        ? action.notification.extra.page : null;
      if (page) navigate(page);
    });
  } catch (err) { /* the app still works, taps just don't route */ }

  // Ask once at boot so Settings can say the real state on first render rather
  // than "checking", and so a background failure is logged once rather than
  // on every tap.
  notificationPermission(false).then((perm) => {
    notifyPermissionCache = perm;
    if (perm.state !== 'granted') console.warn('Sorted notification state:', perm);
  });

  // Start the savings clock before the first plan, so the first run doesn't
  // either fire a nudge about goals that have been there for months or leave
  // the feature inert until someone happens to edit one.
  observeGoalsOnce();

  // Rebuild the schedule on every foreground: paying a bill or recording a spend
  // changes what should be pending, and a foreground is when we can know.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) scheduleAllReminders();
  });
  scheduleAllReminders();
}
