// dsh-annotate-sync — browser / UI half (right-sidebar panel + composer dock).
//
// This is a classic script on purpose: the DeepSeek Harness client loader hands
// it `require('react')` and loads it without a bundler. It must stay free of
// ESM syntax (`node --check` has to pass, and the file is served verbatim).
//
// Talks to:
//   - the host half over POST /__dsh-annotate-sync/api   (PROTOCOL.md §5)
//   - the injected overlay over window.postMessage       (PROTOCOL.md §6)
//
// The panel is the only writer of annotations: overlay changes are collected
// here, debounced 300 ms, saved, and echoed back to the overlay.
window.__ModuleLoader__.load({
  id: 'dsh-annotate-sync',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const React = require('react');
    const h = React.createElement;

    // ---------------------------------------------------------------- i18n
    // Default zh; switch to en when the harness document is English.
    const CATALOG = {
      zh: {
        'tab.title': '批注',
        'tab.desc': '在侧边栏预览本地应用，点选元素写批注，并按页面分组发送到对话。',

        'list.title': '本地服务',
        'list.autoRefresh': '每 5 秒自动检测',
        'list.refresh': '重新检测',
        'list.scanning': '正在检测本地服务…',
        'list.empty': '没有检测到本地运行的服务',
        'list.emptyHint': '先在项目里启动开发服务器（例如 npm run dev），插件会每 5 秒自动检测一次。',
        'list.manual': '手动打开本机地址',
        'list.manualPlaceholder': '5173 或 localhost:3000',
        'list.open': '打开',
        'list.responseMs': '{ms} ms',
        'list.found': '检测到 {count} 个本地服务',
        'list.titleFallback': '本地服务',

        'page.back': '返回服务列表',
        'page.reload': '刷新预览页面',
        'page.mark': '点选',
        'page.marking': '点选中…',
        'page.markHint': '点选模式下点击页面元素即可写批注，Esc 退出',
        'page.list': '批注列表',
        'page.width': '切换预览宽度',
        'page.send': '发送批注',
        'page.sending': '发送中…',
        'page.attach': '加入输入框',
        'page.pending': '{count} 条待处理',
        'page.loading': '正在打开预览…',
        'page.loadingHint': '连接本地服务并注入批注脚本',
        'page.error': '预览打开失败',
        'page.retry': '重试',
        'page.widthFit': '适应宽度',
        'page.widthMobile': '手机宽度',

        'filter.all': '全部',
        'filter.pending': '待处理',
        'filter.applied': '已处理',
        'list.emptyAnno': '暂无批注',
        'list.emptyFilter': '当前筛选下没有批注',
        'list.annoCount': '{count} 条',

        'anno.focus': '在页面中定位',
        'anno.edit': '编辑批注',
        'anno.save': '保存',
        'anno.cancel': '取消',
        'anno.delete': '删除批注',
        'anno.toggle': '切换处理状态',
        'anno.up': '上移',
        'anno.down': '下移',
        'anno.clear': '清空全部',
        'anno.confirmClear': '确认清空全部批注？',
        'anno.confirm': '确认清空',

        'status.pending': '待处理',
        'status.applied': '已处理',

        'notice.pluginUnavailable': '插件服务不可用，请确认 Harness 已加载 dsh-annotate-sync',
        'notice.detectFailed': '检测本地服务失败',
        'notice.badAddress': '地址无效，请输入 localhost:5173 或 5173',
        'notice.notLocal': '只支持本机回环地址（localhost / 127.0.0.1）',
        'notice.previewFailed': '预览打开失败',
        'notice.loadTimeout': '加载超时，请确认本地服务可用',
        'notice.saveFailed': '保存失败，请稍后重试',
        'notice.saved': '已保存',
        'notice.cleared': '已清空全部批注',
        'notice.clearFailed': '清空失败',
        'notice.deleted': '已删除批注',
        'notice.noteEmpty': '批注内容不能为空',
        'notice.sent': '已发送 {count} 条批注',
        'notice.sendFailed': '发送失败：{error}',
        'notice.sendUnavailable': '当前会话不支持直接发送，请改用「加入输入框」',
        'notice.attached': '已加入输入框',
        'notice.attachFailed': '加入输入框失败',
        'notice.noComposer': '输入框不可用',
        'notice.otherPage': '该批注属于其他页面，正在打开对应页面…',

        'dock.chip': '批注 {count}',
        'dock.open': '打开批注面板',

        'block.head': '页面批注（共 {count} 条，按页面分组）：',
        'block.url': '页面：{url}',
        'block.selector': '元素：{selector}',
        'block.tag': '标签：<{tag}>',
        'block.text': '当前文本：{text}',
        'block.style': '样式：字号 {fontSize}，颜色 {color}，背景 {backgroundColor}',
        'block.status': '状态：{status}',
        'block.note': '批注：**{note}**',
      },
      en: {
        'tab.title': 'Annotations',
        'tab.desc': 'Preview a local app in the sidebar, pick elements, and send page-scoped notes to the conversation.',

        'list.title': 'Local services',
        'list.autoRefresh': 'Checked every 5s',
        'list.refresh': 'Scan again',
        'list.scanning': 'Scanning local services…',
        'list.empty': 'No local service is running',
        'list.emptyHint': 'Start a dev server (for example npm run dev); this panel re-scans every 5 seconds.',
        'list.manual': 'Open a local address',
        'list.manualPlaceholder': '5173 or localhost:3000',
        'list.open': 'Open',
        'list.responseMs': '{ms} ms',
        'list.found': '{count} local services found',
        'list.titleFallback': 'Local service',

        'page.back': 'Back to the service list',
        'page.reload': 'Reload the preview',
        'page.mark': 'Mark',
        'page.marking': 'Marking…',
        'page.markHint': 'In mark mode, click an element in the page to write a note. Esc leaves mark mode.',
        'page.list': 'Annotation list',
        'page.width': 'Toggle preview width',
        'page.send': 'Send annotations',
        'page.sending': 'Sending…',
        'page.attach': 'Add to composer',
        'page.pending': '{count} pending',
        'page.loading': 'Opening the preview…',
        'page.loadingHint': 'Connecting to the local service and injecting the overlay',
        'page.error': 'Preview unavailable',
        'page.retry': 'Retry',
        'page.widthFit': 'Fit width',
        'page.widthMobile': 'Mobile width',

        'filter.all': 'All',
        'filter.pending': 'Pending',
        'filter.applied': 'Applied',
        'list.emptyAnno': 'No annotations yet',
        'list.emptyFilter': 'No annotations match this filter',
        'list.annoCount': '{count}',

        'anno.focus': 'Locate in the preview',
        'anno.edit': 'Edit annotation',
        'anno.save': 'Save',
        'anno.cancel': 'Cancel',
        'anno.delete': 'Delete annotation',
        'anno.toggle': 'Toggle status',
        'anno.up': 'Move up',
        'anno.down': 'Move down',
        'anno.clear': 'Clear all',
        'anno.confirmClear': 'Clear all annotations?',
        'anno.confirm': 'Clear all',

        'status.pending': 'Pending',
        'status.applied': 'Applied',

        'notice.pluginUnavailable': 'The plugin service is unavailable. Confirm that Harness loaded dsh-annotate-sync.',
        'notice.detectFailed': 'Could not scan local services',
        'notice.badAddress': 'Invalid address. Try localhost:5173 or 5173.',
        'notice.notLocal': 'Only loopback addresses (localhost / 127.0.0.1) are supported.',
        'notice.previewFailed': 'Could not open the preview',
        'notice.loadTimeout': 'The preview took too long to load. Check the local service and retry.',
        'notice.saveFailed': 'Save failed. Please retry.',
        'notice.saved': 'Saved',
        'notice.cleared': 'All annotations cleared',
        'notice.clearFailed': 'Could not clear annotations',
        'notice.deleted': 'Annotation deleted',
        'notice.noteEmpty': 'The note cannot be empty',
        'notice.sent': 'Sent {count} annotations',
        'notice.sendFailed': 'Send failed: {error}',
        'notice.sendUnavailable': 'This conversation cannot send directly; use “Add to composer” instead.',
        'notice.attached': 'Added to the composer',
        'notice.attachFailed': 'Could not add to the composer',
        'notice.noComposer': 'The composer is unavailable',
        'notice.otherPage': 'This annotation belongs to another page; opening it…',

        'dock.chip': 'Annotations {count}',
        'dock.open': 'Open the annotation panel',

        'block.head': 'Page annotations ({count} total, grouped by page):',
        'block.url': 'Page: {url}',
        'block.selector': 'Element: {selector}',
        'block.tag': 'Tag: <{tag}>',
        'block.text': 'Current text: {text}',
        'block.style': 'Styles: font-size {fontSize}, color {color}, background {backgroundColor}',
        'block.status': 'Status: {status}',
        'block.note': 'Note: **{note}**',
      },
    };

    const detectLang = () => {
      try {
        const lang = document && document.documentElement && document.documentElement.lang;
        return typeof lang === 'string' && lang.toLowerCase().indexOf('en') === 0 ? 'en' : 'zh';
      } catch (error) {
        return 'zh';
      }
    };
    let LANG = detectLang();
    const t = (key, vars) => {
      const table = CATALOG[LANG] || CATALOG.zh;
      const english = CATALOG.en;
      let text = table[key];
      if (text === undefined) text = english[key];
      if (text === undefined) text = key;
      if (!vars) return text;
      return String(text).replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name) =>
        Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match,
      );
    };

    // ----------------------------------------------------------- constants
    const inject = ['timer', 'sessions', 'slots', 'sidebarRight', 'sidebarRightTabs'];
    const TAB_ID = 'annotate-sync';
    const KIND = 'annotate-sync';
    const API_PATH = '/__dsh-annotate-sync/api';
    const CHANNEL = 'dsh-annotate-sync';
    const SAVE_DEBOUNCE_MS = 300;
    const DETECT_INTERVAL_MS = 5000;
    const LOAD_TIMEOUT_MS = 20000;
    const SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-modals';
    const PANEL_VIEW = 'sidebar.right.pane.tab';
    const DOCK_VIEW = 'conversation.input.dock';

    const warned = Object.create(null);
    const warnOnce = (key, message, error) => {
      if (warned[key]) return;
      warned[key] = true;
      try {
        // eslint-disable-next-line no-console
        console.warn('[dsh-annotate-sync] ' + message, error || '');
      } catch (ignored) {
        void ignored;
      }
    };

    // --------------------------------------------------------------- util
    const nowIso = () => new Date().toISOString();
    const isPending = (annotation) => !annotation || annotation.status !== 'applied';
    const truncate = (value, max) => {
      const text = String(value === undefined || value === null ? '' : value);
      return text.length > max ? text.slice(0, max) : text;
    };
    const pageUrlOf = (annotation) => {
      const page = annotation && annotation.page;
      const url = page && typeof page.url === 'string' ? page.url : '';
      return url || 'unknown';
    };
    const pageTitleOf = (annotation) => {
      const page = annotation && annotation.page;
      return page && typeof page.title === 'string' ? page.title : '';
    };
    const isLoopback = (hostname) => {
      const host = String(hostname || '').toLowerCase();
      return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]' || host.indexOf('127.') === 0;
    };
    const newLease = () => {
      try {
        if (typeof crypto !== 'undefined' && crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
      } catch (error) {
        void error;
      }
      return 'lease-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    };
    const normalizeAddress = (input) => {
      const raw = String(input || '').trim();
      if (!raw) return null;
      let candidate = raw;
      if (/^\d{2,5}$/.test(candidate)) candidate = 'http://127.0.0.1:' + candidate + '/';
      else if (candidate.charAt(0) === ':') candidate = 'http://127.0.0.1' + candidate;
      else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) candidate = 'http://' + candidate;
      try {
        const url = new URL(candidate);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
        if (!isLoopback(url.hostname)) return null;
        return url.href;
      } catch (error) {
        return null;
      }
    };
    /** Map a target URL onto its loopback preview origin (path + query kept). */
    const proxyUrl = (origin, target) => {
      try {
        const url = new URL(target);
        return String(origin).replace(/\/$/, '') + url.pathname + url.search + url.hash;
      } catch (error) {
        return String(origin).replace(/\/$/, '') + '/';
      }
    };

    /** Group annotations by page.url; items ordered by `order` then array position. */
    const groupByPage = (annotations) => {
      const groups = [];
      const index = new Map();
      const sorted = Array.isArray(annotations) ? annotations.slice() : [];
      sorted.sort((a, b) => {
        const ua = pageUrlOf(a);
        const ub = pageUrlOf(b);
        if (ua !== ub) return ua < ub ? -1 : 1;
        const oa = typeof a.order === 'number' ? a.order : 0;
        const ob = typeof b.order === 'number' ? b.order : 0;
        return oa - ob;
      });
      sorted.forEach((annotation) => {
        const url = pageUrlOf(annotation);
        let group = index.get(url);
        if (!group) {
          group = { url, title: pageTitleOf(annotation), items: [] };
          index.set(url, group);
          groups.push(group);
        }
        if (!group.title) group.title = pageTitleOf(annotation);
        group.items.push(annotation);
      });
      return groups;
    };

    // ------------------------------------------------------------ host API
    const api = async (method, args) => {
      try {
        const init = {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ method, args: args || {} }),
        };
        try {
          if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
            init.signal = AbortSignal.timeout(LOAD_TIMEOUT_MS);
          }
        } catch (error) {
          void error;
        }
        const response = await fetch(API_PATH, init);
        const payload = await response.json();
        if (!payload || typeof payload !== 'object') return { ok: false, error: 'bad response' };
        return payload;
      } catch (error) {
        return { ok: false, error: String((error && error.message) || error) };
      }
    };

    // --------------------------------------------------------------- style
    const PANEL_CSS = `
.das-panel, .das-dock {
  --das-fallback-ink:#1f2328; --das-fallback-muted:#6b7280; --das-fallback-bg:#ffffff;
  --das-fallback-surface:#f6f7f9; --das-fallback-line:rgba(15,23,42,.12);
  --das-fallback-accent:#2563eb; --das-fallback-danger:#c0392b; --das-fallback-ok:#2f855a;
  --das-ink:var(--dsw-alias-label-primary,var(--das-fallback-ink));
  --das-muted:var(--dsw-alias-label-secondary,var(--das-fallback-muted));
  --das-bg:var(--dsw-alias-bg-base,var(--das-fallback-bg));
  --das-surface:var(--dsw-alias-bg-layer-1,var(--das-fallback-surface));
  --das-surface-2:var(--dsw-alias-bg-layer-2,var(--das-fallback-surface));
  --das-line:var(--dsw-alias-border-primary,var(--das-fallback-line));
  --das-accent:var(--dsw-alias-brand-primary,var(--das-fallback-accent));
  --das-danger:var(--dsw-alias-state-error-primary,var(--das-fallback-danger));
  --das-ok:var(--dsw-alias-state-success-primary,var(--das-fallback-ok));
  --das-sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI","PingFang SC",sans-serif;
  --das-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
@media (prefers-color-scheme: dark) {
  .das-panel, .das-dock {
    --das-fallback-ink:#e8eaed; --das-fallback-muted:#9aa0a6; --das-fallback-bg:#1b1c1e;
    --das-fallback-surface:#242629; --das-fallback-line:rgba(255,255,255,.15);
    --das-fallback-accent:#7cb0ff; --das-fallback-danger:#ff8b83; --das-fallback-ok:#7ddba3;
  }
}
.das-panel { display:flex; flex-direction:column; height:100%; min-height:0; min-width:0; position:relative; color:var(--das-ink);
  background:var(--das-bg); font:13px/1.5 var(--das-sans); container-type:inline-size; }
.das-panel *, .das-dock * { box-sizing:border-box; }
.das-panel button, .das-dock button { font:inherit; color:inherit; cursor:pointer; }
.das-panel button:disabled, .das-dock button:disabled { opacity:.4; cursor:default; }
.das-panel button:focus-visible, .das-panel input:focus-visible, .das-panel textarea:focus-visible {
  outline:2px solid var(--das-accent); outline-offset:1px; }
.das-bar { display:flex; align-items:center; gap:4px; padding:6px 8px; flex:none;
  background:var(--das-surface); border-bottom:1px solid var(--das-line); }
.das-ico { display:inline-flex; align-items:center; justify-content:center; gap:4px; width:30px; height:30px;
  padding:0; border:0; border-radius:7px; background:transparent; color:var(--das-muted); flex:none; }
.das-ico:hover:not(:disabled) { background:color-mix(in srgb,var(--das-ink) 7%,transparent); color:var(--das-ink); }
.das-ico[data-on="true"] { background:color-mix(in srgb,var(--das-ink) 9%,transparent); color:var(--das-ink); }
.das-ico svg { width:15px; height:15px; }
.das-mark { width:auto; padding:0 9px; gap:5px; font-size:12px; white-space:nowrap; }
.das-mark[data-on="true"] { background:color-mix(in srgb,var(--das-accent) 18%,transparent); color:var(--das-ink); }
.das-badge { display:inline-flex; align-items:center; justify-content:center; min-width:16px; height:16px; padding:0 4px;
  border-radius:8px; background:var(--das-accent); color:#fff; font:600 9px/1 var(--das-mono); }
.das-spacer { flex:1; min-width:2px; }
.das-btn { display:inline-flex; align-items:center; justify-content:center; gap:5px; height:29px; padding:0 10px;
  border:1px solid var(--das-line); border-radius:7px; background:transparent; color:var(--das-ink);
  font-size:12px; white-space:nowrap; }
.das-btn:hover:not(:disabled) { background:color-mix(in srgb,var(--das-ink) 6%,transparent); }
.das-btn.primary { background:var(--das-ink); border-color:transparent; color:var(--das-bg); }
.das-btn.primary:hover:not(:disabled) { opacity:.85; }
.das-btn.danger { color:var(--das-danger); border-color:color-mix(in srgb,var(--das-danger) 40%,var(--das-line)); }
.das-btn.ghost { border-color:transparent; color:var(--das-muted); }
.das-send { height:30px; padding:0 12px; border:0; border-radius:8px; background:var(--das-ink); color:var(--das-bg);
  font-size:12px; white-space:nowrap; }
.das-send:hover:not(:disabled) { opacity:.85; }
.das-urlbar { display:flex; align-items:center; gap:8px; padding:4px 10px; flex:none;
  background:var(--das-surface); border-bottom:1px solid var(--das-line); }
.das-urlbar code { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  color:var(--das-muted); font:11px/1.7 var(--das-mono); }
.das-stage { position:relative; flex:1; min-height:0; display:flex; background:var(--das-bg); overflow:hidden; }
.das-frame-wrap { flex:1; min-width:0; display:flex; justify-content:center; background:var(--das-surface-2); }
.das-frame-wrap[data-width="mobile"] { flex:0 0 auto; width:390px; max-width:100%; margin:0 auto;
  border-left:1px solid var(--das-line); border-right:1px solid var(--das-line); }
.das-frame { width:100%; height:100%; border:0; display:block; background:#fff; flex:1; }
.das-overlay { position:absolute; inset:0; z-index:3; display:flex; flex-direction:column; align-items:center;
  justify-content:center; gap:8px; padding:24px; text-align:center; background:color-mix(in srgb,var(--das-bg) 92%,transparent); }
.das-overlay b { font-size:13px; font-weight:600; }
.das-overlay p { margin:0; max-width:320px; color:var(--das-muted); font-size:12px; line-height:1.6; }
.das-spinner { width:22px; height:22px; border:2px solid var(--das-line); border-top-color:var(--das-accent);
  border-radius:50%; animation:das-spin .9s linear infinite; }
@keyframes das-spin { to { transform:rotate(360deg); } }
.das-toast { position:absolute; z-index:6; left:50%; bottom:14px; transform:translateX(-50%); max-width:calc(100% - 24px);
  padding:7px 11px; border:1px solid var(--das-line); border-radius:9px; background:var(--das-surface);
  color:var(--das-ink); font-size:12px; box-shadow:0 4px 16px rgba(0,0,0,.18); }
.das-toast[data-kind="error"] { border-color:color-mix(in srgb,var(--das-danger) 45%,var(--das-line)); }
.das-list { flex:1; min-height:0; overflow:auto; padding:12px; }
.das-list-head { display:flex; align-items:center; gap:8px; }
.das-list-head b { font-size:13px; font-weight:600; }
.das-list-head .das-sub { flex:1; color:var(--das-muted); font-size:11px; }
.das-hint { padding:14px; color:var(--das-muted); font-size:12px; line-height:1.7; text-align:center; }
.das-empty { display:flex; flex-direction:column; align-items:center; gap:6px; padding:26px 14px; text-align:center; }
.das-empty b { font-size:13px; font-weight:600; }
.das-empty p { margin:0; max-width:330px; color:var(--das-muted); font-size:12px; line-height:1.7; }
.das-svc { display:flex; align-items:center; gap:9px; width:100%; margin-top:8px; padding:10px; text-align:left;
  border:1px solid var(--das-line); border-radius:9px; background:var(--das-surface); }
.das-svc:hover { border-color:color-mix(in srgb,var(--das-ink) 26%,var(--das-line)); }
.das-svc-dot { width:7px; height:7px; border-radius:50%; flex:none; background:var(--das-ok); }
.das-svc-main { flex:1; min-width:0; }
.das-svc-main b { display:block; font-size:12px; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.das-svc-main span { display:block; margin-top:2px; color:var(--das-muted); font:10.5px/1.5 var(--das-mono);
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.das-svc-meta { flex:none; color:var(--das-muted); font:10px var(--das-mono); }
.das-manual { margin-top:16px; padding-top:12px; border-top:1px solid var(--das-line); }
.das-label { display:block; margin-bottom:6px; color:var(--das-muted); font-size:11px; }
.das-manual-row { display:flex; gap:6px; }
.das-input { flex:1; min-width:0; height:30px; padding:0 9px; border:1px solid var(--das-line); border-radius:7px;
  background:var(--das-surface); color:var(--das-ink); font:12px var(--das-sans); }
.das-annolist { flex:0 1 auto; min-height:0; max-height:46%; overflow:auto; border-top:1px solid var(--das-line);
  background:var(--das-bg); }
.das-annolist-head { position:sticky; top:0; z-index:2; display:flex; align-items:center; gap:8px; padding:7px 10px;
  background:var(--das-bg); border-bottom:1px solid var(--das-line); }
.das-filters { display:flex; gap:3px; flex:1; }
.das-filter { height:25px; padding:0 8px; border:0; border-radius:6px; background:transparent;
  color:var(--das-muted); font-size:11px; }
.das-filter[data-active="true"] { background:color-mix(in srgb,var(--das-ink) 9%,transparent); color:var(--das-ink); }
.das-link { border:0; background:transparent; padding:4px 6px; border-radius:5px; font-size:11px; color:var(--das-muted); }
.das-link:hover { background:color-mix(in srgb,var(--das-ink) 6%,transparent); color:var(--das-ink); }
.das-link.danger { color:var(--das-danger); }
.das-confirm { display:flex; align-items:center; gap:8px; padding:8px 10px; font-size:12px;
  background:color-mix(in srgb,var(--das-danger) 8%,var(--das-bg)); border-bottom:1px solid var(--das-line); }
.das-confirm span { flex:1; }
.das-group-head { display:flex; align-items:baseline; gap:8px; padding:9px 10px 5px; }
.das-group-head b { font-size:12px; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.das-group-url { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  color:var(--das-muted); font:10px var(--das-mono); }
.das-group-count { flex:none; color:var(--das-muted); font-size:10px; }
.das-row { display:flex; align-items:flex-start; gap:7px; padding:7px 10px; border-top:1px solid var(--das-line); }
.das-row[data-highlight="true"] { background:color-mix(in srgb,var(--das-accent) 10%,transparent); }
.das-row-idx { flex:none; width:18px; height:18px; margin-top:2px; border-radius:50%; display:grid; place-items:center;
  background:color-mix(in srgb,var(--das-ink) 10%,transparent); font:600 9px var(--das-mono); }
.das-row-main { flex:1; min-width:0; }
.das-note { display:block; width:100%; padding:0; border:0; background:transparent; color:var(--das-ink);
  text-align:left; font-size:12px; line-height:1.55; overflow-wrap:anywhere; white-space:pre-wrap; }
.das-note:hover { color:var(--das-accent); }
.das-row-meta { display:flex; align-items:center; gap:7px; margin-top:3px; }
.das-status { display:inline-flex; align-items:center; height:16px; padding:0 5px; border-radius:8px; font-size:9px;
  background:color-mix(in srgb,var(--das-muted) 16%,transparent); color:var(--das-muted); }
.das-status[data-status="pending"] { background:color-mix(in srgb,var(--das-accent) 16%,transparent); color:var(--das-accent); }
.das-sample { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--das-muted); font-size:10px; }
.das-selector { display:block; margin-top:3px; color:var(--das-muted); font:10px/1.5 var(--das-mono);
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.das-row-actions { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:1px; flex:none; width:72px; }
.das-mini { display:inline-flex; align-items:center; justify-content:center; width:22px; height:22px; padding:0;
  border:0; border-radius:5px; background:transparent; color:var(--das-muted); opacity:.7; }
.das-mini svg { width:12px; height:12px; }
.das-mini:hover:not(:disabled) { background:color-mix(in srgb,var(--das-ink) 7%,transparent); color:var(--das-ink); opacity:1; }
.das-mini[data-danger="true"]:hover:not(:disabled) { color:var(--das-danger); }
.das-edit { display:flex; flex-direction:column; gap:6px; }
.das-textarea { width:100%; min-height:62px; resize:vertical; padding:6px 8px; border:1px solid var(--das-line);
  border-radius:7px; background:var(--das-surface); color:var(--das-ink); font:12px/1.55 var(--das-sans); }
.das-edit-actions { display:flex; gap:6px; }
.das-dock { display:inline-flex; align-items:center; gap:6px; height:28px; padding:0 10px; border:1px solid var(--das-line);
  border-radius:14px; background:var(--das-surface); color:var(--das-ink); font:12px/1 var(--das-sans); }
.das-dock:hover { border-color:color-mix(in srgb,var(--das-ink) 26%,var(--das-line)); }
.das-dock-dot { width:6px; height:6px; border-radius:50%; background:var(--das-accent); flex:none; }
@media (prefers-reduced-motion: reduce) { .das-spinner { animation:none; } }
`;

    const injectStyles = (css) => {
      const previous = typeof document.querySelector === 'function' ? document.querySelector('style[data-dsh-annotate-sync]') : null;
      if (previous && previous.parentNode) previous.parentNode.removeChild(previous);
      const element = document.createElement('style');
      element.setAttribute('data-dsh-annotate-sync', '');
      element.textContent = css;
      document.head.appendChild(element);
      return element;
    };

    // --------------------------------------------------------------- icons
    const ICONS = {
      back: 'M15 18l-6-6 6-6',
      refresh: 'M20 12a8 8 0 1 1-2.34-5.66M20 4v4h-4',
      mark: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z',
      list: 'M4 6h16M4 12h16M4 18h10',
      send: 'M22 2 11 13M22 2l-7 20-4-9-9-4Z',
      attach: 'M21 11.5 12.5 20a5 5 0 0 1-7-7l9-9a3.5 3.5 0 0 1 5 5l-9 9a2 2 0 0 1-3-3l8-8',
      trash: 'M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14',
      edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z',
      up: 'M18 15l-6-6-6 6',
      down: 'M6 9l6 6 6-6',
      check: 'M20 6 9 17l-5-5',
      target: 'M12 2v3M12 19v3M2 12h3M19 12h3M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z',
      fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
      phone: 'M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2ZM11 19h2',
    };
    const Icon = (props) =>
      h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: 16,
          height: 16,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('path', { d: ICONS[props.name] || ICONS.mark }),
      );

    // ---------------------------------------------------------- markdown
    const buildBlock = (annotations) => {
      const groups = groupByPage(annotations);
      const lines = [t('block.head', { count: annotations.length })];
      groups.forEach((group) => {
        lines.push('');
        lines.push('## ' + (group.title || group.url));
        lines.push(t('block.url', { url: group.url }));
        group.items.forEach((annotation, index) => {
          lines.push('');
          lines.push('### ' + (index + 1) + '. ' + String(annotation.note || ''));
          if (annotation.selector) lines.push('- ' + t('block.selector', { selector: '`' + annotation.selector + '`' }));
          if (annotation.tag) lines.push('- ' + t('block.tag', { tag: annotation.tag }));
          if (annotation.textSample) lines.push('- ' + t('block.text', { text: truncate(annotation.textSample, 160) }));
          const styles = annotation.styles || {};
          if (styles.fontSize || styles.color || styles.backgroundColor) {
            lines.push(
              '- ' +
                t('block.style', {
                  fontSize: styles.fontSize || '-',
                  color: styles.color || '-',
                  backgroundColor: styles.backgroundColor || '-',
                }),
            );
          }
          lines.push('- ' + t('block.status', { status: isPending(annotation) ? t('status.pending') : t('status.applied') }));
        });
      });
      return lines.join('\n');
    };

    // =====================================================================
    // apply(): register the tab, the panel and the dock chip.
    // =====================================================================
    function apply(ctx) {
      const getService = (name) => {
        try {
          return typeof ctx.get === 'function' ? ctx.get(name) : undefined;
        } catch (error) {
          return undefined;
        }
      };
      const slots = getService('slots');
      const sidebarRightTabs = getService('sidebarRightTabs');
      const sidebarRight = getService('sidebarRight');
      const sessions = getService('sessions');

      /** Panel that currently owns the keyboard (Esc / shortcuts). */
      let activePanel = null;

      if (!slots || typeof slots.inject !== 'function') {
        warnOnce('slots', 'slots service is unavailable; the annotation panel cannot mount');
      }
      if (!sidebarRightTabs || typeof sidebarRightTabs.register !== 'function') {
        warnOnce('sidebarRightTabs', 'sidebarRightTabs is unavailable; the tab cannot register');
      }
      if (!sidebarRight || typeof sidebarRight.openTab !== 'function') {
        warnOnce('sidebarRight', 'sidebarRight is unavailable; shortcuts cannot open the tab');
      }
      if (!sessions) warnOnce('sessions', 'sessions service is unavailable; send-to-conversation is disabled');

      const registerEffect = (setup) => {
        try {
          if (typeof ctx.effect === 'function') return ctx.effect(setup);
          return setup();
        } catch (error) {
          warnOnce('effect', 'ctx.effect failed', error);
          return undefined;
        }
      };
      registerEffect(() => {
        const element = injectStyles(PANEL_CSS);
        return () => {
          try {
            element.remove();
          } catch (error) {
            void error;
          }
        };
      });

      const openTab = () => {
        if (sidebarRight && typeof sidebarRight.openTab === 'function') {
          try {
            sidebarRight.openTab(TAB_ID);
            return true;
          } catch (error) {
            warnOnce('openTab', 'could not open the annotation tab', error);
          }
        } else {
          warnOnce('openTab-missing', 'sidebarRight.openTab is unavailable');
        }
        return false;
      };

      // ------------------------------------------------------ panel models
      const panels = new Map();
      const makeModel = (initial) => {
        let state = initial;
        const subscribers = new Set();
        return {
          get: () => state,
          set: (patch) => {
            state = Object.assign({}, state, patch);
            subscribers.forEach((listener) => {
              try {
                listener();
              } catch (error) {
                void error;
              }
            });
          },
          sub: (listener) => {
            subscribers.add(listener);
            return () => subscribers.delete(listener);
          },
        };
      };
      const getPanel = (sid) => {
        const key = sid || '__root__';
        let panel = panels.get(key);
        if (!panel) {
          panel = {
            sid: key,
            model: makeModel({
              view: 'list',
              services: [],
              detectState: 'idle',
              annotations: [],
              loaded: false,
              url: '',
              pageUrl: '',
              pageTitle: '',
              src: '',
              previewOrigin: '',
              lease: '',
              loading: false,
              error: null,
              mode: 'idle',
              filter: 'all',
              listOpen: false,
              editingId: null,
              editText: '',
              confirmClear: false,
              highlightId: null,
              manualInput: '',
              sending: false,
              notice: null,
              noticeKind: 'info',
              width: 'fit',
            }),
            frame: null,
            saveTimer: null,
            saveChain: Promise.resolve(),
            requestSeq: 0,
            pendingFocus: null,
          };
          panels.set(key, panel);
        }
        return panel;
      };

      // Shared pending count: the Panel publishes, the composer Dock listens.
      let sharedPending = 0;
      const sharedListeners = new Set();
      const setSharedPending = (count) => {
        const next = Number(count) || 0;
        if (next === sharedPending) return;
        sharedPending = next;
        sharedListeners.forEach((listener) => {
          try {
            listener(next);
          } catch (error) {
            void error;
          }
        });
      };

      const showNotice = (panel, message, kind) => {
        if (!message) return;
        panel.model.set({ notice: String(message), noticeKind: kind === 'error' ? 'error' : 'info' });
      };

      // --------------------------------------------------- overlay traffic
      const postOverlay = (panel, type, payload) => {
        const state = panel.model.get();
        const frame = panel.frame;
        if (!frame || !frame.contentWindow || !state.previewOrigin) return;
        try {
          frame.contentWindow.postMessage(
            Object.assign({ channel: CHANNEL, type: type }, payload || {}),
            state.previewOrigin,
          );
        } catch (error) {
          void error;
        }
      };

      const normalizeIncoming = (annotation) => {
        if (!annotation || typeof annotation !== 'object' || typeof annotation.id !== 'string' || !annotation.id) return null;
        const page = annotation.page && typeof annotation.page === 'object' ? annotation.page : { url: '', origin: '', path: '', title: '' };
        return Object.assign({}, annotation, {
          note: typeof annotation.note === 'string' ? annotation.note.slice(0, 2000) : '',
          status: annotation.status === 'applied' ? 'applied' : 'pending',
          page,
        });
      };

      // ------------------------------------------------ save pipeline (300ms)
      const flushSave = (panel) => {
        const list = panel.model.get().annotations;
        const seq = (panel.saveSeq = (panel.saveSeq || 0) + 1);
        const run = async () => {
          const result = await api('save', { sid: panel.sid, annotations: list });
          if (!result || !result.ok) {
            showNotice(panel, t('notice.saveFailed'), 'error');
            return;
          }
          if (panel.saveSeq === seq) {
            postOverlay(panel, 'set-annotations', { annotations: panel.model.get().annotations });
          }
          setSharedPending(panel.model.get().annotations.filter(isPending).length);
        };
        panel.saveChain = panel.saveChain.then(run, run);
        return panel.saveChain;
      };
      const saveSoon = (panel) => {
        if (panel.saveTimer) clearTimeout(panel.saveTimer);
        panel.saveTimer = setTimeout(() => {
          panel.saveTimer = null;
          void flushSave(panel);
        }, SAVE_DEBOUNCE_MS);
      };
      const updateList = (panel, next) => {
        panel.model.set({ annotations: next });
        setSharedPending(next.filter(isPending).length);
        saveSoon(panel);
      };

      // --------------------------------------------------- preview lifecycle
      const releasePreview = (panel) => {
        const state = panel.model.get();
        if (state.lease) void api('releasePreview', { sid: panel.sid, lease: state.lease });
        panel.model.set({ previewOrigin: '', lease: '', src: '' });
      };

      const openPreview = async (panel, rawUrl) => {
        const url = normalizeAddress(rawUrl);
        if (!url) {
          showNotice(panel, /^https?:/i.test(String(rawUrl || '')) ? t('notice.notLocal') : t('notice.badAddress'), 'error');
          return;
        }
        // Never preview the harness itself (it is loopback too).
        try {
          if (typeof location !== 'undefined' && location.origin && new URL(url).origin === location.origin) {
            showNotice(panel, t('notice.notLocal'), 'error');
            return;
          }
        } catch (error) {
          void error;
        }
        const request = (panel.requestSeq = (panel.requestSeq || 0) + 1);
        const previous = panel.model.get();
        const lease = newLease();
        panel.model.set({
          view: 'page',
          loading: true,
          error: null,
          url,
          pageUrl: '',
          pageTitle: '',
          listOpen: false,
          editingId: null,
          confirmClear: false,
          mode: 'idle',
          manualInput: url,
          src: '',
          previewOrigin: '',
          lease: '',
        });
        if (previous.lease) void api('releasePreview', { sid: panel.sid, lease: previous.lease });
        // Send the panel's own origin: the injected overlay posts back to it, and
        // it may differ from webServer.getOrigin() (localhost vs 127.0.0.1).
        const result = await api('preview', { sid: panel.sid, url, lease, parentOrigin: location.origin });
        if (panel.requestSeq !== request) {
          if (result && result.ok && result.lease) void api('releasePreview', { sid: panel.sid, lease: result.lease });
          return;
        }
        if (!result || !result.ok || !result.origin) {
          const detail = (result && (result.error || result.code)) || '';
          panel.model.set({ loading: false, error: detail || t('notice.previewFailed') });
          return;
        }
        panel.model.set({
          previewOrigin: result.origin || '',
          lease: result.lease || lease,
          src: proxyUrl(result.origin, result.target || url),
          loading: true,
        });
      };

      const backToList = (panel) => {
        releasePreview(panel);
        panel.model.set({
          view: 'list',
          loading: false,
          error: null,
          mode: 'idle',
          listOpen: false,
          editingId: null,
          confirmClear: false,
          pageUrl: '',
          pageTitle: '',
        });
        void runDetect(panel);
      };

      const runDetect = async (panel) => {
        if (panel.model.get().detectState === 'busy') return;
        panel.model.set({ detectState: 'busy' });
        const result = await api('detect', { sid: panel.sid });
        if (!result || !result.ok) {
          panel.model.set({ detectState: 'error' });
          if (!panel.detectErrorShown) {
            panel.detectErrorShown = true;
            showNotice(panel, t('notice.detectFailed'), 'error');
          }
          return;
        }
        panel.detectErrorShown = false;
        panel.model.set({
          detectState: 'idle',
          services: Array.isArray(result.services) ? result.services : [],
        });
      };

      const setMode = (panel, mode) => {
        const next = mode === 'picking' ? 'picking' : 'idle';
        panel.model.set({ mode: next });
        postOverlay(panel, 'set-mode', { mode: next });
      };

      // -------------------------------------------------- annotation actions
      const startEdit = (panel, annotation) => {
        panel.model.set({ editingId: annotation.id, editText: String(annotation.note || '') });
      };
      const cancelEdit = (panel) => panel.model.set({ editingId: null, editText: '' });
      const saveEdit = (panel, id) => {
        const state = panel.model.get();
        const note = String(state.editText || '').trim().slice(0, 2000);
        if (!note) {
          showNotice(panel, t('notice.noteEmpty'), 'error');
          return;
        }
        const next = state.annotations.map((item) =>
          item.id === id ? Object.assign({}, item, { note, updatedAt: nowIso() }) : item,
        );
        cancelEdit(panel);
        updateList(panel, next);
      };
      const toggleStatus = (panel, annotation) => {
        const next = panel.model.get().annotations.map((item) =>
          item.id === annotation.id
            ? Object.assign({}, item, { status: isPending(item) ? 'applied' : 'pending', updatedAt: nowIso() })
            : item,
        );
        updateList(panel, next);
      };
      const deleteAnnotation = (panel, annotation) => {
        const state = panel.model.get();
        const next = state.annotations.filter((item) => item.id !== annotation.id);
        if (state.editingId === annotation.id) cancelEdit(panel);
        updateList(panel, next);
      };
      const moveAnnotation = (panel, annotation, delta) => {
        const state = panel.model.get();
        const url = pageUrlOf(annotation);
        const group = groupByPage(state.annotations).filter((item) => item.url === url)[0];
        if (!group) return;
        const index = group.items.findIndex((item) => item.id === annotation.id);
        const target = index + delta;
        if (index < 0 || target < 0 || target >= group.items.length) return;
        const reordered = group.items.slice();
        const swap = reordered[index];
        reordered[index] = reordered[target];
        reordered[target] = swap;
        const orderMap = new Map();
        reordered.forEach((item, position) => orderMap.set(item.id, position));
        const next = state.annotations.map((item) =>
          orderMap.has(item.id) ? Object.assign({}, item, { order: orderMap.get(item.id) }) : item,
        );
        updateList(panel, next);
      };
      const focusAnnotation = (panel, annotation) => {
        const state = panel.model.get();
        const url = pageUrlOf(annotation);
        const current = state.pageUrl || state.url;
        panel.model.set({ highlightId: annotation.id, listOpen: true });
        if (url && current && url !== current && url !== 'unknown') {
          showNotice(panel, t('notice.otherPage'), 'info');
          panel.pendingFocus = annotation.id;
          void openPreview(panel, url);
          return;
        }
        postOverlay(panel, 'focus', { id: annotation.id });
      };
      const clearAll = async (panel) => {
        panel.model.set({ confirmClear: false });
        const result = await api('clear', { sid: panel.sid });
        if (!result || !result.ok) {
          showNotice(panel, t('notice.clearFailed'), 'error');
          return;
        }
        cancelEdit(panel);
        panel.model.set({ annotations: [] });
        setSharedPending(0);
        postOverlay(panel, 'set-annotations', { annotations: [] });
        showNotice(panel, t('notice.cleared'), 'info');
      };

      // ------------------------------------------------------------- sending
      const getSession = (sid) => {
        const service = sessions || getService('sessions');
        if (!service) return null;
        try {
          const scope = typeof service.scope === 'function' ? service.scope(sid) : null;
          if (!scope) return null;
          return typeof service.sessionOf === 'function' ? service.sessionOf(scope) : null;
        } catch (error) {
          return null;
        }
      };

      const sendPending = async (panel) => {
        const state = panel.model.get();
        const pending = state.annotations.filter(isPending);
        if (!pending.length || state.sending) return;
        const text = buildBlock(pending);
        const session = getSession(panel.sid);
        if (!session || typeof session.prompt !== 'function') {
          showNotice(panel, t('notice.sendUnavailable'), 'error');
          return;
        }
        panel.model.set({ sending: true });
        let submission = null;
        try {
          if (typeof session.beginSubmission === 'function') {
            submission = session.beginSubmission({ mode: 'queue', text: text, attachments: [] });
          }
          const requestId = submission && submission.requestId;
          const result = await session.prompt([{ type: 'text', text: text }], 'queue', undefined, requestId);
          if (result && result.ok === false) {
            const error = result.error;
            throw new Error(String((error && (error.message || error)) || 'not accepted'));
          }
          if (result && result.value && result.value.accepted === false) {
            throw new Error('not accepted');
          }
          const ids = new Set(pending.map((item) => item.id));
          const next = panel.model.get().annotations.map((item) =>
            ids.has(item.id) ? Object.assign({}, item, { status: 'applied', updatedAt: nowIso() }) : item,
          );
          panel.model.set({ annotations: next, sending: false });
          setSharedPending(next.filter(isPending).length);
          void flushSave(panel);
          showNotice(panel, t('notice.sent', { count: ids.size }), 'info');
        } catch (error) {
          try {
            if (submission && typeof submission.abandon === 'function') submission.abandon();
          } catch (ignored) {
            void ignored;
          }
          panel.model.set({ sending: false });
          showNotice(panel, t('notice.sendFailed', { error: String((error && error.message) || error) }), 'error');
        }
      };

      // --------------------------------------------------- overlay messages
      const handleOverlayMessage = (panel, event) => {
        const data = event && event.data;
        if (!data || typeof data !== 'object' || data.channel !== CHANNEL) return;
        const state = panel.model.get();
        if (!state.previewOrigin || event.origin !== state.previewOrigin) return;
        const frame = panel.frame;
        if (frame && frame.contentWindow && event.source && event.source !== frame.contentWindow) return;

        if (data.type === 'ready') {
          const page = data.page && typeof data.page === 'object' ? data.page : {};
          panel.overlayReady = true;
          panel.model.set({
            loading: false,
            error: null,
            pageUrl: typeof page.url === 'string' ? page.url : state.pageUrl,
            pageTitle: typeof page.title === 'string' ? page.title : state.pageTitle,
          });
          const current = panel.model.get();
          postOverlay(panel, 'init', {
            annotations: current.annotations,
            pageUrl: current.pageUrl,
            mode: current.mode,
          });
          if (panel.pendingFocus) {
            const focusId = panel.pendingFocus;
            panel.pendingFocus = null;
            panel.model.set({ highlightId: focusId, listOpen: true });
            postOverlay(panel, 'focus', { id: focusId });
          }
          return;
        }
        if (data.type === 'create' || data.type === 'update') {
          const annotation = normalizeIncoming(data.annotation);
          if (!annotation) return;
          const list = panel.model.get().annotations;
          const exists = list.some((item) => item.id === annotation.id);
          const next = exists
            ? list.map((item) => (item.id === annotation.id ? annotation : item))
            : list.concat([annotation]);
          updateList(panel, next);
          return;
        }
        if (data.type === 'remove') {
          if (typeof data.id !== 'string') return;
          updateList(panel, panel.model.get().annotations.filter((item) => item.id !== data.id));
          return;
        }
        if (data.type === 'mode') {
          panel.model.set({ mode: data.mode === 'picking' ? 'picking' : 'idle' });
          return;
        }
        if (data.type === 'focus') {
          if (typeof data.id !== 'string') return;
          panel.model.set({ listOpen: true, filter: 'all', highlightId: data.id });
          return;
        }
        if (data.type === 'notice' && data.message) {
          showNotice(panel, String(data.message), 'info');
        }
      };

      // ------------------------------------------------------------ icons / UI
      const iconButton = (name, label, onClick, options) => {
        const config = options || {};
        return h(
          'button',
          {
            type: 'button',
            className: 'das-ico ' + (config.className || ''),
            title: label,
            'aria-label': label,
            disabled: !!config.disabled,
            'data-on': config.on ? 'true' : 'false',
            onClick: onClick,
          },
          h(Icon, { name: name }),
          config.badge ? h('span', { className: 'das-badge' }, String(config.badge)) : null,
        );
      };
      const miniButton = (name, label, onClick, danger) =>
        h(
          'button',
          {
            type: 'button',
            className: 'das-mini',
            title: label,
            'aria-label': label,
            'data-danger': danger ? 'true' : 'false',
            onClick: onClick,
          },
          h(Icon, { name: name }),
        );

      const renderToast = (panel, state) =>
        state.notice
          ? h(
              'div',
              { className: 'das-toast', 'data-kind': state.noticeKind, role: 'status' },
              state.notice,
              h(
                'button',
                {
                  type: 'button',
                  className: 'das-link',
                  style: { marginLeft: '8px' },
                  onClick: () => panel.model.set({ notice: null }),
                },
                '×',
              ),
            )
          : null;

      // ------------------------------------------------------- list face
      const renderServiceList = (panel, state) => {
        const services = state.services || [];
        return h(
          'div',
          { className: 'das-list' },
          h(
            'div',
            { className: 'das-list-head' },
            h('b', null, t('list.title')),
            h('span', { className: 'das-sub' }, services.length ? t('list.found', { count: services.length }) : t('list.autoRefresh')),
            iconButton('refresh', t('list.refresh'), () => void runDetect(panel), { disabled: state.detectState === 'busy' }),
          ),
          state.detectState === 'busy' && !services.length ? h('div', { className: 'das-hint' }, t('list.scanning')) : null,
          services.length
            ? services.map((service) =>
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'das-svc',
                    key: String(service.origin || service.url || service.port),
                    onClick: () => void openPreview(panel, service.url || service.origin),
                  },
                  h('span', { className: 'das-svc-dot' }),
                  h(
                    'span',
                    { className: 'das-svc-main' },
                    h('b', null, service.title || service.origin || '127.0.0.1:' + String(service.port || '')),
                    h('span', null, service.origin || service.url || ''),
                  ),
                  h(
                    'span',
                    { className: 'das-svc-meta' },
                    typeof service.responseMs === 'number' ? t('list.responseMs', { ms: service.responseMs }) : '',
                  ),
                ),
              )
            : state.detectState === 'busy'
              ? null
              : h(
                  'div',
                  { className: 'das-empty' },
                  h('b', null, t('list.empty')),
                  h('p', null, t('list.emptyHint')),
                ),
          h(
            'div',
            { className: 'das-manual' },
            h('label', { className: 'das-label', htmlFor: 'das-manual-' + (panel.sid || 'root') }, t('list.manual')),
            h(
              'div',
              { className: 'das-manual-row' },
              h('input', {
                id: 'das-manual-' + (panel.sid || 'root'),
                className: 'das-input',
                type: 'text',
                value: state.manualInput,
                placeholder: t('list.manualPlaceholder'),
                spellCheck: false,
                onChange: (event) => panel.model.set({ manualInput: event.target.value }),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void openPreview(panel, panel.model.get().manualInput);
                  }
                },
              }),
              h(
                'button',
                {
                  type: 'button',
                  className: 'das-btn primary',
                  onClick: () => void openPreview(panel, panel.model.get().manualInput),
                },
                t('list.open'),
              ),
            ),
          ),
        );
      };

      // ------------------------------------------------- annotation list
      const renderAnnotationRow = (panel, state, group, annotation) => {
        const editing = state.editingId === annotation.id;
        const pending = isPending(annotation);
        const index = group.items.findIndex((item) => item.id === annotation.id) + 1;
        return h(
          'div',
          {
            className: 'das-row',
            key: annotation.id,
            'data-highlight': state.highlightId === annotation.id ? 'true' : 'false',
          },
          h('span', { className: 'das-row-idx', 'aria-hidden': 'true' }, String(index)),
          h(
            'div',
            { className: 'das-row-main' },
            editing
              ? h(
                  'div',
                  { className: 'das-edit' },
                  h('textarea', {
                    className: 'das-textarea',
                    value: state.editText,
                    autoFocus: true,
                    onChange: (event) => panel.model.set({ editText: event.target.value }),
                    onKeyDown: (event) => {
                      if (event.key === 'Enter' && !event.shiftKey) {
                        event.preventDefault();
                        saveEdit(panel, annotation.id);
                      } else if (event.key === 'Escape') {
                        event.preventDefault();
                        event.stopPropagation();
                        cancelEdit(panel);
                      }
                    },
                  }),
                  h(
                    'div',
                    { className: 'das-edit-actions' },
                    h(
                      'button',
                      { type: 'button', className: 'das-btn primary', onClick: () => saveEdit(panel, annotation.id) },
                      t('anno.save'),
                    ),
                    h('button', { type: 'button', className: 'das-btn ghost', onClick: () => cancelEdit(panel) }, t('anno.cancel')),
                  ),
                )
              : h(
                  'button',
                  { type: 'button', className: 'das-note', title: t('anno.edit'), onClick: () => startEdit(panel, annotation) },
                  String(annotation.note || ''),
                ),
            h(
              'div',
              { className: 'das-row-meta' },
              h('span', { className: 'das-status', 'data-status': pending ? 'pending' : 'applied' }, pending ? t('status.pending') : t('status.applied')),
              annotation.textSample ? h('span', { className: 'das-sample' }, truncate(annotation.textSample, 60)) : null,
            ),
            h('code', { className: 'das-selector' }, String(annotation.selector || '')),
          ),
          h(
            'div',
            { className: 'das-row-actions' },
            miniButton('target', t('anno.focus'), () => focusAnnotation(panel, annotation)),
            miniButton('edit', t('anno.edit'), () => startEdit(panel, annotation)),
            miniButton('check', t('anno.toggle'), () => toggleStatus(panel, annotation)),
            miniButton('up', t('anno.up'), () => moveAnnotation(panel, annotation, -1)),
            miniButton('down', t('anno.down'), () => moveAnnotation(panel, annotation, 1)),
            miniButton('trash', t('anno.delete'), () => deleteAnnotation(panel, annotation), true),
          ),
        );
      };

      const renderAnnotationList = (panel, state) => {
        const all = state.annotations;
        const filtered =
          state.filter === 'pending'
            ? all.filter(isPending)
            : state.filter === 'applied'
              ? all.filter((item) => item.status === 'applied')
              : all;
        const groups = groupByPage(filtered);
        return h(
          'div',
          { className: 'das-annolist', role: 'region', 'aria-label': t('page.list') },
          h(
            'div',
            { className: 'das-annolist-head' },
            h(
              'div',
              { className: 'das-filters' },
              ['all', 'pending', 'applied'].map((filter) =>
                h(
                  'button',
                  {
                    type: 'button',
                    key: filter,
                    className: 'das-filter',
                    'data-active': state.filter === filter ? 'true' : 'false',
                    onClick: () => panel.model.set({ filter: filter }),
                  },
                  t('filter.' + filter),
                ),
              ),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'das-link danger',
                disabled: !all.length,
                onClick: () => panel.model.set({ confirmClear: true }),
              },
              t('anno.clear'),
            ),
          ),
          state.confirmClear
            ? h(
                'div',
                { className: 'das-confirm' },
                h('span', null, t('anno.confirmClear')),
                h(
                  'button',
                  { type: 'button', className: 'das-btn danger', onClick: () => void clearAll(panel) },
                  t('anno.confirm'),
                ),
                h(
                  'button',
                  { type: 'button', className: 'das-btn ghost', onClick: () => panel.model.set({ confirmClear: false }) },
                  t('anno.cancel'),
                ),
              )
            : null,
          groups.length
            ? groups.map((group) =>
                h(
                  'div',
                  { className: 'das-group', key: group.url },
                  h(
                    'div',
                    { className: 'das-group-head' },
                    h('b', null, group.title || group.url),
                    h('span', { className: 'das-group-url' }, group.url),
                    h('span', { className: 'das-group-count' }, t('list.annoCount', { count: group.items.length })),
                  ),
                  group.items.map((annotation) => renderAnnotationRow(panel, state, group, annotation)),
                ),
              )
            : h('div', { className: 'das-hint' }, all.length ? t('list.emptyFilter') : t('list.emptyAnno')),
        );
      };

      // ------------------------------------------------------- page face
      const renderPageFace = (panel, state, options) => {
        const pending = state.annotations.filter(isPending);
        const canCompose = options && options.canCompose;
        return h(
          'div',
          { className: 'das-panel' },
          h(
            'div',
            { className: 'das-bar' },
            iconButton('back', t('page.back'), () => backToList(panel)),
            h(
              'button',
              {
                type: 'button',
                className: 'das-ico das-mark',
                title: t('page.markHint'),
                'data-on': state.mode === 'picking' ? 'true' : 'false',
                onClick: () => setMode(panel, state.mode === 'picking' ? 'idle' : 'picking'),
              },
              h(Icon, { name: 'mark' }),
              state.mode === 'picking' ? t('page.marking') : t('page.mark'),
            ),
            iconButton('refresh', t('page.reload'), () => postOverlay(panel, 'reload', {})),
            iconButton('list', t('page.list'), () => panel.model.set({ listOpen: !state.listOpen }), {
              on: state.listOpen,
              badge: pending.length ? pending.length : 0,
            }),
            h('span', { className: 'das-spacer' }),
            canCompose
              ? iconButton('attach', t('page.attach'), () => options.onAttach(), { disabled: !pending.length })
              : null,
            h(
              'button',
              {
                type: 'button',
                className: 'das-send',
                title: t('page.send'),
                disabled: !pending.length || state.sending,
                onClick: () => void sendPending(panel),
              },
              state.sending ? t('page.sending') : t('page.send') + (pending.length ? ' · ' + pending.length : ''),
            ),
          ),
          h(
            'div',
            { className: 'das-urlbar' },
            h('code', { title: state.url }, state.pageTitle ? state.pageTitle + ' · ' + (state.pageUrl || state.url) : state.pageUrl || state.url || ''),
            iconButton(state.width === 'fit' ? 'phone' : 'fit', t('page.width'), () =>
              panel.model.set({ width: state.width === 'fit' ? 'mobile' : 'fit' }),
            ),
          ),
          h(
            'div',
            { className: 'das-stage' },
            h(
              'div',
              { className: 'das-frame-wrap', 'data-width': state.width },
              state.src
                ? h('iframe', {
                    className: 'das-frame',
                    src: state.src,
                    title: t('page.list'),
                    sandbox: SANDBOX,
                    ref: options && typeof options.frameRef === 'function' ? options.frameRef : (element) => {
                      panel.frame = element;
                    },
                    onLoad: () => {
                      panel.model.set({ loading: false });
                      postOverlay(panel, 'ping', {});
                      const current = panel.model.get();
                      postOverlay(panel, 'init', {
                        annotations: current.annotations,
                        pageUrl: current.pageUrl,
                        mode: current.mode,
                      });
                    },
                  })
                : null,
            ),
            state.loading
              ? h(
                  'div',
                  { className: 'das-overlay' },
                  h('span', { className: 'das-spinner' }),
                  h('b', null, t('page.loading')),
                  h('p', null, t('page.loadingHint')),
                )
              : null,
            state.error
              ? h(
                  'div',
                  { className: 'das-overlay' },
                  h('b', null, t('page.error')),
                  h('p', null, String(state.error)),
                  h(
                    'button',
                    { type: 'button', className: 'das-btn primary', onClick: () => void openPreview(panel, state.url) },
                    t('page.retry'),
                  ),
                )
              : null,
            renderToast(panel, state),
          ),
          state.listOpen ? renderAnnotationList(panel, state) : null,
        );
      };

      // ------------------------------------------------------------- Panel
      const useSub = (model) => {
        const reducer = React.useReducer((value) => value + 1, 0)[1];
        React.useEffect(() => model.sub(reducer), [model]);
      };

      const Panel = (props) => {
        const sid = props && props.sessionId ? String(props.sessionId) : '';
        const panel = getPanel(sid);
        useSub(panel.model);
        const state = panel.model.get();
        const draft =
          props && typeof props.useInput === 'function'
            ? props.useInput((snapshot) => (snapshot && typeof snapshot.draft === 'string' ? snapshot.draft : ''))
            : '';
        const inputActions = props && props.inputActions;

        React.useEffect(() => {
          activePanel = panel;
          return () => {
            if (activePanel === panel) activePanel = null;
          };
        }, [panel]);

        React.useEffect(() => {
          let live = true;
          void (async () => {
            const result = await api('state', { sid: panel.sid });
            if (!live) return;
            if (result && result.ok) {
              const list = Array.isArray(result.annotations) ? result.annotations : [];
              panel.model.set({ annotations: list, loaded: true });
              setSharedPending(list.filter(isPending).length);
              const current = panel.model.get();
              // The tab may have been unmounted and remounted (sidebar closed);
              // a page face without a live lease needs its preview reopened.
              if (current.view === 'page' && current.url && !current.lease) {
                void openPreview(panel, current.url);
                return;
              }
            } else {
              panel.model.set({ loaded: true });
              showNotice(panel, t('notice.pluginUnavailable'), 'error');
            }
            void runDetect(panel);
          })();
          return () => {
            live = false;
          };
        }, [panel]);

        React.useEffect(() => {
          if (state.view !== 'list') return undefined;
          const timer = setInterval(() => {
            if (!document.hidden) void runDetect(panel);
          }, DETECT_INTERVAL_MS);
          return () => clearInterval(timer);
        }, [panel, state.view]);

        React.useEffect(() => {
          const onMessage = (event) => handleOverlayMessage(panel, event);
          window.addEventListener('message', onMessage);
          return () => window.removeEventListener('message', onMessage);
        }, [panel]);

        React.useEffect(() => {
          if (!state.src) return undefined;
          // The iframe can load an upstream error page without ever running the
          // overlay, so "ready" — not onLoad — is the real success signal.
          panel.overlayReady = false;
          const timer = setTimeout(() => {
            if (!panel.overlayReady && panel.model.get().src === state.src) {
              panel.model.set({ loading: false, error: t('notice.previewFailed') });
            }
          }, 12000);
          return () => clearTimeout(timer);
        }, [panel, state.src]);

        React.useEffect(() => {
          if (!state.loading) return undefined;
          const timer = setTimeout(() => {
            if (panel.model.get().loading) panel.model.set({ loading: false, error: t('notice.loadTimeout') });
          }, LOAD_TIMEOUT_MS);
          return () => clearTimeout(timer);
        }, [panel, state.loading, state.src]);

        React.useEffect(() => {
          if (!state.notice) return undefined;
          const timer = setTimeout(() => panel.model.set({ notice: null }), 5000);
          return () => clearTimeout(timer);
        }, [panel, state.notice]);

        React.useEffect(() => {
          if (!state.highlightId) return undefined;
          const timer = setTimeout(() => panel.model.set({ highlightId: null }), 2600);
          return () => clearTimeout(timer);
        }, [panel, state.highlightId]);

        React.useEffect(
          () => () => {
            const current = panel.model.get();
            // Do not drop a pending debounced write when the tab unmounts.
            if (panel.saveTimer) {
              clearTimeout(panel.saveTimer);
              panel.saveTimer = null;
              void flushSave(panel);
            }
            if (current.lease) void api('releasePreview', { sid: panel.sid, lease: current.lease });
            panel.frame = null;
            panel.model.set({ lease: '', previewOrigin: '', src: '' });
          },
          [panel],
        );

        const frameRef = React.useCallback(
          (element) => {
            panel.frame = element;
          },
          [panel],
        );

        if (state.view === 'list') {
          return h(
            'div',
            { className: 'das-panel' },
            renderToast(panel, state),
            renderServiceList(panel, state),
          );
        }
        return renderPageFace(panel, state, {
          canCompose: !!(inputActions && typeof inputActions.setDraft === 'function'),
          frameRef: frameRef,
          onAttach: () => {
            const pending = panel.model.get().annotations.filter(isPending);
            if (!pending.length) return;
            if (!inputActions || typeof inputActions.setDraft !== 'function') {
              showNotice(panel, t('notice.noComposer'), 'error');
              return;
            }
            const block = buildBlock(pending);
            try {
              const base = typeof draft === 'string' ? draft : '';
              inputActions.setDraft(base.trim() ? base.replace(/\s+$/, '') + '\n\n' + block : block);
              showNotice(panel, t('notice.attached'), 'info');
            } catch (error) {
              showNotice(panel, t('notice.attachFailed'), 'error');
            }
          },
        });
      };

      // -------------------------------------------------------------- Dock
      const Dock = (props) => {
        const sid = props && props.sessionId ? String(props.sessionId) : '';
        // The slot passes the same composer contract as the reference dock.
        // v1 has no persistent payload chips, so the chip only needs the count,
        // but the draft/composer are read so a future attach affordance does
        // not need a second hook order.
        const draft =
          props && typeof props.useInput === 'function'
            ? props.useInput((snapshot) => (snapshot && typeof snapshot.draft === 'string' ? snapshot.draft : ''))
            : '';
        const composerAvailable = !!(props && props.inputActions && typeof props.inputActions.setDraft === 'function');
        void draft;
        const [count, setCount] = React.useState(sharedPending);
        React.useEffect(() => {
          let live = true;
          const refresh = async () => {
            const result = await api('state', { sid: sid });
            if (!live || !result || !result.ok || !Array.isArray(result.annotations)) return;
            const pending = result.annotations.filter(isPending).length;
            setSharedPending(pending);
          };
          setCount(sharedPending);
          const listener = (value) => setCount(value);
          sharedListeners.add(listener);
          void refresh();
          const timer = setInterval(() => {
            if (!document.hidden) void refresh();
          }, DETECT_INTERVAL_MS);
          return () => {
            live = false;
            sharedListeners.delete(listener);
            clearInterval(timer);
          };
        }, [sid]);

        if (!count) return null;
        return h(
          'button',
          {
            type: 'button',
            className: 'das-dock',
            title: t('dock.open'),
            'aria-label': t('dock.open'),
            'data-composer': composerAvailable ? 'true' : 'false',
            onClick: () => openTab(),
          },
          h('span', { className: 'das-dock-dot' }),
          t('dock.chip', { count: count }),
        );
      };

      // ------------------------------------------------------ registration
      if (sidebarRightTabs && typeof sidebarRightTabs.register === 'function') {
        const guide = [
          {
            order: 40,
            title: () => t('tab.title'),
            description: () => t('tab.desc'),
            icon: (iconProps) => h(Icon, Object.assign({ name: 'mark' }, iconProps)),
          },
        ];
        registerEffect(() =>
          sidebarRightTabs.register({
            id: TAB_ID,
            kind: KIND,
            priority: 'extension',
            title: () => t('tab.title'),
            guide: guide,
          }),
        );
      } else {
        warnOnce('register-tab', 'sidebarRightTabs.register is unavailable; the tab is not registered');
      }

      const contribute = (view, id, component, extra) => {
        if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return;
        try {
          slots.inject(view, () => slots.register(Object.assign({ name: view, id: id }, extra || {}), component));
        } catch (error) {
          warnOnce('slot-' + view, 'could not register slot ' + view, error);
        }
      };
      contribute(PANEL_VIEW, TAB_ID, Panel, { key: TAB_ID });
      contribute(DOCK_VIEW, TAB_ID + '-dock', Dock);

      // -------------------------------------------------------- shortcuts
      const onKeyDown = (event) => {
        if (!event) return;
        const key = String(event.key || '').toLowerCase();
        const modifier = event.metaKey || event.ctrlKey;
        if (modifier && event.shiftKey && !event.altKey && (key === 'b' || key === 'a')) {
          event.preventDefault();
          openTab();
          return;
        }
        if (key !== 'escape' && event.key !== 'Escape') return;
        const panel = activePanel;
        if (!panel) return;
        const state = panel.model.get();
        if (state.editingId) {
          event.preventDefault();
          cancelEdit(panel);
          return;
        }
        if (state.confirmClear) {
          event.preventDefault();
          panel.model.set({ confirmClear: false });
          return;
        }
        if (state.notice) {
          panel.model.set({ notice: null });
          return;
        }
        if (state.view === 'page' && state.listOpen) {
          event.preventDefault();
          panel.model.set({ listOpen: false });
          return;
        }
        if (state.mode === 'picking') {
          event.preventDefault();
          setMode(panel, 'idle');
        }
      };
      window.addEventListener('keydown', onKeyDown);
      registerEffect(() => () => window.removeEventListener('keydown', onKeyDown));

      // Release every preview lease when the client plugin unloads.
      registerEffect(
        () => () => {
          panels.forEach((panel) => {
            if (panel.saveTimer) clearTimeout(panel.saveTimer);
            const state = panel.model.get();
            if (state.lease) void api('releasePreview', { sid: panel.sid, lease: state.lease });
          });
        },
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
