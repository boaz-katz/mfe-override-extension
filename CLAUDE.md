# MFE Override — Chrome Extension

A Manifest V3 Chrome extension for developers and QA to override Angular Native Federation MFE remote URLs at runtime without touching any server config.

## What it does

Intercepts `remoteEntry.json` requests (and all assets under the same base path) and redirects them to a different URL. For example, redirect a staging MFE to a local dev server, or swap between two deployed environments.

## Project files

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest — permissions, content scripts, service worker |
| `background.js` | Service worker — manages `declarativeNetRequest` rules + detected-remote storage |
| `content.js` | Isolated-world content script — reads storage, detects remoteEntry.json via PerformanceObserver |
| `inject.js` | MAIN-world content script — patches `window.fetch` and `XMLHttpRequest` |
| `popup.html` | Extension popup shell |
| `popup.js` | Popup logic — add/edit/remove/toggle overrides, show detected remotes |
| `popup.css` | Popup styles |

## Architecture

Two redirect layers work together because `declarativeNetRequest` alone cannot redirect HTTPS → HTTP (e.g. staging → localhost):

1. **`declarativeNetRequest` (background.js)** — handles same-protocol redirects and `<script>`/module loads that bypass fetch/XHR.
2. **`window.fetch` + `XMLHttpRequest` patch (inject.js)** — handles cross-protocol redirects (HTTPS → HTTP). Runs in `world: "MAIN"` so it operates inside the page's own JS context.

### Content script split

| Script | World | Chrome APIs | Can patch window |
|---|---|---|---|
| `inject.js` | `MAIN` | None | Yes |
| `content.js` | `ISOLATED` | `chrome.*` | No |

`content.js` reads overrides from `chrome.storage.local` and forwards them to `inject.js` via DOM `CustomEvent` (`__MFEOverride_rules__`, `__MFEOverride_rulesUpdate__`).

### Override data model

```js
{
  id: Number,          // unique integer, auto-incremented
  name: String,        // human label (e.g. "map")
  originalUrl: String, // full remoteEntry.json URL to intercept
  overrideUrl: String, // full remoteEntry.json URL to serve instead
  enabled: Boolean
}
```

Stored in `chrome.storage.local` under key `overrides`.

### Rule creation (background.js `applyRules`)

One `declarativeNetRequest` rule per enabled override:

```
regexFilter:        ^{escapeRegex(originalBase)}(.*)$
regexSubstitution:  {overrideBase}\1
```

`originalBase` / `overrideBase` = everything up to and including the last `/` in each URL, so all assets under that path redirect together.

**Only forward rules.** No reverse rules. A forward + reverse pair causes an infinite redirect loop (Chrome aborts with "No content available because this request was redirected"). Angular Native Federation infers the chunk base URL from where `remoteEntry.json` was served, so chunks load from the override host automatically.

### Concurrency guard

`applyRulesInFlight` boolean in `background.js` prevents concurrent calls (startup + storage change + popup message can all fire simultaneously) from triggering "Rule with id N does not have a unique ID" errors.

### Detected Remotes

`content.js` uses `PerformanceObserver` with `buffered: true` to detect `remoteEntry.json` requests on the active tab. Detected URLs are sent to `background.js` via `chrome.runtime.sendMessage({ type: 'DETECTED_REMOTE', url })` and stored in `chrome.storage.local` under key `detected` (keyed by tab ID). The popup reads these and shows an "Override" button next to each one.

Detected list is cleared on navigation (`chrome.tabs.onUpdated` status=`loading`) and on tab close.

## Known limitations

- `inject.js` only patches `fetch()` and `XMLHttpRequest`. Dynamic `import()` and `<script>` tag injection bypass it — those are handled by `declarativeNetRequest`.
- `declarativeNetRequest` cannot redirect HTTPS → HTTP in all cases (Chrome security policy) — that path is covered by `inject.js`.
- The two layers must not conflict: do NOT add reverse `declarativeNetRequest` rules or reverse checks in `inject.js`.
- **Import map scope mismatch**: inject.js redirects fetch URLs (e.g. `localhost:4301/Mount.js` → `localhost:4304/Mount.js`). The browser records the module as coming from `localhost:4304`. NF's import map has shared-package scopes keyed to `localhost:4301`. Packages declared as `singleton: true` that are only used by the override remote (not by the shell) will fail with "Unable to resolve specifier" because the scope doesn't match. **Fix**: only declare a package as shared/singleton in `federation-share.js` if the shell itself imports it. Packages used only by one remote should be bundled into that remote (not shared).

## Loading the extension

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** and select this folder
4. After any code change: click the refresh icon on the extension card, then reload the target page
