/**
 * content.js — runs in the default ISOLATED world at document_start
 *
 * Has access to chrome.* APIs.  Cannot directly touch the page's window.fetch
 * because isolated-world scripts run in a separate JS context.
 *
 * Responsibilities:
 *  1. Load overrides from chrome.storage.local and forward them to inject.js
 *     (MAIN world) via a DOM CustomEvent so inject.js can rewrite fetch calls.
 *  2. Keep inject.js up-to-date when the user saves changes while the page is open.
 *  3. Detect remoteEntry.json requests via PerformanceObserver and report them
 *     to the background service worker so the popup can display them.
 */
(function () {
  'use strict';

  // ── Forward overrides to inject.js ────────────────────────────────────────────

  function dispatchRules(overrides, eventName) {
    const enabled = (overrides || []).filter((o) => o.enabled);
    document.dispatchEvent(new CustomEvent(eventName, { detail: enabled }));
    console.log(`[MFE Override] content: dispatched "${eventName}" — ${enabled.length} enabled rule(s)`);
  }

  // Initial load — dispatch as soon as storage resolves (typically < 1 ms).
  chrome.storage.local.get('overrides')
    .then(({ overrides = [] }) => {
      dispatchRules(overrides, '__MFEOverride_rules__');
    })
    .catch((err) => {
      console.error('[MFE Override] content: failed to load overrides:', err);
      // Dispatch an empty-rules event so inject.js resolves its overridesReady
      // promise and does not hang waiting for an event that never comes.
      document.dispatchEvent(new CustomEvent('__MFEOverride_rules__', { detail: [] }));
    });

  // Live updates — push to inject.js whenever the user saves in the popup.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.overrides) {
      dispatchRules(changes.overrides.newValue, '__MFEOverride_rulesUpdate__');
    }
  });

  // ── Detect remoteEntry.json via PerformanceObserver ───────────────────────────

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

  // Deduplicate within this page session.
  const reported = new Set();

  function report(raw) {
    const url = canonicalUrl(raw);
    if (reported.has(url)) return;
    reported.add(url);
    console.log('[MFE Override] content: detected remoteEntry —', url);
    try {
      chrome.runtime.sendMessage({ type: 'DETECTED_REMOTE', url }).catch(() => {
        // Background service worker may still be waking up; suppress the error.
      });
    } catch {
      // Extension context invalidated (e.g. extension reloaded while page is open).
    }
  }

  // Popup can ask the content script directly for its in-memory detected list.
  // This is the fallback when the background service worker was sleeping during
  // detection and the DETECTED_REMOTE messages were silently dropped.
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'REQUEST_DETECTED') {
      sendResponse({ urls: [...reported] });
    }
  });

  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (/\/remoteEntry\.json(\?|#|$)/.test(entry.name)) {
          report(entry.name);
        }
      }
    });
    // buffered: true delivers entries already in the buffer at observe() time,
    // catching fetches that completed before this script was injected.
    observer.observe({ type: 'resource', buffered: true });
    console.log('[MFE Override] content: PerformanceObserver attached');
  } catch (err) {
    console.warn('[MFE Override] content: PerformanceObserver unavailable —', err);
  }
})();
