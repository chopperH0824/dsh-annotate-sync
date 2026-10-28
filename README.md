# dsh-annotate-sync

> A complete visual-annotation plugin for **DeepSeek Harness**: open a local app in the
> right sidebar, click elements, leave notes, keep them grouped by page, send them to
> the conversation, and let the agent read them through tools.

Unlike a sync-bridge-only plugin, the annotation UI is part of this package: the
right-sidebar panel, the loopback preview proxy, the injected in-page overlay, the
annotation store and the model tools all ship together. No manual `<script>` tag is
needed in your app.

- Right-sidebar **Annotations** tab (`⌘/Ctrl + Shift + B`)
- Auto-discovers local dev servers (Vite, Next, CRA, static servers, common ports)
- One isolated loopback preview origin per app, so root-absolute assets and SPA routes work
- In-page picking: hover highlight, click-to-comment, numbered pins that follow scrolling,
  resizing and layout shifts
- Annotation workflow: `pending` / `applied`, grouped and filtered by page, edit, delete,
  reorder, clear
- **Send annotations** as one structured message to the current conversation, or
  **add to composer** and add your own context first
- Model tools: `read_annotations`, `set_annotation_status`, `clear_annotations`
- Persistence at `~/.dsh/annotate-sync/annotations.json` plus readable `annotations.md`
- Legacy `/api/annotate-sync/annotations` sync bridge is kept for already-wired pages

## Install

### From npm (after publishing)

```bash
dsh plugin --profile desktop add dsh-annotate-sync@1.0.0
```

Add `"dsh-annotate-sync"` to `dsh.profile.bundles` in
`~/.dsh/profiles/desktop/package.json` (or enable it in DSH Settings → Plugins),
then **fully quit and restart DeepSeek Harness**.

### From a local folder or tarball

```bash
dsh plugin --profile desktop add link:/absolute/path/to/dsh-annotate-sync
# or: npm pack && dsh plugin --profile desktop add /path/to/dsh-annotate-sync-1.0.0.tgz
```

Add the package to `dsh.profile.bundles` and restart.

## Use

1. Start the app you are working on, e.g. `npm run dev` (Vite: `http://127.0.0.1:5173`).
2. Open **Annotations** in the right sidebar, or press `⌘/Ctrl + Shift + B`.
3. Pick the running service from the list; it opens in the panel.
4. Click **Mark** (toolbar) or the floating button in the page, click an element, write
   a note, press `Enter` to save.
5. Filter, edit, mark applied, delete or reorder notes in the list.
6. **Send annotations** puts the pending notes into the conversation as one structured
   block; **Add to composer** merges them into your draft instead.
7. Say "apply my annotations" and the agent calls `read_annotations` to get the list.

### Bundled demo

```bash
python3 -m http.server 4173 -d demo
```

Then open `http://127.0.0.1:4173` from the Annotations panel.

## Configuration

The `config` block in `cordis.patch.yml` (override per row):

| Field | Default | Purpose |
|---|---|---|
| `dir` | `~/.dsh/annotate-sync` | annotation storage directory |
| `route` | `/__dsh-annotate-sync` | internal API/asset prefix |
| `legacyRoute` | `/api/annotate-sync/annotations` | old sync bridge; empty string disables |
| `maxBodyBytes` | `262144` | request body cap |
| `tool` | `true` | register the model tools |
| `preview` | `true` | enable service detection + in-page picking |
| `ports` | `[]` | extra ports to probe |

## Model tools

| Tool | Purpose |
|---|---|
| `read_annotations({ status?, pageUrl?, includeDone? })` | Read annotations; `pending` by default; returns `markdown` and the structured array |
| `set_annotation_status({ ids?, status, all?, pageUrl? })` | Mark applied (or back to pending) after editing code |
| `clear_annotations({ pageUrl? })` | Clear all, optionally scoped to a page |

## Data format

See [docs/PROTOCOL.md](./docs/PROTOCOL.md). The store is versioned and migrates the
previous `annotations.json` shapes automatically.

## Architecture

```
DSH Web
├─ Client half (lib/client.js)   right-sidebar tab + preview iframe + list + send
├─ Host half  (lib/index.js)     routes / store / tools / discovery / preview proxy
└─ Overlay    (lib/overlay.js)   injected into the previewed page: pick, pins, cards
```

- Preview: an ephemeral `127.0.0.1:<random>` proxy per target app; HTML responses get the
  overlay + bootstrap injected, so the app keeps its own paths.
- Security: loopback targets only; the harness origin itself is refused; annotations are
  written only inside the plugin directory.
- Transport: panel ↔ overlay via `postMessage` (strict origin check), panel ↔ host via a
  JSON API.

## Known limitations

- Chromium is the validated browser.
- The preview proxy does not relay WebSocket upgrades: pages load fine, but a dev
  server's HMR socket still talks to its own origin (refresh to see changes).
- Loopback apps only.
- Elements inside closed shadow roots or cross-origin iframes cannot be picked.
- A DSH restart is required after installing or upgrading the plugin.

## Development

```bash
npm test          # node --test
npm run check     # node --check all runtime files
npm run pack:check
```

Protocol: [docs/PROTOCOL.md](./docs/PROTOCOL.md) · Publishing: [docs/PUBLISH.md](./docs/PUBLISH.md)

## License

MIT
