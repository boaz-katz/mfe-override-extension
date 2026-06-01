// ── State ─────────────────────────────────────────────────────────────────────
let overrides    = [];
let nextId       = 1;
let detectedUrls = [];   // detected remoteEntry URLs for the current tab
let currentTabId = null;
let editingId    = null; // ID of the override currently being edited (null = add mode)

// ── Storage helpers ───────────────────────────────────────────────────────────
async function loadFromStorage() {
  const data = await chrome.storage.local.get(['overrides', 'nextId']);
  overrides = data.overrides ?? [];
  nextId    = data.nextId    ?? 1;
}

async function loadDetected() {
  if (currentTabId === null) {
    detectedUrls = [];
    return;
  }
  const { detected = {} } = await chrome.storage.local.get('detected');
  detectedUrls = detected[currentTabId] ?? [];
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

  countBadge.textContent = `${detectedUrls.length} found`;
  countBadge.className   = 'badge badge--active';
  list.innerHTML = detectedUrls.map((url) => buildDetectedItemHTML(url)).join('');
}

function buildDetectedItemHTML(url) {
  const alreadyConfigured = overrides.some((o) => o.originalUrl === url);
  const action = alreadyConfigured
    ? `<span class="badge badge--configured">Configured</span>`
    : `<button class="btn-use" data-action="use-detected" data-url="${esc(url)}">Override</button>`;

  return `
    <div class="detected-item">
      <span class="detected-url" title="${esc(url)}">${esc(url)}</span>
      ${action}
    </div>
  `;
}

// Event delegation for the detected list's "Override" buttons.
document.getElementById('detected-list').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action="use-detected"]');
  if (btn) preloadOverride(btn.dataset.url);
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
  if (e.target.dataset.action === 'edit')   openEditForm(id);
});

// ── Add-form logic ────────────────────────────────────────────────────────────
const addBtn    = document.getElementById('add-btn');
const addForm   = document.getElementById('add-form');
const saveBtn   = document.getElementById('save-btn');
const cancelBtn = document.getElementById('cancel-btn');
const formError = document.getElementById('form-error');

addBtn.addEventListener('click', () => {
  addBtn.hidden  = true;
  addForm.hidden = false;
  document.getElementById('form-name').focus();
});

cancelBtn.addEventListener('click', resetForm);

saveBtn.addEventListener('click', () => {
  const name        = document.getElementById('form-name').value.trim();
  const originalUrl = document.getElementById('form-original').value.trim();
  const overrideUrl = document.getElementById('form-override').value.trim();

  if (!name || !originalUrl || !overrideUrl) {
    formError.textContent = 'All fields are required.';
    return;
  }
  if (!isValidUrl(originalUrl)) {
    formError.textContent = 'Original URL is not a valid URL.';
    return;
  }
  if (!isValidUrl(overrideUrl)) {
    formError.textContent = 'Override URL is not a valid URL.';
    return;
  }

  if (editingId !== null) {
    // Update mode — patch the existing override in place
    const o = overrides.find((x) => x.id === editingId);
    if (o) {
      o.name        = name;
      o.originalUrl = originalUrl;
      o.overrideUrl = overrideUrl;
    }
  } else {
    // Add mode — create a new override
    overrides.push({ id: nextId++, name, originalUrl, overrideUrl, enabled: true });
  }
  saveToStorage();
  render();
  resetForm();
});

// Ctrl/Cmd+Enter submits; Escape cancels.
addForm.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) saveBtn.click();
  if (e.key === 'Escape') cancelBtn.click();
});

function resetForm() {
  editingId = null;
  addForm.hidden = true;
  addBtn.hidden  = false;
  document.getElementById('form-name').value     = '';
  document.getElementById('form-original').value = '';
  document.getElementById('form-override').value = '';
  formError.textContent  = '';
  saveBtn.textContent    = 'Save';
}

// ── Edit an existing override ─────────────────────────────────────────────────

/**
 * Open the form pre-filled with an existing override's values so the user
 * can change any field.  Saving will update the override in place.
 */
function openEditForm(id) {
  const o = overrides.find((x) => x.id === id);
  if (!o) return;

  editingId = id;
  addBtn.hidden  = true;
  addForm.hidden = false;

  document.getElementById('form-name').value     = o.name;
  document.getElementById('form-original').value = o.originalUrl;
  document.getElementById('form-override').value = o.overrideUrl;
  formError.textContent = '';
  saveBtn.textContent   = 'Update';

  document.getElementById('form-override').focus();
  addForm.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ── Pre-load form from a detected URL ─────────────────────────────────────────

/**
 * Open the add-override form pre-filled with data inferred from a detected URL.
 * The user only needs to type the Override URL and press Save.
 */
function preloadOverride(originalUrl) {
  addBtn.hidden  = true;
  addForm.hidden = false;

  document.getElementById('form-name').value     = guessRemoteName(originalUrl);
  document.getElementById('form-original').value = originalUrl;
  document.getElementById('form-override').value = '';
  formError.textContent = '';

  // Focus the one field the user still needs to fill in.
  const overrideInput = document.getElementById('form-override');
  overrideInput.focus();

  // Scroll the form into view in case the popup is tall.
  addForm.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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
  renderDetected();
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
