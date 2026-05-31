// Resource types that cover remoteEntry.json fetches (fetch() maps to xmlhttprequest)
const RESOURCE_TYPES = ['xmlhttprequest', 'script', 'other'];

/**
 * Reads overrides from storage and syncs them to declarativeNetRequest dynamic rules.
 * Also updates the toolbar badge and icon colour.
 */
async function applyRules() {
  const { overrides = [] } = await chrome.storage.local.get('overrides');

  // Remove all current dynamic rules
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map((r) => r.id);

  // Build rules only for enabled overrides
  const enabledOverrides = overrides.filter((o) => o.enabled);
  const addRules = enabledOverrides.map((o) => ({
    id: o.id,
    priority: 1,
    action: {
      type: 'redirect',
      redirect: { url: o.overrideUrl },
    },
    condition: {
      // Leading | anchors the start of the URL; no trailing | so query-string
      // cache-busting (e.g. ?t=1234) added by Native Federation still matches.
      urlFilter: `|${o.originalUrl}`,
      resourceTypes: RESOURCE_TYPES,
    },
  }));

  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });

  const count = enabledOverrides.length;
  updateBadge(count);
  updateIcon(count > 0);
}

function updateBadge(count) {
  if (count > 0) {
    chrome.action.setBadgeText({ text: String(count) });
    chrome.action.setBadgeBackgroundColor({ color: '#22c55e' });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}

/**
 * Draws a tiny "M" icon using OffscreenCanvas so the toolbar icon turns
 * green when overrides are active and grey when none are active.
 */
function updateIcon(active) {
  try {
    const size = 19;
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext('2d');

    // Rounded-rectangle background
    const r = 3;
    ctx.fillStyle = active ? '#22c55e' : '#64748b';
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.lineTo(size - r, 0);
    ctx.arcTo(size, 0, size, r, r);
    ctx.lineTo(size, size - r);
    ctx.arcTo(size, size, size - r, size, r);
    ctx.lineTo(r, size);
    ctx.arcTo(0, size, 0, size - r, r);
    ctx.lineTo(0, r);
    ctx.arcTo(0, 0, r, 0, r);
    ctx.closePath();
    ctx.fill();

    // "M" label
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('M', size / 2, size / 2 + 1);

    chrome.action.setIcon({ imageData: ctx.getImageData(0, 0, size, size) });
  } catch (_) {
    // OffscreenCanvas unavailable – silently fall back to default icon
  }
}

// ── Message listener ──────────────────────────────────────────────────────────
// The popup sends APPLY_RULES after saving so rules update immediately even
// if the storage.onChanged event fires slightly later.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'APPLY_RULES') {
    applyRules()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // keep message channel open for async response
  }
});

// Re-apply whenever overrides change (handles multi-popup or DevTools edits)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.overrides) {
    applyRules();
  }
});

// Restore rules when the service worker starts (e.g. after browser restart)
applyRules();
