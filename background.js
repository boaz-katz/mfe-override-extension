// Resource types to intercept: remoteEntry.json (xmlhttprequest) + JS chunks
// (script) + any other assets the MFE might serve (other).
const RESOURCE_TYPES = ['xmlhttprequest', 'script', 'other'];

// ── URL helpers ───────────────────────────────────────────────────────────────

/**
 * Return everything up to and including the last "/" in a URL.
 * e.g. "https://staging.app.com/sidebar/remoteEntry.json"
 *   →  "https://staging.app.com/sidebar/"
 */
function getBaseUrl(url) {
  const i = url.lastIndexOf('/');
  return i >= 0 ? url.slice(0, i + 1) : url + '/';
}

/**
 * Escape a plain string so it can be used as a literal inside a RE2 regex.
 * declarativeNetRequest uses RE2 syntax (same as Chrome's regexp engine).
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Override rules ────────────────────────────────────────────────────────────

/**
 * Reads overrides from storage and syncs them to declarativeNetRequest dynamic rules.
 * Also updates the toolbar badge and icon colour.
 *
 * Each rule uses regexFilter + regexSubstitution so the entire base-path subtree
 * of the original URL is redirected — not just remoteEntry.json itself — so JS
 * chunks and other assets served alongside it are also covered.
 *
 * The redirect is direction-agnostic: original and override can be any URL
 * (staging, production, localhost, or anything else).
 *
 * Example — staging → local:
 *   originalBase  https://staging.app.com/sidebar/
 *   overrideBase  http://localhost:4302/
 *   regexFilter         ^https://staging\.app\.com/sidebar/(.*)$
 *   regexSubstitution   http://localhost:4302/\1
 *
 * Example — local → staging (reverse):
 *   originalBase  http://localhost:4302/
 *   overrideBase  https://staging.app.com/sidebar/
 *   regexFilter         ^http://localhost:4302/(.*)$
 *   regexSubstitution   https://staging.app.com/sidebar/\1
 */
// Guard against concurrent calls (startup + storage change + popup message can
// all fire at the same moment).  Without this, two concurrent executions both
// read the same existing rule IDs, both try to add rules with those same IDs,
// and Chrome throws "Rule with id N does not have a unique ID".
let applyRulesInFlight = false;

async function applyRules() {
  if (applyRulesInFlight) {
    console.log('[MFE Override] applyRules() already in progress — skipping concurrent call');
    return;
  }
  applyRulesInFlight = true;
  console.log('[MFE Override] applyRules() called');

  try {
    const { overrides = [] } = await chrome.storage.local.get('overrides');
    console.log(`[MFE Override] Overrides loaded from storage (${overrides.length} total):`, overrides);

    // ── Step 1: get every existing dynamic rule ID ────────────────────────
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    const removeRuleIds = existing.map((r) => r.id);
    console.log(`[MFE Override] Step 1 — existing rule IDs: [${removeRuleIds.join(', ') || 'none'}]`);

    // ── Step 2: remove them all and WAIT for completion ───────────────────
    if (removeRuleIds.length > 0) {
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds });
      console.log(`[MFE Override] Step 2 — removed ${removeRuleIds.length} rule(s)`);
    } else {
      console.log('[MFE Override] Step 2 — no existing rules to remove');
    }

    // ── Step 3: build and add the new rules ───────────────────────────────
    const enabledOverrides = overrides.filter((o) => o.enabled);
    console.log(`[MFE Override] Enabled overrides: ${enabledOverrides.length} of ${overrides.length}`);

    const addRules = enabledOverrides.map((o) => {
      const originalBase = getBaseUrl(o.originalUrl);
      const overrideBase = getBaseUrl(o.overrideUrl);

      // Forward rule only: original base → override base
      // e.g. https://staging.app.com/sidebar/* → http://localhost:4302/*
      // A reverse rule would create an infinite redirect loop, so we rely on
      // inject.js (fetch/XHR patch) for the actual redirect, and Native Federation
      // infers the chunk base URL from where remoteEntry.json was served.
      const forwardRule = {
        id: o.id,
        priority: 1,
        action: {
          type: 'redirect',
          redirect: { regexSubstitution: overrideBase + '\\1' },
        },
        condition: {
          regexFilter: `^${escapeRegex(originalBase)}(.*)$`,
          resourceTypes: RESOURCE_TYPES,
        },
      };

      console.log(`[MFE Override] Rule for "${o.name}":`, {
        id: forwardRule.id,
        regexFilter: forwardRule.condition.regexFilter,
        regexSubstitution: forwardRule.action.redirect.regexSubstitution,
      });

      return forwardRule;
    });

    if (addRules.length > 0) {
      await chrome.declarativeNetRequest.updateDynamicRules({ addRules });
      console.log(`[MFE Override] Step 3 — added ${addRules.length} rule(s)`);
    } else {
      console.log('[MFE Override] Step 3 — no enabled overrides, nothing to add');
    }

    updateBadge(enabledOverrides.length);
    updateIcon(enabledOverrides.length > 0);
  } catch (err) {
    console.error('[MFE Override] applyRules() failed:', err);
  } finally {
    applyRulesInFlight = false;
  }
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

// ── Detected remotes ──────────────────────────────────────────────────────────

/**
 * Strip query-string and hash so cache-busting timestamps in Native Federation
 * URLs (e.g. remoteEntry.json?t=1748000000000) are discarded before storage.
 */
function canonicalUrl(raw) {
  try {
    const u = new URL(raw);
    u.search = '';
    u.hash   = '';
    return u.toString();
  } catch {
    return raw;
  }
}

/**
 * Append a newly detected remoteEntry URL for a given tab (deduplicated).
 * The detected map is keyed by tab ID so each tab has its own list.
 */
async function addDetectedRemote(tabId, url) {
  const { detected = {} } = await chrome.storage.local.get('detected');
  const existing = detected[tabId] ?? [];
  if (existing.includes(url)) return; // already known
  detected[tabId] = [...existing, url];
  await chrome.storage.local.set({ detected });
  console.log(`[MFE Override] Detected remote: ${url} (tab ${tabId})`);
}

/** Remove all detected URLs for a tab (called on navigation or tab close). */
async function clearDetectedForTab(tabId) {
  const { detected = {} } = await chrome.storage.local.get('detected');
  if (!(tabId in detected)) return;
  delete detected[tabId];
  await chrome.storage.local.set({ detected });
}

// ── Message listener ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'APPLY_RULES') {
    // Sent by the popup after saving overrides so rules update immediately,
    // in addition to the storage.onChanged listener below.
    applyRules()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // keep channel open for async response
  }

  if (message.type === 'DETECTED_REMOTE') {
    // Sent by the content script when it observes a remoteEntry.json request
    // via PerformanceObserver.  sender.tab.id tells us which tab it came from.
    const tabId = sender.tab?.id;
    if (tabId != null && message.url) {
      console.log(`[MFE Override] DETECTED_REMOTE message received — tab ${tabId}: ${message.url}`);
      addDetectedRemote(tabId, message.url).catch((err) => {
        console.error('[MFE Override] addDetectedRemote failed:', err);
      });
    }
  }
});

// ── Tab lifecycle ─────────────────────────────────────────────────────────────

// Clear the detected list for a tab as soon as it starts a new navigation
// so stale remotes from the previous page are never shown.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    clearDetectedForTab(tabId).catch(() => {});
  }
});

// Clean up storage when a tab is closed entirely.
chrome.tabs.onRemoved.addListener((tabId) => {
  clearDetectedForTab(tabId).catch(() => {});
});

// ── Storage change listener ───────────────────────────────────────────────────

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.overrides) {
    console.log('[MFE Override] Storage changed — re-applying rules');
    applyRules();
  }
});

// ── Startup ───────────────────────────────────────────────────────────────────

console.log('[MFE Override] Service worker started');
applyRules();
