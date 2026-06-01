/**
 * inject.js — runs in world: "MAIN" at document_start
 *
 * This script executes in the same JavaScript context as the page itself,
 * so patching window.fetch here actually intercepts the app's fetch calls.
 *
 * It has NO access to chrome.* APIs.  Overrides are received from content.js
 * (the isolated-world companion script) via a DOM CustomEvent.
 */
(function () {
  'use strict';

  // ── Overrides state ───────────────────────────────────────────────────────────

  // null  = not yet received from the isolated world
  // []    = received; no overrides configured
  // [...] = received; one or more enabled overrides
  let overrides = null;

  // Any fetch() call that fires before overrides arrive awaits this promise.
  // It resolves either when overrides are received, or after a 3 s safety
  // timeout (prevents the page hanging if something goes wrong in content.js).
  let resolveReady;
  const overridesReady = Promise.race([
    new Promise((res) => { resolveReady = res; }),
    new Promise((res) => setTimeout(() => {
      if (overrides === null) {
        console.warn('[MFE Override] inject: overrides not received within 3 s — proceeding without redirect');
        overrides = [];
      }
      res();
    }, 3000)),
  ]);

  // Initial delivery from content.js
  document.addEventListener('__MFEOverride_rules__', (e) => {
    overrides = Array.isArray(e.detail) ? e.detail : [];
    resolveReady();
    console.log('[MFE Override] inject: received overrides —', overrides.length, 'enabled rule(s)', overrides);
    setupImportMapMirror(overrides);
  });

  // Live updates when the user edits overrides while the page is open
  document.addEventListener('__MFEOverride_rulesUpdate__', (e) => {
    overrides = Array.isArray(e.detail) ? e.detail : [];
    console.log('[MFE Override] inject: overrides updated —', overrides.length, 'enabled rule(s)');
  });

  // ── Import map scope mirroring ────────────────────────────────────────────────
  // Problem: inject.js redirects fetch('localhost:4301/Mount.js') by changing the
  // URL to 'localhost:4304/Mount.js'.  The browser records the module URL as
  // localhost:4304 (response.url).  But NF's import map has shared-package scopes
  // keyed to localhost:4301.  Modules at localhost:4304 can't see that scope, so
  // bare specifier imports inside them fail with "Unable to resolve specifier".
  //
  // Fix: patch importShim.addImportMap so that whenever NF adds a scope for the
  // original base URL, we simultaneously add the same entries under the override
  // base URL.  This makes every shared package resolvable from both hosts.

  function setupImportMapMirror(activeOverrides) {
    if (!activeOverrides || !activeOverrides.length) return;

    function patchShim(shim) {
      if (!shim || shim.__mfeOverridePatchedImportMap) return;
      shim.__mfeOverridePatchedImportMap = true;

      const orig = shim.addImportMap.bind(shim);
      shim.addImportMap = function mfeAddImportMap(map) {
        orig(map);
        if (!map || !map.scopes) return;
        const extra = {};
        for (const o of activeOverrides) {
          const src = getBaseUrl(o.originalUrl);
          const dst = getBaseUrl(o.overrideUrl);
          if (map.scopes[src]) extra[dst] = { ...map.scopes[src] };
        }
        if (Object.keys(extra).length) orig({ scopes: extra });
      };
      console.log('[MFE Override] inject: importShim.addImportMap patched for scope mirroring');
    }

    if (window.importShim) {
      patchShim(window.importShim);
    } else {
      // importShim not yet set — intercept the assignment
      try {
        Object.defineProperty(window, 'importShim', {
          configurable: true,
          set(v) {
            // Restore as a normal writable property, then patch
            Object.defineProperty(window, 'importShim', { value: v, writable: true, configurable: true });
            patchShim(v);
          },
        });
      } catch (_) {
        // defineProperty not supported in this context — skip mirroring
      }
    }
  }

  // ── URL helpers ───────────────────────────────────────────────────────────────

  function getBaseUrl(url) {
    const i = url.lastIndexOf('/');
    return i >= 0 ? url.slice(0, i + 1) : url + '/';
  }

  /**
   * Check whether url matches any enabled override.
   * Returns the rewritten URL string, or null if no override applies.
   */
  function applyOverride(url) {
    if (!overrides || overrides.length === 0) return null;
    for (const o of overrides) {
      if (!o.enabled) continue;
      const originalBase = getBaseUrl(o.originalUrl);
      if (url.startsWith(originalBase)) {
        const redirected = getBaseUrl(o.overrideUrl) + url.slice(originalBase.length);
        console.log(`[MFE Override] inject: redirect  ${url}`);
        console.log(`[MFE Override] inject:        →  ${redirected}`);
        return redirected;
      }
    }
    return null;
  }

  // ── Patch window.fetch ────────────────────────────────────────────────────────

  const origFetch = window.fetch.bind(window);

  window.fetch = async function patchedFetch(input, init) {
    // Wait for overrides to arrive before the first call.
    // In practice content.js dispatches the event in < 1 ms (storage is fast),
    // so this await almost never blocks for a meaningful duration.
    await overridesReady;

    const urlStr = input instanceof Request ? input.url : String(input);
    console.log('[MFE Override] inject: fetch intercepted —', urlStr);

    const redirected = applyOverride(urlStr);
    if (redirected !== null) {
      // Preserve all request options when the input was a Request object.
      input = input instanceof Request ? new Request(redirected, input) : redirected;
    }

    return origFetch(input, init);
  };

  // ── Patch window.XMLHttpRequest ───────────────────────────────────────────────
  // open() is synchronous so we can only redirect when overrides have already
  // been received from content.js.  In practice the storage read resolves
  // before any app code runs, so this is effectively always available.

  const OrigXHR = window.XMLHttpRequest;
  window.XMLHttpRequest = class PatchedXHR extends OrigXHR {
    open(method, url, ...rest) {
      const redirected = overrides !== null ? applyOverride(String(url)) : null;
      super.open(method, redirected ?? url, ...rest);
    }
  };

  console.log('[MFE Override] inject: window.fetch and XMLHttpRequest patched');
})();
