// dsh-annotate-sync — browser / UI half (HTML document-preview renderer).
//
// This is a classic script on purpose: the DeepSeek Harness client loader hands
// it `require('react')` and serves it verbatim, without a bundler. It must stay
// free of ESM syntax so `node --check` passes.
//
// It takes over the `.html` / `.htm` document preview: the builtin HTML bytes
// renderer's packing + opaque blob iframe are adapted here and the annotation
// overlay is appended to the generated document, so every HTML file opened in
// the DSH document preview gets the overlay automatically.
//
// Adapted from @deepseek-ai/dsh-client-ui-sidebar-documentpreview (MIT);
// original copyright DeepSeek Harness contributors. Helpers copied/adapted:
// parseFileAddress / sessionFileAddress / hostFileOf, encodeText / decodeText,
// createHtmlDocument, packHtml, createReadHtmlRelative and the blob-iframe
// shape of HtmlFrame. See docs/PROTOCOL-v2.md §6.
//
// Talks to:
//   - the host half over POST /__dsh-annotate-sync/api          (PROTOCOL-v2 §5)
//   - the injected overlay over window.postMessage in the iframe (PROTOCOL-v2 §6-7)
//
// The iframe is `sandbox="allow-scripts"` and therefore has an opaque origin:
// its messages arrive with event.origin === "null", so the parent validates
// event.source === frame.contentWindow plus the channel, never the origin, and
// posts into it with targetOrigin "*". The overlay validates the parent by the
// harness origin, which it receives in window.__DSH_ANNOTATE__.
window.__ModuleLoader__.load({
  id: 'dsh-annotate-sync',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const React = require('react');
    const h = React.createElement;

    // ------------------------------------------------------------- constants
    const inject = ['documentPreviews', 'slots', 'sessions', 'timer'];
    const HTML_ID = 'dsh-annotate-sync/html';
    const DOC_SLOT = 'sidebar.right.tab.document';
    const API_PATH = '/__dsh-annotate-sync/api';
    const OVERLAY_PATH = '/__dsh-annotate-sync/overlay.js';
    const CHANNEL = 'dsh-annotate-sync';
    const SAVE_DEBOUNCE_MS = 300;
    const NOTICE_MS = 4000;
    const CLEAR_ARM_MS = 3000;
    const REQUEST_TIMEOUT_MS = 15000;

    // Same limits as the builtin HTML package reader.
    const MAX_ASSET_BYTES = 4 * 1024 * 1024;
    const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
    const MAX_ASSETS = 64;
    const BASE64_CHUNK_BYTES = 32768;

    const FILE_ADDRESS_PREFIX = 'dsh-resource://file/';

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

    // ---------------------------------------------------------------- i18n
    const CATALOG = {
      zh: {
        'bar.pending': '{count} 条待处理',
        'bar.send': '发送给 Agent',
        'bar.sending': '发送中…',
        'bar.autoSend': '自动发送',
        'bar.clear': '清空',
        'bar.confirmClear': '确认清空',
        'frame.loading': '正在渲染文档…',
        'frame.failed': '无法预览这份 HTML 文档',
        'frame.title': 'HTML 文档预览',
        'notice.apiUnavailable': '插件服务不可用，批注可能无法保存',
        'notice.saveFailed': '保存失败，请稍后重试',
        'notice.sent': '已发送 {count} 条批注',
        'notice.sendFailed': '发送失败：{error}',
        'notice.sendUnavailable': '当前会话不支持直接发送',
        'notice.noSession': '无法确定当前会话，暂时无法发送',
        'notice.nothingToSend': '没有待处理的批注',
        'notice.cleared': '已清空该文件的全部批注',
        'notice.clearFailed': '清空失败，请稍后重试',
        'notice.clearArmed': '再次点击「清空」确认',
        'block.head': 'HTML 文件批注（共 {count} 条，待处理）：',
        'block.file': '文件：{path}',
        'block.url': '资源：{url}',
        'block.selector': '元素：{selector}',
        'block.tag': '标签：<{tag}>',
        'block.text': '当前文本：{text}',
        'block.style': '样式：字号 {fontSize}，颜色 {color}，背景 {backgroundColor}',
        'block.status': '状态：{status}',
        'status.pending': '待处理',
        'status.applied': '已处理',
      },
      en: {
        'bar.pending': '{count} pending',
        'bar.send': 'Send to Agent',
        'bar.sending': 'Sending…',
        'bar.autoSend': 'Auto-send',
        'bar.clear': 'Clear',
        'bar.confirmClear': 'Confirm clear',
        'frame.loading': 'Rendering document…',
        'frame.failed': 'This HTML document could not be previewed',
        'frame.title': 'HTML document preview',
        'notice.apiUnavailable': 'The plugin service is unavailable; annotations may not be saved',
        'notice.saveFailed': 'Save failed. Please retry.',
        'notice.sent': 'Sent {count} annotation(s)',
        'notice.sendFailed': 'Send failed: {error}',
        'notice.sendUnavailable': 'This conversation cannot send directly',
        'notice.noSession': 'The current session is unknown; cannot send',
        'notice.nothingToSend': 'There are no pending annotations',
        'notice.cleared': 'All annotations for this file were cleared',
        'notice.clearFailed': 'Could not clear annotations. Please retry.',
        'notice.clearArmed': 'Click “Clear” again to confirm',
        'block.head': 'HTML file annotations ({count} pending):',
        'block.file': 'File: {path}',
        'block.url': 'Resource: {url}',
        'block.selector': 'Element: {selector}',
        'block.tag': 'Tag: <{tag}>',
        'block.text': 'Current text: {text}',
        'block.style': 'Styles: font-size {fontSize}, color {color}, background {backgroundColor}',
        'block.status': 'Status: {status}',
        'status.pending': 'pending',
        'status.applied': 'applied',
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
    const LANG = detectLang();
    const t = (key, vars) => {
      const table = CATALOG[LANG] || CATALOG.zh;
      let text = table[key];
      if (text === undefined) text = CATALOG.en[key];
      if (text === undefined) text = key;
      if (!vars) return text;
      return String(text).replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name) =>
        Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match,
      );
    };

    // --------------------------------------------------------------- utils
    const isPending = (annotation) => !annotation || annotation.status !== 'applied';
    const truncate = (value, max) => {
      const text = String(value === undefined || value === null ? '' : value);
      return text.length > max ? text.slice(0, max) : text;
    };
    const isPlainObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

    // ------------------------------------------------- dsh-resource addresses
    // Adapted from @deepseek-ai/dsh-client-ui-sidebar-documentpreview (MIT).
    const encodeSegment = (segment) => encodeURIComponent(segment).replace(/%3A/gi, ':');
    const encodePath = (path) => path.split('/').map(encodeSegment).join('/');
    const isDriveSegment = (segment) => segment !== undefined && /^[A-Za-z]:$/.test(segment);

    const sessionFileAddress = (sessionId, path) => {
      const normalized = path.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
      return `${FILE_ADDRESS_PREFIX}session/${encodeSegment(sessionId)}/${encodePath(normalized)}`;
    };

    const parseFileAddress = (address) => {
      try {
        if (typeof address !== 'string' || !address.startsWith(FILE_ADDRESS_PREFIX)) return undefined;
        const end = address.search(/[?#]/);
        const [scope, ...rest] = address.slice(20, end === -1 ? undefined : end).split('/');
        if (scope === 'session') {
          const [id, ...segments] = rest;
          if (id === undefined || id === '' || segments.length === 0) return undefined;
          return {
            scope,
            sessionId: decodeURIComponent(id),
            path: segments.map(decodeURIComponent).join('/'),
          };
        }
        if (scope === 'absolute') {
          const unc = rest[0] === '' && rest.length > 1;
          const segments = (unc ? rest.slice(1) : rest).map(decodeURIComponent);
          if (segments.length === 0 || segments[0] === '') return undefined;
          if (unc) return { scope, path: `//${segments.join('/')}` };
          return { scope, path: isDriveSegment(segments[0]) ? segments.join('/') : `/${segments.join('/')}` };
        }
        return undefined;
      } catch {
        return undefined;
      }
    };

    const hostFileOf = (address) => {
      const parsed = parseFileAddress(address);
      if (!parsed || parsed.scope !== 'session') {
        throw new Error(`dsh-annotate-sync: not a session file address "${address}"`);
      }
      return { sessionId: parsed.sessionId, path: parsed.path };
    };

    /** Directory-safe display name of a file address or path. */
    const baseName = (value) => {
      const text = String(value === undefined || value === null ? '' : value);
      const trimmed = text.replace(/[/\\]+$/, '');
      const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\')) + 1;
      return trimmed.slice(cut) || 'HTML';
    };

    /** Session/path/name of a resource address, or null when it is not one. */
    const fileInfoOf = (address) => {
      try {
        const file = hostFileOf(address);
        return { sessionId: file.sessionId, path: file.path, name: baseName(file.path) };
      } catch {
        return null;
      }
    };

    // ---------------------------------------------- bytes / bootstrap helpers
    // Adapted from @deepseek-ai/dsh-client-ui-sidebar-documentpreview (MIT).
    const decodeText = (data) => new TextDecoder('utf-8', { fatal: true }).decode(data);
    const encodeText = (text) => {
      const bytes = new TextEncoder().encode(text);
      const chunks = [];
      for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_BYTES) {
        chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK_BYTES)));
      }
      return btoa(chunks.join(''));
    };

    /** JSON safe to embed inside an inline <script> in the iframe document. */
    const inlineJson = (value) =>
      JSON.stringify(value)
        .replace(/</g, '\\u003c')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');

    /** JavaScript string literal safe to embed in the bootstrap <script>. */
    const jsString = (value) => inlineJson(String(value));

    const attrEscape = (value) =>
      String(value)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

    /**
     * Build the outer iframe document.
     * Adapted from the builtin html/bootstrap.js (MIT). The overlay bootstrap is
     * appended to the page HTML before document.write so the overlay script
     * starts with the document itself.
     */
    const createHtmlDocument = (bundle, overlayHtml) => `<!doctype html><meta charset="utf-8"><script>(()=>{
const bytes=data=>Uint8Array.from(atob(data),character=>character.charCodeAt(0));
const text=data=>new TextDecoder('utf-8',{fatal:true}).decode(bytes(data));
const bundle=JSON.parse(text("${encodeText(
      JSON.stringify({
        html: decodeText(bundle.data),
        assets: bundle.assets.map((asset) => ({
          kind: asset.kind,
          reference: asset.reference,
          text: decodeText(asset.data),
        })),
      }),
    )}"));
let html=bundle.html;
if(bundle.assets.length){
  const parsed=new DOMParser().parseFromString(html,'text/html');
  for(const asset of bundle.assets){
    const script=asset.kind==='script';
    const url=URL.createObjectURL(new Blob([asset.text],{type:script?'application/javascript':'text/css'}));
    const attribute=script?'src':'href';
    for(const element of parsed.querySelectorAll(script?'script[src]':'link[rel~="stylesheet" i][href]')){
      if(element.getAttribute(attribute)===asset.reference)element.setAttribute(attribute,url);
    }
  }
  html='<!doctype html>'+parsed.documentElement.outerHTML;
}
html += ${jsString(overlayHtml)};
document.open();document.write(html);document.close();
})()<\/script>`;

    /** Inline config + overlay <script> appended to the rendered document. */
    const buildOverlayHtml = (config) =>
      '<script>window.__DSH_ANNOTATE__=' +
      inlineJson(config) +
      ';<\/script><script src="' +
      attrEscape(config.overlaySrc) +
      '"><\/script>';

    // ------------------------------------------------------- relative packing
    // Adapted from @deepseek-ai/dsh-client-ui-sidebar-documentpreview (MIT).
    const isRelativeReference = (reference) =>
      reference.length > 0 && !/^(?:[a-z][a-z\d+.-]*:|[/\\#?])/iu.test(reference) && !reference.includes('\0');

    /**
     * Collect direct relative classic-script / stylesheet dependencies without
     * executing or mounting document elements in the parent page. Same limits
     * as the builtin renderer.
     */
    const packHtml = async (data, readRelative, signal) => {
      signal.throwIfAborted();
      let total = data.byteLength;
      if (total > MAX_TOTAL_BYTES) throw new Error('HTML package exceeds its total byte limit');
      const template = document.createElement('template');
      template.innerHTML = decodeText(data);
      const assets = [];
      if (template.content.querySelector('base[href]') !== null) return { data, assets };
      const seen = new Set();
      for (const element of template.content.querySelectorAll('script[src],link[href]')) {
        const script = element.localName === 'script';
        const type = (element.getAttribute('type') || '').trim().toLowerCase();
        if (script && !['', 'text/javascript', 'application/javascript'].includes(type)) continue;
        if (!script && !(element.getAttribute('rel') || '').toLowerCase().split(/\s+/u).includes('stylesheet')) continue;
        const reference = element.getAttribute(script ? 'src' : 'href');
        const suffix = reference.search(/[?#]/u);
        const path = suffix === -1 ? reference : reference.slice(0, suffix);
        if (!isRelativeReference(reference) || !(script ? /\.js$/iu : /\.css$/iu).test(path)) continue;
        const kind = script ? 'script' : 'stylesheet';
        const key = `${kind}:${reference}`;
        if (seen.has(key)) continue;
        if (assets.length >= MAX_ASSETS) throw new Error('HTML package exceeds its asset count limit');
        signal.throwIfAborted();
        const asset = await readRelative(reference, signal);
        signal.throwIfAborted();
        const size = asset.data.byteLength;
        if (size > MAX_ASSET_BYTES) throw new Error('HTML asset exceeds its byte limit');
        total += size;
        if (total > MAX_TOTAL_BYTES) throw new Error('HTML package exceeds its total byte limit');
        decodeText(asset.data);
        assets.push({ kind, reference, data: asset.data });
        seen.add(key);
      }
      return { data, assets };
    };

    const combineSignals = (first, second) => {
      try {
        if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
          return AbortSignal.any([first, second]);
        }
      } catch (error) {
        void error;
      }
      return first;
    };

    /**
     * Bind the workspace reader to the original HTML file's address.
     * Adapted from the builtin html/read-relative.js (MIT).
     */
    const createReadHtmlRelative = (readRelated, address, lifetime, addResource) => async (reference, signal) => {
      const suffix = reference.search(/[?#]/u);
      const path = decodeURIComponent(suffix === -1 ? reference : reference.slice(0, suffix));
      if (path.length === 0 || /^(?:[a-z][a-z\d+.-]*:|[/\\])/iu.test(path) || path.includes('\0') || path.includes('\\')) {
        throw new Error('HTML dependency must use a relative file path');
      }
      const combined = combineSignals(lifetime, signal);
      combined.throwIfAborted();
      const file = hostFileOf(address);
      const result = await readRelated(address, path, combined);
      combined.throwIfAborted();
      if (!result || !result.ok) {
        const error = result && result.error;
        const details = error && error.details;
        if (details && typeof details.path === 'string') addResource(sessionFileAddress(file.sessionId, details.path));
        throw new Error((error && error.message) || 'HTML dependency could not be read');
      }
      addResource(sessionFileAddress(file.sessionId, result.value.absolutePath));
      return result.value;
    };

    // ----------------------------------------------------------- host API
    const apiRequest = async (method, args) => {
      try {
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const timer = controller ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : null;
        try {
          const response = await fetch(API_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ method: method, args: args || {} }),
            credentials: 'same-origin',
            signal: controller ? controller.signal : undefined,
          });
          const payload = await response.json();
          if (!payload || typeof payload !== 'object') return { ok: false, error: 'bad response' };
          return payload;
        } finally {
          if (timer) clearTimeout(timer);
        }
      } catch (error) {
        return { ok: false, error: String((error && error.message) || error) };
      }
    };

    // --------------------------------------------------------- normalize
    const normalizeIncoming = (annotation) => {
      if (!isPlainObject(annotation) || typeof annotation.id !== 'string' || !annotation.id) return null;
      const page = isPlainObject(annotation.page) ? annotation.page : { url: '', origin: '', path: '', title: '' };
      const next = Object.assign({}, annotation, {
        note: typeof annotation.note === 'string' ? annotation.note.slice(0, 2000) : '',
        status: annotation.status === 'applied' ? 'applied' : 'pending',
        page: Object.assign({}, page),
      });
      if (typeof next.selector !== 'string') next.selector = '';
      if (typeof next.tag !== 'string') next.tag = '';
      if (typeof next.order !== 'number') next.order = 0;
      return next;
    };

    const sortByOrder = (list) =>
      list.slice().sort((a, b) => {
        const oa = typeof a.order === 'number' ? a.order : 0;
        const ob = typeof b.order === 'number' ? b.order : 0;
        return oa - ob;
      });

    /** Markdown block for the conversation; file-aware per PROTOCOL-v2 §3. */
    const buildSendBlock = (list, file, resourceAddress) => {
      const lines = [t('block.head', { count: list.length })];
      if (file) lines.push('', t('block.file', { path: file.path }));
      if (resourceAddress) lines.push(t('block.url', { url: resourceAddress }));
      list.forEach((annotation, index) => {
        lines.push('');
        lines.push((index + 1) + '. **' + String(annotation.note || '') + '**');
        if (annotation.selector) lines.push('   - ' + t('block.selector', { selector: '`' + annotation.selector + '`' }));
        if (annotation.tag) lines.push('   - ' + t('block.tag', { tag: annotation.tag }));
        if (annotation.textSample) lines.push('   - ' + t('block.text', { text: truncate(annotation.textSample, 160) }));
        const styles = annotation.styles || {};
        if (styles.fontSize || styles.color || styles.backgroundColor) {
          lines.push(
            '   - ' +
              t('block.style', {
                fontSize: styles.fontSize || '-',
                color: styles.color || '-',
                backgroundColor: styles.backgroundColor || '-',
              }),
          );
        }
        lines.push(
          '   - ' + t('block.status', { status: isPending(annotation) ? t('status.pending') : t('status.applied') }),
        );
      });
      return lines.join('\n');
    };

    // --------------------------------------------------------------- style
    const CSS = `
.das-view { display:flex; flex-direction:column; height:100%; min-height:0; min-width:0;
  color:var(--dsw-alias-label-primary,#0f172a); background:var(--dsw-alias-bg-base,#ffffff);
  font:12px/1.4 ui-sans-serif,system-ui,-apple-system,"Segoe UI","PingFang SC",sans-serif;
  color-scheme:light dark; }
.das-view *, .das-view *::before, .das-view *::after { box-sizing:border-box; }
.das-bar { display:flex; flex-wrap:wrap; align-items:center; gap:4px 6px; min-height:34px;
  padding:3px 8px; flex:none; overflow:hidden;
  background:var(--dsw-alias-bg-layer-1,#f8fafc);
  border-bottom:1px solid var(--dsw-alias-border-primary,rgba(15,23,42,.12)); }
.das-file { flex:1 1 90px; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  font-size:12px; font-weight:600; }
.das-count { flex:none; color:var(--dsw-alias-label-secondary,#64748b); font-size:11px; white-space:nowrap; }
.das-send { flex:none; height:24px; padding:0 8px; border:0; border-radius:6px; cursor:pointer;
  background:var(--dsw-alias-brand-primary,#2563eb); color:#fff; font:600 11px/1 inherit; white-space:nowrap; }
.das-send:hover:not(:disabled) { opacity:.88; }
.das-send:disabled { opacity:.45; cursor:default; }
.das-auto { flex:none; display:inline-flex; align-items:center; gap:3px; cursor:pointer;
  color:var(--dsw-alias-label-secondary,#64748b); font-size:11px; white-space:nowrap; }
.das-auto input { width:12px; height:12px; margin:0; accent-color:var(--dsw-alias-brand-primary,#2563eb); }
.das-clear { flex:none; height:24px; padding:0 7px; cursor:pointer; white-space:nowrap;
  border:1px solid var(--dsw-alias-border-primary,rgba(15,23,42,.12)); border-radius:6px;
  background:transparent; color:var(--dsw-alias-label-secondary,#64748b); font-size:11px; }
.das-clear:hover:not(:disabled) { color:var(--dsw-alias-label-primary,#0f172a); }
.das-clear[data-armed="true"] { color:var(--dsw-alias-state-error-primary,#c0392b); border-color:currentColor; }
.das-clear:disabled { opacity:.45; cursor:default; }
.das-notice { flex:none; padding:4px 10px; overflow-wrap:anywhere;
  color:var(--dsw-alias-label-secondary,#64748b); font-size:11px; line-height:1.45;
  background:var(--dsw-alias-bg-layer-1,#f8fafc);
  border-bottom:1px solid var(--dsw-alias-border-primary,rgba(15,23,42,.08)); }
.das-notice[data-kind="error"] { color:var(--dsw-alias-state-error-primary,#c0392b); }
.das-stage { position:relative; flex:1; min-height:0; overflow:hidden; background:var(--dsw-alias-bg-base,#fff); }
.das-frame { display:block; width:100%; height:100%; border:0; background:#fff; }
.das-status { margin:0; padding:12px; color:var(--dsw-alias-label-secondary,#64748b); font-size:12px; }
`;

    const injectStyles = (css) => {
      try {
        const previous = document.querySelector('style[data-dsh-annotate-sync]');
        if (previous && previous.parentNode) previous.parentNode.removeChild(previous);
        const element = document.createElement('style');
        element.setAttribute('data-dsh-annotate-sync', '');
        element.textContent = css;
        document.head.appendChild(element);
        return element;
      } catch (error) {
        warnOnce('style', 'could not inject the renderer stylesheet', error);
        return null;
      }
    };

    // ======================================================================
    // apply(): register the HTML document renderer and its document slot body.
    // ======================================================================
    function apply(ctx) {
      const getService = (name) => {
        try {
          return ctx && typeof ctx.get === 'function' ? ctx.get(name) : undefined;
        } catch (error) {
          return undefined;
        }
      };
      const registerEffect = (setup) => {
        try {
          if (ctx && typeof ctx.effect === 'function') return ctx.effect(setup);
          return setup();
        } catch (error) {
          warnOnce('effect', 'ctx.effect failed', error);
          return undefined;
        }
      };

      const documentPreviews = getService('documentPreviews');
      const slots = getService('slots');
      const sessions = getService('sessions');
      // Injected for scheduling parity with the document preview package; this
      // renderer only uses local, explicitly-cleared timers.
      getService('timer');

      /**
       * Session-scoped workspace read for a relative dependency, mirroring the
       * builtin slot registration (PROTOCOL-v2 §6).
       */
      const readRelated = (address, relativePath, signal) => {
        let file;
        try {
          file = hostFileOf(address);
        } catch (error) {
          return Promise.resolve({
            ok: false,
            error: { code: 'badAddress', message: String((error && error.message) || error), details: {} },
          });
        }
        let remote;
        try {
          remote = getService('remote') || (ctx && ctx.remote);
        } catch (error) {
          remote = undefined;
        }
        const workspaceFiles = remote && remote.workspaceFiles;
        if (!workspaceFiles || typeof workspaceFiles.readBytes !== 'function') {
          warnOnce('remote', 'remote.workspaceFiles is unavailable; relative assets cannot be loaded');
          return Promise.resolve({
            ok: false,
            error: { code: 'remoteUnavailable', message: 'workspace file reader is unavailable', details: {} },
          });
        }
        try {
          return workspaceFiles.readBytes(file.sessionId, relativePath, { baseFile: file.path }, signal);
        } catch (error) {
          return Promise.resolve({
            ok: false,
            error: { code: 'remoteFailed', message: String((error && error.message) || error), details: {} },
          });
        }
      };

      // ------------------------------------------------------- component
      const AnnotatedHtmlBody = (props) => {
        const options = isPlainObject(props) ? props : {};
        const content = options.content;
        const data = content && content.kind === 'bytes' && content.data ? content.data : null;
        const resourceAddress = typeof options.resourceAddress === 'string' ? options.resourceAddress : '';
        const file = fileInfoOf(resourceAddress);
        const sessionId =
          (typeof options.sessionId === 'string' && options.sessionId) || (file ? file.sessionId : '') || '';

        const useTabInfo = typeof options.useTabInfo === 'function' ? options.useTabInfo : null;
        const tabInfo = useTabInfo ? useTabInfo() : null;
        const tab = tabInfo && tabInfo.tab ? tabInfo.tab : null;
        const tabId = tab && tab.id ? String(tab.id) : sessionId || 'file';
        const frameName = 'dsh-annotate-sync-html-' + tabId.replace(/[^A-Za-z0-9_-]+/g, '-');

        const readRelatedProp = typeof options.readRelated === 'function' ? options.readRelated : readRelated;
        const addResource = typeof options.addResource === 'function' ? options.addResource : null;
        const setResources = typeof options.setResources === 'function' ? options.setResources : null;

        const [frame, setFrame] = React.useState(null);
        const [annotations, setAnnotations] = React.useState([]);
        const [mode, setMode] = React.useState('idle');
        const [autoSend, setAutoSend] = React.useState(true);
        const [sending, setSending] = React.useState(false);
        const [notice, setNotice] = React.useState(null);
        const [clearArmed, setClearArmed] = React.useState(false);

        const frameElRef = React.useRef(null);
        const overlayReadyRef = React.useRef(false);
        const annotationsRef = React.useRef(annotations);
        annotationsRef.current = annotations;
        const modeRef = React.useRef('idle');
        modeRef.current = mode;
        const autoSendRef = React.useRef(true);
        autoSendRef.current = autoSend;
        const sessionIdRef = React.useRef(sessionId);
        sessionIdRef.current = sessionId;
        const addressRef = React.useRef(resourceAddress);
        addressRef.current = resourceAddress;
        const sendingRef = React.useRef(false);
        // Annotation ids already delivered in this tab session, so auto-send
        // only carries the new batch instead of resending the whole review.
        const sentIdsRef = React.useRef(new Set());
        const saveTimerRef = React.useRef(null);
        const saveChainRef = React.useRef(Promise.resolve());
        const saveSeqRef = React.useRef(0);
        const noticeTimerRef = React.useRef(null);
        const clearTimerRef = React.useRef(null);
        const packControllerRef = React.useRef(null);
        const messageRef = React.useRef(null);

        const setList = (next) => {
          annotationsRef.current = next;
          setAnnotations(next);
        };

        const showNotice = (message, kind) => {
          if (!message) return;
          setNotice({ message: String(message), kind: kind === 'error' ? 'error' : 'info' });
          if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
          noticeTimerRef.current = setTimeout(() => {
            noticeTimerRef.current = null;
            setNotice(null);
          }, NOTICE_MS);
        };

        // ------------------------------------------------- overlay messages
        const postToOverlay = (type, payload) => {
          const element = frameElRef.current;
          if (!element || !element.contentWindow) return false;
          try {
            // The iframe is opaque (sandbox="allow-scripts"): targetOrigin must be "*".
            element.contentWindow.postMessage(Object.assign({ channel: CHANNEL, type: type }, payload || {}), '*');
            return true;
          } catch (error) {
            return false;
          }
        };

        const postInit = () => {
          postToOverlay('init', {
            annotations: annotationsRef.current,
            pageUrl: resourceAddress,
            mode: modeRef.current,
          });
        };

        // --------------------------------------------------------- save
        const flushSave = () => {
          const list = annotationsRef.current.slice();
          const seq = ++saveSeqRef.current;
          const run = async () => {
            const result = await apiRequest('saveFile', { url: addressRef.current, annotations: list });
            if (!result || !result.ok) {
              showNotice(t('notice.saveFailed'), 'error');
              return;
            }
            if (saveSeqRef.current !== seq) return;
            const saved = Array.isArray(result.annotations)
              ? sortByOrder(result.annotations.map(normalizeIncoming).filter(Boolean))
              : null;
            postToOverlay('set-annotations', { annotations: saved || annotationsRef.current });
          };
          saveChainRef.current = saveChainRef.current.then(run, run);
          return saveChainRef.current;
        };

        const scheduleSave = () => {
          if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
          saveTimerRef.current = setTimeout(() => {
            saveTimerRef.current = null;
            void flushSave();
          }, SAVE_DEBOUNCE_MS);
        };

        // --------------------------------------------------------- send
        const sendPending = async (options) => {
          const auto = !!(options && options.auto === true);
          if (sendingRef.current) return;
          const pending = annotationsRef.current.filter(isPending);
          const list = auto ? pending.filter((item) => !sentIdsRef.current.has(item.id)) : pending;
          if (!list.length) {
            if (!auto) showNotice(t('notice.nothingToSend'), 'info');
            return;
          }
          const sid = sessionIdRef.current;
          const service = sessions || getService('sessions');
          if (!service || !sid || typeof service.scope !== 'function') {
            showNotice(t('notice.sendUnavailable'), 'error');
            return;
          }
          let session = null;
          try {
            const scope = service.scope(sid);
            session = scope && typeof service.sessionOf === 'function' ? service.sessionOf(scope) : null;
          } catch (error) {
            session = null;
          }
          if (!session || typeof session.prompt !== 'function') {
            showNotice(t('notice.sendUnavailable'), 'error');
            return;
          }
          sendingRef.current = true;
          setSending(true);
          let submission = null;
          try {
            const text = buildSendBlock(list, file, resourceAddress);
            if (typeof session.beginSubmission === 'function') {
              submission = session.beginSubmission({ mode: 'queue', text: text, attachments: [] });
            }
            const requestId = submission && submission.requestId;
            const result = await session.prompt([{ type: 'text', text: text }], 'queue', undefined, requestId);
            if (result && result.ok === false) {
              const error = result.error;
              throw new Error(String((error && (error.message || error)) || 'not accepted'));
            }
            if (result && result.value && result.value.accepted === false) throw new Error('not accepted');
            // Sending never marks annotations applied: the Agent applies them.
            // Remember the delivered ids so the next auto-send carries only new notes.
            for (const annotation of list) sentIdsRef.current.add(annotation.id);
            showNotice(t('notice.sent', { count: list.length }), 'info');
          } catch (error) {
            try {
              if (submission && typeof submission.abandon === 'function') submission.abandon();
            } catch (ignored) {
              void ignored;
            }
            showNotice(t('notice.sendFailed', { error: String((error && error.message) || error) }), 'error');
          } finally {
            sendingRef.current = false;
            setSending(false);
          }
        };

        const maybeAutoSend = () => {
          if (!autoSendRef.current || sendingRef.current) return;
          if (!annotationsRef.current.some(isPending)) return;
          void sendPending({ auto: true });
        };

        const onOverlayMessage = (message) => {
          if (message.type === 'ready') {
            overlayReadyRef.current = true;
            postInit();
            return;
          }
          if (message.type === 'create' || message.type === 'update') {
            const incoming = normalizeIncoming(message.annotation);
            if (!incoming) return;
            // The file address is the grouping key; the overlay may omit it in
            // a transition build, so stamp it here as well.
            incoming.page = Object.assign({}, incoming.page, {
              url: resourceAddress,
              path: incoming.page.path || (file ? file.path : ''),
              title: incoming.page.title || (file ? file.name : ''),
            });
            if (file) {
              incoming.file = Object.assign(
                { sessionId: file.sessionId, path: file.path, name: file.name, address: resourceAddress },
                incoming.file || {},
              );
            }
            const list = annotationsRef.current;
            const exists = list.some((item) => item.id === incoming.id);
            const next = exists
              ? list.map((item) => (item.id === incoming.id ? incoming : item))
              : list.concat([incoming]);
            // A new or edited note must be eligible for the next auto-send.
            sentIdsRef.current.delete(incoming.id);
            setList(next);
            scheduleSave();
            return;
          }
          if (message.type === 'remove') {
            if (typeof message.id !== 'string') return;
            sentIdsRef.current.delete(message.id);
            const next = annotationsRef.current.filter((item) => item.id !== message.id);
            setList(next);
            scheduleSave();
            return;
          }
          if (message.type === 'mode') {
            const nextMode = message.mode === 'picking' ? 'picking' : 'idle';
            modeRef.current = nextMode;
            setMode(nextMode);
            if (nextMode === 'idle') maybeAutoSend();
            return;
          }
          if (message.type === 'focus') {
            // This renderer has no annotation list; focus stays inside the overlay.
            return;
          }
          if (message.type === 'notice' && message.message) {
            showNotice(String(message.message), 'info');
          }
        };
        messageRef.current = onOverlayMessage;

        // ------------------------------------------------ listener (stable)
        React.useEffect(() => {
          const listener = (event) => {
            const element = frameElRef.current;
            if (!element || !element.contentWindow) return;
            // Opaque-origin iframe: event.origin === "null" and checking it is
            // wrong. Only the source window plus the channel identify the overlay.
            if (!event || event.source !== element.contentWindow) return;
            const message = event.data;
            if (!message || typeof message !== 'object' || message.channel !== CHANNEL) return;
            const handler = messageRef.current;
            if (typeof handler === 'function') handler(message);
          };
          window.addEventListener('message', listener);
          return () => window.removeEventListener('message', listener);
        }, []);

        // -------------------------------------------------- state on mount
        React.useEffect(() => {
          if (!resourceAddress) return undefined;
          let live = true;
          overlayReadyRef.current = false;
          sentIdsRef.current = new Set();
          void (async () => {
            const result = await apiRequest('state', {});
            if (!live) return;
            if (!result || !result.ok) {
              showNotice(t('notice.apiUnavailable'), 'error');
              return;
            }
            const list = sortByOrder(
              (Array.isArray(result.annotations) ? result.annotations : [])
                .filter((item) => item && isPlainObject(item.page) && item.page.url === resourceAddress)
                .map((item) => {
                  const normalized = normalizeIncoming(item);
                  if (!normalized) return null;
                  if (file) {
                    normalized.file = Object.assign(
                      { sessionId: file.sessionId, path: file.path, name: file.name, address: resourceAddress },
                      normalized.file || {},
                    );
                  }
                  return normalized;
                })
                .filter(Boolean),
            );
            setList(list);
            if (overlayReadyRef.current) postToOverlay('set-annotations', { annotations: list });
          })();
          return () => {
            live = false;
          };
        }, [resourceAddress]);

        // ------------------------------------------- pack document + iframe
        React.useEffect(() => {
          if (!data || !resourceAddress) return undefined;
          const controller = new AbortController();
          packControllerRef.current = controller;
          const resources = new Set();
          const track = (address) => {
            if (!address) return;
            resources.add(address);
            if (addResource) {
              try {
                addResource(address);
              } catch (ignored) {
                void ignored;
              }
            }
          };
          let url;
          overlayReadyRef.current = false;
          (async () => {
            try {
              const readRelative = createReadHtmlRelative(readRelatedProp, resourceAddress, controller.signal, track);
              const bundle = await packHtml(data, readRelative, controller.signal);
              controller.signal.throwIfAborted();
              const harnessOrigin = location.origin;
              const overlayHtml = buildOverlayHtml({
                mode: 'file',
                parentOrigin: harnessOrigin,
                apiOrigin: harnessOrigin,
                file: {
                  url: resourceAddress,
                  path: file ? file.path : '',
                  name: file ? file.name : 'HTML',
                  sessionId: file ? file.sessionId : sessionId,
                },
                overlaySrc: harnessOrigin + OVERLAY_PATH,
              });
              const html = createHtmlDocument(bundle, overlayHtml);
              controller.signal.throwIfAborted();
              url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
              if (!controller.signal.aborted) {
                setFrame({ data: data, readRelated: readRelatedProp, url: url, error: null });
              }
            } catch (error) {
              if (!controller.signal.aborted) {
                setFrame({
                  data: data,
                  readRelated: readRelatedProp,
                  url: undefined,
                  error: String((error && error.message) || error),
                });
              }
            } finally {
              if (!controller.signal.aborted && setResources) {
                try {
                  setResources(Array.from(resources));
                } catch (ignored) {
                  void ignored;
                }
              }
            }
          })();
          return () => {
            controller.abort();
            if (packControllerRef.current === controller) packControllerRef.current = null;
            if (url !== undefined) {
              try {
                URL.revokeObjectURL(url);
              } catch (ignored) {
                void ignored;
              }
            }
          };
        }, [data, resourceAddress, readRelatedProp, addResource, setResources]);

        // ------------------------------------------------- cleanup timers
        React.useEffect(
          () => () => {
            if (noticeTimerRef.current) {
              clearTimeout(noticeTimerRef.current);
              noticeTimerRef.current = null;
            }
            if (clearTimerRef.current) {
              clearTimeout(clearTimerRef.current);
              clearTimerRef.current = null;
            }
            if (saveTimerRef.current) {
              // Do not drop a pending debounced write when the tab unmounts.
              clearTimeout(saveTimerRef.current);
              saveTimerRef.current = null;
              void flushSave();
            }
            if (packControllerRef.current) {
              try {
                packControllerRef.current.abort();
              } catch (ignored) {
                void ignored;
              }
              packControllerRef.current = null;
            }
            frameElRef.current = null;
            overlayReadyRef.current = false;
            // eslint-disable-next-line react-hooks/exhaustive-deps
          },
          [],
        );

        // ------------------------------------------------------- actions
        const onClear = () => {
          if (!clearArmed) {
            setClearArmed(true);
            showNotice(t('notice.clearArmed'), 'info');
            if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
            clearTimerRef.current = setTimeout(() => {
              clearTimerRef.current = null;
              setClearArmed(false);
            }, CLEAR_ARM_MS);
            return;
          }
          setClearArmed(false);
          if (clearTimerRef.current) {
            clearTimeout(clearTimerRef.current);
            clearTimerRef.current = null;
          }
          void (async () => {
            const result = await apiRequest('clear', { pageUrl: resourceAddress });
            if (!result || !result.ok) {
              showNotice(t('notice.clearFailed'), 'error');
              return;
            }
            setList([]);
            postToOverlay('set-annotations', { annotations: [] });
            showNotice(t('notice.cleared'), 'info');
          })();
        };

        if (!data || !resourceAddress) return null;

        const pending = annotations.filter(isPending);
        const pendingCount = pending.length;
        const currentFrame =
          frame && frame.data === data && frame.readRelated === readRelatedProp ? frame : null;
        const name = file ? file.name : baseName(resourceAddress);

        return h(
          'div',
          { className: 'das-view' },
          h(
            'div',
            { className: 'das-bar' },
            h('span', { className: 'das-file', title: file ? file.path : resourceAddress }, name),
            h('span', { className: 'das-count' }, t('bar.pending', { count: pendingCount })),
            h(
              'button',
              {
                type: 'button',
                className: 'das-send',
                disabled: sending || pendingCount === 0,
                onClick: () => void sendPending(),
              },
              sending ? t('bar.sending') : t('bar.send'),
            ),
            h(
              'label',
              { className: 'das-auto' },
              h('input', {
                type: 'checkbox',
                checked: autoSend,
                onChange: (event) => setAutoSend(!!(event && event.target && event.target.checked)),
              }),
              h('span', null, t('bar.autoSend')),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'das-clear',
                'data-armed': clearArmed ? 'true' : undefined,
                disabled: annotations.length === 0,
                onClick: onClear,
              },
              clearArmed ? t('bar.confirmClear') : t('bar.clear'),
            ),
          ),
          notice
            ? h(
                'div',
                { className: 'das-notice', 'data-kind': notice.kind, role: 'status' },
                notice.message,
              )
            : null,
          h(
            'div',
            { className: 'das-stage' },
            currentFrame && currentFrame.url
              ? h('iframe', {
                  key: currentFrame.url,
                  ref: frameElRef,
                  name: frameName,
                  className: 'das-frame',
                  src: currentFrame.url,
                  sandbox: 'allow-scripts',
                  title: t('frame.title'),
                  'data-html-preview': true,
                  onLoad: () => {
                    if (!overlayReadyRef.current) postInit();
                  },
                })
              : h(
                  'p',
                  { className: 'das-status', role: currentFrame && currentFrame.error ? 'alert' : 'status' },
                  currentFrame && currentFrame.error ? t('frame.failed') : t('frame.loading'),
                ),
          ),
        );
      };

      // ----------------------------------------------------- registrations
      registerEffect(() => {
        const element = injectStyles(CSS);
        return () => {
          try {
            if (element && typeof element.remove === 'function') element.remove();
            else if (element && element.parentNode) element.parentNode.removeChild(element);
          } catch (ignored) {
            void ignored;
          }
        };
      });

      if (documentPreviews && typeof documentPreviews.register === 'function') {
        registerEffect(() =>
          documentPreviews.register({
            id: HTML_ID,
            extensions: ['html', 'htm'],
            priority: 'external',
            title: () => 'HTML · 批注',
            loading: 'bytes-complete',
            wrap: false,
          }),
        );
      } else {
        warnOnce('documentPreviews', 'documentPreviews is unavailable; the HTML renderer cannot register');
      }

      if (slots && typeof slots.inject === 'function' && typeof slots.register === 'function') {
        registerEffect(() =>
          slots.inject(DOC_SLOT, () =>
            slots.register(
              {
                name: DOC_SLOT,
                key: HTML_ID,
                inject: () => ({ readRelated: readRelated }),
              },
              AnnotatedHtmlBody,
            ),
          ),
        );
      } else {
        warnOnce('slots', 'slots is unavailable; the annotated HTML body cannot register');
      }
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
