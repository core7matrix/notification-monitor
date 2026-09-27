// Isolated-world content script: forwards captured notifications from the page
// to the extension background worker.
function reportStatus() {
  try {
    chrome.runtime
      .sendMessage({
        type: 'hello',
        payload: {
          url: location.href,
          permission: typeof Notification === 'function' ? Notification.permission : 'unsupported',
        },
      })
      .catch(() => {});
  } catch {}
}

console.log('[relay] content script loaded on', location.href);
reportStatus();
setInterval(reportStatus, 60000);
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.__notificationRelay !== true) return;

  console.log('[relay] caught notification:', data.title, '-', data.body);

  try {
    chrome.runtime
      .sendMessage({
        type: 'notification',
        payload: {
          source: data.source,
          title: data.title,
          body: data.body,
          icon: data.icon,
          tag: data.tag,
          url: location.href,
          pageTitle: document.title,
        },
      })
      .catch(() => {});
  } catch {
    // Extension was reloaded; this page needs a refresh to reconnect.
  }
});
