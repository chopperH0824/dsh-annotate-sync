# Changelog

All notable changes to `dsh-annotate-sync` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this package uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] — 2026-10-28

Complete redesign: annotate the HTML document that is already open in the DSH
document preview, instead of managing local dev servers.

### Added

- An **external-band HTML document preview implementation** (`dsh-annotate-sync/html`)
  that takes over `.html` / `.htm` previews and injects the annotation overlay
  automatically. Opening an HTML file is now the only action needed.
- The overlay receives the document's `dsh-resource://file/...` address, so every
  annotation carries the exact file path, session id and selector.
- The document preview's relative CSS/JS packing, opaque `allow-scripts` iframe and
  resource tracking are preserved; the overlay is injected into the same packed
  document.
- Compact toolbar above the preview: file name, pending count, **发送给 Agent**,
  **自动发送** (default on), and **清空**.
- Batch handoff: annotations are stored immediately, and the batch is sent to the
  current conversation when the user leaves picking mode (with auto-send on) or
  presses the send button.
- File-scoped store (`replacePage`) and `saveFile` host API; Markdown now prints
  `文件：<path>` so the agent can edit the source file directly.
- `NOTICE` with the MIT attribution for the adapted DSH HTML renderer helpers.

### Changed

- The store schema is v3; legacy v0/v1/v2 annotation files migrate automatically.
  HTTP-page annotations from v1 remain readable.
- The model tools keep their names, but `read_annotations` Markdown is file-oriented.

### Removed

- The local-service discovery panel, loopback preview proxy, right-sidebar tab,
  composer dock chip, sidebar footer action and first-run auto-open from 1.0.x.
- `lib/preview.js`, `lib/discover.js` and their tests.
- Config fields `preview` and `ports`.

### Known limitations

- The custom HTML renderer always allows the document's own scripts (required for
  the overlay). Unlike the built-in preview it is not gated by the developer-tools
  interactive-preview setting.
- Cross-origin iframes and closed shadow roots inside the HTML cannot be picked.
- A page with a strict CSP that blocks our overlay script will not show the
  annotation UI; the preview still renders.

## [1.0.1] — 2026-10-28 (staged, superseded by 2.0.0)

Discovery fix: the plugin was active but its only entry was the right-sidebar tab,
which is invisible while that column is collapsed.

### Added

- Permanent **批注 / Annotations** action beside Settings in the left sidebar
  (`sidebar.footer.action`), icon-only in the collapsed rail.
- The Annotations tab opens once automatically on first launch after install or
  update, so starting DSH and seeing the annotator are the same moment.

### Changed

- The right-sidebar guide entry now carries an explicit id, so pinning and card
  identity are stable in the guide list.

## [1.0.0] — 2026-10-28

The annotation UI is now part of the plugin, not a separate demo page.

### Added

- Right-sidebar **Annotations** tab (`⌘/Ctrl+Shift+B`) with a local-service list
  and an in-panel preview.
- Loopback preview proxy with per-target isolated origins, HTML overlay injection,
  CSP/X-Frame-Options stripping and absolute-redirect rewriting.
- In-page overlay: element picking, numbered pins that follow scroll and layout
  changes, inline comment cards, applied/pending styling, floating pick toggle.
- Page-scoped annotations: every annotation carries its page URL, title and path,
  and the panel groups/filter by page.
- Annotation status workflow: `pending` / `applied`, filter tabs, per-row toggle.
- Edit, delete, reorder (up/down), clear-all, pending counter and composer dock chip.
- Send annotations to the conversation as one structured Markdown block, or add
  them to the composer draft when that action is available.
- Model tools: `read_annotations`, `set_annotation_status`, `clear_annotations`.
- Persistence to `~/.dsh/annotate-sync/annotations.json` plus a human-readable
  `annotations.md`; migration from the previous v0/v1 file shapes.
- Local service auto-discovery across common dev-server ports.
- Bundled demo page under `demo/` and the original overlay behavior as a fallback.
- npm-publishable package metadata, locale metadata (`en`/`zh`), original icon,
  MIT license, protocol document and install/publish guide.

### Changed

- The old `lib/index.js` sync-bridge-only plugin is replaced by a complete plugin;
  the legacy `/api/annotate-sync/annotations` route is still served for pages that
  were wired to the previous version.

### Known limitations

- Chromium is the validated browser.
- The preview proxy does not relay WebSocket upgrades; a dev server's HMR socket
  keeps talking to its own origin. Pages still load and refresh normally.
- The proxy only accepts loopback targets; remote apps are out of scope.
- Picking and pins rely on CSS selectors and computed rectangles; elements rendered
  into closed shadow roots or cross-origin iframes cannot be annotated.
