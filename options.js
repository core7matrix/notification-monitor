const fields = ['vpsName', 'serverUrl', 'apiKey'];
const $ = (id) => document.getElementById(id);

function showMessage(text, cls) {
  const el = $('message');
  el.textContent = text;
  el.className = cls || '';
}

function fmt(ts) {
  return ts ? new Date(ts).toLocaleString() : 'never';
}

async function renderStats() {
  const { stats = {}, pendingQueue = [] } = await chrome.storage.local.get(['stats', 'pendingQueue']);
  const page = stats.lastPage;
  const pageFresh = page && Date.now() - page.at < 3 * 60 * 1000;
  let pageLine;
  if (!pageFresh) {
    pageLine = '<span class="error">Slack tab: not detected. Open or refresh app.slack.com</span>';
  } else if (page.permission !== 'granted') {
    pageLine = `<span class="error">Slack tab: connected, but notification permission is "${escapeHtml(page.permission)}". Allow notifications for app.slack.com</span>`;
  } else {
    pageLine = '<span class="ok">Slack tab: connected, notifications allowed</span>';
  }

  const serverOrigin = await getServerOrigin();
  const hasAccess = serverOrigin ? await chrome.permissions.contains({ origins: [`${serverOrigin}/*`] }) : true;
  $('grant').classList.toggle('hidden', hasAccess);

  $('stats').innerHTML = `
    ${hasAccess ? '' : `<span class="error">No permission to send to ${escapeHtml(serverOrigin)}. Click "Grant server access".</span><br>`}
    ${pageLine}<br>
    Captured: <b>${stats.captured || 0}</b><br>
    Pending (not yet sent): <b>${pendingQueue.length}</b><br>
    Last captured: ${fmt(stats.lastCapturedAt)}<br>
    Last sent: ${fmt(stats.lastSentAt)}<br>
    ${stats.lastError ? `<span class="error">Last error: ${escapeHtml(stats.lastError)}</span>` : '<span class="ok">No errors</span>'}
  `;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

async function getServerOrigin() {
  const { serverUrl = '' } = await chrome.storage.sync.get('serverUrl');
  try {
    return new URL(serverUrl).origin;
  } catch {
    return '';
  }
}

$('grant').addEventListener('click', () => {
  const origin = (() => {
    try {
      return new URL($('serverUrl').value.trim()).origin;
    } catch {
      return '';
    }
  })();
  if (!origin) {
    showMessage('Enter a valid server URL first.', 'error');
    return;
  }
  chrome.permissions.request({ origins: [`${origin}/*`] }).then((granted) => {
    showMessage(granted ? 'Access granted.' : 'Access was not granted.', granted ? 'ok' : 'error');
    if (granted) chrome.runtime.sendMessage({ type: 'flush' }).finally(renderStats);
  });
});

async function load() {
  const values = await chrome.storage.sync.get(fields);
  for (const f of fields) $(f).value = values[f] || '';
  renderStats();
}

$('save').addEventListener('click', async () => {
  const serverUrl = $('serverUrl').value.trim().replace(/\/+$/, '');
  if (serverUrl && !/^https?:\/\//i.test(serverUrl)) {
    showMessage('Server URL must start with http:// or https://', 'error');
    return;
  }
  await chrome.storage.sync.set({
    vpsName: $('vpsName').value.trim(),
    serverUrl,
    apiKey: $('apiKey').value.trim(),
  });
  showMessage('Saved.', 'ok');
  chrome.runtime.sendMessage({ type: 'flush' }).finally(renderStats);
});

$('test').addEventListener('click', async () => {
  showMessage('Sending test...');
  try {
    await chrome.runtime.sendMessage({ type: 'test' });
  } catch (err) {
    showMessage(`Extension background not responding: ${err.message}. Reload the extension.`, 'error');
    return;
  }
  await renderStats();
  const { stats = {}, pendingQueue = [] } = await chrome.storage.local.get(['stats', 'pendingQueue']);
  if (pendingQueue.length) showMessage(`Failed: ${stats.lastError || 'still pending'}`, 'error');
  else showMessage('Test notification sent. Check the dashboard.', 'ok');
});

chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === 'local') renderStats();
});

load();
