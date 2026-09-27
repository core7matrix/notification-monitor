// Isolated-world content script: forwards captured notifications from the page
// to the extension background worker. May be injected again after an extension
// reload, so guard against double registration.
if (!window.__notificationRelayBridge) {
  window.__notificationRelayBridge = true;

  console.log('[relay] content script loaded on', location.href);

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'ping') {
      sendResponse({
        ok: true,
        url: location.href,
        permission: typeof Notification === 'function' ? Notification.permission : 'unsupported',
      });
    }
  });

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
      // Extension was reloaded; the background worker re-injects a fresh copy.
    }
  });
}
