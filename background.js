const QUEUE_KEY = 'pendingQueue';
const STATS_KEY = 'stats';
const MAX_QUEUE = 500;
const DEDUPE_WINDOW_MS = 5000;
const RETRY_ALARM = 'flushQueue';

const APPS = [{ match: /(^|\.)slack\.com$/, name: 'slack' }];

const recent = new Map();
let flushing = false;

function appFromUrl(url) {
  try {
    const host = new URL(url).hostname;
    const app = APPS.find((a) => a.match.test(host));
    return app ? app.name : host;
  } catch {
    return 'unknown';
  }
}

function isDuplicate(n) {
  const key = `${n.app}|${n.tag || ''}|${n.title}|${n.body}`;
  const now = Date.now();
  for (const [k, t] of recent) {
    if (now - t > DEDUPE_WINDOW_MS) recent.delete(k);
  }
  if (recent.has(key)) return true;
  recent.set(key, now);
  return false;
}

async function getConfig() {
  const { serverUrl = '', apiKey = '', vpsName = '' } = await chrome.storage.sync.get([
    'serverUrl',
    'apiKey',
    'vpsName',
  ]);
  return { serverUrl: serverUrl.replace(/\/+$/, ''), apiKey, vpsName };
}

async function updateStats(patch) {
  const { [STATS_KEY]: stats = {} } = await chrome.storage.local.get(STATS_KEY);
  await chrome.storage.local.set({ [STATS_KEY]: { ...stats, ...patch } });
}

async function enqueue(item) {
  const { [QUEUE_KEY]: queue = [] } = await chrome.storage.local.get(QUEUE_KEY);
  queue.push(item);
  while (queue.length > MAX_QUEUE) queue.shift();
  await chrome.storage.local.set({ [QUEUE_KEY]: queue });
}

async function postNotifications(config, items) {
  const url = `${config.serverUrl}/api/notifications/ingest`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': config.apiKey },
      body: JSON.stringify({ notifications: items }),
    });
  } catch (err) {
    throw new Error(`Cannot reach ${url} (${err.message})`);
  }
  if (!res.ok) throw new Error(`Server responded ${res.status} for ${url}`);
}

async function flushQueue() {
  if (flushing) return;
  flushing = true;
  try {
    const config = await getConfig();
    if (!config.serverUrl || !config.apiKey) {
      await updateStats({ lastError: 'Server URL or API key not configured' });
      return;
    }
    for (;;) {
      const { [QUEUE_KEY]: queue = [] } = await chrome.storage.local.get(QUEUE_KEY);
      if (queue.length === 0) {
        await updateStats({ lastError: null });
        return;
      }

      const batch = queue.slice(0, 50);
      await postNotifications(config, batch);

      const { [QUEUE_KEY]: current = [] } = await chrome.storage.local.get(QUEUE_KEY);
      const sentIds = new Set(batch.map((n) => n.id));
      await chrome.storage.local.set({ [QUEUE_KEY]: current.filter((n) => !sentIds.has(n.id)) });
      await updateStats({ lastSentAt: Date.now(), lastError: null });
      console.log(`[relay] sent ${batch.length} notification(s) to ${config.serverUrl}`);
    }
  } catch (err) {
    console.warn('[relay] send failed, will retry:', err);
    await updateStats({ lastError: String(err && err.message ? err.message : err), lastErrorAt: Date.now() });
  } finally {
    flushing = false;
  }
}

async function handleNotification(payload) {
  const config = await getConfig();
  const item = {
    id: crypto.randomUUID(),
    vps: config.vpsName || 'unnamed-vps',
    app: appFromUrl(payload.url),
    title: payload.title || '',
    body: payload.body || '',
    icon: payload.icon,
    tag: payload.tag,
    url: payload.url,
    pageTitle: payload.pageTitle,
    source: payload.source,
    capturedAt: Date.now(),
  };
  if (isDuplicate(item)) {
    console.log('[relay] duplicate skipped:', item.title);
    return;
  }
  console.log(`[relay] captured (${item.app}/${item.source}):`, item.title, '-', item.body);

  const { [STATS_KEY]: stats = {} } = await chrome.storage.local.get(STATS_KEY);
  await updateStats({ captured: (stats.captured || 0) + 1, lastCapturedAt: item.capturedAt });
  await enqueue(item);
  await flushQueue();
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'notification' && msg.payload) {
    handleNotification(msg.payload).finally(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg?.type === 'test') {
    handleNotification({
      title: 'Test notification',
      body: `Sent from the Notification Relay popup at ${new Date().toLocaleTimeString()}.`,
      url: 'https://app.slack.com/',
      source: 'test',
      pageTitle: 'Test',
    })
      .then(() => chrome.storage.local.get([STATS_KEY, QUEUE_KEY]))
      .then((data) => sendResponse({ ok: true, ...data }));
    return true;
  }
  if (msg?.type === 'hello' && msg.payload) {
    console.log('[relay] content script active:', msg.payload.url, 'permission:', msg.payload.permission);
    updateStats({ lastPage: { ...msg.payload, at: Date.now() } }).finally(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg?.type === 'flush') {
    flushQueue().then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});

function ensureAlarm() {
  chrome.alarms.create(RETRY_ALARM, { periodInMinutes: 1 });
}

chrome.runtime.onInstalled.addListener(ensureAlarm);
chrome.runtime.onStartup.addListener(ensureAlarm);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RETRY_ALARM) flushQueue();
});
