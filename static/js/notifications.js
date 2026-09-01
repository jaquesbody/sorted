/* =============================================================================
   notifications.js
   Web Notifications API, per project.md 5 — Android-only, reliability caveat
   (needs the PWA installed and occasionally opened; no true background push
   without a server, see protocol.md notes on this).

   Two independent reminder types:
   1. Daily "log your spending" nudge at a user-set time.
   2. A heads-up when a recurring Due item is within 3 days of its due date.

   Both only fire once per calendar day per type, tracked via localStorage,
   and only run when the dashboard is actually open (the check happens on
   page load, not truly in the background).
   ============================================================================= */

const NOTIF_KEYS = {
  enabled: 'sorted_notifications_enabled',
  reminderTime: 'sorted_reminder_time',
  lastDailyNotify: 'sorted_last_daily_notify',
  lastDueCheck: 'sorted_last_due_check',
  askedPermission: 'sorted_asked_permission',
};

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function isNotificationSupported() {
  return 'Notification' in window;
}

function showPermissionBanner() {
  if (!isNotificationSupported()) return;
  if (Notification.permission !== 'default') return;
  if (localStorage.getItem(NOTIF_KEYS.askedPermission)) return;

  const banner = document.createElement('div');
  banner.className = 'surface p-3 mb-3';
  banner.style.display = 'flex';
  banner.style.flexDirection = 'column';
  banner.style.gap = '8px';
  banner.innerHTML = `
    <span class="text-sm">Get a daily reminder to log spending, and a heads-up 3 days before recurring bills are due?</span>
    <div class="flex gap-2">
      <button type="button" class="btn-accent" id="notif-enable-btn">Enable</button>
      <button type="button" class="btn-ghost" id="notif-ignore-btn">Not now</button>
    </div>
  `;

  const main = document.querySelector('main.dashboard');
  main.insertBefore(banner, main.firstChild.nextSibling);

  document.getElementById('notif-enable-btn').addEventListener('click', async () => {
    localStorage.setItem(NOTIF_KEYS.askedPermission, 'true');
    const permission = await Notification.requestPermission();
    if (permission === 'granted') {
      localStorage.setItem(NOTIF_KEYS.enabled, 'true');
      if (!localStorage.getItem(NOTIF_KEYS.reminderTime)) {
        localStorage.setItem(NOTIF_KEYS.reminderTime, '20:00');
      }
    }
    banner.remove();
  });

  document.getElementById('notif-ignore-btn').addEventListener('click', () => {
    localStorage.setItem(NOTIF_KEYS.askedPermission, 'true');
    banner.remove();
  });
}

function checkDailyReminder() {
  if (Notification.permission !== 'granted') return;
  if (localStorage.getItem(NOTIF_KEYS.enabled) !== 'true') return;

  const reminderTime = localStorage.getItem(NOTIF_KEYS.reminderTime) || '20:00';
  const [hour, minute] = reminderTime.split(':').map(Number);
  const now = new Date();
  const target = new Date();
  target.setHours(hour, minute, 0, 0);

  if (now < target) return;
  if (localStorage.getItem(NOTIF_KEYS.lastDailyNotify) === todayStr()) return;

  new Notification('Sorted', { body: "Don't forget to log today's spending." });
  localStorage.setItem(NOTIF_KEYS.lastDailyNotify, todayStr());
}

async function checkDueReminders() {
  if (Notification.permission !== 'granted') return;
  if (localStorage.getItem(NOTIF_KEYS.enabled) !== 'true') return;
  if (localStorage.getItem(NOTIF_KEYS.lastDueCheck) === todayStr()) return;

  const dueItems = await getAll('due');
  const now = new Date();
  const threeDaysOut = new Date();
  threeDaysOut.setDate(now.getDate() + 3);

  dueItems
    .filter((item) => item.recurring)
    .filter((item) => {
      const due = new Date(item.dueDate);
      return due >= now && due <= threeDaysOut;
    })
    .forEach((item) => {
      new Notification('Sorted', {
        body: `${item.title} (£${item.amount.toFixed(2)}) is due ${item.dueDate}.`,
      });
    });

  localStorage.setItem(NOTIF_KEYS.lastDueCheck, todayStr());
}

document.addEventListener('DOMContentLoaded', () => {
  if (!isNotificationSupported()) return;
  showPermissionBanner();
  checkDailyReminder();
  checkDueReminders();
});
