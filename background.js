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
  const baseUrl = serverUrl.trim().replace(/\/+$/, '').replace(/\/api\/notifications\/ingest$/, '');
  return { serverUrl: baseUrl, apiKey, vpsName };
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

// ---------- merging page messages with browser notifications ----------
// The same Slack message can arrive twice: as a browser notification (short
// preview) and from the page watcher (full text). Notifications are held
// briefly so the full-text version wins when both show up.

const NOTIFICATION_HOLD_MS = 3000;
const MERGE_WINDOW_MS = 2 * 60 * 1000;
const pendingNotifications = new Map();
const recentDom = [];
const recentNotifications = [];

function normText(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/(…|\.\.\.)\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function sameMessage(a, b) {
  const A = normText(a);
  const B = normText(b);
  if (!A || !B) return false;
  const k = Math.min(30, A.length, B.length);
  if (k < 4) return A === B;
  return A.includes(B.slice(0, k)) || B.includes(A.slice(0, k));
}

function prune(list) {
  const cutoff = Date.now() - MERGE_WINDOW_MS;
  while (list.length && list[0].at < cutoff) list.shift();
}

async function commit(item) {
  console.log(`[relay] captured (${item.app}/${item.source}):`, item.title, '-', item.body);
  const { [STATS_KEY]: stats = {} } = await chrome.storage.local.get(STATS_KEY);
  await updateStats({ captured: (stats.captured || 0) + 1, lastCapturedAt: item.capturedAt });
  await enqueue(item);
  await flushQueue();
}

async function handleDomMessage(item) {
  prune(recentDom);
  prune(recentNotifications);
  recentDom.push({ body: item.body, at: Date.now() });

  for (const [id, pending] of pendingNotifications) {
    if (sameMessage(pending.item.body, item.body)) {
      clearTimeout(pending.timer);
      pendingNotifications.delete(id);
      console.log('[relay] notification replaced by full page message:', pending.item.title);
    }
  }

  const alreadySent = recentNotifications.find((n) => sameMessage(n.body, item.body));
  if (alreadySent && normText(item.body).length <= normText(alreadySent.body).length + 3) {
    console.log('[relay] page message already sent as notification:', item.title);
    return;
  }
  await commit(item);
}

function holdNotification(item) {
  const timer = setTimeout(async () => {
    pendingNotifications.delete(item.id);
    prune(recentDom);
    if (recentDom.some((d) => sameMessage(d.body, item.body))) {
      console.log('[relay] notification skipped, full page message already sent:', item.title);
      return;
    }
    recentNotifications.push({ body: item.body, at: Date.now() });
    await commit(item);
  }, NOTIFICATION_HOLD_MS);
  pendingNotifications.set(item.id, { item, timer });
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

  if (item.source === 'dom') {
    item.id = `slack-${item.vps}-${item.tag}`;
    return handleDomMessage(item);
  }
  if (item.source === 'Notification' || item.source === 'ServiceWorker') {
    return holdNotification(item);
  }
  await commit(item);
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
  if (msg?.type === 'status') {
    checkTabs().then((tabs) => sendResponse({ tabs }));
    return true;
  }
  if (msg?.type === 'flush') {
    flushQueue().then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});

// ---------- watched tabs ----------

const WATCHED_URLS = [...new Set(chrome.runtime.getManifest().content_scripts.flatMap((cs) => cs.matches))];

function ping(tabId) {
  return Promise.race([
    chrome.tabs.sendMessage(tabId, { type: 'ping' }),
    new Promise((resolve) => setTimeout(() => resolve(null), 3000)),
  ]).catch(() => null);
}

async function injectInto(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['inject.js'], world: 'MAIN' });
  await chrome.scripting.executeScript({ target: { tabId }, files: ['bridge.js', 'slack-dom.js'] });
}

async function checkTab(tab) {
  const info = { id: tab.id, url: tab.url, title: tab.title };

  if (tab.autoDiscardable) {
    await chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
  }
  if (tab.discarded) {
    console.log('[relay] tab was discarded by Chrome, reloading:', tab.url);
    await chrome.tabs.reload(tab.id).catch(() => {});
    return { ...info, state: 'reloading' };
  }
  if (tab.status !== 'complete') return { ...info, state: 'loading' };

  let reply = await ping(tab.id);
  if (!reply && !tab.frozen) {
    console.log('[relay] content script not responding, re-injecting:', tab.url);
    try {
      await Promise.race([
        injectInto(tab.id),
        new Promise((_, reject) => setTimeout(() => reject(new Error('inject timed out')), 5000)),
      ]);
      reply = await ping(tab.id);
    } catch (err) {
      console.warn('[relay] re-inject failed:', err);
    }
  }
  if (!reply) return { ...info, state: tab.frozen ? 'frozen' : 'no-response' };
  return { ...info, state: 'ok', permission: reply.permission };
}

async function checkTabs() {
  const tabs = await chrome.tabs.query({ url: WATCHED_URLS });
  const results = await Promise.all(tabs.map(checkTab));
  await updateStats({ tabs: results, tabsCheckedAt: Date.now() });
  return results;
}

function ensureAlarm() {
  chrome.alarms.create(RETRY_ALARM, { periodInMinutes: 1 });
}

function onBoot() {
  ensureAlarm();
  checkTabs();
}

chrome.runtime.onInstalled.addListener(onBoot);
chrome.runtime.onStartup.addListener(onBoot);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== RETRY_ALARM) return;
  flushQueue();
  checkTabs();
});
