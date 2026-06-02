// ── State ─────────────────────────────────────────────────────────────────────
let overrides       = [];
let nextId          = 1;
let detectedUrls    = [];   // detected remoteEntry URLs for the current tab
let detectedRemotes = [];   // { url, name }[] — name fetched from each remoteEntry.json
let currentTabId    = null;

// ── Storage helpers ───────────────────────────────────────────────────────────
async function loadFromStorage() {
  const data = await chrome.storage.local.get(['overrides', 'nextId']);
  overrides = data.overrides ?? [];
  nextId    = data.nextId    ?? 1;
}

async function loadDetected() {
  if (currentTabId === null) {
    detectedUrls = [];
    detectedRemotes = [];
    return;
  }
  const { detected = {} } = await chrome.storage.local.get('detected');
  detectedUrls = detected[currentTabId] ?? [];

  // If storage is empty the background service worker may have been sleeping
  // when the page loaded and the DETECTED_REMOTE messages were dropped.
  // Ask the content script directly — it keeps its own in-memory reported set.
  if (detectedUrls.length === 0) {
    try {
      const resp = await chrome.tabs.sendMessage(currentTabId, { type: 'REQUEST_DETECTED' });
      if (resp?.urls?.length) {
        detectedUrls = resp.urls;
        // Persist so live-update via storage.onChanged works going forward.
        const { detected: d = {} } = await chrome.storage.local.get('detected');
        d[currentTabId] = detectedUrls;
        chrome.storage.local.set({ detected: d });
      }
    } catch {
      // Content script not present on this page (e.g. chrome:// URL) — ignore.
    }
  }

  detectedRemotes = await resolveRemoteNames(detectedUrls);
}

/** Fetch each remoteEntry.json and read the federation `name` field. */
async function resolveRemoteNames(urls) {
  return Promise.all(urls.map(async (url) => {
    try {
      const resp = await fetch(url);
      const json = await resp.json();
      return { url, name: json.name || guessRemoteName(url) };
    } catch {
      return { url, name: guessRemoteName(url) };
    }
  }));
}


async function saveToStorage() {
  await chrome.storage.local.set({ overrides, nextId });
  // Tell the background to apply rules immediately, in addition to the
  // storage.onChanged listener already present in background.js.
  chrome.runtime.sendMessage({ type: 'APPLY_RULES' }).catch(() => {});
}

// ── Tab resolution ────────────────────────────────────────────────────────────
async function resolveCurrentTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTabId = tab?.id ?? null;
  } catch {
    currentTabId = null;
  }
}

// ── Rendering ─────────────────────────────────────────────────────────────────
function render() {
  renderDetected();
  renderOverrides();
  renderBadge();
}

// ── Detected section ──────────────────────────────────────────────────────────
function renderDetected() {
  const list         = document.getElementById('detected-list');
  const countBadge   = document.getElementById('detected-count');

  if (currentTabId === null) {
    countBadge.textContent = '—';
    countBadge.className   = 'badge badge--inactive';
    list.innerHTML = `<div class="detected-empty">Open a regular page to start detecting remotes.</div>`;
    return;
  }

  if (detectedUrls.length === 0) {
    countBadge.textContent = 'scanning';
    countBadge.className   = 'badge badge--inactive';
    list.innerHTML = `
      <div class="detected-scanning">
        <span class="dot-pulse"></span>
        Waiting for remoteEntry.json requests&hellip;
      </div>`;
    return;
  }

  const unmatched = detectedRemotes.filter(
    (r) => !overrides.some((o) => o.originalUrl === r.url)
  );

  countBadge.textContent = `${unmatched.length} found`;
  countBadge.className   = unmatched.length > 0 ? 'badge badge--active' : 'badge badge--inactive';
  list.innerHTML = unmatched.map((r) => buildDetectedItemHTML(r)).join('');
}

function buildDetectedItemHTML({ url, name }) {
  return `
    <div class="detected-item">
      <div class="detected-info">
        <span class="detected-name">${esc(name)}</span>
        <span class="detected-url" title="${esc(url)}">${esc(url)}</span>
      </div>
      <button class="btn-use" data-action="use-detected" data-url="${esc(url)}">Override</button>
    </div>
  `;
}

// Event delegation for the detected list's "Override" buttons.
document.getElementById('detected-list').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action="use-detected"]');
  if (btn) openInlineAddForm(btn.dataset.url, btn.closest('.detected-item'));
});

// ── Override section ──────────────────────────────────────────────────────────
function renderOverrides() {
  const list       = document.getElementById('override-list');
  const emptyState = document.getElementById('empty-state');

  if (overrides.length === 0) {
    list.innerHTML    = '';
    emptyState.hidden = false;
  } else {
    emptyState.hidden = true;
    list.innerHTML    = overrides.map((o) => buildItemHTML(o)).join('');
  }
}

/** Mirror of the helper in background.js — derive the base path from a URL. */
function getBaseUrl(url) {
  const i = url.lastIndexOf('/');
  return i >= 0 ? url.slice(0, i + 1) : url + '/';
}

function buildItemHTML(o) {
  const checked  = o.enabled ? 'checked' : '';
  const disabled = o.enabled ? '' : ' is-disabled';
  // Show the base-path pattern that is actually intercepted (…/*) so the user
  // can see at a glance that all chunks — not just remoteEntry.json — redirect.
  const fromPattern = esc(getBaseUrl(o.originalUrl)) + '*';
  const toPattern   = esc(getBaseUrl(o.overrideUrl))  + '*';
  return `
    <div class="override-item${disabled}" data-id="${o.id}" role="listitem">
      <label class="toggle" title="${o.enabled ? 'Disable' : 'Enable'} override">
        <input type="checkbox" ${checked} data-action="toggle" />
        <span class="slider"></span>
      </label>
      <div class="override-info">
        <div class="override-name">${esc(o.name)}</div>
        <div class="override-urls">
          <span class="url" title="${fromPattern}">${fromPattern}</span>
          <span class="arrow">&#8594;</span>
          <span class="url override-url" title="${toPattern}">${toPattern}</span>
        </div>
      </div>
      <button class="btn-edit"   data-action="edit"   title="Edit override">&#9998;</button>
      <button class="btn-remove" data-action="remove" title="Remove override">&#215;</button>
    </div>
  `;
}

function renderBadge() {
  const count = overrides.filter((o) => o.enabled).length;
  const badge = document.getElementById('active-badge');
  if (count > 0) {
    badge.textContent = `${count} active`;
    badge.className   = 'badge badge--active';
  } else {
    badge.textContent = 'none active';
    badge.className   = 'badge badge--inactive';
  }
}

// ── Override actions ──────────────────────────────────────────────────────────
function toggleOverride(id) {
  const o = overrides.find((x) => x.id === id);
  if (!o) return;
  o.enabled = !o.enabled;
  saveToStorage();
  render();
}

function removeOverride(id) {
  overrides = overrides.filter((x) => x.id !== id);
  saveToStorage();
  render();
}

// ── Event delegation on the override list ─────────────────────────────────────
document.getElementById('override-list').addEventListener('change', (e) => {
  if (e.target.dataset.action === 'toggle') {
    const item = e.target.closest('[data-id]');
    if (item) toggleOverride(Number(item.dataset.id));
  }
});

document.getElementById('override-list').addEventListener('click', (e) => {
  const item = e.target.closest('[data-id]');
  if (!item) return;
  const id = Number(item.dataset.id);
  if (e.target.dataset.action === 'remove') removeOverride(id);
  if (e.target.dataset.action === 'edit')   openInlineEditForm(id, item);
});

// ── Inline form ───────────────────────────────────────────────────────────────
// One inline form can be open at a time.  It is inserted directly after the
// item that triggered it (detected-item or override-item) and removed on
// save or cancel.

let inlineFormState = null; // { mode: 'add'|'edit', originalUrl?, editId? }

function closeInlineForm() {
  document.querySelector('.inline-form')?.remove();
  inlineFormState = null;
}

function openInlineAddForm(originalUrl, anchorEl) {
  closeInlineForm();
  inlineFormState = { mode: 'add', originalUrl };
  const formEl = buildInlineFormEl('');
  anchorEl.after(formEl);
  formEl.querySelector('.inline-override-input').focus();
}

function openInlineEditForm(id, anchorEl) {
  closeInlineForm();
  const o = overrides.find((x) => x.id === id);
  if (!o) return;
  inlineFormState = { mode: 'edit', editId: id };
  const formEl = buildInlineFormEl(o.overrideUrl);
  anchorEl.after(formEl);
  formEl.querySelector('.inline-override-input').focus();
}

function buildInlineFormEl(existingValue) {
  const div = document.createElement('div');
  div.className = 'inline-form';
  div.innerHTML = `
    <input class="form-input inline-override-input" type="url"
           value="${esc(existingValue)}"
           placeholder="http://localhost:4301/remoteEntry.json" autocomplete="off" />
    <p class="form-error inline-form-error" aria-live="polite"></p>
    <div class="form-actions">
      <button class="btn btn--primary inline-save-btn">Save &amp; Reload</button>
      <button class="btn btn--ghost inline-cancel-btn">Cancel</button>
    </div>
  `;
  div.querySelector('.inline-cancel-btn').addEventListener('click', closeInlineForm);
  div.querySelector('.inline-save-btn').addEventListener('click', () => saveInlineForm(div));
  div.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) saveInlineForm(div);
    if (e.key === 'Escape') closeInlineForm();
  });
  return div;
}

function saveInlineForm(formEl) {
  const overrideUrl = formEl.querySelector('.inline-override-input').value.trim();
  const errorEl     = formEl.querySelector('.inline-form-error');

  if (!overrideUrl) { errorEl.textContent = 'Override URL is required.'; return; }
  if (!isValidUrl(overrideUrl)) { errorEl.textContent = 'Not a valid URL.'; return; }

  if (inlineFormState.mode === 'add') {
    const { originalUrl } = inlineFormState;
    const name = detectedRemotes.find((r) => r.url === originalUrl)?.name
                 ?? guessRemoteName(originalUrl);
    overrides.push({ id: nextId++, name, originalUrl, overrideUrl, enabled: true });
  } else {
    const o = overrides.find((x) => x.id === inlineFormState.editId);
    if (o) o.overrideUrl = overrideUrl;
  }

  saveToStorage();
  closeInlineForm();
  render();
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    chrome.tabs.reload(tab.id);
  });
}

/**
 * Derive a human-readable remote name from the URL path.
 * e.g. https://staging.app.com/map/remoteEntry.json  →  "map"
 *      https://staging.app.com/remoteEntry.json       →  "remote"
 */
function guessRemoteName(url) {
  try {
    const parts = new URL(url).pathname
      .split('/')
      .filter(Boolean)
      .map((s) => s.toLowerCase());

    const idx = parts.findIndex((p) => p.startsWith('remoteentry'));
    // Use the segment immediately before remoteEntry.json, if one exists.
    if (idx > 0) return parts[idx - 1];
    // Fallback: first path segment (might be the only one).
    if (parts.length > 0 && !parts[0].startsWith('remoteentry')) return parts[0];
  } catch {
    // URL parse failed
  }
  return '';
}

// ── Live updates while the popup is open ──────────────────────────────────────
// When the content script detects a new remote on the active tab, the
// background writes to storage. This listener re-renders the detected section
// without requiring the user to close and reopen the popup.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.detected || currentTabId === null) return;
  const allDetected = changes.detected.newValue ?? {};
  detectedUrls = allDetected[currentTabId] ?? [];
  resolveRemoteNames(detectedUrls).then((remotes) => {
    detectedRemotes = remotes;
    renderDetected();
  });
});

// ── Utilities ─────────────────────────────────────────────────────────────────
function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isValidUrl(str) {
  try { new URL(str); return true; } catch { return false; }
}

// ── Boot ──────────────────────────────────────────────────────────────────────
Promise.all([
  resolveCurrentTab(),
  loadFromStorage(),
]).then(async () => {
  await loadDetected();
  render();
});
