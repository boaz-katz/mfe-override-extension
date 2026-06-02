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
  "use strict";

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
    new Promise((res) => {
      resolveReady = res;
    }),
    new Promise((res) =>
      setTimeout(() => {
        if (overrides === null) {
          overrides = [];
        }
        res();
      }, 3000),
    ),
  ]);

  // Initial delivery from content.js
  document.addEventListener("__MFEOverride_rules__", (e) => {
    overrides = Array.isArray(e.detail) ? e.detail : [];
    resolveReady();
  });

  // Live updates when the user edits overrides while the page is open
  document.addEventListener("__MFEOverride_rulesUpdate__", (e) => {
    overrides = Array.isArray(e.detail) ? e.detail : [];
  });

  // ── remoteEntry.json scope mirroring ─────────────────────────────────────────
  // Problem: inject.js redirects fetch('localhost:4301/Mount.js') to
  // 'localhost:4304/Mount.js'.  The browser records the module URL as
  // localhost:4304.  But NF's import map has shared-package scopes keyed to
  // localhost:4301.  Modules at localhost:4304 can't see that scope, so bare
  // specifier imports inside them fail with "Unable to resolve specifier".
  //
  // Fix: when a redirected fetch is for remoteEntry.json, intercept the JSON
  // response and add a mirrored scope entry for the original base URL alongside
  // the override base URL.  NF then registers both scopes in the import map, so
  // packages are resolvable from modules at either host — automatically, for
  // every package the remote declares, with no hardcoding required.

  async function mirrorRemoteEntryScopes(response, originalUrl, redirectedUrl) {
    try {
      const json = await response.clone().json();
      if (!json || !json.scopes) return response;

      const originalBase = getBaseUrl(originalUrl);
      const overrideBase = getBaseUrl(redirectedUrl);
      const extra = {};

      for (const [scopeKey, scopeEntries] of Object.entries(json.scopes)) {
        // Mirror override-base scopes → original-base scopes
        if (scopeKey.startsWith(overrideBase)) {
          const mirrorKey = originalBase + scopeKey.slice(overrideBase.length);
          if (!json.scopes[mirrorKey]) extra[mirrorKey] = scopeEntries;
        }
        // Mirror original-base scopes → override-base scopes
        if (scopeKey.startsWith(originalBase)) {
          const mirrorKey = overrideBase + scopeKey.slice(originalBase.length);
          if (!json.scopes[mirrorKey]) extra[mirrorKey] = scopeEntries;
        }
      }

      if (!Object.keys(extra).length) return response;

      const patched = { ...json, scopes: { ...json.scopes, ...extra } };
      return new Response(JSON.stringify(patched), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (_) {
      return response;
    }
  }

  // ── importmap-shim DOM injection interceptor ─────────────────────────────────
  // NF does NOT call importShim.addImportMap().  Instead it appends import maps by
  // inserting <script type="importmap-shim"> elements into document.head:
  //
  //   document.head.appendChild(Object.assign(document.createElement("script"), {
  //     type: "importmap-shim",
  //     textContent: JSON.stringify(importMap)
  //   }));
  //
  // We intercept every such insertion.  For each scope entry added by any remote,
  // we mirror all bare-specifier entries into the active override URL's scope so
  // that modules loaded from the override host can resolve every shared package —
  // regardless of which remote originally provided the implementation.
  //
  // Set up eagerly at inject.js startup (before any page scripts run) so the patch
  // is in place before NF calls appendImportMap for any remote.

  const _origAppendChild = Element.prototype.appendChild;
  Element.prototype.appendChild = function mfeAppendChild(node) {
    if (
      overrides !== null &&
      overrides.length > 0 &&
      node instanceof HTMLElement &&
      node.tagName === "SCRIPT" &&
      String(node.type) === "importmap-shim"
    ) {
      try {
        const json = JSON.parse(String(node.textContent));
        if (json && json.scopes) {
          const extra = {};
          for (const [scopeKey, scopeEntries] of Object.entries(json.scopes)) {
            for (const o of overrides) {
              const overrideBase = getBaseUrl(o.overrideUrl);
              if (scopeKey === overrideBase) continue;
              for (const [specifier, url] of Object.entries(scopeEntries)) {
                if (!specifier.startsWith(".")) {
                  if (!extra[overrideBase]) extra[overrideBase] = {};
                  if (!extra[overrideBase][specifier]) {
                    extra[overrideBase][specifier] = url;
                  }
                }
              }
            }
          }
          if (Object.keys(extra).length) {
            json.scopes = { ...json.scopes, ...extra };
            node.textContent = JSON.stringify(json);
          }
        }
      } catch (_) {}
    }
    return _origAppendChild.call(this, node);
  };

  function setupImportMapMirror() {} // mirroring now handled via appendChild patch above

  // ── URL helpers ───────────────────────────────────────────────────────────────

  function getBaseUrl(url) {
    const i = url.lastIndexOf("/");
    return i >= 0 ? url.slice(0, i + 1) : url + "/";
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
        const redirected =
          getBaseUrl(o.overrideUrl) + url.slice(originalBase.length);
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


    const redirected = applyOverride(urlStr);
    if (redirected !== null) {
      // Preserve all request options when the input was a Request object.
      const newInput =
        input instanceof Request ? new Request(redirected, input) : redirected;
      const response = await origFetch(newInput, init);

      // When redirecting a remoteEntry.json, mirror its scopes so that packages
      // declared by the remote are resolvable from modules at either host URL.

      if (urlStr.includes("remoteEntry.json")) {
        return mirrorRemoteEntryScopes(response, urlStr, redirected);
      }

      return response;
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

})();
