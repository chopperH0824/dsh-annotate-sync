/**
 * dsh-annotate-sync — DeepSeek Harness plugin (host half, v2).
 *
 * Responsibilities (docs/PROTOCOL-v2.md):
 * - register the harness-hosted annotation API used by the HTML document
 *   preview component (state / saveFile / setStatus / remove / clear / markdown);
 * - serve the injected overlay script at `<route>/overlay.js`;
 * - own the annotation store (schema v3, file-scoped) and the model tools.
 *
 * v2 removed the loopback preview proxy and local-service discovery entirely:
 * annotations now live on DSH's own HTML document preview, addressed by
 * `dsh-resource://file/...` URLs instead of proxied HTTP pages.
 *
 * The legacy `/api/annotate-sync/annotations` sync bridge from v1 is kept
 * (`legacyRoute`, default on) for pages that were already wired to it, with its
 * permissive CORS and loopback-only behavior.
 */

import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createApiHandler, isLoopbackAddress, sendJson } from "./api.js";
import { buildMarkdown } from "./markdown.js";
import { createStore } from "./store.js";

/** Cordis plugin name used by loader diagnostics. */
export const name = "annotate-sync";

/** Services consumed by this plugin. */
export const inject = ["webServer", "tools"];

const DEFAULT_DIR = "~/.dsh/annotate-sync";
const DEFAULT_ROUTE = "/__dsh-annotate-sync";
const DEFAULT_LEGACY_ROUTE = "/api/annotate-sync/annotations";
const DEFAULT_MAX_BODY_BYTES = 262144;

/** Expand a leading `~` and resolve to an absolute path. */
function resolveDir(input) {
  const raw = typeof input === "string" && input.trim() !== "" ? input.trim() : DEFAULT_DIR;
  if (raw === "~") return homedir();
  if (raw.startsWith("~/")) return join(homedir(), raw.slice(2));
  return resolve(raw);
}

/** Normalize a route prefix: leading slash, no trailing slash. */
function normalizeRoute(value, fallback) {
  const raw = typeof value === "string" ? value.trim() : "";
  const candidate = raw === "" ? fallback : raw;
  const withSlash = candidate.startsWith("/") ? candidate : `/${candidate}`;
  const trimmed = withSlash.length > 1 ? withSlash.replace(/\/+$/, "") : withSlash;
  return trimmed === "/" ? fallback : trimmed;
}

/** Normalize an exact legacy route; "" disables it. */
function normalizeLegacyRoute(value) {
  if (typeof value !== "string" || value.trim() === "") return "";
  const raw = value.trim();
  return raw.startsWith("/") ? raw : `/${raw}`;
}

/** Positive safe integer with a default. */
function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/** Read at most `maxBytes` of a request body; rejects with code `badArgs`. */
function readBoundedBody(req, maxBytes) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        settled = true;
        chunks.length = 0;
        const error = new Error("request body too large");
        error.code = "badArgs";
        rejectPromise(error);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolvePromise(Buffer.concat(chunks).toString("utf-8"));
    });
    req.on("error", (error) => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    });
  });
}

/** Build the three model-facing tools (docs/PROTOCOL-v2.md section 8). */
function buildTools({ store, log }) {
  const toolError = (message) => {
    log?.warn?.(`annotate-sync: ${message}`);
    return new Error(message);
  };

  return [
    {
      name: "read_annotations",
      description:
        "Read the in-place annotations (批注) the user made by clicking elements in a previewed HTML document, or " +
        "the legacy page annotations. Call this whenever the user says “按批注修改”, “apply my annotations”, or asks " +
        "you to fix the annotated elements — it returns each annotation's file path, CSS selector, current " +
        "text/styles and the user's change instruction as a Markdown task sheet plus structured records. For " +
        "file-backed annotations the task sheet names the file (`文件：<path>`), so edit that source file. Only " +
        "pending annotations are returned by default; pass includeDone=true (or status=\"applied\") to read " +
        "annotations already marked applied.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          status: {
            type: "string",
            enum: ["pending", "applied"],
            description: "Only return annotations with this status. Defaults to pending unless includeDone is true.",
          },
          pageUrl: {
            type: "string",
            description: "Only return annotations whose page.url equals this URL (for file annotations: the dsh-resource address).",
          },
          includeDone: {
            type: "boolean",
            description: "Include annotations that were already marked applied. Defaults to false.",
          },
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["count", "markdown", "annotations"],
          properties: {
            count: { type: "number", description: "Number of returned annotations." },
            markdown: { type: "string", description: "Human-readable annotation task sheet, including 文件：<path>." },
            annotations: {
              type: "array",
              description: "Structured annotation records.",
              items: { type: "object", additionalProperties: true },
            },
          },
        },
        render(_args, value) {
          return [{ type: "text", text: String(value?.markdown ?? "") }];
        },
      },
      async execute(rawArgs = {}) {
        const args = rawArgs === null || rawArgs === undefined ? {} : rawArgs;
        await store.ensureLoaded();
        let items = store.list();
        if (typeof args.pageUrl === "string" && args.pageUrl !== "") {
          items = items.filter((annotation) => annotation.page.url === args.pageUrl);
        }
        if (args.status === "pending" || args.status === "applied") {
          items = items.filter((annotation) => annotation.status === args.status);
        } else if (args.includeDone !== true) {
          items = items.filter((annotation) => annotation.status === "pending");
        }
        return { count: items.length, markdown: buildMarkdown(items), annotations: items };
      },
    },
    {
      name: "set_annotation_status",
      description:
        "Update the status of the user's annotations. After you have implemented the requested changes in the " +
        "annotated file, call this with status=\"applied\" (and ids, or all=true scoped by pageUrl) so the panel " +
        "stops showing them as pending. Use status=\"pending\" to reopen them if more work is needed.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["status"],
        properties: {
          ids: {
            type: "array",
            items: { type: "string" },
            description: "Annotation ids to update. Ignored when all=true.",
          },
          status: {
            type: "string",
            enum: ["pending", "applied"],
            description: "Target status.",
          },
          all: {
            type: "boolean",
            description: "Update every annotation in scope (optionally narrowed by pageUrl). Defaults to false.",
          },
          pageUrl: {
            type: "string",
            description: "Restrict the scope to annotations whose page.url equals this URL.",
          },
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["updated", "count"],
          properties: {
            updated: { type: "number", description: "Number of annotations whose status changed." },
            count: { type: "number", description: "Number of annotations in the selected scope." },
          },
        },
        render(args, value) {
          const label = args?.status === "applied" ? "已处理" : "待处理";
          return [{ type: "text", text: `已把 ${value?.updated ?? 0} 条批注（共 ${value?.count ?? 0} 条）标记为${label}。` }];
        },
      },
      async execute(rawArgs = {}) {
        const args = rawArgs === null || rawArgs === undefined ? {} : rawArgs;
        const status = args.status === "pending" || args.status === "applied" ? args.status : null;
        if (status === null) throw toolError("set_annotation_status: status must be pending or applied");
        await store.ensureLoaded();
        const all = store.list();
        const scoped =
          typeof args.pageUrl === "string" && args.pageUrl !== ""
            ? all.filter((item) => item.page.url === args.pageUrl)
            : all;
        const idSet = new Set(Array.isArray(args.ids) ? args.ids.filter((id) => typeof id === "string") : []);
        const targets = args.all === true ? scoped : scoped.filter((item) => idSet.has(item.id));
        if (targets.length > 0) {
          const targetIds = new Set(targets.map((item) => item.id));
          const timestamp = new Date().toISOString();
          const next = all.map((item) =>
            targetIds.has(item.id) ? { ...item, status, updatedAt: timestamp } : item,
          );
          await store.replace(next);
        }
        return { updated: targets.length, count: scoped.length };
      },
    },
    {
      name: "clear_annotations",
      description:
        "Remove stored annotations. Call this only when the user explicitly asks to clear or delete " +
        "annotations; pass pageUrl to clear a single annotated file instead of everything.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          pageUrl: {
            type: "string",
            description: "Only clear annotations whose page.url equals this URL.",
          },
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["cleared"],
          properties: {
            cleared: { type: "number", description: "Number of removed annotations." },
          },
        },
        render(_args, value) {
          return [{ type: "text", text: `已清除 ${value?.cleared ?? 0} 条批注。` }];
        },
      },
      async execute(rawArgs = {}) {
        const args = rawArgs === null || rawArgs === undefined ? {} : rawArgs;
        const pageUrl = typeof args.pageUrl === "string" && args.pageUrl !== "" ? args.pageUrl : undefined;
        return { cleared: await store.clear(pageUrl) };
      },
    },
  ];
}

/**
 * Register the plugin for the lifetime of `ctx`.
 *
 * @param ctx Cordis context providing `webServer`, `tools`, `effect` and `logger`.
 * @param {object} [config] Plugin configuration from cordis.patch.yml.
 */
export function apply(ctx, config = {}) {
  const settings = typeof config === "object" && config !== null && !Array.isArray(config) ? config : {};
  const dir = resolveDir(settings.dir);
  const route = normalizeRoute(settings.route, DEFAULT_ROUTE);
  const legacyRoute = normalizeLegacyRoute(
    settings.legacyRoute === undefined ? DEFAULT_LEGACY_ROUTE : settings.legacyRoute,
  );
  const maxBodyBytes = positiveInteger(settings.maxBodyBytes, DEFAULT_MAX_BODY_BYTES);
  const toolEnabled = settings.tool !== false;

  const log = {
    info(message) {
      try {
        ctx.logger?.info?.(message);
      } catch {
        /* logging must never break activation */
      }
    },
    warn(message) {
      try {
        ctx.logger?.warn?.(message);
      } catch {
        /* logging must never break activation */
      }
    },
  };

  /** Register through `ctx.effect` when available; never fail activation. */
  function registerEffect(factory, label) {
    try {
      if (typeof ctx.effect === "function") return ctx.effect(factory, label);
      return factory();
    } catch (error) {
      log.warn(`${label} unavailable: ${String(error?.message ?? error)}`);
      return undefined;
    }
  }

  const store = createStore({ dir, log });
  const overlayFile = fileURLToPath(new URL("./overlay.js", import.meta.url));
  let overlaySource = null;

  const ASSET_MAX_BYTES = 4 * 1024 * 1024;

  /**
   * Read one relative asset for the HTML document renderer when the browser
   * remote is unavailable. The renderer normally uses
   * `ctx.remote.workspaceFiles.readBytes`; this host-side path keeps the
   * document preview working (relative CSS/JS) even if that remote face is not
   * ready yet. Only files inside the Session's working directory are served.
   */
  async function readWorkspaceAsset(args = {}) {
    const sessionId = typeof args.sessionId === "string" ? args.sessionId.trim() : "";
    const relPath = typeof args.path === "string" ? args.path.trim() : "";
    const baseFile = typeof args.baseFile === "string" ? args.baseFile.trim() : "";
    if (sessionId === "" || relPath === "") {
      const error = new Error("sessionId and path are required");
      error.code = "badArgs";
      throw error;
    }
    let sessions;
    let workingDirectory;
    try {
      sessions = typeof ctx.get === "function" ? ctx.get("sessions") : undefined;
      workingDirectory = typeof ctx.get === "function" ? ctx.get("workingDirectory") : undefined;
    } catch {
      /* unavailable below */
    }
    if (!sessions || typeof sessions.get !== "function" || !workingDirectory || typeof workingDirectory.get !== "function") {
      const error = new Error("workspace file services are unavailable");
      error.code = "internal";
      throw error;
    }
    const session = sessions.get(sessionId);
    if (session === undefined || session === null) {
      const error = new Error("session not found");
      error.code = "badArgs";
      throw error;
    }
    let cwd;
    try {
      cwd = workingDirectory.get(session);
    } catch {
      cwd = undefined;
    }
    if (typeof cwd !== "string" || cwd === "") {
      const error = new Error("session working directory is unavailable");
      error.code = "internal";
      throw error;
    }
    const root = resolve(cwd);
    const target = resolve(root, baseFile === "" ? "." : dirname(baseFile), relPath);
    const rootReal = await realpath(root);
    const targetReal = await realpath(target);
    const inside = (parent, child) => {
      const diff = relative(parent, child);
      return diff !== "" && !diff.startsWith("..") && !isAbsolute(diff);
    };
    if (!inside(rootReal, targetReal) && targetReal !== rootReal) {
      const error = new Error("asset path escapes the session workspace");
      error.code = "badArgs";
      throw error;
    }
    const info = await stat(targetReal);
    if (!info.isFile() || info.size > ASSET_MAX_BYTES) {
      const error = new Error("asset is not a readable file within the size limit");
      error.code = "badArgs";
      throw error;
    }
    const data = await readFile(targetReal);
    return {
      data: Buffer.from(data).toString("base64"),
      absolutePath: relative(rootReal, targetReal),
      size: data.byteLength,
    };
  }

  // --- HTTP API (document preview component -> host) ----------------------
  const api = createApiHandler({
    store,
    readAsset: readWorkspaceAsset,
    config: { maxBodyBytes },
    log,
  });

  /** Load the overlay script once; false when it is not bundled. */
  async function loadOverlaySource() {
    if (overlaySource !== null) return overlaySource;
    try {
      overlaySource = await readFile(overlayFile, "utf-8");
    } catch {
      overlaySource = false;
    }
    return overlaySource;
  }

  /** Serve the injected overlay script. */
  async function serveOverlay(req, res) {
    res.setHeader("access-control-allow-origin", "*");
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendJson(res, 405, { ok: false, code: "methodNotAllowed", error: "GET only" });
      return;
    }
    const source = await loadOverlaySource();
    if (source === false) {
      sendJson(res, 404, { ok: false, code: "notFound", error: "overlay.js is not bundled" });
      return;
    }
    res.statusCode = 200;
    res.setHeader("content-type", "text/javascript; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-content-type-options", "nosniff");
    if (req.method === "HEAD") res.end();
    else res.end(source);
  }

  /** Handler for the plugin's own prefix route. */
  async function handlePrefixed(req, res) {
    let pathname = "/";
    try {
      pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    } catch {
      pathname = "/";
    }
    if (pathname === `${route}/api`) {
      await api(req, res);
      return;
    }
    if (pathname === `${route}/overlay.js`) {
      await serveOverlay(req, res);
      return;
    }
    if (pathname === route || pathname === `${route}/`) {
      sendJson(res, 200, { ok: true, name, route, tool: toolEnabled });
      return;
    }
    sendJson(res, 404, { ok: false, code: "notFound", error: "not found" });
  }

  // --- Legacy v1 sync bridge ----------------------------------------------
  /** v1 bridge: permissive CORS, loopback-only, `{ annotations }` JSON. */
  async function handleLegacy(req, res) {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type");
    res.setHeader("access-control-max-age", "86400");

    if (!isLoopbackAddress(req.socket?.remoteAddress)) {
      sendJson(res, 403, { ok: false, error: "loopback-only" });
      return;
    }

    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }

    await store.ensureLoaded();

    if (req.method === "GET") {
      const annotations = store.list();
      sendJson(res, 200, { ok: true, dir, count: annotations.length, annotations, markdown: await store.markdown() });
      return;
    }

    if (req.method === "DELETE") {
      const cleared = await store.clear();
      sendJson(res, 200, { ok: true, count: 0, cleared, dir });
      return;
    }

    if (req.method === "POST") {
      const mediaType = String(req.headers?.["content-type"] ?? "")
        .split(";", 1)[0]
        .trim()
        .toLowerCase();
      if (mediaType !== "application/json") {
        sendJson(res, 415, { ok: false, error: "content-type must be application/json" });
        return;
      }
      let text;
      try {
        text = await readBoundedBody(req, maxBodyBytes);
      } catch (error) {
        const status = error?.code === "badArgs" ? 413 : 400;
        sendJson(res, status, {
          ok: false,
          error: error?.code === "badArgs" ? "payload too large" : "payload unreadable",
        });
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        sendJson(res, 400, { ok: false, error: "body must be JSON" });
        return;
      }
      const incoming = Array.isArray(parsed?.annotations) ? parsed.annotations : Array.isArray(parsed) ? parsed : null;
      if (incoming === null) {
        sendJson(res, 400, { ok: false, error: "body must contain an annotations array" });
        return;
      }
      const result = await store.replace(incoming);
      log.info(`legacy bridge saved ${result.count} annotation(s) to ${dir}`);
      sendJson(res, 200, { ok: true, count: result.count, dir, updatedAt: result.updatedAt });
      return;
    }

    sendJson(res, 405, { ok: false, error: "method not allowed" });
  }

  // --- Registrations -------------------------------------------------------
  registerEffect(
    () => ctx.webServer.register({ kind: "prefix", path: route, handler: handlePrefixed }),
    `annotate-sync: route ${route}`,
  );

  if (legacyRoute !== "") {
    registerEffect(
      () => ctx.webServer.register({ kind: "exact", path: legacyRoute, handler: handleLegacy }),
      `annotate-sync: legacy route ${legacyRoute}`,
    );
  }

  // --- Model tools ---------------------------------------------------------
  if (toolEnabled && ctx.tools !== undefined && ctx.tools !== null) {
    for (const tool of buildTools({ store, log })) {
      try {
        registerEffect(() => ctx.tools.register(tool), `annotate-sync: tool ${tool.name}`);
      } catch (error) {
        log.warn(`tool ${tool.name} was not registered: ${String(error?.message ?? error)}`);
      }
    }
  }

  log.info(`annotate-sync: serving ${route} -> ${dir}`);
}
