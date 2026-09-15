/**
 * Point Guard web app.
 *
 * Vanilla, no build step, no framework -- the actions/plans/memory shape.
 * Two jobs: show the book (every session point-guard is watching) and let a
 * human message point-guard and read the reply, with a small scrollback.
 *
 * No WebSocket -- point-guard has no WS surface exposed through this proxy,
 * and a 15-30s poll of a book that changes on a 60s tick is plenty fresh.
 */

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const BOOK_POLL_MS = 20_000;
let toastTimer;

/** Errors are shown, never swallowed -- see the note on `render` below. */
function toast(message, isError) {
  const t = $('#toast');
  t.textContent = message;
  t.classList.toggle('err', Boolean(isError));
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, isError ? 6000 : 3000);
}

async function api(path, init) {
  const res = await fetch(path, init);
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = {}; }
  if (!res.ok) {
    const detail = body.error || `request failed (${res.status})`;
    throw new Error(detail);
  }
  return body;
}

/**
 * Render a list, or the honest reason it is empty.
 *
 * `empty` and `error` are deliberately different strings. A book that
 * renders No sessions identically for there are none and point-guard
 * is unreachable is a check that cannot fail: the broken state and the
 * healthy-but-empty state would look identical.
 */
function render(container, items, build, empty) {
  container.replaceChildren();
  if (!items.length) {
    container.append(el('p', 'state', empty));
    return;
  }
  for (const item of items) container.append(build(item));
}

function showError(container, err) {
  container.replaceChildren();
  container.append(el('p', 'state error', `Could not load: ${err.message}`));
}

/* ---------------- relative time ---------------- */

function relativeTime(ms) {
  if (ms === null || ms === undefined) return null;
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return new Date(ms).toLocaleDateString();
}

/* ---------------- the book ---------------- */

/**
 * mergeTreeCheckedAt has two distinct meanings and they must never render
 * the same:
 *   - null: the merge-tree backstop has NEVER run for this session yet.
 *   - a timestamp: the backstop ran at that time and found no textual
 *     conflict as of then (point-guard own wording discipline: no
 *     textual conflict, never safe or clean -- merge-tree only proves
 *     the absence of a textual clash, not semantic compatibility).
 * Collapsing never checked and checked, nothing found into one all
 * clear state is exactly the bug class the backstop exists to catch, so
 * this UI does not reproduce it.
 */
function mergeTreeLabel(mergeTreeCheckedAt) {
  if (mergeTreeCheckedAt === null || mergeTreeCheckedAt === undefined) {
    return 'merge-tree: not yet checked';
  }
  return `merge-tree: last checked ${relativeTime(mergeTreeCheckedAt)}`;
}

function sessionRow(s) {
  const row = el('div', 'row');
  row.dataset.status = s.status;

  const head = el('div', 'row-head');
  head.append(el('span', `dot ${s.status}`), el('span', 'row-name', s.sessionId.slice(0, 12)));
  if (s.branch) head.append(el('span', 'row-branch', s.branch));
  row.append(head);

  if (s.repo) {
    const repoLine = s.worktree && s.worktree !== s.repo ? `${s.repo} — ${s.worktree}` : s.repo;
    row.append(el('div', 'row-repo', repoLine));
  } else {
    row.append(el('div', 'row-repo', 'no repo (non-code task)'));
  }

  const meta = el('div', 'row-meta');
  meta.append(el('span', null, s.status));
  meta.append(el('span', null, s.lastActivityAt === null
    ? 'no messages yet'
    : `last active ${relativeTime(s.lastActivityAt)}`));
  meta.append(el('span', null, mergeTreeLabel(s.mergeTreeCheckedAt)));
  row.append(meta);

  if (s.flaggedReason) row.append(el('div', 'row-flag', s.flaggedReason));

  return row;
}

async function loadBook() {
  const box = document.querySelector('#book');
  try {
    const data = await api('/api/book');
    const sessions = data.sessions || [];
    render(box, sessions, sessionRow, 'No sessions in the book.');
    document.querySelector('#book-meta').textContent = sessions.length
      ? `${sessions.length} session${sessions.length === 1 ? '' : 's'}`
      : '';
  } catch (err) {
    showError(box, err);
    document.querySelector('#book-meta').textContent = '';
  }
}

/* ---------------- message + history ---------------- */

function historyItem(m) {
  const item = el('div', 'hist-item');
  item.append(el('div', 'hist-q', m.message));
  item.append(el('div', 'hist-a', m.reply));
  item.append(el('div', 'hist-time', relativeTime(m.createdAt)));
  return item;
}

async function loadHistory() {
  const box = document.querySelector('#message-history');
  try {
    const data = await api('/api/message/history?limit=20');
    const messages = (data.messages || []).slice().reverse();
    render(box, messages, historyItem, 'No messages yet.');
  } catch (err) {
    showError(box, err);
  }
}

function setupMessageForm() {
  const form = document.querySelector('#message-form');
  const input = document.querySelector('#message-input');
  const send = document.querySelector('#message-send');
  const replyBox = document.querySelector('#message-reply');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const content = input.value.trim();
    if (!content) return;
    send.disabled = true;
    send.textContent = 'Sending…';
    try {
      const data = await api('/api/message', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      replyBox.textContent = data.reply;
      replyBox.hidden = false;
      input.value = '';
      loadHistory();
    } catch (err) {
      toast(err.message, true);
    } finally {
      send.disabled = false;
      send.textContent = 'Send';
    }
  });
}

/* ---------------- boot ---------------- */

setupMessageForm();
loadBook();
loadHistory();
setInterval(loadBook, BOOK_POLL_MS);
