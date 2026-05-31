// ── State ─────────────────────────────────────────────────────────────────────
let overrides = [];
let nextId = 1;

// ── Storage helpers ───────────────────────────────────────────────────────────
async function loadFromStorage() {
  const data = await chrome.storage.local.get(['overrides', 'nextId']);
  overrides = data.overrides ?? [];
  nextId    = data.nextId    ?? 1;
}

async function saveToStorage() {
  await chrome.storage.local.set({ overrides, nextId });
  // Also tell the background to apply rules immediately (belt-and-suspenders
  // alongside the storage.onChanged listener in background.js).
  chrome.runtime.sendMessage({ type: 'APPLY_RULES' }).catch(() => {
    // Service worker may have been sleeping; storage.onChanged will wake it.
  });
}

// ── Rendering ─────────────────────────────────────────────────────────────────
function render() {
  const list       = document.getElementById('override-list');
  const emptyState = document.getElementById('empty-state');

  if (overrides.length === 0) {
    list.innerHTML = '';
    emptyState.hidden = false;
  } else {
    emptyState.hidden = true;
    list.innerHTML = overrides.map((o) => buildItemHTML(o)).join('');
  }

  renderBadge();
}

function buildItemHTML(o) {
  const checked  = o.enabled ? 'checked' : '';
  const disabled = o.enabled ? '' : ' is-disabled';
  return `
    <div class="override-item${disabled}" data-id="${o.id}" role="listitem">
      <label class="toggle" title="${o.enabled ? 'Disable' : 'Enable'} override">
        <input type="checkbox" ${checked} data-action="toggle" />
        <span class="slider"></span>
      </label>
      <div class="override-info">
        <div class="override-name">${esc(o.name)}</div>
        <div class="override-urls">
          <span class="url" title="${esc(o.originalUrl)}">${esc(o.originalUrl)}</span>
          <span class="arrow">&#8594;</span>
          <span class="url override-url" title="${esc(o.overrideUrl)}">${esc(o.overrideUrl)}</span>
        </div>
      </div>
      <button class="btn-remove" data-action="remove" title="Remove override">&#215;</button>
    </div>
  `;
}

function renderBadge() {
  const count  = overrides.filter((o) => o.enabled).length;
  const badge  = document.getElementById('active-badge');
  if (count > 0) {
    badge.textContent = `${count} active`;
    badge.className   = 'badge badge--active';
  } else {
    badge.textContent = 'none active';
    badge.className   = 'badge badge--inactive';
  }
}

// HTML-escape to prevent XSS when injecting user-supplied strings into innerHTML
function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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

// ── Event delegation on the list ─────────────────────────────────────────────
document.getElementById('override-list').addEventListener('change', (e) => {
  if (e.target.dataset.action === 'toggle') {
    const item = e.target.closest('[data-id]');
    if (item) toggleOverride(Number(item.dataset.id));
  }
});

document.getElementById('override-list').addEventListener('click', (e) => {
  if (e.target.dataset.action === 'remove') {
    const item = e.target.closest('[data-id]');
    if (item) removeOverride(Number(item.dataset.id));
  }
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

  overrides.push({ id: nextId++, name, originalUrl, overrideUrl, enabled: true });
  saveToStorage();
  render();
  resetForm();
});

// Also allow Ctrl+Enter / Cmd+Enter inside the form to save quickly
addForm.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) saveBtn.click();
  if (e.key === 'Escape') cancelBtn.click();
});

function resetForm() {
  addForm.hidden = true;
  addBtn.hidden  = false;
  document.getElementById('form-name').value     = '';
  document.getElementById('form-original').value = '';
  document.getElementById('form-override').value = '';
  formError.textContent = '';
}

function isValidUrl(str) {
  try {
    new URL(str);
    return true;
  } catch {
    return false;
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────
loadFromStorage().then(render);
