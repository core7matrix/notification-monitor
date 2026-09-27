// Watches the Slack page for newly rendered messages and relays their full text.
// Slack only renders the open channel/thread, so this complements (not replaces)
// the Notification capture in inject.js. Selectors rely on Slack's data-qa
// attributes, with class-name fallbacks, and may need updating if Slack changes.
if (!window.__notificationRelaySlackDom) {
  window.__notificationRelaySlackDom = true;

  const SEL = {
    message: '[data-qa="message_container"], .c-message_kit__message',
    sender: '[data-qa="message_sender_name"], .c-message__sender_button',
    text: '[data-qa="message-text"], .c-message_kit__blocks, .p-rich_text_block',
    file: '[data-qa="file_name"], .c-file__title',
    avatar: 'img.c-base_icon, .c-message_kit__avatar img',
    listItem: '[data-item-key], .c-virtual_list__item',
    thread: '[data-qa="threads_flexpane"], .p-threads_flexpane, .p-flexpane',
  };
  const TS_RE = /^\d{9,}\.\d+$/;

  // Slack message timestamps are seconds; anything older than load is history.
  const startedAt = Date.now() / 1000 - 5;
  const seen = new Set();
  let primed = false;
  let timer = null;

  function messageTs(el) {
    const key = el.closest(SEL.listItem)?.dataset.itemKey;
    if (key && TS_RE.test(key)) return key;
    const tsEl = el.querySelector('[data-ts]');
    if (tsEl && TS_RE.test(tsEl.dataset.ts)) return tsEl.dataset.ts;
    return null;
  }

  // Consecutive messages from the same person omit the sender, so look back.
  function findInPrevious(el, selector) {
    const own = el.querySelector(selector);
    if (own) return own;
    let item = el.closest(SEL.listItem);
    for (let i = 0; item && i < 30; i++) {
      item = item.previousElementSibling;
      const found = item?.querySelector(selector);
      if (found) return found;
    }
    return null;
  }

  function channelName() {
    const title = document.title.replace(/^(\(\d+\)|\*|!)\s*/, '');
    const parts = title.includes(' | ') ? title.split(' | ').filter((p) => p !== 'Slack') : title.split(' - ');
    return (parts[0] || '').replace(/\s*\((Channel|DM|Group DM|Private channel)\)\s*$/i, '').trim();
  }

  function messageText(el) {
    const textEl = el.querySelector(SEL.text);
    let text = textEl ? textEl.innerText.trim() : '';
    const files = [...el.querySelectorAll(SEL.file)].map((f) => f.textContent.trim()).filter(Boolean);
    if (files.length) text = [text, ...files.map((f) => `[file] ${f}`)].filter(Boolean).join('\n');
    return text;
  }

  function send(payload) {
    try {
      chrome.runtime.sendMessage({ type: 'notification', payload }).catch(() => {});
    } catch {
      // Extension was reloaded; the background worker re-injects a fresh copy.
    }
  }

  function scan() {
    timer = null;
    for (const el of document.querySelectorAll(SEL.message)) {
      const ts = messageTs(el);
      if (!ts || seen.has(ts)) continue;

      const text = messageText(el);
      if (!text) continue; // still rendering; pick it up on the next mutation
      seen.add(ts);
      if (!primed || parseFloat(ts) < startedAt) continue;

      const sender = findInPrevious(el, SEL.sender)?.textContent.trim() || 'Unknown';
      const channel = channelName();
      const inThread = !!el.closest(SEL.thread);
      const where = channel ? ` in ${channel}${inThread ? ' (thread)' : ''}` : '';

      console.log('[relay] new message on page:', sender, '-', text);
      send({
        source: 'dom',
        title: `${sender}${where}`,
        body: text,
        icon: findInPrevious(el, SEL.avatar)?.src,
        tag: ts,
        url: location.href,
        pageTitle: document.title,
      });
    }
    primed = true;
  }

  const observer = new MutationObserver(() => {
    if (!timer) timer = setTimeout(scan, 400);
  });

  function start() {
    scan();
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    console.log('[relay] watching Slack page for new messages');
  }

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
}
