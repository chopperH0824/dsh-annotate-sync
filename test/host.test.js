/**
 * Hermetic host-half tests (v2): store schema v3, file-scoped replacement,
 * file-aware Markdown, the v2 HTTP API, plugin wiring and the model tools.
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

import { API_CODES, createApiHandler, isLoopbackAddress } from "../lib/api.js";
import { apply, inject, name } from "../lib/index.js";
import { buildMarkdown, EMPTY_MARKDOWN } from "../lib/markdown.js";
import { createStore, normalizeAnnotation, STORE_VERSION } from "../lib/store.js";

const SESSION_ID = "session-1";
const RESOURCE_A = `dsh-resource://file/session/${SESSION_ID}/src%2Findex.html`;
const RESOURCE_B = `dsh-resource://file/session/${SESSION_ID}/about.html`;
const LEGACY_URL = "http://127.0.0.1:5173/pricing";
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

/** v2 file-backed annotation fixture. */
function makeFileAnnotation(overrides = {}) {
  const url = overrides.pageUrl ?? RESOURCE_A;
  const filePath = overrides.filePath ?? "src/index.html";
  const fileName = overrides.fileName ?? "index.html";
  const pageTitle = overrides.pageTitle ?? "Acme 首页";
  return {
    id: overrides.id ?? "file-1",
    page: { url, origin: "", path: filePath, title: pageTitle },
    file: { sessionId: SESSION_ID, path: filePath, name: fileName, address: url },
    selector: overrides.selector ?? "#hero-title",
    tag: "h1",
    className: "hero-title",
    textSample: "把成本算清",
    styles: { fontSize: "26px", color: "rgb(15, 23, 42)", backgroundColor: "rgba(0, 0, 0, 0)" },
    rect: { x: 120, y: 340, w: 420, h: 32 },
    note: overrides.note ?? "把标题改短一点",
    status: overrides.status ?? "pending",
    order: overrides.order ?? 0,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

/** Legacy HTTP-page annotation fixture (no `file`). */
function makeLegacyAnnotation(overrides = {}) {
  const pageUrl = overrides.pageUrl ?? LEGACY_URL;
  const parsed = new URL(pageUrl);
  return {
    id: overrides.id ?? "legacy-1",
    page: {
      url: pageUrl,
      origin: parsed.origin,
      path: parsed.pathname,
      title: overrides.pageTitle ?? "Pricing - Acme",
    },
    selector: overrides.selector ?? "main > h2",
    tag: "h2",
    className: "section-title",
    textSample: "Simple pricing",
    styles: { fontSize: "26px", color: "rgb(248, 250, 252)", backgroundColor: "rgba(0,0,0,0)" },
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
  return { status: res.statusCode, headers: res.headers, text: res.body(), json: res.json() };
}

/** Invoke the JSON API envelope. */
async function api(handler, method, args = {}, options = {}) {
  return invoke(handler, { method: "POST", url: API_PATH, body: { method, args }, ...options });
}

/** Read the persisted JSON store file. */
async function readJson(dir) {
  return JSON.parse(await readFile(join(dir, "annotations.json"), "utf-8"));
}

/** Store + API handler in a temp dir. */
async function makeApiFixture(t, options = {}) {
  const dir = await makeTempDir(t);
  const store = createStore({ dir, log: options.log ?? quietLog() });
  const handler = createApiHandler({ store, config: { maxBodyBytes: options.maxBodyBytes ?? 262144 }, log: quietLog() });
  return { dir, store, handler };
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
        return "http://127.0.0.1:62605";
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
// store.normalize (v3)
// ---------------------------------------------------------------------------

test("normalizeAnnotation keeps optional file metadata and the page.url group key", () => {
  assert.equal(normalizeAnnotation({ selector: "", note: "改", page: {} }, 0, NOW), null);
  assert.equal(normalizeAnnotation({ selector: "h1", note: "" }, 0, NOW), null);
  assert.equal(normalizeAnnotation(null, 0, NOW), null);
  assert.equal(normalizeAnnotation([], 0, NOW), null);

  const file = normalizeAnnotation(
    {
      id: "keep-me",
      page: { url: `${RESOURCE_A}#hero`, path: "src/index.html" },
      file: { sessionId: ` ${SESSION_ID} `, path: " src/index.html ", name: "index.html", address: RESOURCE_A },
      selector: "s".repeat(1200),
      note: "n".repeat(2100),
      className: "c".repeat(400),
      textSample: "t".repeat(200),
      status: "something-else",
    },
    4,
    NOW,
  );
  assert.equal(file.id, "keep-me");
  assert.equal(file.selector.length, 1000);
  assert.equal(file.note.length, 2000);
  assert.equal(file.textSample.length, 160);
  assert.equal(file.className.length, 300);
  assert.equal(file.status, "pending");
  assert.equal(file.order, 4);
  assert.equal(file.page.url, RESOURCE_A);
  assert.equal(file.page.origin, "", "dsh-resource URLs never invent an origin");
  assert.equal(file.page.path, "src/index.html");
  assert.deepEqual(file.file, {
    sessionId: SESSION_ID,
    path: "src/index.html",
    name: "index.html",
    address: RESOURCE_A,
  });

  const legacy = normalizeAnnotation({ selector: "h1", note: "改", page: { url: `${LEGACY_URL}#x` } }, 0, NOW);
  assert.equal(legacy.page.url, LEGACY_URL);
  assert.equal(legacy.page.origin, "http://127.0.0.1:5173");
  assert.equal(legacy.page.path, "/pricing");
  assert.equal(Object.prototype.hasOwnProperty.call(legacy, "file"), false, "legacy records keep no empty file block");

  const emptyFile = normalizeAnnotation({ selector: "h1", note: "改", file: {} }, 0, NOW);
  assert.equal(Object.prototype.hasOwnProperty.call(emptyFile, "file"), false);
});

// ---------------------------------------------------------------------------
// store migration -> v3
// ---------------------------------------------------------------------------

test("store migrates v0 array, v1 object and v2 files to schema v3", async (t) => {
  const root = await makeTempDir(t);

  const legacyArrayDir = join(root, "legacy-array");
  await writeStoreFile(legacyArrayDir, [{ selector: "#subscribe", note: "按钮文案改短", tag: "button" }]);
  const legacyArray = createStore({ dir: legacyArrayDir, log: quietLog() });
  await legacyArray.ensureLoaded();
  let list = legacyArray.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].page.url, "unknown");
  assert.equal(list[0].status, "pending");
  assert.match(list[0].id, /^[0-9a-f-]{36}$/);
  assert.equal((await readJson(legacyArrayDir)).version, 3, "v0 arrays are rewritten as v3");

  const legacyObjectDir = join(root, "legacy-object");
  await writeStoreFile(legacyObjectDir, {
    updatedAt: NOW,
    dir: "/old/place",
    annotations: [makeLegacyAnnotation({ id: "old-1", status: "applied" })],
  });
  const legacyObject = createStore({ dir: legacyObjectDir, log: quietLog() });
  await legacyObject.ensureLoaded();
  list = legacyObject.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "old-1");
  assert.equal(list[0].status, "applied");
  assert.equal((await readJson(legacyObjectDir)).version, 3);

  const v2Dir = join(root, "v2");
  await writeStoreFile(v2Dir, { version: 2, updatedAt: NOW, annotations: [makeLegacyAnnotation({ id: "v2-1" })] });
  const v2 = createStore({ dir: v2Dir, log: quietLog() });
  await v2.ensureLoaded();
  assert.equal(v2.list().length, 1);
  assert.equal((await readJson(v2Dir)).version, 3);

  const v3Dir = join(root, "v3");
  await writeStoreFile(v3Dir, { version: 3, updatedAt: NOW, annotations: [makeFileAnnotation({ id: "v3-1" })] });
  const v3 = createStore({ dir: v3Dir, log: quietLog() });
  await v3.ensureLoaded();
  list = v3.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].file.path, "src/index.html");
  assert.equal(list[0].page.url, RESOURCE_A);

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
// store.replacePage: one file group only
// ---------------------------------------------------------------------------

test("replacePage touches only the requested page.url group and merges the file key", async (t) => {
  const dir = await makeTempDir(t);
  const store = createStore({ dir, log: quietLog() });

  const replaced = await store.replace([
    makeFileAnnotation({ id: "a1", order: 0 }),
    makeFileAnnotation({ id: "b1", pageUrl: RESOURCE_B, filePath: "about.html", fileName: "about.html", order: 0 }),
    makeLegacyAnnotation({ id: "legacy", order: 0 }),
  ]);
  assert.equal(replaced.count, 3);

  const saved = await store.replacePage(RESOURCE_A, [
    makeFileAnnotation({ id: "a2", selector: "#new", order: 0 }),
    makeFileAnnotation({ id: "a3", selector: "#newer", order: 1 }),
  ]);
  assert.equal(saved.count, 2);
  assert.match(saved.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(
    saved.annotations.map((item) => item.id),
    ["a2", "a3"],
  );
  assert.ok(saved.annotations.every((item) => item.page.url === RESOURCE_A));

  const list = store.list();
  assert.deepEqual(
    list.map((item) => item.id).sort(),
    ["a2", "a3", "b1", "legacy"],
    "other pages survive the file-scoped save",
  );
  assert.equal(list.find((item) => item.id === "b1").page.url, RESOURCE_B);
  assert.equal(list.find((item) => item.id === "b1").file.path, "about.html");

  // Missing page.url is forced onto the group key; a mismatched page.url cannot
  // move a document's annotations into a different file group.
  const noPage = makeFileAnnotation({ id: "forced", selector: "#forced" });
  delete noPage.page;
  const mismatched = makeFileAnnotation({ id: "mismatch", pageUrl: RESOURCE_B, filePath: "about.html" });
  const forced = await store.replacePage(RESOURCE_A, [noPage, mismatched]);
  assert.deepEqual(
    forced.annotations.map((item) => item.id),
    ["forced", "mismatch"],
  );
  assert.ok(forced.annotations.every((item) => item.page.url === RESOURCE_A));
  assert.deepEqual(forced.annotations[0].file, {
    sessionId: SESSION_ID,
    path: "src/index.html",
    name: "index.html",
    address: RESOURCE_A,
  });
  assert.equal(
    store.list().filter((item) => item.page.url === RESOURCE_B).length,
    1,
    "the other file group is untouched",
  );

  // An explicit page.path wins over the address-derived path.
  const nested = await store.replacePage(RESOURCE_A, [
    { id: "nested", selector: "#nested", note: "改一下", page: { path: "nested/page.html" } },
  ]);
  assert.equal(nested.annotations[0].file.path, "nested/page.html");
  assert.equal(nested.annotations[0].file.name, "page.html");
  assert.equal(nested.annotations[0].file.sessionId, SESSION_ID);

  // An empty array clears exactly one group.
  assert.equal((await store.replacePage(RESOURCE_A, [])).count, 0);
  assert.equal(store.list().filter((item) => item.page.url === RESOURCE_A).length, 0);
  assert.equal(store.list().filter((item) => item.page.url === RESOURCE_B).length, 1);

  const disk = await readJson(dir);
  assert.equal(disk.version, 3);
  assert.equal(disk.annotations.length, 2);

  assert.deepEqual(store.filePaths, {
    dir,
    json: join(dir, "annotations.json"),
    markdown: join(dir, "annotations.md"),
  });
});

// ---------------------------------------------------------------------------
// store mutations and persistence
// ---------------------------------------------------------------------------

test("store replace/status/reorder/remove/clear persist v3 JSON and Markdown", async (t) => {
  const dir = await makeTempDir(t);
  const store = createStore({ dir, log: quietLog() });

  const first = makeFileAnnotation({ id: "a", order: 0 });
  const second = makeFileAnnotation({ id: "b", order: 1 });
  const other = makeFileAnnotation({
    id: "c",
    pageUrl: RESOURCE_B,
    filePath: "about.html",
    fileName: "about.html",
    order: 0,
  });
  const legacy = makeLegacyAnnotation({ id: "d", order: 0 });

  const replaced = await store.replace([first, second, other, legacy]);
  assert.equal(replaced.count, 4);

  const json = await readJson(dir);
  assert.equal(json.version, STORE_VERSION);
  assert.equal(json.annotations.length, 4);
  assert.equal(typeof json.updatedAt, "string");

  const pages = store.pages();
  assert.equal(pages.length, 3);
  const pageA = pages.find((page) => page.url === RESOURCE_A);
  assert.equal(pageA.count, 2);
  assert.equal(pageA.pending, 2);
  assert.equal(pageA.file.path, "src/index.html");
  assert.equal(pageA.file.name, "index.html");
  const legacyPage = pages.find((page) => page.url === LEGACY_URL);
  assert.equal(legacyPage.file, undefined, "legacy pages have no file block");

  const updated = await store.setStatus("a", "applied");
  assert.equal(updated.status, "applied");
  assert.equal(await store.setStatus("does-not-exist", "applied"), null);

  const md = await readFile(join(dir, "annotations.md"), "utf-8");
  assert.match(md, /已处理/);
  assert.match(md, /文件：`src\/index\.html`/);

  const reordered = await store.reorder(RESOURCE_A, ["b", "a"]);
  const pageAItems = reordered.filter((item) => item.page.url === RESOURCE_A);
  assert.deepEqual(
    pageAItems.map((item) => item.id),
    ["b", "a"],
  );
  assert.deepEqual(
    pageAItems.map((item) => item.order),
    [0, 1],
  );

  assert.equal(await store.remove("c"), true);
  assert.equal(await store.remove("c"), false);
  assert.equal(store.list().length, 3);

  assert.equal(await store.clear(RESOURCE_A), 2);
  assert.equal(store.list().length, 1);
  assert.equal(await store.clear(), 1);
  assert.deepEqual(store.list(), []);
  assert.equal(await store.clear(), 0);

  // Concurrent writes serialize into one valid v3 file.
  await Promise.all([
    store.replace([makeFileAnnotation({ id: "x" })]),
    store.replace([makeFileAnnotation({ id: "y" }), makeFileAnnotation({ id: "z", order: 2 })]),
  ]);
  const concurrent = await readJson(dir);
  assert.equal(concurrent.version, 3);
  assert.equal(concurrent.annotations.length, 2);
});

test("store persistence failures only warn and never reject", async (t) => {
  const root = await makeTempDir(t);
  const blocked = join(root, "blocked");
  await writeFile(blocked, "not a directory");
  const warnings = [];
  const store = createStore({ dir: blocked, log: { info() {}, warn: (message) => warnings.push(String(message)) } });

  const result = await store.replace([makeFileAnnotation({ id: "still-works" })]);
  assert.equal(result.count, 1);
  assert.deepEqual(
    store.list().map((item) => item.id),
    ["still-works"],
  );
  assert.ok(warnings.length > 0, "persistence failures are logged");
});

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

test("buildMarkdown renders 文件：<path> for file annotations and keeps legacy output", () => {
  assert.equal(buildMarkdown([]), EMPTY_MARKDOWN);
  assert.equal(buildMarkdown([]), "# 暂无未处理的页面批注\n");
  assert.equal(buildMarkdown(null), EMPTY_MARKDOWN);

  const fileAnnotation = makeFileAnnotation({
    id: "p1",
    selector: "#second",
    order: 1,
    pageTitle: "",
    fileName: "index.html",
    filePath: "src/index.html",
  });
  const fileAnnotation2 = makeFileAnnotation({
    id: "p0",
    selector: "#first",
    order: 0,
    status: "applied",
    pageTitle: "",
  });
  const legacyAnnotation = makeLegacyAnnotation({ id: "l1", selector: "#about", pageUrl: LEGACY_URL, pageTitle: "About - Acme" });

  const markdown = buildMarkdown([fileAnnotation, legacyAnnotation, fileAnnotation2]);
  assert.match(markdown, /^# 页面批注清单（共 3 处）/);
  assert.match(markdown, /已处理 1 处/);
  assert.ok(markdown.includes("- 文件：`src/index.html`"), "file-backed groups name the source file");
  assert.ok(markdown.includes("## index.html"), "file.name is the heading when page.title is empty");
  assert.equal(markdown.indexOf("## index.html") < markdown.indexOf("## About - Acme"), true);

  const firstIndex = markdown.indexOf("#first");
  const secondIndex = markdown.indexOf("#second");
  assert.ok(firstIndex > 0 && secondIndex > 0);
  assert.ok(firstIndex < secondIndex, "annotations are ordered by order");

  assert.match(markdown, /\[已处理\]/);
  assert.match(markdown, /\[待处理\]/);
  assert.match(markdown, /当前文本：/);
  assert.match(markdown, /当前样式：/);
  assert.match(markdown, /修改指令：\*\*把标题改短一点\*\*/);
  assert.ok(markdown.endsWith("\n"));
  assert.equal(buildMarkdown([fileAnnotation, legacyAnnotation, fileAnnotation2]), markdown, "deterministic");

  const legacyOnly = buildMarkdown([legacyAnnotation]);
  assert.equal(legacyOnly.includes("文件："), false, "legacy page groups keep the old output");
  assert.match(legacyOnly, /## About - Acme/);

  const custom = buildMarkdown([], { emptyText: "nothing\n" });
  assert.equal(custom, "nothing\n");
  assert.match(buildMarkdown([makeFileAnnotation({ id: "p" })], { heading: "自定义清单" }), /^# 自定义清单（共 1 处）/);
});

// ---------------------------------------------------------------------------
// API dispatch (v2)
// ---------------------------------------------------------------------------

test("API exposes state/saveFile/save/setStatus/remove/clear/markdown", async (t) => {
  const { dir, handler } = await makeApiFixture(t);

  let response = await api(handler, "state");
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, { ok: true, annotations: [], pages: [] });

  response = await api(handler, "saveFile", { url: RESOURCE_A, annotations: [makeFileAnnotation({ id: "a" })] });
  assert.equal(response.status, 200);
  assert.equal(response.json.ok, true);
  assert.equal(response.json.count, 1);
  assert.match(response.json.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(response.json.annotations[0].id, "a");
  assert.equal(response.json.annotations[0].file.path, "src/index.html");

  response = await api(handler, "saveFile", {
    url: RESOURCE_B,
    annotations: [
      {
        id: "b",
        selector: "#about",
        tag: "h2",
        note: "改一下",
        order: 0,
      },
    ],
  });
  assert.equal(response.status, 200);
  assert.equal(response.json.annotations[0].page.url, RESOURCE_B, "saveFile assigns the group key");
  assert.deepEqual(response.json.annotations[0].file, {
    sessionId: SESSION_ID,
    path: "about.html",
    name: "about.html",
    address: RESOURCE_B,
  });

  response = await api(handler, "state");
  assert.equal(response.json.annotations.length, 2);
  assert.equal(response.json.pages.length, 2);
  const pageA = response.json.pages.find((page) => page.url === RESOURCE_A);
  assert.equal(pageA.count, 1);
  assert.equal(pageA.file.name, "index.html");
  const pageB = response.json.pages.find((page) => page.url === RESOURCE_B);
  assert.equal(pageB.file.path, "about.html");

  response = await api(handler, "saveFile", { url: RESOURCE_A, annotations: [] });
  assert.equal(response.status, 200);
  assert.equal(response.json.count, 0);
  response = await api(handler, "state");
  assert.equal(response.json.annotations.length, 1, "only the requested file group was replaced");
  assert.equal(response.json.annotations[0].page.url, RESOURCE_B);

  response = await api(handler, "save", {
    annotations: [makeFileAnnotation({ id: "again" }), makeLegacyAnnotation({ id: "old" })],
  });
  assert.equal(response.status, 200);
  assert.equal(response.json.count, 2);
  assert.equal(response.json.updatedAt !== undefined, true);

  response = await api(handler, "setStatus", { id: "again", status: "applied" });
  assert.equal(response.status, 200);
  assert.equal(response.json.annotation.status, "applied");

  response = await api(handler, "markdown", { pageUrl: RESOURCE_A });
  assert.equal(response.status, 200);
  assert.equal(response.json.count, 1);
  assert.match(response.json.markdown, /文件：`src\/index\.html`/);

  response = await api(handler, "remove", { id: "old" });
  assert.equal(response.status, 200);
  assert.equal(response.json.removed, true);
  response = await api(handler, "remove", { id: "old" });
  assert.equal(response.json.removed, false);

  response = await api(handler, "clear", { pageUrl: RESOURCE_A });
  assert.equal(response.status, 200);
  assert.equal(response.json.cleared, 1);
  response = await api(handler, "state");
  assert.equal(response.json.annotations.length, 0);

  const disk = await readJson(dir);
  assert.equal(disk.version, 3);
});

test("API rejects bad peers, methods, args and bodies with protocol codes", async (t) => {
  const fixture = await makeApiFixture(t);
  const { handler } = fixture;

  assert.deepEqual([...API_CODES], ["badMethod", "badArgs", "methodNotAllowed", "loopbackOnly", "internal"]);

  let response = await api(handler, "state", {}, { remoteAddress: "10.0.0.9" });
  assert.equal(response.status, 403);
  assert.equal(response.json.code, "loopbackOnly");
  assert.equal(isLoopbackAddress("10.0.0.9"), false);
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackAddress("::1"), true);
  assert.equal(isLoopbackAddress(""), false);

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

  response = await invoke(handler, {
    method: "POST",
    url: API_PATH,
    headers: { "content-type": "application/json" },
    body: "[]",
  });
  assert.equal(response.status, 400);
  assert.equal(response.json.code, "badArgs");

  response = await api(handler, "no-such-method");
  assert.equal(response.status, 400);
  assert.equal(response.json.code, "badMethod");

  for (const removed of ["preview", "detect", "releasePreview", "reorder"]) {
    response = await api(handler, removed, {});
    assert.equal(response.status, 400, `${removed} is gone`);
    assert.equal(response.json.code, "badMethod");
  }

  response = await api(handler, "saveFile", { annotations: [] });
  assert.equal(response.status, 400);
  assert.equal(response.json.code, "badArgs");
  response = await api(handler, "saveFile", { url: "   ", annotations: [] });
  assert.equal(response.json.code, "badArgs");
  response = await api(handler, "saveFile", { url: RESOURCE_A, annotations: "nope" });
  assert.equal(response.json.code, "badArgs");
  response = await api(handler, "save", { annotations: "nope" });
  assert.equal(response.status, 400);
  assert.equal(response.json.code, "badArgs");
  response = await api(handler, "setStatus", { id: "", status: "applied" });
  assert.equal(response.json.code, "badArgs");
  response = await api(handler, "setStatus", { id: "a", status: "weird" });
  assert.equal(response.status, 400);
  assert.equal(response.json.code, "badArgs");
  response = await api(handler, "setStatus", { id: "missing", status: "applied" });
  assert.equal(response.status, 400);
  assert.equal(response.json.code, "badArgs");
  response = await api(handler, "remove", {});
  assert.equal(response.status, 400);
  assert.equal(response.json.code, "badArgs");
  response = await api(handler, "markdown", { pageUrl: RESOURCE_A });
  assert.equal(response.status, 200);
  assert.equal(response.json.count, 0);

  response = await invoke(handler, { method: "OPTIONS", url: API_PATH });
  assert.equal(response.status, 204);
  assert.equal(response.text, "");

  const capped = await makeApiFixture(t, { maxBodyBytes: 64 });
  response = await api(capped.handler, "saveFile", {
    url: RESOURCE_A,
    annotations: [makeFileAnnotation({ note: "x".repeat(500) })],
  });
  assert.equal(response.status, 413);
  assert.equal(response.json.code, "badArgs");
});

// ---------------------------------------------------------------------------
// Plugin wiring (fake Cordis context)
// ---------------------------------------------------------------------------

test("apply registers the prefix route, overlay, legacy bridge and three tools", async (t) => {
  const dir = await makeTempDir(t);
  const fake = makeCtx();
  apply(fake.ctx, { dir });

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
  assert.equal(response.json.route, "/__dsh-annotate-sync");
  assert.equal(response.json.tool, true);

  response = await invoke(prefix.handler, { method: "GET", url: "/__dsh-annotate-sync/unknown" });
  assert.equal(response.status, 404);
  assert.equal(response.json.code, "notFound");

  response = await invoke(prefix.handler, { method: "GET", url: "/__dsh-annotate-sync/overlay.js" });
  assert.equal(response.status, 200, "overlay.js is served from the bundle");
  assert.match(String(response.headers["content-type"]), /javascript/);
  assert.equal(response.headers["access-control-allow-origin"], "*");
  assert.equal(response.headers["cache-control"], "no-store");
  const overlaySource = response.text;
  assert.ok(overlaySource.length > 0);
  response = await invoke(prefix.handler, { method: "HEAD", url: "/__dsh-annotate-sync/overlay.js" });
  assert.equal(response.status, 200);
  assert.equal(response.text, "");

  // saveFile through the mounted prefix route.
  response = await invoke(prefix.handler, {
    method: "POST",
    url: API_PATH,
    body: { method: "saveFile", args: { url: RESOURCE_A, annotations: [makeFileAnnotation({ id: "wire-1" })] } },
  });
  assert.equal(response.status, 200);
  assert.equal(response.json.count, 1);

  response = await invoke(prefix.handler, { method: "POST", url: API_PATH, body: { method: "state", args: {} } });
  assert.equal(response.status, 200);
  assert.equal(response.json.annotations.length, 1);
  assert.equal(response.json.annotations[0].file.name, "index.html");

  // The removed preview API is not reachable through the mounted route.
  response = await invoke(prefix.handler, {
    method: "POST",
    url: API_PATH,
    body: { method: "preview", args: { url: LEGACY_URL } },
  });
  assert.equal(response.status, 400);
  assert.equal(response.json.code, "badMethod");

  // Legacy v1 sync bridge: permissive CORS, loopback-only, annotations in/out.
  let legacyResponse = await invoke(legacy.handler, { method: "GET", url: "/api/annotate-sync/annotations" });
  assert.equal(legacyResponse.status, 200);
  assert.equal(legacyResponse.headers["access-control-allow-origin"], "*");
  assert.equal(legacyResponse.json.count, 1);
  assert.match(legacyResponse.json.markdown, /文件：`src\/index\.html`/);

  legacyResponse = await invoke(legacy.handler, { method: "OPTIONS", url: "/api/annotate-sync/annotations" });
  assert.equal(legacyResponse.status, 204);
  assert.equal(legacyResponse.headers["access-control-allow-origin"], "*");

  legacyResponse = await invoke(legacy.handler, {
    method: "POST",
    url: "/api/annotate-sync/annotations",
    body: { annotations: [makeLegacyAnnotation({ id: "legacy-1" })] },
  });
  assert.equal(legacyResponse.status, 200);
  assert.equal(legacyResponse.json.count, 1);

  legacyResponse = await invoke(legacy.handler, {
    method: "POST",
    url: "/api/annotate-sync/annotations",
    body: [makeLegacyAnnotation({ id: "legacy-array" })],
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

test("apply honours tool:false, legacyRoute:'' and tolerates missing services", async (t) => {
  const dir = await makeTempDir(t);

  const noTools = makeCtx();
  apply(noTools.ctx, { dir, tool: false, legacyRoute: "" });
  assert.equal(noTools.routes.length, 1, "only the prefix route is registered");
  assert.equal(noTools.routes[0].kind, "prefix");
  assert.equal(noTools.tools.length, 0);

  const customRoute = makeCtx();
  apply(customRoute.ctx, { dir, route: "custom/annotate", legacyRoute: "" });
  assert.equal(customRoute.routes[0].path, "/custom/annotate");

  const minimal = makeCtx({ withTools: false, withWebServer: true });
  assert.doesNotThrow(() => apply(minimal.ctx, { dir, legacyRoute: "" }));
  assert.equal(minimal.routes.length, 1);

  const noWebServer = makeCtx({ withWebServer: false });
  assert.doesNotThrow(() => apply(noWebServer.ctx, { dir, legacyRoute: "" }));
  assert.ok(
    noWebServer.warnings.some((warning) => /route .* unavailable/.test(warning)),
    "a missing webServer degrades to a warning",
  );

  const defaultRoutes = makeCtx();
  apply(defaultRoutes.ctx, { dir });
  assert.ok(
    defaultRoutes.routes.some(
      (route) => route.kind === "exact" && route.path === "/api/annotate-sync/annotations",
    ),
    "the legacy route is on by default",
  );
});

// ---------------------------------------------------------------------------
// Model tools
// ---------------------------------------------------------------------------

test("model tools read file-aware annotations, update status and clear", async (t) => {
  const dir = await makeTempDir(t);
  const fake = makeCtx();
  apply(fake.ctx, { dir });

  const prefix = fake.routes.find((route) => route.kind === "prefix");
  await invoke(prefix.handler, {
    method: "POST",
    url: API_PATH,
    body: {
      method: "saveFile",
      args: {
        url: RESOURCE_A,
        annotations: [
          makeFileAnnotation({ id: "tool-pending", order: 0 }),
          makeFileAnnotation({ id: "tool-applied", order: 1, status: "applied" }),
        ],
      },
    },
  });
  await invoke(prefix.handler, {
    method: "POST",
    url: API_PATH,
    body: {
      method: "saveFile",
      args: { url: RESOURCE_B, annotations: [{ id: "other", selector: "#about", note: "改一下", order: 0 }] },
    },
  });

  const read = fake.tools.find((tool) => tool.name === "read_annotations");
  const setStatus = fake.tools.find((tool) => tool.name === "set_annotation_status");
  const clear = fake.tools.find((tool) => tool.name === "clear_annotations");
  assert.ok(read && setStatus && clear);

  let value = await read.execute({});
  assert.equal(value.count, 2, "pending only by default");
  assert.match(value.markdown, /文件：`src\/index\.html`/);
  assert.match(value.markdown, /把标题改短一点/);
  const rendered = read.output.render({}, value);
  assert.deepEqual(rendered, [{ type: "text", text: value.markdown }]);

  value = await read.execute({ includeDone: true });
  assert.equal(value.count, 3);

  value = await read.execute({ status: "applied" });
  assert.equal(value.count, 1);
  assert.equal(value.annotations[0].id, "tool-applied");

  value = await read.execute({ pageUrl: RESOURCE_B });
  assert.equal(value.count, 1);
  assert.equal(value.annotations[0].id, "other");
  assert.equal(value.annotations[0].file.path, "about.html", "missing file metadata is derived from the address");
  assert.match(value.markdown, /文件：`about\.html`/);

  value = await read.execute({ pageUrl: "dsh-resource://file/session/nope/missing.html" });
  assert.equal(value.count, 0);
  assert.equal(value.markdown, EMPTY_MARKDOWN);

  const updated = await setStatus.execute({ status: "applied", all: true, pageUrl: RESOURCE_A });
  assert.deepEqual(updated, { updated: 2, count: 2 });
  const setRendered = setStatus.output.render({ status: "applied" }, updated);
  assert.match(setRendered[0].text, /已处理/);

  value = await read.execute({ status: "pending" });
  assert.equal(value.count, 1);
  assert.equal(value.annotations[0].id, "other");

  await assert.rejects(() => setStatus.execute({ status: "bogus" }), /status must be pending or applied/);

  const cleared = await clear.execute({ pageUrl: RESOURCE_A });
  assert.deepEqual(cleared, { cleared: 2 });
  assert.match(clear.output.render({}, cleared)[0].text, /2/);

  value = await read.execute({ includeDone: true });
  assert.equal(value.count, 1);

  const legacy = await invoke(prefix.handler, { method: "GET", url: "/__dsh-annotate-sync/" });
  assert.equal(legacy.status, 200);
});
