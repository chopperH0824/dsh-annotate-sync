/**
 * Hermetic host-half tests: store, Markdown, API dispatch and plugin wiring.
 *
 * No network, no dependencies, no writes outside OS temp dirs. Fake HTTP
 * request/response objects and a fake Cordis context keep this fast and stable.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { createApiHandler, isLoopbackAddress } from "../lib/api.js";
import { apply, inject, name } from "../lib/index.js";
import { buildMarkdown, EMPTY_MARKDOWN } from "../lib/markdown.js";
import { createStore, normalizeAnnotation } from "../lib/store.js";

const PRICING_URL = "http://127.0.0.1:5173/pricing";
const ABOUT_URL = "http://127.0.0.1:5173/about";
const HARNESS_ORIGIN = "http://127.0.0.1:62605";
const API_PATH = "/__dsh-annotate-sync/api";
const NOW = "2026-10-28T03:35:40.757Z";

/** Quiet logger for tests. */
function quietLog() {
  return { info() {}, warn() {} };
}

/** Create a temp dir removed when the test ends. */
async function makeTempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "dsh-annotate-host-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Write an annotations.json file (creating its directory first). */
async function writeStoreFile(dir, value) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "annotations.json"), typeof value === "string" ? value : JSON.stringify(value));
}

/** Annotation fixture with the protocol shape. */
function makeAnnotation(overrides = {}) {
  const pageUrl = overrides.pageUrl ?? PRICING_URL;
  const parsed = new URL(pageUrl);
  const page = {
    url: pageUrl,
    origin: parsed.origin,
    path: parsed.pathname,
    title: overrides.pageTitle ?? (pageUrl === PRICING_URL ? "Pricing - Acme" : "About - Acme"),
  };
  return {
    id: overrides.id ?? "annotation-1",
    page,
    selector: overrides.selector ?? "main > section:nth-of-type(2) > h2",
    tag: "h2",
    className: "section-title",
    textSample: "Simple pricing",
    styles: { fontSize: "26px", color: "rgb(248, 250, 252)", backgroundColor: "rgba(0, 0, 0, 0)" },
    rect: { x: 120, y: 340, w: 420, h: 32 },
    note: overrides.note ?? "把标题改成更短的文案",
    status: overrides.status ?? "pending",
    order: overrides.order ?? 0,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

/** Minimal ServerResponse double. */
function makeRes() {
  const res = {
    statusCode: 200,
    headers: Object.create(null),
    chunks: [],
    writableEnded: false,
    setHeader(key, value) {
      res.headers[String(key).toLowerCase()] = value;
    },
    getHeader(key) {
      return res.headers[String(key).toLowerCase()];
    },
    end(chunk) {
      if (chunk !== undefined) res.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      res.writableEnded = true;
    },
    body() {
      return Buffer.concat(res.chunks).toString("utf8");
    },
    json() {
      const text = res.body();
      if (text === "") return null;
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    },
  };
  return res;
}

/** Minimal IncomingMessage double backed by a Readable. */
function makeReq({ method = "POST", url = "/", headers = {}, body, remoteAddress = "127.0.0.1" } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(typeof body === "string" ? body : JSON.stringify(body))];
  const req = Readable.from(chunks);
  req.method = method;
  req.url = url;
  req.headers = headers;
  req.socket = { remoteAddress };
  return req;
}

/** Invoke a route handler and collect its response. */
async function invoke(handler, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (options.body !== undefined && headers["content-type"] === undefined) {
    headers["content-type"] = "application/json";
  }
  const req = makeReq({ ...options, headers });
  const res = makeRes();
  await handler(req, res);
  return {
    status: res.statusCode,
    headers: res.headers,
    text: res.body(),
    json: res.json(),
  };
}

/** Invoke the JSON API envelope. */
async function api(handler, method, args = {}, options = {}) {
  return invoke(handler, {
    method: "POST",
    url: API_PATH,
    body: { method, args },
    ...options,
  });
}

/** Build a fake Cordis context recording route/tool/effect registrations. */
function makeCtx({ withTools = true, withWebServer = true } = {}) {
  const routes = [];
  const tools = [];
  const effects = [];
  const disposers = [];
  const warnings = [];
  const infos = [];

  const ctx = {
    effect(factory, label) {
      effects.push(label);
      const disposer = factory();
      if (typeof disposer === "function") disposers.push(disposer);
      return disposer;
    },
    logger: {
      info(message) {
        infos.push(String(message));
      },
      warn(message) {
        warnings.push(String(message));
      },
    },
  };

  if (withWebServer) {
    ctx.webServer = {
      getOrigin() {
        return HARNESS_ORIGIN;
      },
      register(spec) {
        routes.push(spec);
        return () => {
          spec.disposed = true;
        };
      },
    };
  }

  if (withTools) {
    ctx.tools = {
      register(tool) {
        tools.push(tool);
        return () => {};
      },
    };
  }

  return { ctx, routes, tools, effects, disposers, warnings, infos };
}

// ---------------------------------------------------------------------------
// store.normalize
// ---------------------------------------------------------------------------

test("normalizeAnnotation drops unusable records and applies contract defaults", () => {
  assert.equal(normalizeAnnotation({ selector: "", note: "改", page: {} }, 0, NOW), null);
  assert.equal(normalizeAnnotation({ selector: "h1", note: "", page: {} }, 0, NOW), null);
  assert.equal(normalizeAnnotation({ selector: "   ", note: "   " }, 0, NOW), null);
  assert.equal(normalizeAnnotation(null, 0, NOW), null);
  assert.equal(normalizeAnnotation([], 0, NOW), null);

  const normalized = normalizeAnnotation(
    {
      id: "keep-me",
      page: { url: `${PRICING_URL}#hash`, title: "T".repeat(200) },
      selector: "s".repeat(1200),
      tag: "  h2 ",
      className: "c".repeat(400),
      textSample: "t".repeat(200),
      styles: { fontSize: "26px" },
      rect: { x: 12, y: "bad" },
      note: "n".repeat(2100),
      status: "something-else",
    },
    4,
    NOW,
  );

  assert.equal(normalized.id, "keep-me");
  assert.equal(normalized.selector.length, 1000);
  assert.equal(normalized.note.length, 2000);
  assert.equal(normalized.textSample.length, 160);
  assert.equal(normalized.className.length, 300);
  assert.equal(normalized.page.title.length, 120);
  assert.equal(normalized.page.url, PRICING_URL);
  assert.equal(normalized.page.origin, "http://127.0.0.1:5173");
  assert.equal(normalized.page.path, "/pricing");
  assert.equal(normalized.status, "pending");
  assert.equal(normalized.order, 4);
  assert.equal(normalized.tag, "h2");
  assert.equal(normalized.createdAt, NOW);
  assert.equal(normalized.updatedAt, NOW);
  assert.deepEqual(normalized.rect, { x: 12, y: 0, w: 0, h: 0 });
  assert.deepEqual(normalized.styles, { fontSize: "26px", color: "", backgroundColor: "" });

  const generated = normalizeAnnotation({ selector: "h1", note: "改" }, 0, NOW);
  assert.match(generated.id, /^[0-9a-f-]{36}$/);
  assert.equal(generated.page.url, "unknown");
  assert.equal(generated.page.origin, "");
  assert.equal(generated.page.path, "");
});

// ---------------------------------------------------------------------------
// store migration
// ---------------------------------------------------------------------------

test("store migrates legacy array, legacy object and v2 files", async (t) => {
  const root = await makeTempDir(t);

  const legacyArrayDir = join(root, "legacy-array");
  await writeStoreFile(legacyArrayDir, [{ selector: "#subscribe", note: "按钮文案改短", tag: "button" }]);
  const legacyArray = createStore({ dir: legacyArrayDir, log: quietLog() });
  await legacyArray.ensureLoaded();
  let list = legacyArray.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].page.url, "unknown");
  assert.equal(list[0].status, "pending");
  assert.equal(list[0].order, 0);
  assert.match(list[0].id, /^[0-9a-f-]{36}$/);

  const legacyObjectDir = join(root, "legacy-object");
  await writeStoreFile(legacyObjectDir, {
    updatedAt: NOW,
    dir: "/old/place",
    annotations: [makeAnnotation({ id: "old-1", status: "applied" })],
  });
  const legacyObject = createStore({ dir: legacyObjectDir, log: quietLog() });
  await legacyObject.ensureLoaded();
  list = legacyObject.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "old-1");
  assert.equal(list[0].status, "applied");
  assert.equal(list[0].page.url, PRICING_URL);

  const v2Dir = join(root, "v2");
  await writeStoreFile(v2Dir, { version: 2, updatedAt: NOW, annotations: [makeAnnotation({ id: "v2-1" })] });
  const v2 = createStore({ dir: v2Dir, log: quietLog() });
  await v2.ensureLoaded();
  assert.equal(v2.list().length, 1);

  const brokenDir = join(root, "broken");
  await writeStoreFile(brokenDir, "{not json");
  const broken = createStore({ dir: brokenDir, log: quietLog() });
  await broken.ensureLoaded();
  assert.deepEqual(broken.list(), []);

  const missingDir = join(root, "missing");
  const missing = createStore({ dir: missingDir, log: quietLog() });
  await missing.ensureLoaded();
  assert.deepEqual(missing.list(), []);
});

// ---------------------------------------------------------------------------
// store mutations and persistence
// ---------------------------------------------------------------------------

test("store replace/status/reorder/remove/clear persist v2 JSON and Markdown", async (t) => {
  const dir = await makeTempDir(t);
  const store = createStore({ dir, log: quietLog() });

  const first = makeAnnotation({ id: "a", selector: "#first", order: 0 });
  const second = makeAnnotation({ id: "b", selector: "#second", order: 1 });
  const about = makeAnnotation({ id: "c", pageUrl: ABOUT_URL, selector: "#about", order: 0 });

  const replaced = await store.replace([first, second, about]);
  assert.equal(replaced.count, 3);
  assert.match(replaced.updatedAt, /^\d{4}-\d{2}-\d{2}T/);

  const json = JSON.parse(await readFile(join(dir, "annotations.json"), "utf-8"));
  assert.equal(json.version, 2);
  assert.equal(json.annotations.length, 3);
  assert.equal(typeof json.updatedAt, "string");

  let list = store.list();
  assert.deepEqual(
    list.map((item) => item.id),
    ["c", "a", "b"],
  );

  const pages = store.pages();
  assert.equal(pages.length, 2);
  const pricingPage = pages.find((page) => page.url === PRICING_URL);
  assert.deepEqual(pricingPage, {
    url: PRICING_URL,
    origin: "http://127.0.0.1:5173",
    path: "/pricing",
    title: "Pricing - Acme",
    count: 2,
    pending: 2,
  });

  const updated = await store.setStatus("a", "applied");
  assert.equal(updated.status, "applied");
  assert.equal(await store.setStatus("does-not-exist", "applied"), null);

  const md = await readFile(join(dir, "annotations.md"), "utf-8");
  assert.match(md, /已处理/);
  assert.match(md, /把标题改成更短的文案/);

  const reordered = await store.reorder(PRICING_URL, ["b", "a"]);
  const pricing = reordered.filter((item) => item.page.url === PRICING_URL);
  assert.deepEqual(
    pricing.map((item) => item.id),
    ["b", "a"],
  );
  assert.deepEqual(
    pricing.map((item) => item.order),
    [0, 1],
  );

  assert.equal(await store.remove("c"), true);
  assert.equal(await store.remove("c"), false);
  assert.equal(store.list().length, 2);

  assert.equal(await store.clear(PRICING_URL), 2);
  assert.deepEqual(store.list(), []);
  assert.equal(await store.clear(), 0);

  await store.replace([makeAnnotation({ id: "one" })]);
  const after = JSON.parse(await readFile(join(dir, "annotations.json"), "utf-8"));
  assert.equal(after.annotations.length, 1);

  // Concurrent replace calls must serialize into one valid file.
  await Promise.all([
    store.replace([makeAnnotation({ id: "x" })]),
    store.replace([makeAnnotation({ id: "y" }), makeAnnotation({ id: "z" })]),
  ]);
  const concurrent = JSON.parse(await readFile(join(dir, "annotations.json"), "utf-8"));
  assert.equal(concurrent.version, 2);
  assert.equal(concurrent.annotations.length, 2);
});

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

test("buildMarkdown groups by page, honours order and labels statuses", () => {
  assert.equal(buildMarkdown([]), EMPTY_MARKDOWN);
  assert.equal(buildMarkdown([]), "# 暂无未处理的页面批注\n");
  assert.equal(buildMarkdown(null), EMPTY_MARKDOWN);

  const markdown = buildMarkdown([
    makeAnnotation({ id: "p1", selector: "#second", order: 1 }),
    makeAnnotation({ id: "a1", pageUrl: ABOUT_URL, pageTitle: "About - Acme", selector: "#about", order: 0 }),
    makeAnnotation({ id: "p0", selector: "#first", order: 0, status: "applied" }),
  ]);

  assert.match(markdown, /^# 页面批注清单（共 3 处）/);
  assert.match(markdown, /已处理 1 处/);
  const aboutIndex = markdown.indexOf("## About - Acme");
  const pricingIndex = markdown.indexOf("## Pricing - Acme");
  assert.ok(aboutIndex > 0 && pricingIndex > 0);
  assert.ok(aboutIndex < pricingIndex, "pages are ordered by page.url");

  const firstIndex = markdown.indexOf("#first");
  const secondIndex = markdown.indexOf("#second");
  assert.ok(firstIndex > 0 && secondIndex > 0);
  assert.ok(firstIndex < secondIndex, "annotations are ordered by order");

  assert.match(markdown, /\[已处理\]/);
  assert.match(markdown, /\[待处理\]/);
  assert.match(markdown, /当前文本：/);
  assert.match(markdown, /当前样式：/);
  assert.match(markdown, /修改指令：\*\*把标题改成更短的文案\*\*/);
  assert.ok(markdown.endsWith("\n"));

  const custom = buildMarkdown([], { emptyText: "nothing\n" });
  assert.equal(custom, "nothing\n");
  assert.match(buildMarkdown([makeAnnotation({ id: "p" })], { heading: "自定义清单" }), /^# 自定义清单（共 1 处）/);
});

// ---------------------------------------------------------------------------
// API dispatch
// ---------------------------------------------------------------------------

/** Store + API handler in a temp dir with a configurable preview manager. */
async function makeApiFixture(t, options = {}) {
  const dir = await makeTempDir(t);
  const store = createStore({ dir, log: quietLog() });
  const previewCalls = [];
  const releaseCalls = [];
  const detectCalls = [];
  const previewManager =
    options.previewManager === undefined
      ? {
          async preview(previewOptions) {
            previewCalls.push(previewOptions);
            return { origin: "http://127.0.0.1:7777", lease: previewOptions.lease, target: previewOptions.target };
          },
          async release(lease) {
            releaseCalls.push(lease);
            return true;
          },
        }
      : options.previewManager;
  const detect =
    options.detect === undefined
      ? async (detectOptions) => {
          detectCalls.push(detectOptions);
          return [{ port: 5173, origin: PRICING_URL, url: `${PRICING_URL}/`, title: "Vite", kind: "dev", responseMs: 12 }];
        }
      : options.detect;
  const handler = createApiHandler({
    store,
    previewManager,
    detect,
    config: {
      maxBodyBytes: options.maxBodyBytes ?? 262144,
      root: dir,
      ports: [4321],
      getHarnessOrigin: () => HARNESS_ORIGIN,
    },
    log: quietLog(),
  });
  return { dir, store, handler, previewCalls, releaseCalls, detectCalls };
}

test("API dispatches every protocol method", async (t) => {
  const fixture = await makeApiFixture(t);
  const { handler } = fixture;

  let response = await api(handler, "save", {
    sid: "session-1",
    annotations: [
      makeAnnotation({ id: "a", order: 0 }),
      makeAnnotation({ id: "b", order: 1, status: "applied" }),
    ],
  });
  assert.equal(response.status, 200);
  assert.equal(response.json.ok, true);
  assert.equal(response.json.count, 2);
  assert.match(response.json.updatedAt, /^\d{4}-\d{2}-\d{2}T/);

  response = await api(handler, "state", { sid: "session-1" });
  assert.equal(response.status, 200);
  assert.equal(response.json.root, fixture.dir);
  assert.deepEqual(response.json.services, []);
  assert.equal(response.json.annotations.length, 2);
  assert.equal(response.json.pages.length, 1);
  assert.equal(response.json.pages[0].count, 2);
  assert.equal(response.json.pages[0].pending, 1);

  response = await api(handler, "detect", { sid: "session-1", ports: [5173] });
  assert.equal(response.status, 200);
  assert.equal(response.json.services.length, 1);
  assert.equal(response.json.services[0].port, 5173);
  assert.deepEqual(fixture.detectCalls[0], { ports: [4321, 5173] });

  response = await api(handler, "state", { sid: "session-1" });
  assert.equal(response.json.services.length, 1, "state reuses the detection cache");

  response = await api(handler, "setStatus", { sid: "session-1", id: "a", status: "applied" });
  assert.equal(response.status, 200);
  assert.equal(response.json.annotation.status, "applied");

  response = await api(handler, "reorder", { sid: "session-1", pageUrl: PRICING_URL, ids: ["b", "a"] });
  assert.equal(response.status, 200);
  assert.deepEqual(
    response.json.annotations.map((item) => item.id),
    ["b", "a"],
  );

  response = await api(handler, "markdown", { sid: "session-1", pageUrl: PRICING_URL });
  assert.equal(response.status, 200);
  assert.equal(response.json.count, 2);
  assert.match(response.json.markdown, /## Pricing - Acme/);

  response = await api(handler, "preview", { sid: "session-1", url: `${PRICING_URL}/app`, lease: "lease-1" });
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, { ok: true, origin: "http://127.0.0.1:7777", lease: "lease-1", target: `${PRICING_URL}/app` });
  assert.deepEqual(fixture.previewCalls[0], {
    target: `${PRICING_URL}/app`,
    lease: "lease-1",
    parentOrigin: HARNESS_ORIGIN,
  });

  response = await api(handler, "preview", { sid: "session-1", url: `${PRICING_URL}/other` });
  assert.equal(response.status, 200);
  assert.match(response.json.lease, /^[0-9a-f-]{36}$/, "a lease is generated when omitted");

  response = await api(handler, "releasePreview", { sid: "session-1", lease: "lease-1" });
  assert.equal(response.status, 200);
  assert.equal(response.json.released, true);
  assert.deepEqual(fixture.releaseCalls, ["lease-1"]);

  response = await api(handler, "remove", { sid: "session-1", id: "does-not-exist" });
  assert.equal(response.status, 200);
  assert.equal(response.json.removed, false);

  response = await api(handler, "clear", { sid: "session-1", pageUrl: PRICING_URL });
  assert.equal(response.status, 200);
  assert.equal(response.json.cleared, 2);
});

test("API rejects bad peers, methods, args and targets with protocol codes", async (t) => {
  const fixture = await makeApiFixture(t);
  const { handler, store } = fixture;

  let response = await api(handler, "state", {}, { remoteAddress: "10.0.0.9" });
  assert.equal(response.status, 403);
  assert.equal(response.json.code, "loopbackOnly");
  assert.equal(isLoopbackAddress("10.0.0.9"), false);
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);

  response = await invoke(handler, { method: "GET", url: API_PATH });
  assert.equal(response.status, 405);
  assert.equal(response.json.code, "methodNotAllowed");

  response = await invoke(handler, {
    method: "POST",
    url: API_PATH,
    headers: { "content-type": "text/plain" },
    body: { method: "state", args: {} },
  });
  assert.equal(response.status, 415);
  assert.equal(response.json.code, "badArgs");

  response = await invoke(handler, {
    method: "POST",
    url: API_PATH,
    headers: { "content-type": "application/json" },
    body: "{not json",
  });
  assert.equal(response.status, 400);
  assert.equal(response.json.code, "badArgs");

  response = await api(handler, "no-such-method");
  assert.equal(response.status, 400);
  assert.equal(response.json.code, "badMethod");

  response = await api(handler, "save", { annotations: "nope" });
  assert.equal(response.status, 400);
  assert.equal(response.json.code, "badArgs");

  response = await api(handler, "setStatus", { id: "a", status: "weird" });
  assert.equal(response.status, 400);
  assert.equal(response.json.code, "badArgs");

  response = await api(handler, "setStatus", { id: "missing", status: "applied" });
  assert.equal(response.status, 400);
  assert.equal(response.json.code, "badArgs");

  response = await api(handler, "releasePreview", {});
  assert.equal(response.status, 400);
  assert.equal(response.json.code, "badArgs");

  response = await api(handler, "preview", { url: "http://example.com/app" });
  assert.equal(response.status, 403);
  assert.equal(response.json.code, "notLocalTarget");

  response = await api(handler, "preview", { url: "file:///etc/passwd" });
  assert.equal(response.status, 403);
  assert.equal(response.json.code, "notLocalTarget");

  response = await api(handler, "preview", { url: `${HARNESS_ORIGIN}/` });
  assert.equal(response.status, 403);
  assert.equal(response.json.code, "notLocalTarget");

  response = await api(handler, "preview", { url: `http://user:pass@127.0.0.1:5173/` });
  assert.equal(response.status, 403);
  assert.equal(response.json.code, "notLocalTarget");

  const tooMany = {
    async preview() {
      const error = new Error("limit");
      error.code = "tooManyPreviews";
      throw error;
    },
    async release() {
      return true;
    },
  };
  const tooManyHandler = createApiHandler({
    store,
    previewManager: tooMany,
    config: { root: fixture.dir },
    log: quietLog(),
  });
  response = await api(tooManyHandler, "preview", { url: `${PRICING_URL}/` });
  assert.equal(response.status, 429);
  assert.equal(response.json.code, "tooManyPreviews");

  const notLocal = {
    async preview() {
      const error = new Error("nope");
      error.code = "notLocalTarget";
      throw error;
    },
    async release() {
      return true;
    },
  };
  const notLocalHandler = createApiHandler({ store, previewManager: notLocal, config: {}, log: quietLog() });
  response = await api(notLocalHandler, "preview", { url: `${PRICING_URL}/` });
  assert.equal(response.status, 403);
  assert.equal(response.json.code, "notLocalTarget");

  const failing = {
    async preview() {
      throw new Error("boom");
    },
    async release() {
      throw new Error("boom");
    },
  };
  const failingHandler = createApiHandler({ store, previewManager: failing, config: {}, log: quietLog() });
  response = await api(failingHandler, "preview", { url: `${PRICING_URL}/` });
  assert.equal(response.status, 502);
  assert.equal(response.json.code, "previewFailed");
  response = await api(failingHandler, "releasePreview", { lease: "lease-x" });
  assert.equal(response.status, 502);
  assert.equal(response.json.code, "previewFailed");

  const noPreviewHandler = createApiHandler({ store, detect: null, config: {}, log: quietLog() });
  response = await api(noPreviewHandler, "preview", { url: `${PRICING_URL}/` });
  assert.equal(response.status, 502);
  assert.equal(response.json.code, "previewFailed");
  response = await api(noPreviewHandler, "detect", {});
  assert.equal(response.status, 500);
  assert.equal(response.json.code, "internal");

  response = await invoke(handler, { method: "OPTIONS", url: API_PATH });
  assert.equal(response.status, 204);
  assert.equal(response.text, "");

  const cappedFixture = await makeApiFixture(t, { maxBodyBytes: 64 });
  response = await api(cappedFixture.handler, "save", {
    annotations: [makeAnnotation({ id: "huge", note: "x".repeat(500) })],
  });
  assert.equal(response.status, 413);
  assert.equal(response.json.code, "badArgs");
});

// ---------------------------------------------------------------------------
// Plugin wiring (fake Cordis context)
// ---------------------------------------------------------------------------

test("apply registers the prefix route, legacy bridge, cleanup and three tools", async (t) => {
  const dir = await makeTempDir(t);
  const fake = makeCtx();
  apply(fake.ctx, { dir, legacyRoute: "/api/annotate-sync/annotations", ports: [4321] });

  assert.equal(name, "annotate-sync");
  assert.deepEqual([...inject], ["webServer", "tools"]);

  const prefix = fake.routes.find((route) => route.kind === "prefix");
  assert.ok(prefix, "prefix route registered");
  assert.equal(prefix.path, "/__dsh-annotate-sync");

  const legacy = fake.routes.find((route) => route.kind === "exact");
  assert.ok(legacy, "legacy route registered");
  assert.equal(legacy.path, "/api/annotate-sync/annotations");

  assert.deepEqual(
    fake.tools.map((tool) => tool.name).sort(),
    ["clear_annotations", "read_annotations", "set_annotation_status"],
  );
  for (const tool of fake.tools) {
    assert.equal(tool.parameters.type, "object");
    assert.equal(typeof tool.execute, "function");
    assert.equal(typeof tool.output.render, "function");
  }

  let response = await invoke(prefix.handler, { method: "GET", url: "/__dsh-annotate-sync/" });
  assert.equal(response.status, 200);
  assert.equal(response.json.ok, true);
  assert.equal(response.json.name, "annotate-sync");

  response = await invoke(prefix.handler, { method: "GET", url: "/__dsh-annotate-sync/unknown" });
  assert.equal(response.status, 404);
  assert.equal(response.json.code, "notFound");

  response = await invoke(prefix.handler, {
    method: "POST",
    url: API_PATH,
    body: { method: "save", args: { annotations: [makeAnnotation({ id: "wire-1" }), makeAnnotation({ id: "wire-2" })] } },
  });
  assert.equal(response.status, 200);
  assert.equal(response.json.count, 2);

  // The overlay asset is served when bundled (`lib/overlay.js`) or 404 before.
  response = await invoke(prefix.handler, { method: "GET", url: "/__dsh-annotate-sync/overlay.js" });
  assert.ok([200, 404].includes(response.status));
  if (response.status === 200) {
    assert.match(String(response.headers["content-type"]), /javascript/);
    assert.equal(response.headers["access-control-allow-origin"], "*");
  }

  response = await invoke(prefix.handler, {
    method: "POST",
    url: API_PATH,
    body: { method: "preview", args: { url: "http://example.com/app" } },
  });
  assert.equal(response.status, 403);
  assert.equal(response.json.code, "notLocalTarget");

  let legacyResponse = await invoke(legacy.handler, { method: "GET", url: "/api/annotate-sync/annotations" });
  assert.equal(legacyResponse.status, 200);
  assert.equal(legacyResponse.headers["access-control-allow-origin"], "*");
  assert.equal(legacyResponse.json.count, 2);
  assert.match(legacyResponse.json.markdown, /Pricing/);

  legacyResponse = await invoke(legacy.handler, { method: "OPTIONS", url: "/api/annotate-sync/annotations" });
  assert.equal(legacyResponse.status, 204);
  assert.equal(legacyResponse.headers["access-control-allow-origin"], "*");

  legacyResponse = await invoke(legacy.handler, {
    method: "POST",
    url: "/api/annotate-sync/annotations",
    body: { annotations: [makeAnnotation({ id: "legacy-1" })] },
  });
  assert.equal(legacyResponse.status, 200);
  assert.equal(legacyResponse.json.count, 1);

  legacyResponse = await invoke(legacy.handler, {
    method: "POST",
    url: "/api/annotate-sync/annotations",
    body: [makeAnnotation({ id: "legacy-array" })],
  });
  assert.equal(legacyResponse.status, 200);
  assert.equal(legacyResponse.json.count, 1);

  legacyResponse = await invoke(legacy.handler, {
    method: "POST",
    url: "/api/annotate-sync/annotations",
    headers: { "content-type": "text/plain" },
    body: "{}",
  });
  assert.equal(legacyResponse.status, 415);

  legacyResponse = await invoke(legacy.handler, {
    method: "GET",
    url: "/api/annotate-sync/annotations",
    remoteAddress: "10.0.0.9",
  });
  assert.equal(legacyResponse.status, 403);

  legacyResponse = await invoke(legacy.handler, { method: "DELETE", url: "/api/annotate-sync/annotations" });
  assert.equal(legacyResponse.status, 200);
  assert.equal(legacyResponse.json.count, 0);
  assert.equal(legacyResponse.headers["access-control-allow-origin"], "*");

  // Every registered disposer can run without throwing.
  for (const disposer of fake.disposers) disposer();
});

test("apply honours tool:false and legacyRoute:'' and tolerates a missing tools service", async (t) => {
  const dir = await makeTempDir(t);

  const noTools = makeCtx();
  apply(noTools.ctx, { dir, tool: false, legacyRoute: "" });
  assert.equal(noTools.routes.length, 1, "only the prefix route is registered");
  assert.equal(noTools.routes[0].kind, "prefix");
  assert.equal(noTools.tools.length, 0);

  const minimal = makeCtx({ withTools: false, withWebServer: true });
  assert.doesNotThrow(() => apply(minimal.ctx, { dir, legacyRoute: "" }));
  assert.equal(minimal.routes.length, 1);

  const defaultRoutes = makeCtx();
  apply(defaultRoutes.ctx, { dir });
  assert.ok(
    defaultRoutes.routes.some((route) => route.kind === "exact" && route.path === "/api/annotate-sync/annotations"),
    "the legacy route is on by default",
  );
});

// ---------------------------------------------------------------------------
// Model tools
// ---------------------------------------------------------------------------

test("model tools read pending annotations, update status and clear", async (t) => {
  const dir = await makeTempDir(t);
  const fake = makeCtx();
  apply(fake.ctx, { dir });

  const prefix = fake.routes.find((route) => route.kind === "prefix");
  await invoke(prefix.handler, {
    method: "POST",
    url: API_PATH,
    body: {
      method: "save",
      args: {
        annotations: [
          makeAnnotation({ id: "tool-pending", order: 0 }),
          makeAnnotation({ id: "tool-applied", order: 1, status: "applied" }),
        ],
      },
    },
  });

  const read = fake.tools.find((tool) => tool.name === "read_annotations");
  const setStatus = fake.tools.find((tool) => tool.name === "set_annotation_status");
  const clear = fake.tools.find((tool) => tool.name === "clear_annotations");
  assert.ok(read && setStatus && clear);

  let value = await read.execute({});
  assert.equal(value.count, 1);
  assert.equal(value.annotations[0].id, "tool-pending");
  assert.match(value.markdown, /待处理/);
  const rendered = read.output.render({}, value);
  assert.deepEqual(rendered, [{ type: "text", text: value.markdown }]);

  value = await read.execute({ includeDone: true });
  assert.equal(value.count, 2);

  value = await read.execute({ status: "applied" });
  assert.equal(value.count, 1);
  assert.equal(value.annotations[0].id, "tool-applied");

  value = await read.execute({ pageUrl: ABOUT_URL });
  assert.equal(value.count, 0);
  assert.equal(value.markdown, EMPTY_MARKDOWN);

  const updated = await setStatus.execute({ status: "applied", all: true, pageUrl: PRICING_URL });
  assert.deepEqual(updated, { updated: 2, count: 2 });
  const setRendered = setStatus.output.render({ status: "applied" }, updated);
  assert.match(setRendered[0].text, /已处理/);

  value = await read.execute({ status: "pending" });
  assert.equal(value.count, 0);

  await assert.rejects(() => setStatus.execute({ status: "bogus" }), /status must be pending or applied/);

  const cleared = await clear.execute({ pageUrl: PRICING_URL });
  assert.deepEqual(cleared, { cleared: 2 });
  assert.match(clear.output.render({}, cleared)[0].text, /2/);

  const legacy = await invoke(prefix.handler, { method: "GET", url: "/__dsh-annotate-sync/" });
  assert.equal(legacy.status, 200);
});
