/**
 * dsh-annotate-sync — injected in-page annotation overlay (v2)
 *
 * Loaded as a classic script (`<script src>`) by the HTML document-preview
 * renderer, after the bootstrap script that defines `window.__DSH_ANNOTATE__`:
 *
 *   // v2 doc mode: appended to the generated document, rendered inside an
 *   // opaque sandboxed iframe (sandbox="allow-scripts", origin "null").
 *   window.__DSH_ANNOTATE__ = {
 *     mode: 'file', parentOrigin, apiOrigin,
 *     file: { url, path, name, sessionId }, overlaySrc
 *   }
 *
 *   // legacy sidebar-preview proxy (still supported):
 *   window.__DSH_ANNOTATE__ = {
 *     parentOrigin, apiOrigin, lease, target, overlaySrc
 *   }
 *
 * Responsibilities:
 *   - hover highlight + click-to-annotate in pick mode
 *   - render numbered pins for the annotations of the current page
 *   - open/edit/delete annotation cards, toggle pending/applied
 *   - tell the parent (DSH page) about user actions over postMessage only
 *
 * Hard rules (see docs/PROTOCOL-v2.md §7):
 *   - No imports, no build step, no dependencies, no ESM.
 *   - Only talks to the parent through postMessage on the `dsh-annotate-sync`
 *     channel. Never fetches the host API. Never touches storage.
 *   - Doc mode: page identity comes from the bootstrap `file` object; the
 *     iframe URL is opaque, so location is never consulted for it.
 *   - Only runs when the bootstrap is present: no-ops otherwise.
 *   - Everything it adds to the page lives under #das-root / .das-* selectors,
 *     and user-supplied text is always assigned with textContent.
 */
(function () {
  'use strict';

  /** Bootstrap is injected by the preview proxy only; elsewhere this is a no-op. */
  var CFG = window.__DSH_ANNOTATE__;
  if (!CFG || typeof CFG !== 'object') return;
  if (document.getElementById('das-root')) return;

  var CHANNEL = 'dsh-annotate-sync';

  /**
   * v2 document-preview mode: the overlay is injected into the HTML document
   * that DSH renders inside an opaque sandboxed iframe (the iframe's origin is
   * "null"). The annotation page identity therefore comes from the bootstrap
   * `file` object — a dsh-resource:// address — and never from the iframe URL.
   * The legacy sidebar-preview proxy has no `mode` and keeps its old logic.
   */
  var DOC_MODE = CFG.mode === 'file';
  var DOC_FILE = DOC_MODE && CFG.file && typeof CFG.file === 'object' ? CFG.file : null;
  var DOC_URL = DOC_FILE && typeof DOC_FILE.url === 'string' ? DOC_FILE.url : '';
  if (DOC_MODE && !DOC_URL) return;

  var PARENT_ORIGIN = typeof CFG.parentOrigin === 'string' ? CFG.parentOrigin : '';
  if (!PARENT_ORIGIN) return;
  try {
    PARENT_ORIGIN = new URL(PARENT_ORIGIN).origin;
  } catch (e) {
    return;
  }

  /**
   * Legacy preview mode only. The overlay runs on the preview proxy origin
   * (127.0.0.1:<random>), but an annotation belongs to the app's real URL as
   * stored in the panel. The bootstrap `target` is that canonical app origin;
   * combining it with the live pathname keeps page grouping stable across
   * preview leases and restarts. Doc mode never consults location, because
   * inside the opaque sandbox it carries no usable identity.
   */
  var TARGET_ORIGIN = '';
  if (!DOC_MODE) {
    TARGET_ORIGIN = (function (target) {
      try {
        if (typeof target === 'string' && target) return new URL(target).origin;
      } catch (e) {
        /* fall through to the proxy origin */
      }
      return location.origin;
    })(CFG.target);
  }

  var PAGE_TITLE_MAX = 120;
  var NOTE_MAX = 2000;
  var TEXT_MAX = 160;
  var SELECTOR_MAX = 1000;
  var CLASS_MAX = 300;
  var MAX_DEPTH = 8;
  var STATUS_LABEL = { pending: '待处理', applied: '已处理' };
  var TESTID_ATTRS = ['data-testid', 'data-test', 'data-test-id', 'data-qa'];
  var PICK_HINT = '点选中 · 点击元素添加批注 · Esc 退出';
  var EDIT_HINT = 'Enter 保存 · Shift+Enter 换行 · Esc 取消';

  /* ---------------------------------------------------------------- helpers */

  function h(tag, attrs, children) {
    var node = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (key) {
      var value = attrs[key];
      if (value == null) return;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = String(value);
      else if (key === 'dataset' && typeof value === 'object') {
        Object.keys(value).forEach(function (name) {
          node.dataset[name] = String(value[name]);
        });
      } else if (key === 'style' && typeof value === 'object') {
        Object.keys(value).forEach(function (name) {
          node.style[name] = value[name];
        });
      } else {
        node.setAttribute(key, String(value));
      }
    });
    (children || []).forEach(function (child) {
      if (child == null) return;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
    return node;
  }

  function clamp(value, min, max) {
    if (max < min) return min;
    return Math.min(Math.max(value, min), max);
  }

  function clipText(value, max) {
    var text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    if (text.length <= max) return text;
    return text.slice(0, Math.max(1, max - 1)) + '…';
  }

  function cssEscape(value) {
    var text = String(value);
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(text);
    return text.replace(/[^a-zA-Z0-9_\u00a0-\uffff-]/g, function (char) {
      return '\\' + char;
    });
  }

  function attrValue(value) {
    return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }

  function uuid() {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === 'function') {
        return window.crypto.randomUUID();
      }
    } catch (e) {
      /* older Chromium */
    }
    var bytes = new Uint8Array(16);
    try {
      window.crypto.getRandomValues(bytes);
    } catch (e) {
      for (var i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
    }
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    var hex = '';
    for (var j = 0; j < 16; j += 1) hex += (bytes[j] + 256).toString(16).slice(1);
    return (
      hex.slice(0, 8) +
      '-' +
      hex.slice(8, 12) +
      '-' +
      hex.slice(12, 16) +
      '-' +
      hex.slice(16, 20) +
      '-' +
      hex.slice(20)
    );
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function isoOrNow(value) {
    if (typeof value === 'string' && value) {
      var parsed = Date.parse(value);
      if (!isNaN(parsed)) return new Date(parsed).toISOString();
    }
    return nowIso();
  }

  function numberOr(value, fallback) {
    var number = typeof value === 'number' ? value : parseFloat(value);
    return isFinite(number) ? number : fallback;
  }

  function isOverlayNode(node) {
    return !!(root && node && node.nodeType === 1 && root.contains(node));
  }

  function nearestElement(node) {
    if (!node) return null;
    if (node.nodeType === 1) return node;
    if (node.nodeType === 3 && node.parentElement) return node.parentElement;
    return null;
  }

  /* ------------------------------------------------------------ page + post */

  function docFileName() {
    return DOC_FILE && typeof DOC_FILE.name === 'string' ? DOC_FILE.name : '';
  }

  function docFilePath() {
    return DOC_FILE && typeof DOC_FILE.path === 'string' ? DOC_FILE.path : '';
  }

  function docTitle() {
    return clipText(document.title || docFileName(), PAGE_TITLE_MAX);
  }

  /*
   * v2 annotations may carry the optional `file` block (PROTOCOL-v2 §3). Doc
   * mode always knows it from the bootstrap, and the host store uses it to
   * render `文件：<path>` in Markdown, so every emitted annotation includes it.
   */
  function docFileInfo() {
    if (!DOC_MODE) return null;
    return {
      sessionId: typeof DOC_FILE.sessionId === 'string' ? DOC_FILE.sessionId : '',
      path: docFilePath(),
      name: docFileName(),
      address: DOC_URL,
    };
  }

  function currentPageUrl() {
    if (DOC_MODE) return DOC_URL;
    /* Hash is deliberately dropped: it is not part of the page grouping key. */
    return TARGET_ORIGIN + location.pathname + location.search;
  }

  function pageInfo() {
    if (DOC_MODE) {
      return {
        url: DOC_URL,
        origin: '',
        path: docFilePath(),
        title: docTitle(),
      };
    }
    return {
      url: currentPageUrl(),
      origin: TARGET_ORIGIN,
      path: location.pathname,
      title: clipText(document.title, PAGE_TITLE_MAX),
    };
  }

  function viewportInfo() {
    return { w: window.innerWidth, h: window.innerHeight };
  }

  function post(type, payload) {
    var message = { channel: CHANNEL, type: type };
    if (payload) {
      Object.keys(payload).forEach(function (key) {
        message[key] = payload[key];
      });
    }
    try {
      /* Doc mode: parent is the harness page at CFG.parentOrigin. */
      window.parent.postMessage(message, PARENT_ORIGIN);
    } catch (e) {
      /* the preview iframe is gone */
    }
  }

  function postReady() {
    post('ready', { page: pageInfo(), viewport: viewportInfo(), mode: S.mode });
  }

  /**
   * Doc mode: the host renders `page.title` from the document's own <title>
   * (or the file name when absent), which page scripts may fill in after the
   * overlay boots. A cheap poll keeps the host in sync; no observers, no
   * storage, and a no-op in legacy mode.
   */
  function checkDocTitle() {
    if (!DOC_MODE || !S.mounted) return;
    var title = docTitle();
    if (title === S.docTitle) return;
    S.docTitle = title;
    postReady();
  }

  /* ---------------------------------------------------------------- state */

  var S = {
    mounted: false,
    annotations: [],
    pageUrl: currentPageUrl(),
    mode: 'idle',
    docTitle: '',
    hoverEl: null,
    pointer: null,
    card: null,
    listOpen: false,
    elements: Object.create(null),
    docRects: Object.create(null),
    pinNodes: Object.create(null),
    lastOrphanQuery: 0,
    rafId: 0,
    timerId: 0,
    loopId: 0,
    watchTimer: 0,
    flashTimer: 0,
    toastTimer: 0,
    pendingMessages: [],
    reducedMotion: false,
  };

  try {
    S.reducedMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch (e) {
    S.reducedMotion = false;
  }

  var root = null;
  var layer = null;
  var hoverBox = null;
  var hoverLabel = null;
  var pinsEl = null;
  var cardEl = null;
  var indicatorEl = null;
  var fabEl = null;
  var countEl = null;
  var listEl = null;
  var toastEl = null;

  /* -------------------------------------------------------------- styling */

  var CSS = [
    '#das-root, #das-root * { box-sizing: border-box; }',
    '#das-root {',
    '  --das-bg: #0f172a;',
    '  --das-bg-soft: #1b2537;',
    '  --das-fg: #f8fafc;',
    '  --das-muted: #94a3b8;',
    '  --das-border: rgba(148, 163, 184, 0.32);',
    '  --das-accent: #6366f1;',
    '  --das-accent-soft: rgba(99, 102, 241, 0.16);',
    '  --das-accent-fg: #ffffff;',
    '  --das-danger: #fb7185;',
    '  --das-applied: #34d399;',
    '  --das-shadow: 0 18px 44px rgba(2, 6, 23, 0.55);',
    '  position: fixed !important;',
    '  inset: 0 !important;',
    '  width: 100% !important;',
    '  height: 100% !important;',
    '  margin: 0 !important;',
    '  padding: 0 !important;',
    '  border: 0 !important;',
    '  background: transparent !important;',
    '  overflow: hidden !important;',
    '  pointer-events: none !important;',
    '  z-index: 2147483000 !important;',
    '  color: var(--das-fg);',
    '  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;',
    '  font-size: 13px;',
    '  font-weight: 400;',
    '  line-height: 1.5;',
    '  letter-spacing: normal;',
    '  text-align: left;',
    '  text-transform: none;',
    '  direction: ltr;',
    '  color-scheme: light dark;',
    '  -webkit-font-smoothing: antialiased;',
    '  user-select: none;',
    '}',
    '@media (prefers-color-scheme: light) {',
    '  #das-root {',
    '    --das-bg: #ffffff;',
    '    --das-bg-soft: #f1f5f9;',
    '    --das-fg: #0f172a;',
    '    --das-muted: #64748b;',
    '    --das-border: rgba(15, 23, 42, 0.16);',
    '    --das-accent: #4f46e5;',
    '    --das-accent-soft: rgba(79, 70, 229, 0.1);',
    '    --das-danger: #e11d48;',
    '    --das-applied: #059669;',
    '    --das-shadow: 0 18px 44px rgba(15, 23, 42, 0.18);',
    '  }',
    '}',
    '#das-root [hidden] { display: none !important; }',
    '#das-root .das-layer { position: absolute; inset: 0; overflow: hidden; pointer-events: none; }',
    '#das-root .das-hover { position: absolute; display: none; border: 2px solid var(--das-accent); border-radius: 4px; background: var(--das-accent-soft); pointer-events: none; z-index: 1; }',
    '#das-root .das-hover.is-on { display: block; }',
    '#das-root .das-hover-label { position: absolute; left: -2px; bottom: calc(100% + 5px); max-width: 60vw; padding: 2px 8px; border-radius: 5px; background: var(--das-accent); color: var(--das-accent-fg); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; font-weight: 600; line-height: 1.6; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; box-shadow: 0 2px 10px rgba(2, 6, 23, 0.35); pointer-events: none; }',
    '#das-root .das-hover-label.das-below { bottom: auto; top: calc(100% + 5px); }',
    '#das-root .das-pins { position: absolute; inset: 0; pointer-events: none; z-index: 2; }',
    '#das-root .das-pin { position: absolute; display: flex; align-items: center; justify-content: center; width: 24px; height: 24px; margin: 0; padding: 0; border: 2px solid rgba(255, 255, 255, 0.92); border-radius: 50%; background: var(--das-accent); color: var(--das-accent-fg); font: inherit; font-size: 11px; font-weight: 800; line-height: 1; cursor: pointer; transform: translate(-50%, -50%); box-shadow: 0 4px 14px rgba(2, 6, 23, 0.42); pointer-events: auto; transition: transform 120ms ease, box-shadow 120ms ease; }',
    '#das-root .das-pin:hover { transform: translate(-50%, -50%) scale(1.15); }',
    '#das-root .das-pin:focus-visible { outline: 2px solid var(--das-fg); outline-offset: 2px; }',
    '#das-root .das-pin[data-status="applied"] { background: var(--das-applied); color: #052e16; opacity: 0.85; }',
    '#das-root .das-pin[data-orphan="1"] { background: var(--das-bg-soft); color: var(--das-muted); border-style: dashed; border-color: var(--das-border); }',
    '#das-root .das-pin.is-flash { animation: das-pin-flash 900ms ease-out; z-index: 3; }',
    '@keyframes das-pin-flash { 0% { box-shadow: 0 0 0 0 rgba(99, 102, 241, 0.75); } 100% { box-shadow: 0 0 0 16px rgba(99, 102, 241, 0); } }',
    '#das-root .das-card { position: absolute; display: flex; flex-direction: column; gap: 8px; width: min(340px, calc(100vw - 24px)); max-height: calc(100vh - 24px); overflow: auto; margin: 0; padding: 12px; border: 1px solid var(--das-border); border-radius: 12px; background: var(--das-bg); color: var(--das-fg); box-shadow: var(--das-shadow); pointer-events: auto; z-index: 5; user-select: text; }',
    '#das-root .das-card-head { display: flex; align-items: center; gap: 8px; }',
    '#das-root .das-card-title { flex: 1 1 auto; font-size: 13px; font-weight: 700; }',
    '#das-root .das-icon-btn { flex: 0 0 auto; display: flex; align-items: center; justify-content: center; width: 22px; height: 22px; margin: 0; padding: 0; border: 1px solid transparent; border-radius: 6px; background: transparent; color: var(--das-muted); font: inherit; font-size: 12px; line-height: 1; cursor: pointer; }',
    '#das-root .das-icon-btn:hover { background: var(--das-bg-soft); color: var(--das-fg); }',
    '#das-root .das-meta { margin: 0; font-size: 11px; color: var(--das-muted); overflow-wrap: anywhere; }',
    '#das-root .das-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }',
    '#das-root .das-note { max-height: 160px; overflow: auto; padding: 8px 10px; border-radius: 8px; background: var(--das-bg-soft); font-size: 12.5px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }',
    '#das-root .das-textarea { width: 100%; min-height: 86px; max-height: 220px; margin: 0; padding: 8px 10px; border: 1px solid var(--das-border); border-radius: 8px; background: var(--das-bg-soft); color: var(--das-fg); font: inherit; font-size: 12.5px; line-height: 1.5; resize: vertical; }',
    '#das-root .das-textarea:focus { outline: none; border-color: var(--das-accent); box-shadow: 0 0 0 3px var(--das-accent-soft); }',
    '#das-root .das-hint { margin: 0; font-size: 10.5px; color: var(--das-muted); }',
    '#das-root .das-hint.is-error { color: var(--das-danger); }',
    '#das-root .das-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }',
    '#das-root .das-spacer { flex: 1 1 auto; }',
    '#das-root .das-badge { flex: 0 0 auto; padding: 1px 7px; border-radius: 999px; background: var(--das-accent-soft); color: var(--das-accent); font-size: 10.5px; font-weight: 700; }',
    '#das-root .das-badge[data-status="applied"] { background: rgba(16, 185, 129, 0.16); color: var(--das-applied); }',
    '#das-root .das-btn { margin: 0; padding: 5px 10px; border: 1px solid var(--das-border); border-radius: 7px; background: var(--das-bg-soft); color: var(--das-fg); font: inherit; font-size: 11.5px; font-weight: 600; cursor: pointer; }',
    '#das-root .das-btn:hover { border-color: var(--das-accent); }',
    '#das-root .das-btn-primary { border-color: transparent; background: var(--das-accent); color: var(--das-accent-fg); }',
    '#das-root .das-btn-danger { border-color: transparent; background: transparent; color: var(--das-danger); }',
    '#das-root .das-btn-danger:hover { border-color: transparent; background: rgba(244, 63, 94, 0.12); }',
    '#das-root .das-btn-ghost { background: transparent; }',
    '#das-root .das-btn:focus-visible, #das-root .das-icon-btn:focus-visible, #das-root .das-fab:focus-visible, #das-root .das-count:focus-visible, #das-root .das-row:focus-visible, #das-root .das-textarea:focus-visible { outline: 2px solid var(--das-accent); outline-offset: 2px; }',
    '#das-root .das-indicator { position: absolute; left: 16px; bottom: 16px; display: inline-flex; align-items: center; gap: 8px; padding: 7px 12px; border: 1px solid var(--das-accent); border-radius: 999px; background: var(--das-bg); color: var(--das-fg); font-size: 11.5px; font-weight: 600; box-shadow: var(--das-shadow); pointer-events: none; z-index: 4; }',
    '#das-root .das-indicator-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--das-accent); box-shadow: 0 0 8px var(--das-accent); animation: das-pulse 1.6s ease-in-out infinite; }',
    '@keyframes das-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }',
    '#das-root .das-fab { position: absolute; right: 16px; bottom: 16px; margin: 0; padding: 8px 16px; border: 1px solid transparent; border-radius: 999px; background: var(--das-accent); color: var(--das-accent-fg); font: inherit; font-size: 12.5px; font-weight: 700; cursor: pointer; box-shadow: var(--das-shadow); pointer-events: auto; z-index: 4; }',
    '#das-root .das-fab:hover { filter: brightness(1.06); }',
    '#das-root .das-fab.is-picking { border-color: var(--das-accent); background: var(--das-bg); color: var(--das-accent); }',
    '#das-root .das-count { position: absolute; right: 16px; bottom: 64px; display: inline-flex; align-items: center; gap: 6px; margin: 0; padding: 7px 12px; border: 1px solid var(--das-border); border-radius: 999px; background: var(--das-bg); color: var(--das-fg); font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; box-shadow: var(--das-shadow); pointer-events: auto; z-index: 4; }',
    '#das-root .das-count:hover { border-color: var(--das-accent); }',
    '#das-root .das-list { position: absolute; right: 16px; bottom: 104px; display: flex; flex-direction: column; width: min(340px, calc(100vw - 32px)); max-height: min(48vh, 420px); overflow: hidden; border: 1px solid var(--das-border); border-radius: 12px; background: var(--das-bg); color: var(--das-fg); box-shadow: var(--das-shadow); pointer-events: auto; z-index: 4; }',
    '#das-root .das-list-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--das-border); }',
    '#das-root .das-list-title { font-size: 12.5px; font-weight: 700; }',
    '#das-root .das-list-body { display: flex; flex-direction: column; gap: 4px; overflow: auto; padding: 6px; }',
    '#das-root .das-row { display: flex; align-items: flex-start; gap: 8px; width: 100%; margin: 0; padding: 8px; border: 1px solid transparent; border-radius: 8px; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }',
    '#das-root .das-row:hover { border-color: var(--das-border); background: var(--das-bg-soft); }',
    '#das-root .das-row-no { flex: 0 0 auto; display: flex; align-items: center; justify-content: center; width: 20px; height: 20px; margin-top: 1px; border-radius: 50%; background: var(--das-accent-soft); color: var(--das-accent); font-size: 11px; font-weight: 800; }',
    '#das-root .das-row-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }',
    '#das-root .das-row-note { display: -webkit-box; overflow: hidden; -webkit-line-clamp: 2; -webkit-box-orient: vertical; font-size: 12px; line-height: 1.45; overflow-wrap: anywhere; }',
    '#das-root .das-row-meta { overflow: hidden; font-size: 10.5px; color: var(--das-muted); white-space: nowrap; text-overflow: ellipsis; }',
    '#das-root .das-list-hint, #das-root .das-empty { margin: 0; padding: 8px 12px; font-size: 11px; color: var(--das-muted); }',
    '#das-root .das-toast { position: absolute; left: 50%; bottom: 24px; max-width: min(420px, calc(100vw - 32px)); padding: 8px 14px; border: 1px solid var(--das-border); border-radius: 999px; background: var(--das-bg); color: var(--das-fg); font-size: 12px; font-weight: 600; box-shadow: var(--das-shadow); opacity: 0; pointer-events: none; transform: translateX(-50%); transition: opacity 160ms ease; z-index: 6; }',
    '#das-root .das-toast.is-on { opacity: 1; }',
    '@media (prefers-reduced-motion: reduce) {',
    '  #das-root .das-pin, #das-root .das-toast, #das-root .das-indicator-dot, #das-root .das-hover { animation: none !important; transition: none !important; }',
    '}',
  ].join('\n');

  /* ----------------------------------------------------------- annotations */

  function stringValue(value) {
    return typeof value === 'string' ? value : '';
  }

  function normalizeFile(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var file = {
      sessionId: stringValue(raw.sessionId),
      path: stringValue(raw.path),
      name: stringValue(raw.name),
      address: stringValue(raw.address),
    };
    if (!file.sessionId && !file.path && !file.name && !file.address) return null;
    return file;
  }

  function normalizeAnnotation(raw, index) {
    if (!raw || typeof raw !== 'object') return null;
    var id = stringValue(raw.id);
    if (!id) return null;
    var page = raw.page && typeof raw.page === 'object' ? raw.page : {};
    var url = stringValue(page.url);
    var origin = stringValue(page.origin);
    var path = stringValue(page.path);
    if (!url && origin) url = origin + path;
    if (!url) url = 'unknown';
    var selector = stringValue(raw.selector).slice(0, SELECTOR_MAX);
    var note = stringValue(raw.note).slice(0, NOTE_MAX);
    /* Objects without a target or note are unusable (protocol §3). */
    if (!selector || !note) return null;
    var styles = raw.styles && typeof raw.styles === 'object' ? raw.styles : {};
    var rect = raw.rect && typeof raw.rect === 'object' ? raw.rect : {};
    var file = normalizeFile(raw.file);
    var annotation = {
      id: id,
      page: {
        url: url,
        origin: origin,
        path: path,
        title: stringValue(page.title).slice(0, PAGE_TITLE_MAX),
      },
      selector: selector,
      tag: stringValue(raw.tag).toLowerCase(),
      className: stringValue(raw.className).slice(0, CLASS_MAX),
      textSample: stringValue(raw.textSample).slice(0, TEXT_MAX),
      styles: {
        fontSize: stringValue(styles.fontSize),
        color: stringValue(styles.color),
        backgroundColor: stringValue(styles.backgroundColor),
      },
      rect: {
        x: numberOr(rect.x, 0),
        y: numberOr(rect.y, 0),
        w: numberOr(rect.w, 0),
        h: numberOr(rect.h, 0),
      },
      note: note,
      status: raw.status === 'applied' ? 'applied' : 'pending',
      order: numberOr(raw.order, index),
      createdAt: isoOrNow(raw.createdAt),
      updatedAt: isoOrNow(raw.updatedAt),
    };
    if (file) annotation.file = file;
    return annotation;
  }

  function annotationsForPage(url) {
    var items = [];
    for (var i = 0; i < S.annotations.length; i += 1) {
      var ann = S.annotations[i];
      if (ann.page && ann.page.url === url) items.push({ ann: ann, index: i });
    }
    items.sort(function (left, right) {
      if (left.ann.order !== right.ann.order) return left.ann.order - right.ann.order;
      return left.index - right.index;
    });
    return items.map(function (item) {
      return item.ann;
    });
  }

  function orderedPageAnnotations() {
    return annotationsForPage(S.pageUrl);
  }

  function hasPageAnnotations() {
    return orderedPageAnnotations().length > 0;
  }

  function findAnnotation(id) {
    for (var i = 0; i < S.annotations.length; i += 1) {
      if (S.annotations[i].id === id) return S.annotations[i];
    }
    return null;
  }

  function annotationNumber(ann) {
    if (!ann || !ann.page) return 0;
    var list = annotationsForPage(ann.page.url);
    for (var i = 0; i < list.length; i += 1) {
      if (list[i].id === ann.id) return i + 1;
    }
    return 0;
  }

  function nextOrder() {
    var list = annotationsForPage(S.pageUrl);
    var max = -1;
    for (var i = 0; i < list.length; i += 1) {
      if (typeof list[i].order === 'number' && list[i].order > max) max = list[i].order;
    }
    return max + 1;
  }

  function ingestAnnotations(raw, pageHint) {
    var next = [];
    if (Array.isArray(raw)) {
      for (var i = 0; i < raw.length; i += 1) {
        var ann = normalizeAnnotation(raw[i], i);
        if (ann) next.push(ann);
      }
    }
    /*
     * pageHint is informational: the live location is authoritative because a
     * preview can redirect between the ready handshake and init.
     */
    void pageHint;
    S.annotations = next;

    var cached = Object.create(null);
    var keepDocs = Object.create(null);
    next.forEach(function (item) {
      keepDocs[item.id] = true;
      if (S.elements[item.id]) cached[item.id] = S.elements[item.id];
    });
    Object.keys(S.docRects).forEach(function (id) {
      if (!keepDocs[id]) delete S.docRects[id];
    });
    S.elements = cached;

    if (S.card && S.card.ann) {
      var fresh = findAnnotation(S.card.ann.id);
      if (!fresh) {
        closeCard();
      } else {
        S.card.ann = fresh;
        if (S.card.kind === 'view') renderCard();
      }
    }

    renderPins();
    updateChrome();
  }

  /* ---------------------------------------------------------- selector etc */

  function testIdOf(el) {
    for (var i = 0; i < TESTID_ATTRS.length; i += 1) {
      var attr = TESTID_ATTRS[i];
      if (!el.getAttribute) continue;
      var value = el.getAttribute(attr);
      if (value) return { attr: attr, value: value };
    }
    return null;
  }

  function nthSuffix(el, force) {
    var parent = el.parentElement;
    if (!parent) return '';
    var siblings = [];
    for (var i = 0; i < parent.children.length; i += 1) {
      if (parent.children[i].tagName === el.tagName) siblings.push(parent.children[i]);
    }
    if (siblings.length > 1 || force) {
      return ':nth-of-type(' + (siblings.indexOf(el) + 1) + ')';
    }
    return '';
  }

  function uniqueSelector(selector) {
    if (!selector) return false;
    try {
      return document.querySelectorAll(selector).length === 1;
    } catch (e) {
      return false;
    }
  }

  /**
   * Stable-ish CSS path, capped at MAX_DEPTH:
   *   1. `#id` when the id is unique,
   *   2. nearest `[data-testid=...]` anchor (or an ancestor id),
   *   3. otherwise a `tag:nth-of-type(n)` chain.
   * Uniqueness is not guaranteed by the protocol; we verify and deepen when we
   * can, then return the best effort.
   */
  function selectorFor(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el.id) {
      var byId = '#' + cssEscape(el.id);
      if (uniqueSelector(byId)) return byId;
    }

    var parts = [];
    var node = el;
    var depth = 0;
    while (node && node.nodeType === 1 && node !== document.documentElement && depth < MAX_DEPTH) {
      var tag = node.tagName.toLowerCase();
      if (node !== el && node.id) {
        parts.unshift('#' + cssEscape(node.id));
        break;
      }
      var testId = testIdOf(node);
      if (node !== el && testId) {
        parts.unshift(tag + '[' + testId.attr + '=' + attrValue(testId.value) + ']');
        break;
      }
      if (node === el && testId) {
        parts.unshift(tag + '[' + testId.attr + '=' + attrValue(testId.value) + ']');
        break;
      }
      parts.unshift(tag + nthSuffix(node, false));
      if (node.parentElement && node.parentElement === document.body) break;
      node = node.parentElement;
      depth += 1;
    }

    var selector = parts.join(' > ');
    if (selector && uniqueSelector(selector)) return selector.slice(0, SELECTOR_MAX);

    /* Deep fallback: spell out the whole nth-of-type path from <body>. */
    var deep = [];
    var cursor = el;
    var guard = 0;
    while (cursor && cursor.nodeType === 1 && cursor !== document.documentElement && guard < MAX_DEPTH) {
      var name = cursor.tagName.toLowerCase();
      if (cursor.id) {
        deep.unshift('#' + cssEscape(cursor.id));
        break;
      }
      deep.unshift(name + nthSuffix(cursor, true));
      cursor = cursor.parentElement;
      guard += 1;
    }
    if (deep.length) {
      var deepSelector = deep.join(' > ');
      if (uniqueSelector(deepSelector)) return deepSelector.slice(0, SELECTOR_MAX);
      if (!selector) selector = deepSelector;
    }
    return selector.slice(0, SELECTOR_MAX);
  }

  function rectOf(el) {
    var rect = el.getBoundingClientRect();
    return {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
    };
  }

  function computedStylesOf(el) {
    try {
      var computed = window.getComputedStyle(el);
      return {
        fontSize: computed.fontSize,
        color: computed.color,
        backgroundColor: computed.backgroundColor,
      };
    } catch (e) {
      return { fontSize: '', color: '', backgroundColor: '' };
    }
  }

  function textSampleOf(el) {
    var text = '';
    try {
      text = el.innerText;
    } catch (e) {
      text = '';
    }
    if (!text) text = el.textContent || '';
    return clipText(text, TEXT_MAX);
  }

  function classNameOf(el) {
    if (!el.classList) return '';
    var classes = [];
    for (var i = 0; i < el.classList.length && classes.length < 3; i += 1) {
      classes.push(el.classList[i]);
    }
    return classes.join(' ').slice(0, CLASS_MAX);
  }

  function labelFor(el) {
    var tag = el.tagName ? el.tagName.toLowerCase() : 'element';
    var label = tag;
    if (el.id) {
      label += '#' + el.id;
    } else {
      var testId = testIdOf(el);
      if (testId) {
        label += '[' + testId.attr + '="' + testId.value + '"]';
      } else if (el.classList && el.classList.length) {
        label += '.' + el.classList[0];
      }
    }
    var rect = el.getBoundingClientRect();
    label += ' · ' + Math.round(rect.width) + '×' + Math.round(rect.height);
    return label.length > 90 ? label.slice(0, 89) + '…' : label;
  }

  function annotationLabel(ann) {
    var label = ann.tag || 'element';
    if (ann.className) label += '.' + ann.className.split(/\s+/)[0];
    return label;
  }

  function detailFor(el) {
    return {
      selector: selectorFor(el),
      tag: el.tagName ? el.tagName.toLowerCase() : '',
      className: classNameOf(el),
      textSample: textSampleOf(el),
      styles: computedStylesOf(el),
      rect: rectOf(el),
    };
  }

  function buildAnnotation(el, note) {
    var detail = detailFor(el);
    var timestamp = nowIso();
    var annotation = {
      id: uuid(),
      page: pageInfo(),
      selector: detail.selector.slice(0, SELECTOR_MAX),
      tag: detail.tag,
      className: detail.className,
      textSample: detail.textSample,
      styles: detail.styles,
      rect: detail.rect,
      note: note.slice(0, NOTE_MAX),
      status: 'pending',
      order: nextOrder(),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    var file = docFileInfo();
    if (file) annotation.file = file;
    return annotation;
  }

  function resolveElement(ann, canQuery) {
    var cached = S.elements[ann.id];
    if (cached && cached.isConnected) return cached;
    delete S.elements[ann.id];
    if (!canQuery) return null;
    var selector = ann.selector;
    if (!selector) return null;
    var el = null;
    try {
      var matches = document.querySelectorAll(selector);
      for (var i = 0; i < matches.length; i += 1) {
        var candidate = matches[i];
        if (!ann.tag || (candidate.tagName && candidate.tagName.toLowerCase() === ann.tag)) {
          el = candidate;
          break;
        }
      }
    } catch (e) {
      return null;
    }
    if (!el || !el.isConnected) return null;
    S.elements[ann.id] = el;
    return el;
  }

  /* -------------------------------------------------------------- mount UI */

  function buildRoot() {
    root = h('div', { id: 'das-root' });
    var styleEl = document.createElement('style');
    styleEl.id = 'das-style';
    styleEl.textContent = CSS;
    root.appendChild(styleEl);

    layer = h('div', { class: 'das-layer' });
    root.appendChild(layer);

    hoverBox = h('div', { class: 'das-hover' });
    hoverLabel = h('div', { class: 'das-hover-label' });
    hoverBox.appendChild(hoverLabel);
    layer.appendChild(hoverBox);

    pinsEl = h('div', { class: 'das-pins' });
    layer.appendChild(pinsEl);

    cardEl = h('section', { class: 'das-card', role: 'dialog', 'aria-label': '页面批注', hidden: 'hidden' });
    layer.appendChild(cardEl);

    indicatorEl = h('div', { class: 'das-indicator', 'aria-live': 'polite', hidden: 'hidden' }, [
      h('span', { class: 'das-indicator-dot' }),
      h('span', { text: PICK_HINT }),
    ]);
    layer.appendChild(indicatorEl);

    countEl = h('button', { class: 'das-count', type: 'button', hidden: 'hidden' });
    countEl.setAttribute('aria-expanded', 'false');
    countEl.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      toggleList();
    });
    layer.appendChild(countEl);

    fabEl = h('button', { class: 'das-fab', type: 'button' });
    fabEl.setAttribute('aria-label', '进入点选批注模式');
    fabEl.setAttribute('aria-pressed', 'false');
    fabEl.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      setMode(S.mode === 'picking' ? 'idle' : 'picking', true);
    });
    layer.appendChild(fabEl);

    listEl = h('section', { class: 'das-list', 'aria-label': '本页批注列表', hidden: 'hidden' });
    layer.appendChild(listEl);

    toastEl = h('div', { class: 'das-toast', role: 'status', 'aria-live': 'polite' });
    layer.appendChild(toastEl);

    document.documentElement.appendChild(root);
  }

  /* ------------------------------------------------------------------ mode */

  function setMode(nextMode, notify) {
    var mode = nextMode === 'picking' ? 'picking' : 'idle';
    var changed = mode !== S.mode;
    S.mode = mode;
    if (mode === 'idle') {
      S.hoverEl = null;
      S.pointer = null;
      hideHover();
      if (notify) closeCard();
    }
    syncModeChrome();
    if (changed && notify) post('mode', { mode: mode });
    scheduleUpdate();
    ensureLoop();
  }

  function syncModeChrome() {
    if (!S.mounted) return;
    var picking = S.mode === 'picking';
    indicatorEl.hidden = !picking;
    fabEl.textContent = picking ? '退出点选' : '点选批注';
    fabEl.className = 'das-fab' + (picking ? ' is-picking' : '');
    fabEl.setAttribute('aria-pressed', picking ? 'true' : 'false');
    fabEl.setAttribute('aria-label', picking ? '退出点选批注模式' : '进入点选批注模式');
  }

  /* ------------------------------------------------------------ hover/pick */

  function elementAt(x, y) {
    var el = document.elementFromPoint(x, y);
    if (!el || isOverlayNode(el)) return null;
    if (el === document.documentElement || el === document.body) return null;
    return el;
  }

  function hideHover() {
    if (!hoverBox) return;
    hoverBox.classList.remove('is-on');
  }

  function refreshHover() {
    if (!S.mounted || S.mode !== 'picking' || S.card || !S.pointer) {
      hideHover();
      return;
    }
    var el = elementAt(S.pointer.x, S.pointer.y);
    if (!el) {
      S.hoverEl = null;
      hideHover();
      return;
    }
    if (el !== S.hoverEl) {
      S.hoverEl = el;
      hoverLabel.textContent = labelFor(el);
    }
    var rect = el.getBoundingClientRect();
    var visible =
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom > 0 &&
      rect.top < window.innerHeight &&
      rect.right > 0 &&
      rect.left < window.innerWidth;
    if (!visible) {
      hideHover();
      return;
    }
    hoverBox.classList.add('is-on');
    hoverBox.style.left = rect.left + 'px';
    hoverBox.style.top = rect.top + 'px';
    hoverBox.style.width = rect.width + 'px';
    hoverBox.style.height = rect.height + 'px';
    hoverLabel.classList.toggle('das-below', rect.top < 32);
  }

  function openCreateCard(el) {
    if (!el || el.nodeType !== 1) return;
    S.hoverEl = null;
    hideHover();
    S.card = { kind: 'create', el: el, ann: null, detail: detailFor(el), draft: '' };
    cardEl.hidden = false;
    renderCard();
    anchorCard();
    focusEditor();
    scheduleUpdate();
    ensureLoop();
  }

  /* ------------------------------------------------------------------ pins */

  function renderPins() {
    if (!S.mounted) return;
    var list = orderedPageAnnotations();
    pinsEl.textContent = '';
    S.pinNodes = Object.create(null);
    list.forEach(function (ann, index) {
      var pin = h('button', {
        class: 'das-pin',
        type: 'button',
        title: ann.note,
        dataset: { id: ann.id, status: ann.status, orphan: '0' },
      });
      pin.textContent = String(index + 1);
      pin.setAttribute('aria-label', '查看批注 ' + (index + 1) + '：' + clipText(ann.note, 60));
      pin.addEventListener('click', function (event) {
        event.preventDefault();
        event.stopPropagation();
        if (S.card && (S.card.kind === 'create' || S.card.kind === 'edit')) return;
        focusAnnotation(ann.id);
        post('focus', { id: ann.id });
      });
      S.pinNodes[ann.id] = pin;
      pinsEl.appendChild(pin);
    });
    updatePinPositions();
    updateChrome();
    ensureLoop();
  }

  function setPinHidden(pin, hidden) {
    if (pin.hidden !== hidden) pin.hidden = hidden;
  }

  function movePin(pin, x, y) {
    var left = Math.round(x) + 'px';
    var top = Math.round(y) + 'px';
    if (pin.style.left !== left) pin.style.left = left;
    if (pin.style.top !== top) pin.style.top = top;
  }

  /*
   * Pins live in a fixed, zero-interaction layer so the overlay can never add a
   * scrollbar to the page. Their anchor is tracked in document space
   * (getBoundingClientRect() + scroll offsets), then converted back to viewport
   * coordinates for painting; this keeps pins glued to elements while scrolling
   * and gives orphaned annotations a stable fallback.
   */
  function updatePinPositions() {
    if (!S.mounted) return;
    var list = orderedPageAnnotations();
    var now = Date.now();
    var canQuery = now - S.lastOrphanQuery > 400;
    if (canQuery) S.lastOrphanQuery = now;

    for (var i = 0; i < list.length; i += 1) {
      var ann = list[i];
      var pin = S.pinNodes[ann.id];
      if (!pin) continue;
      var el = resolveElement(ann, canQuery);
      var rect = null;
      var orphan = false;

      if (el) {
        var live = el.getBoundingClientRect();
        if (live.width > 0 || live.height > 0) {
          rect = { left: live.left, top: live.top, width: live.width, height: live.height };
          S.docRects[ann.id] = {
            x: live.left + window.scrollX,
            y: live.top + window.scrollY,
            w: live.width,
            h: live.height,
          };
        }
      }

      if (!rect) {
        orphan = true;
        var doc = S.docRects[ann.id];
        if (!doc && ann.rect && (ann.rect.w > 0 || ann.rect.h > 0)) {
          doc = {
            x: ann.rect.x + window.scrollX,
            y: ann.rect.y + window.scrollY,
            w: ann.rect.w,
            h: ann.rect.h,
          };
          S.docRects[ann.id] = doc;
        }
        if (doc) {
          rect = {
            left: doc.x - window.scrollX,
            top: doc.y - window.scrollY,
            width: doc.w,
            height: doc.h,
          };
        }
      }

      if (!rect || (rect.width <= 0 && rect.height <= 0)) {
        setPinHidden(pin, true);
        continue;
      }
      var onScreen =
        rect.left + rect.width > 0 &&
        rect.top + rect.height > 0 &&
        rect.left < window.innerWidth &&
        rect.top < window.innerHeight;
      if (!onScreen) {
        setPinHidden(pin, true);
        continue;
      }
      setPinHidden(pin, false);
      /*
       * Anchor on the element's top-right corner: the pin sits half outside the
       * box so it rarely covers the content it points at, and stays clear of the
       * card, which docks to the right of the same corner.
       */
      var x = clamp(rect.left + rect.width, 12, window.innerWidth - 12);
      var y = clamp(rect.top, 12, window.innerHeight - 12);
      movePin(pin, x, y);
      var orphanValue = orphan ? '1' : '0';
      if (pin.dataset.orphan !== orphanValue) pin.dataset.orphan = orphanValue;
    }
  }

  function flashPin(id) {
    var pin = S.pinNodes && S.pinNodes[id];
    if (!pin) return;
    pin.classList.remove('is-flash');
    if (S.reducedMotion) return;
    void pin.offsetWidth;
    pin.classList.add('is-flash');
    if (S.flashTimer) clearTimeout(S.flashTimer);
    S.flashTimer = setTimeout(function () {
      pin.classList.remove('is-flash');
    }, 950);
  }

  /* ------------------------------------------------------------------ card */

  function actionButton(label, ariaLabel, handler, className) {
    var button = h('button', { class: className || 'das-btn', type: 'button', text: label });
    button.setAttribute('aria-label', ariaLabel);
    button.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      handler(event);
    });
    return button;
  }

  function closeCard() {
    S.card = null;
    if (cardEl) {
      cardEl.hidden = true;
      cardEl.textContent = '';
    }
    scheduleUpdate();
    ensureLoop();
  }

  function focusEditor() {
    if (!cardEl) return;
    var area = cardEl.querySelector('textarea.das-textarea');
    if (area) {
      try {
        area.focus({ preventScroll: true });
        area.setSelectionRange(area.value.length, area.value.length);
      } catch (e) {
        /* older engines */
      }
    }
  }

  function setCardError(message) {
    if (!cardEl) return;
    var hint = cardEl.querySelector('.das-hint');
    if (!hint) return;
    hint.textContent = message;
    hint.classList.add('is-error');
  }

  function renderCard() {
    if (!cardEl) return;
    cardEl.textContent = '';
    var card = S.card;
    if (!card) {
      cardEl.hidden = true;
      return;
    }
    var kind = card.kind;
    var ann = card.ann;

    var head = h('div', { class: 'das-card-head' });
    var titleText = kind === 'create' ? '添加批注' : kind === 'edit' ? '编辑批注' : '批注';
    if (ann) {
      var number = annotationNumber(ann);
      if (number) titleText += ' #' + number;
    }
    head.appendChild(h('span', { class: 'das-card-title', text: titleText }));
    if (ann) {
      head.appendChild(h('span', { class: 'das-badge', dataset: { status: ann.status }, text: STATUS_LABEL[ann.status] || '待处理' }));
    }
    var closeButton = h('button', { class: 'das-icon-btn', type: 'button', text: '✕' });
    closeButton.setAttribute('aria-label', '关闭批注卡片');
    closeButton.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      closeCard();
    });
    head.appendChild(closeButton);
    cardEl.appendChild(head);

    var liveEl = card.el && card.el.isConnected ? card.el : null;
    var label = liveEl ? labelFor(liveEl) : ann ? annotationLabel(ann) : '未知元素';
    cardEl.appendChild(h('div', { class: 'das-meta', text: label, title: label }));
    var selector = ann ? ann.selector : card.detail ? card.detail.selector : '';
    if (selector) {
      cardEl.appendChild(h('div', { class: 'das-meta das-mono', text: selector, title: selector }));
    }

    if (kind === 'view') renderViewBody(card, liveEl);
    else renderEditBody(card, kind);

    anchorCard();
    scheduleUpdate();
  }

  function renderViewBody(card, liveEl) {
    var ann = card.ann;
    cardEl.appendChild(h('div', { class: 'das-note', text: ann.note }));
    if (!liveEl) {
      cardEl.appendChild(h('p', { class: 'das-hint', text: '元素已不在当前页面上，这条批注仍保存在列表里。' }));
    }
    var actions = h('div', { class: 'das-actions' });
    actions.appendChild(
      actionButton('编辑', '编辑这条批注', function () {
        startEdit(ann);
      })
    );
    actions.appendChild(
      actionButton(ann.status === 'applied' ? '标记待处理' : '标记已处理', '切换批注状态', function () {
        toggleStatus(ann);
      })
    );
    actions.appendChild(
      actionButton(
        '删除',
        '删除这条批注',
        function () {
          deleteAnnotation(ann.id);
        },
        'das-btn das-btn-danger'
      )
    );
    actions.appendChild(h('span', { class: 'das-spacer' }));
    actions.appendChild(
      actionButton(
        '关闭',
        '关闭批注卡片',
        function () {
          closeCard();
        },
        'das-btn das-btn-ghost'
      )
    );
    cardEl.appendChild(actions);
  }

  function renderEditBody(card, kind) {
    var area = h('textarea', { class: 'das-textarea', rows: '3', placeholder: '描述这里应该怎么改…' });
    area.setAttribute('aria-label', '批注内容');
    area.maxLength = NOTE_MAX;
    area.value = kind === 'edit' && card.ann ? card.ann.note : card.draft || '';
    area.addEventListener('input', function () {
      card.draft = area.value;
      var hint = cardEl.querySelector('.das-hint');
      if (hint && hint.classList.contains('is-error')) {
        hint.textContent = EDIT_HINT;
        hint.classList.remove('is-error');
      }
    });
    area.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        submitCard();
      }
    });
    cardEl.appendChild(area);
    cardEl.appendChild(h('p', { class: 'das-hint', text: EDIT_HINT }));

    var actions = h('div', { class: 'das-actions' });
    actions.appendChild(h('span', { class: 'das-spacer' }));
    actions.appendChild(
      actionButton(
        '取消',
        '取消本次批注',
        function () {
          closeCard();
        },
        'das-btn das-btn-ghost'
      )
    );
    actions.appendChild(
      actionButton(
        '保存',
        '保存批注',
        function () {
          submitCard();
        },
        'das-btn das-btn-primary'
      )
    );
    cardEl.appendChild(actions);
  }

  function submitCard() {
    var card = S.card;
    if (!card || !cardEl) return;
    var area = cardEl.querySelector('textarea.das-textarea');
    var note = area ? area.value.trim() : '';
    if (!note) {
      setCardError('请先写下要修改什么');
      if (area) area.focus();
      return;
    }
    note = note.slice(0, NOTE_MAX);

    if (card.kind === 'create') {
      if (!card.el || !card.el.isConnected) {
        setCardError('元素已离开页面，无法保存');
        return;
      }
      var ann = buildAnnotation(card.el, note);
      S.annotations.push(ann);
      S.elements[ann.id] = card.el;
      S.docRects[ann.id] = {
        x: ann.rect.x + window.scrollX,
        y: ann.rect.y + window.scrollY,
        w: ann.rect.w,
        h: ann.rect.h,
      };
      post('create', { annotation: ann });
      closeCard();
      renderPins();
      updateChrome();
      toast('已添加批注 · 本页共 ' + orderedPageAnnotations().length + ' 条');
      return;
    }

    if (card.kind === 'edit' && card.ann) {
      var target = findAnnotation(card.ann.id) || card.ann;
      target.note = note;
      target.updatedAt = nowIso();
      post('update', { annotation: target });
      S.card = { kind: 'view', ann: target, el: card.el };
      renderCard();
      if (S.listOpen) renderList();
      toast('批注已更新');
    }
    scheduleUpdate();
    ensureLoop();
  }

  function startEdit(ann) {
    var target = findAnnotation(ann.id) || ann;
    var el = resolveElement(target, true);
    S.card = { kind: 'edit', ann: target, el: el, draft: target.note };
    cardEl.hidden = false;
    renderCard();
    focusEditor();
  }

  function toggleStatus(ann) {
    var target = findAnnotation(ann.id) || ann;
    target.status = target.status === 'applied' ? 'pending' : 'applied';
    target.updatedAt = nowIso();
    post('update', { annotation: target });
    if (S.card && S.card.ann && S.card.ann.id === target.id) {
      S.card.ann = target;
      if (S.card.kind === 'view') renderCard();
    }
    renderPins();
    updateChrome();
    if (S.listOpen) renderList();
    toast(target.status === 'applied' ? '已标记为已处理' : '已标记为待处理');
  }

  function deleteAnnotation(id) {
    var ann = findAnnotation(id);
    S.annotations = S.annotations.filter(function (item) {
      return item.id !== id;
    });
    delete S.elements[id];
    delete S.docRects[id];
    if (ann) post('remove', { id: id });
    if (S.card && S.card.ann && S.card.ann.id === id) closeCard();
    renderPins();
    updateChrome();
    if (S.listOpen) renderList();
    toast('已删除批注');
    scheduleUpdate();
    ensureLoop();
  }

  function focusAnnotation(id) {
    var ann = findAnnotation(id);
    if (!ann) return false;
    var el = resolveElement(ann, true);
    if (el) {
      try {
        el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
      } catch (e) {
        try {
          el.scrollIntoView();
        } catch (e2) {
          /* element vanished */
        }
      }
    }
    S.card = { kind: 'view', ann: ann, el: el };
    cardEl.hidden = false;
    renderCard();
    anchorCard();
    flashPin(id);
    if (!el) toast('元素已不在页面上，仅显示批注记录');
    scheduleUpdate();
    ensureLoop();
    return true;
  }

  function anchorCard() {
    if (!S.mounted || !S.card || !cardEl || cardEl.hidden) return;
    var width = cardEl.offsetWidth || 340;
    var height = cardEl.offsetHeight || 220;
    var viewportWidth = window.innerWidth;
    var viewportHeight = window.innerHeight;
    var left = null;
    var top = null;
    var rect = null;
    var el = S.card.el;
    if (el && el.isConnected) rect = el.getBoundingClientRect();
    if (rect && (rect.width > 0 || rect.height > 0)) {
      var gap = 12;
      if (rect.right + gap + width <= viewportWidth - 8) left = rect.right + gap;
      else if (rect.left - gap - width >= 8) left = rect.left - gap - width;
      else left = (viewportWidth - width) / 2;
      top = rect.top;
      if (top + height > viewportHeight - 8) top = viewportHeight - height - 8;
      if (top < 8) top = 8;
    } else {
      left = (viewportWidth - width) / 2;
      top = Math.max(8, (viewportHeight - height) / 2);
    }
    left = clamp(left, 8, Math.max(8, viewportWidth - width - 8));
    top = clamp(top, 8, Math.max(8, viewportHeight - height - 8));
    cardEl.style.left = Math.round(left) + 'px';
    cardEl.style.top = Math.round(top) + 'px';
  }

  /* -------------------------------------------------------------- list/pill */

  function openList() {
    S.listOpen = true;
    if (listEl) listEl.hidden = false;
    renderList();
    if (countEl) countEl.setAttribute('aria-expanded', 'true');
    ensureLoop();
  }

  function closeList() {
    S.listOpen = false;
    if (listEl) listEl.hidden = true;
    if (countEl) countEl.setAttribute('aria-expanded', 'false');
  }

  function toggleList() {
    if (S.listOpen) closeList();
    else openList();
  }

  function renderList() {
    if (!S.mounted || !S.listOpen || !listEl) return;
    listEl.textContent = '';
    var list = orderedPageAnnotations();
    var head = h('div', { class: 'das-list-head' });
    head.appendChild(h('span', { class: 'das-list-title', text: '本页批注 · ' + list.length }));
    var closeButton = h('button', { class: 'das-icon-btn', type: 'button', text: '✕' });
    closeButton.setAttribute('aria-label', '关闭批注列表');
    closeButton.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      closeList();
    });
    head.appendChild(closeButton);
    listEl.appendChild(head);

    if (!list.length) {
      listEl.appendChild(h('p', { class: 'das-empty', text: '本页还没有批注。点击右下角「点选批注」开始。' }));
      return;
    }

    var body = h('div', { class: 'das-list-body' });
    list.forEach(function (ann, index) {
      var liveEl = resolveElement(ann, true);
      var row = h('button', { class: 'das-row', type: 'button' });
      row.setAttribute('aria-label', '定位第 ' + (index + 1) + ' 条批注');
      row.appendChild(h('span', { class: 'das-row-no', text: String(index + 1) }));
      var main = h('span', { class: 'das-row-main' });
      main.appendChild(h('span', { class: 'das-row-note', text: ann.note }));
      main.appendChild(
        h('span', {
          class: 'das-row-meta',
          text: (liveEl ? '' : '元素未找到 · ') + annotationLabel(ann),
        })
      );
      row.appendChild(main);
      row.appendChild(h('span', { class: 'das-badge', dataset: { status: ann.status }, text: STATUS_LABEL[ann.status] || '待处理' }));
      row.addEventListener('click', function (event) {
        event.preventDefault();
        event.stopPropagation();
        closeList();
        focusAnnotation(ann.id);
        post('focus', { id: ann.id });
      });
      body.appendChild(row);
    });
    listEl.appendChild(body);
    listEl.appendChild(h('p', { class: 'das-list-hint', text: '元素不在页面上时记录仍会保留，可在这里重新打开。' }));
  }

  function updateChrome() {
    if (!S.mounted) return;
    var count = orderedPageAnnotations().length;
    countEl.textContent = count + ' 条批注';
    countEl.setAttribute('aria-label', '查看本页批注列表（共 ' + count + ' 条）');
    countEl.hidden = count === 0;
    countEl.setAttribute('aria-expanded', S.listOpen ? 'true' : 'false');
    if (count === 0 && S.listOpen) closeList();
    syncModeChrome();
    if (S.listOpen) renderList();
  }

  function toast(message) {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.classList.add('is-on');
    if (S.toastTimer) clearTimeout(S.toastTimer);
    S.toastTimer = setTimeout(function () {
      toastEl.classList.remove('is-on');
    }, 2600);
  }

  /* ------------------------------------------------------ position updates */

  function updatePositions() {
    if (!S.mounted) return;
    updatePinPositions();
    if (S.card) anchorCard();
    if (S.mode === 'picking' && !S.card) refreshHover();
    else hideHover();
  }

  /*
   * Coalesce geometry reads into one frame. rAF is the fast path; a short
   * timeout keeps scroll/resize tracking alive in environments where frames
   * are throttled (background tabs, some headless/compositor states).
   */
  function scheduleUpdate() {
    if (!S.mounted || S.rafId || S.timerId) return;
    var ran = false;
    function run() {
      if (ran) return;
      ran = true;
      if (S.rafId) {
        window.cancelAnimationFrame(S.rafId);
        S.rafId = 0;
      }
      if (S.timerId) {
        clearTimeout(S.timerId);
        S.timerId = 0;
      }
      updatePositions();
    }
    S.rafId = window.requestAnimationFrame(run);
    S.timerId = setTimeout(run, 50);
  }

  function ensureLoop() {
    if (!S.mounted || S.loopId) return;
    if (!(hasPageAnnotations() || S.card || S.mode !== 'idle' || S.listOpen)) return;
    S.loopId = window.requestAnimationFrame(loop);
  }

  function loop() {
    S.loopId = 0;
    updatePositions();
    if (hasPageAnnotations() || S.card || S.mode !== 'idle' || S.listOpen) {
      S.loopId = window.requestAnimationFrame(loop);
    }
  }

  /* -------------------------------------------------------------- messages */

  function handleMessage(data) {
    if (!data || typeof data.type !== 'string') return;
    switch (data.type) {
      case 'init':
        ingestAnnotations(data.annotations, data.pageUrl);
        if (data.mode === 'picking') setMode('picking', false);
        else if (data.mode === 'idle') setMode('idle', false);
        break;
      case 'set-annotations':
        ingestAnnotations(data.annotations);
        break;
      case 'set-mode':
        setMode(data.mode, false);
        break;
      case 'focus':
        if (typeof data.id === 'string' && data.id) focusAnnotation(data.id);
        break;
      case 'navigate':
        try {
          window.history.go(data.delta === -1 ? -1 : 1);
        } catch (e) {
          /* history unavailable */
        }
        break;
      case 'reload':
        try {
          location.reload();
        } catch (e) {
          /* opaque sandbox may refuse; the host rebuilds the frame instead */
        }
        break;
      case 'ping':
        postReady();
        break;
      default:
        break;
    }
  }

  function onMessage(event) {
    /*
     * Doc mode: the iframe has an opaque origin, but the sender's origin is
     * still the real parent origin (the harness page), so the same check works.
     * The source must be this frame's actual parent; a same-origin-looking
     * message from any other window is ignored.
     */
    if (!event || event.origin !== PARENT_ORIGIN) return;
    if (event.source !== window.parent) return;
    var data = event.data;
    if (!data || typeof data !== 'object' || data.channel !== CHANNEL) return;
    if (!S.mounted) {
      S.pendingMessages.push(data);
      return;
    }
    handleMessage(data);
  }

  /* ---------------------------------------------------------------- events */

  function blockPageEvent(event) {
    if (S.mode !== 'picking') return;
    if (isOverlayNode(event.target)) return;
    if (event.type === 'contextmenu') {
      event.preventDefault();
      event.stopImmediatePropagation();
      setMode('idle', true);
      return;
    }
    if (event.type === 'dragstart') {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (event.type === 'pointerdown' || event.type === 'pointerup') {
      /* Keep pointer defaults (touch scrolling) but mute app handlers. */
      event.stopImmediatePropagation();
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function onClickCapture(event) {
    var target = nearestElement(event.target);
    if (isOverlayNode(target)) return;

    if (S.mode !== 'picking') {
      if (S.card) closeCard();
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();

    if (!target) return;
    if (target === document.documentElement || target === document.body) return;
    if (S.card && (S.card.kind === 'create' || S.card.kind === 'edit')) {
      /* Never discard an in-progress note by clicking the page behind it. */
      focusEditor();
      return;
    }
    openCreateCard(target);
  }

  function onKeyDown(event) {
    if (event.key !== 'Escape' && event.key !== 'Esc') return;
    if (S.card) {
      event.preventDefault();
      event.stopPropagation();
      closeCard();
      return;
    }
    if (S.listOpen) {
      event.preventDefault();
      event.stopPropagation();
      closeList();
      return;
    }
    if (S.mode === 'picking') {
      event.preventDefault();
      event.stopPropagation();
      setMode('idle', true);
    }
  }

  function onMouseMove(event) {
    if (S.mode !== 'picking') return;
    S.pointer = { x: event.clientX, y: event.clientY };
    scheduleUpdate();
  }

  function onViewportChange() {
    scheduleUpdate();
  }

  function handleNavigation(forceReady) {
    var nextUrl = currentPageUrl();
    var changed = nextUrl !== S.pageUrl;
    if (changed) {
      S.pageUrl = nextUrl;
      S.elements = Object.create(null);
      S.docRects = Object.create(null);
      S.hoverEl = null;
      S.pointer = null;
      hideHover();
      if (S.card) closeCard();
      renderPins();
      updateChrome();
    }
    if (changed || forceReady) postReady();
    scheduleUpdate();
    ensureLoop();
  }

  function patchHistory() {
    ['pushState', 'replaceState'].forEach(function (method) {
      var original = window.history[method];
      if (typeof original !== 'function') return;
      window.history[method] = function () {
        var result = original.apply(this, arguments);
        handleNavigation(false);
        return result;
      };
    });
    window.addEventListener('popstate', function () {
      handleNavigation(true);
    });
    window.addEventListener('hashchange', function () {
      handleNavigation(true);
    });
  }

  function bindEvents() {
    document.addEventListener('mousemove', onMouseMove, { capture: true, passive: true });
    document.addEventListener('click', onClickCapture, true);
    ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'dblclick', 'auxclick', 'contextmenu', 'dragstart'].forEach(function (type) {
      document.addEventListener(type, blockPageEvent, true);
    });
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('scroll', onViewportChange, { capture: true, passive: true });
    window.addEventListener('resize', onViewportChange);
    if (typeof window.ResizeObserver === 'function') {
      try {
        var observer = new window.ResizeObserver(onViewportChange);
        observer.observe(document.documentElement);
      } catch (e) {
        /* very old engines rely on scroll/resize only */
      }
    }
    patchHistory();
  }

  /* ------------------------------------------------------------------- boot */

  function boot() {
    if (S.mounted) return;
    if (document.getElementById('das-root')) return;
    buildRoot();
    S.mounted = true;
    S.docTitle = DOC_MODE ? docTitle() : '';
    bindEvents();
    renderPins();
    updateChrome();
    postReady();
    ensureLoop();
    /*
     * Last-resort geometry tick: requestAnimationFrame is paused in hidden
     * preview iframes and some throttled states, and scroll events are delivered
     * with frames. A slow timer keeps pins and the open card attached to their
     * elements even then; it is a no-op when there is nothing to position.
     */
    S.watchTimer = setInterval(function () {
      if (!S.mounted) return;
      checkDocTitle();
      if (hasPageAnnotations() || S.card || S.mode !== 'idle' || S.listOpen) updatePositions();
    }, 300);
    var pending = S.pendingMessages.splice(0, S.pendingMessages.length);
    pending.forEach(handleMessage);
  }

  /*
   * Register for panel messages before the first paint: the panel may send
   * `init` right after the iframe load event, and nothing should be dropped.
   */
  window.addEventListener('message', onMessage, false);

  if (document.body || document.readyState !== 'loading') boot();
  else document.addEventListener('DOMContentLoaded', boot, { once: true });
})();
