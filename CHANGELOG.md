# Changelog

All notable changes to `dsh-annotate-sync` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this package uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
