const fields = ['vpsName', 'serverUrl', 'apiKey'];
const $ = (id) => document.getElementById(id);

// ---------- helpers ----------

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

let toastTimer = null;
function toast(text, cls = '') {
  const el = $('toast');
  el.textContent = text;
  el.className = `toast show ${cls}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), cls === 'err' ? 5000 : 2500);
}

function ago(ts) {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(ts).toLocaleDateString();
}

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

// ---------- status ----------

const TAB_STATE = {
  reloading: ['warn', 'Slack tab is waking up', 'Chrome put it to sleep; reloading it now.'],
  loading: ['warn', 'Slack tab is loading', 'Wait a moment for it to finish.'],
  frozen: ['err', 'Slack tab is frozen', 'Chrome froze it. Click on the tab once to wake it.'],
  'no-response': ['err', 'Slack tab not responding', 'Refresh the Slack tab.'],
};

function tabChecks(tabs) {
  if (!tabs.length) {
    return [['err', 'No Slack tab open', 'Open app.slack.com in a tab to start capturing.']];
  }
  return tabs.map((tab) => {
    if (tab.state !== 'ok') {
      const [lvl, title, detail] = TAB_STATE[tab.state] || ['err', 'Slack tab problem', tab.state];
      return [lvl, title, detail];
    }
    if (tab.permission !== 'granted') {
      return [
        'warn',
        'Slack connected, notifications blocked',
        `Permission is "${tab.permission}". Allow notifications for app.slack.com.`,
      ];
    }
    return ['ok', 'Slack connected', 'Listening for messages and notifications.'];
  });
}

function serverCheck(config, hasAccess, stats) {
  if (!config.serverUrl || !config.apiKey) {
    return ['err', 'Server not configured', 'Enter a server URL and API key below.'];
  }
  if (!hasAccess) return ['err', 'No access to server', 'Click “Grant access” above.'];
  if (stats.lastError) return ['err', 'Delivery failing', stats.lastError];
  return ['ok', 'Server reachable', `Delivering to ${hostOf(config.serverUrl)}`];
}

function renderChecks(checks) {
  const icon = { ok: '✓', warn: '!', err: '✕' };
  $('checks').innerHTML = checks
    .map(
      ([lvl, title, detail]) => `
      <li class="${lvl}">
        <span class="ico">${icon[lvl]}</span>
        <span><b>${escapeHtml(title)}</b><span class="detail">${escapeHtml(detail)}</span></span>
      </li>`
    )
    .join('');
}

function renderOverall(checks, pending) {
  const levels = checks.map((c) => c[0]);
  const el = $('overall');
  if (levels.includes('err')) {
    el.className = 'pill err';
    el.textContent = 'Attention';
  } else if (levels.includes('warn') || pending > 0) {
    el.className = 'pill warn';
    el.textContent = pending > 0 ? 'Sending…' : 'Degraded';
  } else {
    el.className = 'pill ok';
    el.textContent = 'Live';
  }
}

async function renderStats() {
  const [{ stats = {}, pendingQueue = [] }, config] = await Promise.all([
    chrome.storage.local.get(['stats', 'pendingQueue']),
    chrome.storage.sync.get(fields),
  ]);

  const serverOrigin = originOf(config.serverUrl || '');
  const hasAccess = serverOrigin ? await chrome.permissions.contains({ origins: [`${serverOrigin}/*`] }) : true;
  $('grantBanner').hidden = hasAccess;
  if (!hasAccess) $('grantText').textContent = `No permission to reach ${serverOrigin}.`;

  const checks = [...tabChecks(stats.tabs || []), serverCheck(config, hasAccess, stats)];
  renderChecks(checks);
  renderOverall(checks, pendingQueue.length);

  $('mCaptured').textContent = (stats.captured || 0).toLocaleString();
  $('mPending').textContent = pendingQueue.length.toLocaleString();
  $('mPendingBox').classList.toggle('alert', pendingQueue.length > 0);
  $('mSwitches').textContent = (stats.autoSwitches || 0).toLocaleString();
  $('tCaptured').textContent = ago(stats.lastCapturedAt);
  $('tSent').textContent = ago(stats.lastSentAt);

  $('subtitle').textContent = config.vpsName ? `${config.vpsName} · Slack → dashboard` : 'Slack → dashboard';
  $('connSummary').textContent = hostOf(config.serverUrl || '') || 'not set';
}

// ---------- behavior settings ----------

function renderSwitch(enabled, delay) {
  $('autoSwitch').checked = enabled;
  $('autoSwitchDelay').value = String(delay);
  $('delayRow').hidden = !enabled;
  $('delayHint').hidden = !enabled || Number(delay) !== 0;
}

async function saveSwitch() {
  const enabled = $('autoSwitch').checked;
  const delay = Number($('autoSwitchDelay').value) || 0;
  renderSwitch(enabled, delay);
  await chrome.storage.sync.set({ autoSwitch: enabled, autoSwitchDelay: delay });
  toast(enabled ? 'Keep Slack in front: on' : 'Keep Slack in front: off', 'ok');
}

$('autoSwitch').addEventListener('change', saveSwitch);
$('autoSwitchDelay').addEventListener('change', saveSwitch);

// ---------- connection ----------

$('reveal').addEventListener('click', () => {
  const input = $('apiKey');
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  $('reveal').textContent = show ? 'Hide' : 'Show';
});

$('serverUrl').addEventListener('input', () => $('serverUrl').classList.remove('invalid'));

$('save').addEventListener('click', async () => {
  const serverUrl = $('serverUrl').value.trim().replace(/\/+$/, '');
  if (serverUrl && !/^https?:\/\/[^/]+/i.test(serverUrl)) {
    $('serverUrl').classList.add('invalid');
    toast('Server URL must start with http:// or https://', 'err');
    return;
  }
  await chrome.storage.sync.set({
    vpsName: $('vpsName').value.trim(),
    serverUrl,
    apiKey: $('apiKey').value.trim(),
  });
  toast('Settings saved', 'ok');
  chrome.runtime.sendMessage({ type: 'flush' }).catch(() => {}).finally(renderStats);
});

$('test').addEventListener('click', async () => {
  const btn = $('test');
  btn.disabled = true;
  btn.textContent = 'Sending…';
  try {
    await chrome.runtime.sendMessage({ type: 'test' });
    await renderStats();
    const { stats = {}, pendingQueue = [] } = await chrome.storage.local.get(['stats', 'pendingQueue']);
    if (pendingQueue.length) toast(`Test failed: ${stats.lastError || 'still pending'}`, 'err');
    else toast('Test sent. Check the dashboard.', 'ok');
  } catch (err) {
    toast(`Background not responding: ${err.message}. Reload the extension.`, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send test';
  }
});

$('grant').addEventListener('click', async () => {
  const origin = originOf($('serverUrl').value.trim());
  if (!origin) {
    $('connection').open = true;
    toast('Enter a valid server URL first.', 'err');
    return;
  }
  const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
  toast(granted ? 'Access granted' : 'Access was not granted', granted ? 'ok' : 'err');
  if (granted) chrome.runtime.sendMessage({ type: 'flush' }).catch(() => {}).finally(renderStats);
});

$('refresh').addEventListener('click', async () => {
  const btn = $('refresh');
  btn.disabled = true;
  try {
    await chrome.runtime.sendMessage({ type: 'status' });
  } catch {
    // Background asleep or reloading; stats below are still the last known.
  }
  await renderStats();
  btn.disabled = false;
});

// ---------- init ----------

async function load() {
  // Opened as a full tab (options page) rather than the toolbar popup.
  const tab = await chrome.tabs.getCurrent().catch(() => null);
  if (tab) document.body.classList.add('page');

  const values = await chrome.storage.sync.get([...fields, 'autoSwitch', 'autoSwitchDelay']);
  for (const f of fields) $(f).value = values[f] || '';
  renderSwitch(!!values.autoSwitch, values.autoSwitchDelay ?? 0);
  $('connection').open = !values.serverUrl || !values.apiKey;

  await renderStats();
  chrome.runtime.sendMessage({ type: 'status' }).catch(() => {});
}

chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === 'local') renderStats();
});

// Keep relative times ("2m ago") fresh while open.
setInterval(renderStats, 15000);

load();
