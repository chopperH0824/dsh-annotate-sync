/**
 * HTTP API for the dsh-annotate-sync host half.
 *
 * One endpoint, `POST <route>/api`, with a JSON envelope `{ method, args }`
 * (docs/PROTOCOL.md section 5). Every response is either `{ ok: true, ... }`
 * or `{ ok: false, code, error }`; failures never leak stack traces.
 *
 * The panel posts same-origin from the harness, so no CORS headers are emitted
 * here. The route is additionally restricted to loopback peers.
 */

import { randomUUID } from "node:crypto";

/** Error codes from the protocol contract. */
export const API_CODES = Object.freeze([
  "badMethod",
  "badArgs",
  "notLocalTarget",
  "previewFailed",
  "tooManyPreviews",
  "methodNotAllowed",
  "loopbackOnly",
  "internal",
]);

const HTTP_STATUS_BY_CODE = Object.freeze({
  badMethod: 400,
  badArgs: 400,
  notLocalTarget: 403,
  previewFailed: 502,
  tooManyPreviews: 429,
  methodNotAllowed: 405,
  loopbackOnly: 403,
  internal: 500,
});

const DEFAULT_MAX_BODY_BYTES = 262144;

/** Create an Error carrying one of the protocol error codes. */
function apiError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** Whether a socket address belongs to the loopback interface. */
export function isLoopbackAddress(address) {
  if (typeof address !== "string" || address === "") return false;
  return (
    address === "::1" ||
    address === "::ffff:127.0.0.1" ||
    address === "localhost" ||
    address.startsWith("127.") ||
    address.startsWith("::ffff:127.")
  );
}

/** Whether a URL hostname resolves to a loopback interface literal. */
export function isLoopbackHost(hostname) {
  if (typeof hostname !== "string" || hostname === "") return false;
  const host = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return host === "localhost" || host === "::1" || host.startsWith("127.") || host.startsWith("::ffff:127.");
}

/** Whether a value is a plain object (not null / array). */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** JSON response with no-store caching. */
export function sendJson(res, status, payload) {
  if (res.writableEnded === true) return;
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-content-type-options", "nosniff");
  res.end(body);
}

/** Failure envelope. */
function fail(res, status, code, error) {
  sendJson(res, status, { ok: false, code, error: String(error ?? code) });
}

/** Read a bounded request body as UTF-8; rejects with `badArgs` when too large. */
function readBoundedBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        settled = true;
        chunks.length = 0;
        reject(apiError("badArgs", "request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf-8"));
    });
    req.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

/** Validate a preview target: absolute http(s), loopback, not the harness itself. */
function inspectTarget(value, harnessOrigin) {
  if (typeof value !== "string" || value.trim() === "") {
    return { ok: false, error: "url must be a non-empty string" };
  }
  let target;
  try {
    target = new URL(value.trim());
  } catch {
    return { ok: false, error: "url must be an absolute http(s) URL" };
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return { ok: false, error: "only http(s) targets can be previewed" };
  }
  if (target.username !== "" || target.password !== "") {
    return { ok: false, error: "targets with credentials are not allowed" };
  }
  if (!isLoopbackHost(target.hostname)) {
    return { ok: false, error: "only loopback targets can be previewed" };
  }
  if (typeof harnessOrigin === "string" && harnessOrigin !== "") {
    try {
      if (new URL(harnessOrigin).origin === target.origin) {
        return { ok: false, error: "refusing to preview the harness itself" };
      }
    } catch {
      /* an unparseable harness origin cannot match anything */
    }
  }
  return { ok: true, url: target.href };
}

/** Normalize a status argument; null when invalid. */
function asStatus(value) {
  return value === "pending" || value === "applied" ? value : null;
}

/** Normalize a non-empty string argument; "" when invalid. */
function asId(value) {
  return typeof value === "string" ? value.trim() : "";
}

/** Normalize an http(s) origin supplied by the panel; "" when invalid. */
function asOrigin(value) {
  if (typeof value !== "string" || value.trim() === "") return "";
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : "";
  } catch {
    return "";
  }
}

/**
 * Create the API request handler.
 *
 * @param {object} options
 * @param {object} options.store store facade from createStore
 * @param {object|Function} [options.previewManager] preview manager or async facade
 * @param {Function} [options.detect] service detector
 * @param {object} [options.config] { maxBodyBytes, root, ports, getHarnessOrigin }
 * @param {object} [options.log] Logger ({ info, warn })
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createApiHandler({ store, previewManager = null, detect = null, config = {}, log } = {}) {
  if (store === null || typeof store !== "object" || typeof store.list !== "function") {
    throw new TypeError("createApiHandler: store is required");
  }

  const maxBodyBytes =
    Number.isSafeInteger(config.maxBodyBytes) && config.maxBodyBytes > 0 ? config.maxBodyBytes : DEFAULT_MAX_BODY_BYTES;
  const extraPorts = Array.isArray(config.ports)
    ? config.ports.filter((port) => Number.isInteger(port) && port > 0 && port <= 65535)
    : [];
  const warn = (message) => {
    try {
      log?.warn?.(`annotate-sync: ${message}`);
    } catch {
      /* logging must never break the handler */
    }
  };

  /** Services discovered by the last `detect` call (state reuses them). */
  let services = [];

  /** Resolve the harness origin used as the overlay's parent origin. */
  function harnessOrigin() {
    try {
      if (typeof config.getHarnessOrigin === "function") return String(config.getHarnessOrigin() ?? "");
      if (typeof config.harnessOrigin === "string") return config.harnessOrigin;
    } catch (error) {
      warn(`failed to resolve the harness origin: ${String(error?.message ?? error)}`);
    }
    return "";
  }

  /** Require preview support (feature flag or missing teammate module). */
  function requirePreviewManager() {
    if (previewManager === null || previewManager === undefined) {
      throw apiError("previewFailed", "preview support is not available");
    }
    return previewManager;
  }

  const methods = {
    async state() {
      await store.ensureLoaded?.();
      const annotations = store.list();
      return {
        root: typeof config.root === "string" ? config.root : store.filePaths?.dir ?? "",
        services,
        annotations,
        pages: typeof store.pages === "function" ? store.pages() : [],
      };
    },

    async detect(args) {
      if (typeof detect !== "function") throw apiError("internal", "service detection is not available");
      const requested = Array.isArray(args.ports)
        ? args.ports.filter((port) => Number.isInteger(port) && port > 0 && port <= 65535)
        : [];
      const ports = [...new Set([...extraPorts, ...requested])];
      try {
        services = await detect({ ports });
      } catch (error) {
        throw apiError("internal", `service detection failed: ${String(error?.message ?? error)}`);
      }
      return { services };
    },

    async preview(args) {
      const manager = requirePreviewManager();
      const harness = harnessOrigin();
      const target = inspectTarget(args.url, harness);
      if (!target.ok) throw apiError("notLocalTarget", target.error);

      const lease = asId(args.lease) === "" ? randomUUID() : asId(args.lease);
      // The panel may be served from `localhost` while webServer.getOrigin() is
      // `127.0.0.1` (or vice versa); postMessage must target the panel's real
      // origin or the overlay's replies are dropped.
      const parentOrigin = asOrigin(args.parentOrigin) || harness;
      let result;
      try {
        result = await manager.preview({ target: target.url, lease, parentOrigin });
      } catch (error) {
        if (error?.code === "tooManyPreviews") {
          throw apiError("tooManyPreviews", "too many previews are open; release one first");
        }
        if (error?.code === "notLocalTarget") {
          throw apiError("notLocalTarget", String(error?.message ?? "only loopback targets can be previewed"));
        }
        throw apiError("previewFailed", `failed to start the preview: ${String(error?.message ?? error)}`);
      }
      if (typeof result?.origin !== "string" || result.origin === "") {
        throw apiError("previewFailed", "the preview proxy returned no origin");
      }
      return {
        origin: result.origin,
        lease: typeof result.lease === "string" && result.lease !== "" ? result.lease : lease,
        target: typeof result.target === "string" && result.target !== "" ? result.target : target.url,
      };
    },

    async releasePreview(args) {
      const lease = asId(args.lease);
      if (lease === "") throw apiError("badArgs", "lease is required");
      const manager = requirePreviewManager();
      let released;
      try {
        released = await manager.release(lease);
      } catch (error) {
        throw apiError("previewFailed", `failed to release the preview: ${String(error?.message ?? error)}`);
      }
      return { released: released !== false };
    },

    async save(args) {
      if (!Array.isArray(args.annotations)) throw apiError("badArgs", "annotations must be an array");
      const result = await store.replace(args.annotations);
      return { count: result.count, updatedAt: result.updatedAt };
    },

    async setStatus(args) {
      const id = asId(args.id);
      if (id === "") throw apiError("badArgs", "id is required");
      const status = asStatus(args.status);
      if (status === null) throw apiError("badArgs", "status must be pending or applied");
      const annotation = await store.setStatus(id, status);
      if (annotation === null) throw apiError("badArgs", `annotation not found: ${id}`);
      return { annotation };
    },

    async remove(args) {
      const id = asId(args.id);
      if (id === "") throw apiError("badArgs", "id is required");
      return { removed: await store.remove(id) };
    },

    async reorder(args) {
      const pageUrl = asId(args.pageUrl);
      if (pageUrl === "") throw apiError("badArgs", "pageUrl is required");
      if (!Array.isArray(args.ids) || args.ids.some((id) => typeof id !== "string")) {
        throw apiError("badArgs", "ids must be an array of annotation ids");
      }
      return { annotations: await store.reorder(pageUrl, args.ids) };
    },

    async clear(args) {
      const pageUrl = asId(args.pageUrl);
      return { cleared: await store.clear(pageUrl === "" ? undefined : pageUrl) };
    },

    async markdown(args) {
      const pageUrl = asId(args.pageUrl);
      const scoped = pageUrl === "" ? undefined : pageUrl;
      await store.ensureLoaded();
      const annotations = scoped === undefined ? store.list() : store.list().filter((item) => item.page.url === scoped);
      return { markdown: await store.markdown(scoped), count: annotations.length };
    },
  };

  return async function handle(req, res) {
    if (!isLoopbackAddress(req.socket?.remoteAddress)) {
      fail(res, 403, "loopbackOnly", "only loopback clients can call this API");
      return;
    }

    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.setHeader("cache-control", "no-store");
      res.end();
      return;
    }

    if (req.method !== "POST") {
      fail(res, 405, "methodNotAllowed", "use POST with a JSON { method, args } body");
      return;
    }

    const mediaType = String(req.headers?.["content-type"] ?? "")
      .split(";", 1)[0]
      .trim()
      .toLowerCase();
    if (mediaType !== "application/json") {
      fail(res, 415, "badArgs", "content-type must be application/json");
      return;
    }

    let text;
    try {
      text = await readBoundedBody(req, maxBodyBytes);
    } catch (error) {
      if (error?.code === "badArgs") fail(res, 413, "badArgs", error.message);
      else fail(res, 400, "badArgs", "request body could not be read");
      return;
    }

    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      fail(res, 400, "badArgs", "body must be JSON");
      return;
    }
    if (!isPlainObject(payload)) {
      fail(res, 400, "badArgs", "body must be a JSON object");
      return;
    }

    const method = payload.method;
    if (typeof method !== "string" || !Object.prototype.hasOwnProperty.call(methods, method)) {
      fail(res, 400, "badMethod", `unknown method: ${String(method)}`);
      return;
    }
    const args = isPlainObject(payload.args) ? payload.args : {};

    try {
      const data = await methods[method](args, req);
      sendJson(res, 200, { ok: true, ...data });
      log?.info?.(`annotate-sync: api ${method} ok`);
    } catch (error) {
      const code =
        typeof error?.code === "string" && HTTP_STATUS_BY_CODE[error.code] !== undefined ? error.code : "internal";
      if (code === "internal") warn(`api ${method} failed: ${String(error?.stack ?? error)}`);
      fail(res, HTTP_STATUS_BY_CODE[code], code, error?.message ?? "internal error");
    }
  };
}
