/* =============================================================================
   settings.js
   Reads/writes the same localStorage keys notifications.js checks against.
   ============================================================================= */

const NOTIF_KEYS = {
  enabled: 'sorted_notifications_enabled',
  reminderTime: 'sorted_reminder_time',
  askedPermission: 'sorted_asked_permission',
};

function describePermissionStatus() {
  const el = document.getElementById('permission-status');
  if (!('Notification' in window)) {
    el.textContent = 'Notifications are not supported in this browser.';
    return;
  }
  if (Notification.permission === 'denied') {
    el.textContent = 'Notifications are blocked at the browser level — check your browser/site settings to allow them.';
  } else if (Notification.permission === 'default') {
    el.textContent = 'Permission not yet granted — saving with the box ticked will ask for it.';
  } else {
    el.textContent = 'Notification permission granted.';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('notif-enabled').checked =
    localStorage.getItem(NOTIF_KEYS.enabled) === 'true';
  document.getElementById('reminder-time').value =
    localStorage.getItem(NOTIF_KEYS.reminderTime) || '20:00';

  describePermissionStatus();

  document.getElementById('save-settings-btn').addEventListener('click', async () => {
    const wantsEnabled = document.getElementById('notif-enabled').checked;
    const time = document.getElementById('reminder-time').value || '20:00';

    localStorage.setItem(NOTIF_KEYS.reminderTime, time);

    if (wantsEnabled) {
      if ('Notification' in window && Notification.permission === 'default') {
        const permission = await Notification.requestPermission();
        localStorage.setItem(NOTIF_KEYS.askedPermission, 'true');
        if (permission !== 'granted') {
          localStorage.setItem(NOTIF_KEYS.enabled, 'false');
          describePermissionStatus();
          alert('Permission was not granted — reminders stay off until it is.');
          return;
        }
      }
      localStorage.setItem(NOTIF_KEYS.enabled, 'true');
    } else {
      localStorage.setItem(NOTIF_KEYS.enabled, 'false');
    }

    describePermissionStatus();
    window.location.href = 'index.html';
  });
});
