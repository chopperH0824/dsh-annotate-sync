# dsh-annotate-sync

> Open an HTML preview in DeepSeek Harness and the annotation overlay is already there.
> Pick elements, write notes, hand the batch to the agent, and the agent edits the
> source file by path. No server, no `<script>` tag, no target picker.

![icon](./icon.svg)

## What it is

A DeepSeek Harness plugin that takes over `.html` / `.htm` document previews:

- open any HTML file in the right-sidebar **Files** panel (including one the agent just
  generated) and the **点选批注 / Mark** overlay appears automatically;
- hover highlight, click an element, write a note; numbered pins follow scrolling,
  resizing and layout changes;
- annotations are saved **per file**, with selector, sampled text, computed styles and
  the change instruction;
- leave picking with `Esc`, or press **Send to Agent**, and the batch goes into the
  current conversation as one structured message;
- the agent calls `read_annotations`, receives **file path + selector + note**, and edits
  that HTML/CSS directly;
- after the file changes the preview rebuilds; annotations stay; the agent can call
  `set_annotation_status` when done.

The old Agentation demo experience is preserved, without manually adding
`agentation.js`, without the 8765 sync server, and without a local-service list to pick.

## Install

```bash
# bundled CLI (macOS Desktop)
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop add dsh-annotate-sync@2.0.0
```

Add `"dsh-annotate-sync"` to `dsh.profile.bundles` in
`~/.dsh/profiles/desktop/package.json`, then **fully quit and restart DeepSeek Harness**.

Local development / tarball:

```bash
npm pack
dsh plugin --profile desktop add /absolute/path/to/dsh-annotate-sync-2.0.0.tgz
```

## Use

1. Restart DSH.
2. Open any `.html` file from the right-sidebar **Files** panel — or open the bundled
   [`demo/index.html`](./demo/index.html) to try it.
3. The floating **点选批注 / Mark** button appears in the preview; click it and then
   click an element.
4. Write the note and press `Enter`; `Esc` leaves picking.
5. **Auto-send** is on by default: leaving picking sends the batch into the current
   conversation. You can also press **Send to Agent** at any time, or turn auto-send off.
6. The agent reads the annotations and edits the source file; the preview refreshes when
   the file changes.
7. If the agent does not mark them, say "apply my annotations" so it calls
   `read_annotations`.

The toolbar above the preview shows the file name, pending count, send, auto-send and
clear.

## Annotation data

```jsonc
{
  "id": "uuid",
  "page": {
    "url": "dsh-resource://file/session/<sessionId>/<encoded path>",
    "origin": "",
    "path": "demo/index.html",
    "title": "index.html"
  },
  "file": { "sessionId": "...", "path": "demo/index.html", "name": "index.html", "address": "dsh-resource://..." },
  "selector": "#hero-title",
  "tag": "h1",
  "className": "hero-title",
  "textSample": "Simple pricing",
  "styles": { "fontSize": "26px", "color": "rgb(15,23,42)", "backgroundColor": "rgba(0,0,0,0)" },
  "rect": { "x": 120, "y": 340, "w": 420, "h": 32 },
  "note": "Make the title shorter",
  "status": "pending",
  "order": 0,
  "createdAt": "ISO",
  "updatedAt": "ISO"
}
```

Store: `~/.dsh/annotate-sync/annotations.json` plus readable `annotations.md`.
Legacy v0/v1/v2 files migrate to v3 automatically; old HTTP-page annotations remain
readable.

## Model tools

| Tool | Purpose |
|---|---|
| `read_annotations({ status?, pageUrl?, includeDone? })` | Read annotations; pending by default; Markdown includes `文件：<path>` per file |
| `set_annotation_status({ ids?, status, all?, pageUrl? })` | Mark applied (or back to pending) after editing |
| `clear_annotations({ pageUrl? })` | Clear all, optionally per file |

## Configuration

`config` in `cordis.patch.yml`:

| Field | Default | Purpose |
|---|---|---|
| `dir` | `~/.dsh/annotate-sync` | annotation storage directory |
| `route` | `/__dsh-annotate-sync` | internal API/overlay prefix |
| `legacyRoute` | `/api/annotate-sync/annotations` | old sync bridge; empty disables |
| `maxBodyBytes` | `262144` | request body cap |
| `tool` | `true` | register the model tools |

## Architecture

```
DSH Web
└─ Client: custom HTML document-preview renderer (priority: external)
   ├─ reuses the builtin bytes-complete renderer + relative CSS/JS packing + opaque blob iframe
   ├─ injects window.__DSH_ANNOTATE__ + overlay.js
   ├─ toolbar: send / auto-send / clear
   └─ postMessage bridge: overlay ↔ document component
Host: routes + v3 annotation store + three model tools
Overlay: picking, pins, comment cards, status
```

- The iframe stays `sandbox="allow-scripts"` with an opaque origin; the overlay and the
  document component only exchange `postMessage`; the parent validates `event.source`
  plus the channel.
- Relative CSS/JS are read through DSH's workspaceFiles and packed into the blob, same as
  the builtin preview.
- No extra HTTP server is started and no network requests are injected into the page.

## Known limitations

- A page CSP that blocks external scripts also blocks the overlay; the preview itself
  still renders.
- The custom renderer always allows the page's own scripts (the overlay needs them); it
  is not gated by the builtin interactive-preview setting.
- Elements inside cross-origin iframes or closed shadow roots cannot be picked.
- Only `.html` / `.htm` are taken over; other document types keep the builtin preview.
- Pins rely on CSS selectors and geometry; large DOM changes can misplace a pin, while
  the note and file path remain.

## Upgrading from 1.x

v2 removes the local-service preview and the right-sidebar annotation panel. The old
`annotations.json` migrates; the legacy `/api/annotate-sync/annotations` bridge stays.
`sync-server.mjs` is no longer needed.

## Development

```bash
npm test          # node --test
npm run check     # node --check all runtime files
npm run pack:check
```

Protocol: [docs/PROTOCOL.md](./docs/PROTOCOL.md) · Publishing: [docs/PUBLISH.md](./docs/PUBLISH.md)

## License

MIT. The HTML renderer is adapted from DeepSeek Harness (MIT); see [NOTICE](./NOTICE).
