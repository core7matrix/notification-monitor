// Runs in the page's own JS context (world: MAIN) before the app's scripts,
// so it can wrap the Notification APIs the app uses.
(() => {
  if (window.__notificationRelayInstalled) return;
  window.__notificationRelayInstalled = true;

  const toUrl = (value) => {
    if (!value) return undefined;
    try {
      return new URL(value, location.href).href;
    } catch {
      return undefined;
    }
  };

  const send = (source, title, opts) => {
    const o = opts || {};
    window.postMessage(
      {
        __notificationRelay: true,
        source,
        title: String(title ?? ''),
        body: typeof o.body === 'string' ? o.body : '',
        icon: toUrl(o.icon),
        tag: typeof o.tag === 'string' ? o.tag : undefined,
      },
      window.location.origin
    );
  };

  const OrigNotification = window.Notification;
  if (typeof OrigNotification === 'function') {
    const Patched = function Notification(title, opts) {
      send('Notification', title, opts);
      return new OrigNotification(title, opts);
    };
    Patched.prototype = OrigNotification.prototype;
    Object.defineProperty(Patched, 'permission', {
      get: () => OrigNotification.permission,
    });
    Object.defineProperty(Patched, 'maxActions', {
      get: () => OrigNotification.maxActions,
    });
    Patched.requestPermission = (...args) => OrigNotification.requestPermission(...args);
    window.Notification = Patched;
  }

  const SWR = window.ServiceWorkerRegistration;
  if (SWR && SWR.prototype && typeof SWR.prototype.showNotification === 'function') {
    const origShow = SWR.prototype.showNotification;
    SWR.prototype.showNotification = function showNotification(title, opts) {
      send('ServiceWorker', title, opts);
      return origShow.call(this, title, opts);
    };
  }
})();
