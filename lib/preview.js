/**
 * dsh-annotate-sync — per-target loopback preview proxy.
 *
 * The sidebar panel embeds the local app in an iframe, but an app served from
 * `http://127.0.0.1:5173` cannot load the annotation overlay from the Harness
 * origin directly: the cross-origin document cannot be instrumented, and its
 * CSP / X-Frame-Options may refuse to render inside the panel at all. Each
 * preview target therefore gets its own loopback HTTP server (random port,
 * bound to 127.0.0.1) that:
 *
 *   - forwards every request to the target, rewriting only the Host header;
 *   - strips CSP / X-Frame-Options and adds `cache-control: no-store` so the
 *     panel iframe always renders the freshest document;
 *   - injects the bootstrap config + overlay script into HTML documents;
 *   - rewrites absolute upstream redirects to the preview origin;
 *   - never proxies anything but loopback, never proxies the Harness itself.
 *
 * v1 deliberately does not relay WebSocket upgrades (see README): HMR sockets
 * simply fail, the page itself keeps working.
 */

import http from "node:http";
import https from "node:https";
import { randomUUID } from "node:crypto";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const STRIPPED_RESPONSE_HEADERS = new Set([
  "content-security-policy",
  "content-security-policy-report-only",
  "x-frame-options",
]);

const PREVIEW_HOST = "127.0.0.1";
const HTML_BUFFER_CAP = 4 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 15_000;
const DEFAULT_OVERLAY_PATH = "/__dsh-annotate-sync/overlay.js";
const DEFAULT_MAX_PREVIEWS = 12;
const DEFAULT_IDLE_MS = 300_000;

/** Build a typed plugin error; `code` is what api.js maps to protocol codes. */
function previewError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** Human-readable message for logs and proxy error pages. */
function describe(error) {
  return error instanceof Error && error.message ? error.message : String(error);
}

/** Whether a hostname can only resolve to this machine's loopback interface. */
function isLoopbackHostname(hostname) {
  const host = String(hostname ?? "")
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "::1" || host === "127.0.0.1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** Parse an http(s) URL, returning null instead of throwing. */
function parseUrl(value) {
  try {
    const url = new URL(String(value));
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url;
  } catch {
    return null;
  }
}

/** Canonical origin string of an http(s) URL, or "". */
function normalizeOrigin(value) {
  const url = parseUrl(value);
  return url === null ? "" : url.origin;
}

/** Effective port of an http(s) URL (explicit or protocol default). */
function effectivePort(url) {
  if (url.port !== "") return url.port;
  return url.protocol === "https:" ? "443" : "80";
}

/**
 * Validate and normalize the requested preview target.
 *
 * @param {unknown} raw
 * @param {string} harnessOrigin
 * @returns {URL}
 */
function parseTarget(raw, harnessOrigin) {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw previewError("notLocalTarget", "preview target must be an http(s) loopback URL");
  }
  const url = parseUrl(raw.trim());
  if (url === null) {
    throw previewError("notLocalTarget", "preview target must be an http(s) URL");
  }
  if (url.username !== "" || url.password !== "") {
    throw previewError("notLocalTarget", "preview target must not contain credentials");
  }
  if (!isLoopbackHostname(url.hostname)) {
    throw previewError("notLocalTarget", "only loopback preview targets are allowed");
  }
  const harness = parseUrl(harnessOrigin);
  if (harness !== null && effectivePort(url) === effectivePort(harness)) {
    // Listening on the Harness port means it *is* the Harness (proxying it
    // would recurse into the panel/API and expose the plugin to itself).
    throw previewError("notLocalTarget", "the Harness origin cannot be previewed");
  }
  return url;
}

/** Read `getHarnessOrigin()` defensively; "" when the host cannot provide it. */
function readHarnessOrigin(getHarnessOrigin, warn) {
  try {
    const value = typeof getHarnessOrigin === "function" ? getHarnessOrigin() : "";
    return normalizeOrigin(value);
  } catch (error) {
    warn(`could not read the Harness origin: ${describe(error)}`);
    return "";
  }
}

/** Keep a caller-supplied parent origin only when it is a plausible http(s) origin. */
function sanitizeParentOrigin(value, fallback = "") {
  return normalizeOrigin(value) || fallback;
}

/** Resolve the overlay script URL to inject (absolute, on the Harness origin). */
function resolveOverlaySource(overlaySrc, overlayPath, apiOrigin) {
  const configured = typeof overlaySrc === "string" && overlaySrc.trim() !== "" ? overlaySrc.trim() : "";
  const fallback = typeof overlayPath === "string" && overlayPath.trim() !== "" ? overlayPath.trim() : DEFAULT_OVERLAY_PATH;
  const raw = configured || fallback;
  if (/^https?:\/\//i.test(raw)) return raw;
  const path = raw.startsWith("/") ? raw : `/${raw}`;
  return apiOrigin === "" ? path : `${apiOrigin}${path}`;
}

/** JSON that is safe to embed inside an inline <script> element. */
function safeJson(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** Escape a string for use inside a double-quoted HTML attribute. */
function escapeAttribute(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Render the inline bootstrap script. Profiles may pass their own
 * `overlayBootstrap` function/string (host-core integration); otherwise we emit
 * the documented `window.__DSH_ANNOTATE__` payload. A broken custom renderer
 * falls back to the default payload instead of losing the overlay.
 */
function renderBootstrap(overlayBootstrap, config) {
  let custom = "";
  try {
    if (typeof overlayBootstrap === "function") custom = overlayBootstrap(config);
    else if (typeof overlayBootstrap === "string") custom = overlayBootstrap;
  } catch {
    custom = "";
  }
  if (typeof custom === "string" && custom.trim() !== "") {
    return /<script[\s>]/i.test(custom) ? custom : `<script>${custom}</script>`;
  }
  return `<script>window.__DSH_ANNOTATE__=${safeJson(config)};</script>`;
}

/** Inject the bootstrap + overlay `<script>` pair before the closing body tag. */
function injectOverlay(html, snippet) {
  const index = html.toLowerCase().lastIndexOf("</body>");
  if (index === -1) return `${html}${snippet}`;
  return `${html.slice(0, index)}${snippet}${html.slice(index)}`;
}

/**
 * Rewrite an absolute redirect that points at the target origin. Relative
 * locations already resolve against the preview origin, so they stay untouched.
 */
function rewriteLocation(value, targetOrigin, proxyOrigin) {
  if (typeof value !== "string" || value === "") return value;
  const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) || value.startsWith("//");
  if (!absolute) return value;
  try {
    const destination = new URL(value, `${targetOrigin}/`);
    if (destination.origin !== targetOrigin) return value;
    return `${proxyOrigin}${destination.pathname}${destination.search}${destination.hash}`;
  } catch {
    return value;
  }
}

/** Write a plain-text proxy failure without crashing on an already-sent head. */
function sendProxyError(res, error) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  try {
    res.writeHead(502, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(`dsh-annotate-sync: preview proxy failed: ${describe(error)}`);
  } catch {
    try {
      res.destroy();
    } catch {
      /* already gone */
    }
  }
}

/** Copy upstream headers for the browser, dropping framing/hop-by-hop headers. */
function buildResponseHeaders(upstreamRes, record, forInjection) {
  const out = {};
  for (const [name, value] of Object.entries(upstreamRes.headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (STRIPPED_RESPONSE_HEADERS.has(lower)) continue;
    if (forInjection && (lower === "content-length" || lower === "content-encoding")) continue;
    if (lower === "location" && typeof value === "string") {
      out[name] = rewriteLocation(value, record.target, record.origin);
      continue;
    }
    out[name] = value;
  }
  out["cache-control"] = "no-store";
  return out;
}

/**
 * Handle one upstream response: stream non-HTML bodies and buffer (bounded)
 * HTML documents so the overlay can be injected before `</body>`.
 */
function handleUpstreamResponse(req, res, upstreamRes, record, helpers) {
  const { warn, buildSnippet } = helpers;
  const status = upstreamRes.statusCode ?? 502;
  const method = String(req.method ?? "GET").toUpperCase();
  const contentType = String(upstreamRes.headers["content-type"] ?? "").toLowerCase();
  const contentEncoding = String(upstreamRes.headers["content-encoding"] ?? "").toLowerCase();
  const encoded = contentEncoding !== "" && contentEncoding !== "identity";
  const bodyless = status === 204 || status === 304;
  const html = contentType.includes("text/html");
  const injectable = method === "GET" && html && !bodyless && !encoded;

  const streamThrough = () => {
    try {
      res.writeHead(status, buildResponseHeaders(upstreamRes, record, false));
    } catch (error) {
      warn(`could not write preview response headers: ${describe(error)}`);
      res.destroy();
      upstreamRes.destroy();
      return;
    }
    upstreamRes.on("error", () => res.destroy());
    upstreamRes.on("aborted", () => res.destroy());
    upstreamRes.pipe(res);
  };

  if (bodyless) {
    upstreamRes.resume();
    try {
      res.writeHead(status, buildResponseHeaders(upstreamRes, record, false));
      res.end();
    } catch (error) {
      warn(`could not write preview response: ${describe(error)}`);
      res.destroy();
    }
    return;
  }

  if (!injectable) {
    streamThrough();
    return;
  }

  const declaredLength = Number(upstreamRes.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > HTML_BUFFER_CAP) {
    // Too big to buffer for injection; serve it untouched (still no-store).
    streamThrough();
    return;
  }

  /** @type {Buffer[]} */
  const chunks = [];
  let size = 0;
  let settled = false;

  const onUpstreamError = () => res.destroy();

  const onData = (chunk) => {
    if (settled) return;
    chunks.push(chunk);
    size += chunk.length;
    if (size > HTML_BUFFER_CAP) {
      // Past the buffering budget: flush what we have and stream the rest.
      settled = true;
      upstreamRes.removeListener("data", onData);
      upstreamRes.removeListener("end", onEnd);
      upstreamRes.removeListener("error", onUpstreamError);
      const buffered = Buffer.concat(chunks);
      chunks.length = 0;
      try {
        res.writeHead(status, buildResponseHeaders(upstreamRes, record, false));
        if (buffered.length > 0) res.write(buffered);
      } catch (error) {
        warn(`could not stream oversized preview HTML: ${describe(error)}`);
        res.destroy();
        upstreamRes.destroy();
        return;
      }
      upstreamRes.on("error", () => res.destroy());
      upstreamRes.on("aborted", () => res.destroy());
      upstreamRes.pipe(res);
    }
  };

  const onEnd = () => {
    if (settled) return;
    settled = true;
    upstreamRes.removeListener("error", onUpstreamError);
    const original = Buffer.concat(chunks);
    chunks.length = 0;
    let body = original;
    try {
      body = Buffer.from(injectOverlay(original.toString("utf8"), buildSnippet(record)), "utf8");
    } catch (error) {
      warn(`overlay injection failed for ${record.target}: ${describe(error)}`);
    }
    let headers;
    try {
      headers = buildResponseHeaders(upstreamRes, record, true);
    } catch (error) {
      warn(`could not build preview headers: ${describe(error)}`);
      res.destroy();
      return;
    }
    headers["content-length"] = String(body.length);
    try {
      res.writeHead(status, headers);
      res.end(body);
    } catch (error) {
      warn(`could not write injected preview response: ${describe(error)}`);
      res.destroy();
    }
  };

  upstreamRes.on("data", onData);
  upstreamRes.on("end", onEnd);
  upstreamRes.on("error", onUpstreamError);
  upstreamRes.on("aborted", onUpstreamError);
}

/** Proxy one browser request to the preview target. */
function proxyRequest(req, res, record, helpers) {
  const warn = helpers.warn;

  // DNS-rebinding hygiene: this server only answers requests addressed to the
  // exact loopback origin it advertised.
  const expectedHost = new URL(record.origin).host;
  if (String(req.headers.host ?? "") !== expectedHost) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    res.end("forbidden");
    return;
  }

  let target;
  try {
    target = new URL(record.target);
  } catch (error) {
    sendProxyError(res, previewError("previewFailed", `invalid preview target: ${describe(error)}`));
    return;
  }

  let requestPath = "/";
  try {
    const incoming = new URL(String(req.url ?? "/"), record.origin);
    requestPath = `${incoming.pathname}${incoming.search}`;
  } catch {
    requestPath = "/";
  }

  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    const lower = name.toLowerCase();
    if (lower === "host" || HOP_BY_HOP.has(lower) || lower === "accept-encoding" || lower.startsWith("proxy-")) {
      continue;
    }
    headers[name] = value;
  }
  headers.host = target.host;

  const transport = target.protocol === "https:" ? https : http;
  let upstream;
  try {
    upstream = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname.replace(/^\[|\]$/g, ""),
        port: target.port === "" ? undefined : target.port,
        method: req.method,
        path: requestPath,
        headers,
      },
      (upstreamRes) => handleUpstreamResponse(req, res, upstreamRes, record, helpers),
    );
  } catch (error) {
    warn(`preview request setup failed for ${record.target}: ${describe(error)}`);
    sendProxyError(res, error);
    return;
  }

  upstream.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
    upstream.destroy(previewError("previewFailed", "upstream request timed out"));
  });
  upstream.on("error", (error) => {
    warn(`preview upstream error for ${record.target}: ${describe(error)}`);
    if (res.headersSent) {
      res.destroy();
      return;
    }
    sendProxyError(res, error);
  });
  req.on("error", () => upstream.destroy());
  res.on("error", () => upstream.destroy());
  res.on("close", () => {
    if (!res.writableEnded) upstream.destroy();
  });
  req.pipe(upstream);
}

/**
 * Create the per-target preview proxy manager.
 *
 * @param {{
 *   getHarnessOrigin?: () => string,
 *   overlayPath?: string,
 *   overlaySrc?: string,
 *   overlayBootstrap?: ((config: object) => string) | string,
 *   maxPreviews?: number,
 *   idleMs?: number,
 *   log?: ((message: string) => void) | { warn?: (message: string) => void, info?: (message: string) => void },
 * }} [options]
 */
export function createPreviewManager(options = {}) {
  const {
    getHarnessOrigin,
    overlayPath = DEFAULT_OVERLAY_PATH,
    overlaySrc,
    overlayBootstrap,
    maxPreviews = DEFAULT_MAX_PREVIEWS,
    idleMs = DEFAULT_IDLE_MS,
    log,
  } = options ?? {};

  const requestedMax = Number(maxPreviews);
  const maxActive = Number.isFinite(requestedMax) && requestedMax >= 1 ? Math.floor(requestedMax) : DEFAULT_MAX_PREVIEWS;
  const requestedIdle = Number(idleMs);
  const idleTimeout = Number.isFinite(requestedIdle) && requestedIdle > 0 ? requestedIdle : DEFAULT_IDLE_MS;

  /** @type {Map<string, object>} */
  const previews = new Map();
  /** @type {Map<string, Promise<object>>} */
  const creating = new Map();
  let generation = 0;

  const warn = (message) => {
    try {
      if (typeof log === "function") log(message);
      else if (log && typeof log.warn === "function") log.warn(message);
      else if (log && typeof log.info === "function") log.info(message);
    } catch {
      /* logging must never break a preview */
    }
  };

  /** Drop a preview record and every socket it owns. */
  const closeRecord = (record) => {
    if (record.closed) return;
    record.closed = true;
    if (previews.get(record.key) === record) previews.delete(record.key);
    try {
      record.server.close();
    } catch {
      /* already closed */
    }
    for (const socket of record.sockets) {
      try {
        socket.destroy();
      } catch {
        /* already gone */
      }
    }
    record.sockets.clear();
  };

  const sweepInterval = Math.max(25, Math.min(30_000, Math.floor(idleTimeout / 2)));
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const record of [...previews.values()]) {
      // A leased preview is held by an open panel: idle HTTP traffic is normal
      // (the page may simply be untouched), so never sweep it. Orphaned
      // previews whose lease was lost are still reclaimed here.
      if (!record.closed && record.leases.size === 0 && now - record.lastUsedAt >= idleTimeout) closeRecord(record);
    }
  }, sweepInterval);
  sweeper.unref?.();

  /** Build the inline bootstrap config for one preview record. */
  const bootstrapConfig = (record) => {
    const apiOrigin = record.harnessOrigin || record.parentOrigin || "";
    const parentOrigin = record.parentOrigin || apiOrigin;
    return {
      parentOrigin,
      apiOrigin,
      lease: record.lease || "",
      target: record.target,
      overlaySrc: resolveOverlaySource(overlaySrc, overlayPath, apiOrigin),
    };
  };

  /** The complete injection snippet: config script + overlay script tag. */
  const buildSnippet = (record) => {
    const config = bootstrapConfig(record);
    const bootstrap = renderBootstrap(overlayBootstrap, config);
    return `${bootstrap}<script src="${escapeAttribute(config.overlaySrc)}"></script>`;
  };

  const helpers = { warn, buildSnippet };

  /** Start the loopback server for one target origin. */
  const startPreview = async (targetUrl, key, harnessOrigin, parentOrigin) => {
    const creationGeneration = generation;
    const record = {
      key,
      target: key,
      origin: "",
      leases: new Set(),
      lease: "",
      parentOrigin: sanitizeParentOrigin(parentOrigin, harnessOrigin),
      harnessOrigin,
      lastUsedAt: Date.now(),
      server: null,
      sockets: new Set(),
      closed: false,
    };

    const server = http.createServer((req, res) => {
      record.lastUsedAt = Date.now();
      try {
        proxyRequest(req, res, record, helpers);
      } catch (error) {
        warn(`preview request failed for ${record.target}: ${describe(error)}`);
        sendProxyError(res, error);
      }
    });
    record.server = server;
    server.on("connection", (socket) => {
      record.sockets.add(socket);
      socket.once("close", () => record.sockets.delete(socket));
    });
    server.on("clientError", (_error, socket) => {
      try {
        socket.destroy();
      } catch {
        /* already gone */
      }
    });

    try {
      await new Promise((resolvePromise, rejectPromise) => {
        const onError = (error) => {
          server.removeListener("listening", onListening);
          rejectPromise(error);
        };
        const onListening = () => {
          server.removeListener("error", onError);
          resolvePromise(undefined);
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(0, PREVIEW_HOST);
      });
    } catch (error) {
      try {
        server.close();
      } catch {
        /* never listened */
      }
      for (const socket of record.sockets) {
        try {
          socket.destroy();
        } catch {
          /* already gone */
        }
      }
      throw previewError("previewFailed", `could not start preview server: ${describe(error)}`);
    }

    const address = server.address();
    if (address === null || typeof address !== "object") {
      closeRecord(record);
      throw previewError("previewFailed", "preview server did not report a bound port");
    }
    record.origin = `http://${PREVIEW_HOST}:${address.port}`;
    // A late server error must not become an uncaught exception.
    server.on("error", (error) => {
      warn(`preview server error for ${record.target}: ${describe(error)}`);
      closeRecord(record);
    });

    if (creationGeneration !== generation) {
      closeRecord(record);
      throw previewError("previewClosed", "preview manager was closed while starting");
    }
    previews.set(key, record);
    return record;
  };

  /** Attach a lease (or mint one) and refresh activity metadata. */
  const attachLease = (record, lease, parentOrigin, harnessOrigin) => {
    const requested = typeof lease === "string" && lease.trim() !== "" ? lease.trim() : "";
    const value = requested || randomUUID();
    record.leases.add(value);
    record.lease = value;
    record.lastUsedAt = Date.now();
    if (harnessOrigin !== "") record.harnessOrigin = harnessOrigin;
    const parent = sanitizeParentOrigin(parentOrigin, record.harnessOrigin);
    if (parent !== "") record.parentOrigin = parent;
    return { origin: record.origin, lease: value, target: record.target, key: record.key };
  };

  /**
   * Open (or reuse) the preview proxy for one loopback target.
   *
   * @param {{target?: string, lease?: string, parentOrigin?: string}} request
   * @returns {Promise<{origin: string, lease: string, target: string, key: string}>}
   */
  const preview = async ({ target, lease, parentOrigin } = {}) => {
    const harnessOrigin = readHarnessOrigin(getHarnessOrigin, warn);
    const targetUrl = parseTarget(target, harnessOrigin);
    const key = targetUrl.origin;

    const existing = previews.get(key);
    if (existing && !existing.closed) {
      return attachLease(existing, lease, parentOrigin, harnessOrigin);
    }

    const pending = creating.get(key);
    if (pending) {
      const record = await pending;
      if (record.closed) throw previewError("previewClosed", "preview was closed while starting");
      return attachLease(record, lease, parentOrigin, harnessOrigin);
    }

    if (previews.size + creating.size >= maxActive) {
      // Reclaim orphaned (unleased) targets before refusing the request.
      // Leased previews belong to an open panel and must never be killed here.
      const now = Date.now();
      for (const record of [...previews.values()]) {
        if (record.leases.size === 0 && now - record.lastUsedAt >= idleTimeout) closeRecord(record);
      }
    }
    if (previews.size + creating.size >= maxActive) {
      throw previewError("tooManyPreviews", `at most ${maxActive} previews may be open at once`);
    }

    const creation = startPreview(targetUrl, key, harnessOrigin, parentOrigin);
    creating.set(key, creation);
    try {
      const record = await creation;
      return attachLease(record, lease, parentOrigin, harnessOrigin);
    } finally {
      if (creating.get(key) === creation) creating.delete(key);
    }
  };

  /**
   * Release one lease. The proxy closes once its last lease is gone.
   *
   * @param {string} lease
   * @returns {boolean} whether the lease belonged to a live preview
   */
  const release = (lease) => {
    const value = typeof lease === "string" ? lease.trim() : "";
    if (value === "") return false;
    for (const record of [...previews.values()]) {
      if (!record.leases.has(value)) continue;
      record.leases.delete(value);
      if (record.leases.size === 0) closeRecord(record);
      return true;
    }
    return false;
  };

  /** Close every preview; safe to call from the plugin's effect cleanup. */
  const closeAll = () => {
    generation += 1;
    const records = [...previews.values()];
    for (const record of records) closeRecord(record);
    previews.clear();
    return records.length;
  };

  /** Snapshot of live previews for diagnostics. */
  const stats = () =>
    [...previews.values()]
      .filter((record) => !record.closed)
      .map((record) => ({
        origin: record.origin,
        target: record.target,
        leases: record.leases.size,
        lastUsedAt: record.lastUsedAt,
        key: record.key,
      }));

  return { preview, release, closeAll, stats };
}
