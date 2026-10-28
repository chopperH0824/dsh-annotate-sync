/**
 * HTTP API for the dsh-annotate-sync host half (v2).
 *
 * One endpoint, `POST <route>/api`, with a JSON envelope `{ method, args }`
 * (docs/PROTOCOL-v2.md section 5). Every response is either `{ ok: true, ... }`
 * or `{ ok: false, code, error }`; failures never leak stack traces.
 *
 * v2 removed the local-service preview proxy, so `preview`, `detect` and
 * `releasePreview` are gone. The panel posts same-origin from the harness, so
 * no CORS headers are emitted here; the route is restricted to loopback peers.
 */

/** Error codes from the v2 protocol contract. */
export const API_CODES = Object.freeze(["badMethod", "badArgs", "methodNotAllowed", "loopbackOnly", "internal"]);

const HTTP_STATUS_BY_CODE = Object.freeze({
  badMethod: 400,
  badArgs: 400,
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

/** Normalize a status argument; null when invalid. */
function asStatus(value) {
  return value === "pending" || value === "applied" ? value : null;
}

/** Normalize a non-empty string argument; "" when invalid. */
function asId(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Create the API request handler.
 *
 * @param {object} options
 * @param {object} options.store store facade from createStore
 * @param {object} [options.config] { maxBodyBytes }
 * @param {object} [options.log] Logger ({ info, warn })
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createApiHandler({ store, readAsset = null, config = {}, log } = {}) {
  if (store === null || typeof store !== "object" || typeof store.list !== "function") {
    throw new TypeError("createApiHandler: store is required");
  }

  const maxBodyBytes =
    Number.isSafeInteger(config.maxBodyBytes) && config.maxBodyBytes > 0 ? config.maxBodyBytes : DEFAULT_MAX_BODY_BYTES;
  const warn = (message) => {
    try {
      log?.warn?.(`annotate-sync: ${message}`);
    } catch {
      /* logging must never break the handler */
    }
  };

  const methods = {
    /** Panel bootstrap: every annotation plus the derived page groups. */
    async state() {
      await store.ensureLoaded?.();
      return {
        annotations: store.list(),
        pages: typeof store.pages === "function" ? store.pages() : [],
      };
    },

    /** v2 document save: replace exactly one file group (`page.url === url`). */
    async saveFile(args) {
      const url = typeof args.url === "string" ? args.url.trim() : "";
      if (url === "") throw apiError("badArgs", "url must be a non-empty string");
      if (!Array.isArray(args.annotations)) throw apiError("badArgs", "annotations must be an array");
      if (typeof store.replacePage !== "function") throw apiError("internal", "store does not support saveFile");
      const result = await store.replacePage(url, args.annotations);
      return { count: result.count, updatedAt: result.updatedAt, annotations: result.annotations };
    },

    /** Legacy full save (v1 panel compatibility). */
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

    /**
     * Relative asset read for the HTML renderer. Normally the browser uses
     * `ctx.remote.workspaceFiles`; this host fallback survives a not-ready or
     * unavailable remote face and is restricted to the Session workspace.
     */
    async readAsset(args) {
      if (typeof readAsset !== "function") throw apiError("internal", "asset reader is unavailable");
      try {
        return await readAsset(args);
      } catch (error) {
        if (error && (error.code === "badArgs" || error.code === "internal")) throw error;
        throw apiError("badArgs", String((error && error.message) || error));
      }
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
