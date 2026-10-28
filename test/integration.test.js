/**
 * Hermetic v2 integration test: plugin wiring -> mounted prefix route ->
 * overlay asset -> file-scoped annotation API -> Markdown -> model tools.
 *
 * No network, no profile, no DSH process: fake Cordis context and fake HTTP
 * request/response doubles only.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { apply } from "../lib/index.js";

const ROUTE = "/__dsh-annotate-sync";
const RESOURCE = "dsh-resource://file/session/session-9/notes%2Findex.html";
const FILE_PATH = "notes/index.html";

/** Minimal IncomingMessage double for the plugin handlers. */
function makeReq(method, url, body) {
  const text = body === undefined ? "" : JSON.stringify(body);
  const req = Readable.from(text === "" ? [] : [Buffer.from(text)]);
  req.method = method;
  req.url = url;
  req.headers = text === "" ? {} : { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) };
  req.socket = { remoteAddress: "127.0.0.1" };
  return req;
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
    end(chunk) {
      if (chunk !== undefined) res.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      res.writableEnded = true;
    },
    body() {
      return Buffer.concat(res.chunks).toString("utf-8");
    },
    json() {
      const text = res.body();
      return text === "" ? null : JSON.parse(text);
    },
  };
  return res;
}

/** Build a fake Cordis context recording registered routes and tools. */
function makeCtx() {
  const routes = new Map();
  const tools = new Map();
  const disposers = [];
  const ctx = {
    logger: { info() {}, warn() {} },
    webServer: {
      getOrigin: () => "http://127.0.0.1:62605",
      register(route) {
        routes.set(route.path, route.handler);
        return () => routes.delete(route.path);
      },
    },
    tools: {
      register(tool) {
        tools.set(tool.name, tool);
        return () => tools.delete(tool.name);
      },
    },
    effect(factory) {
      const disposer = factory();
      if (typeof disposer === "function") disposers.push(disposer);
      return () => {};
    },
  };
  return { ctx, routes, tools, disposers };
}

/** Invoke one captured route with a fake request and return the response. */
async function invoke(handler, method, path, body) {
  const res = makeRes();
  await handler(makeReq(method, path, body), res);
  return res;
}

test("host + overlay route + file annotation API + tools work end to end", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-annotate-integration-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const { ctx, routes, tools, disposers } = makeCtx();
  apply(ctx, { dir, route: ROUTE, legacyRoute: "", tool: true });
  t.after(() => {
    for (const disposer of disposers.reverse()) {
      try {
        disposer();
      } catch {
        /* teardown is best-effort */
      }
    }
  });

  const prefix = routes.get(ROUTE);
  assert.equal(typeof prefix, "function", "prefix route is registered");
  assert.equal(routes.get(`${ROUTE}/api`), undefined, "API lives under the prefix route");
  assert.equal(routes.get("/api/annotate-sync/annotations"), undefined, "legacy bridge was disabled");

  // --- overlay asset route ----------------------------------------------
  const overlayRes = await invoke(prefix, "GET", `${ROUTE}/overlay.js`);
  assert.equal(overlayRes.statusCode, 200, "overlay.js is served");
  assert.match(String(overlayRes.headers["content-type"]), /text\/javascript/);
  assert.ok(overlayRes.body().length > 0);

  // --- saveFile + state + markdown --------------------------------------
  const annotation = {
    id: "annotation-1",
    page: { url: RESOURCE, origin: "", path: FILE_PATH, title: "notes/index.html" },
    file: { sessionId: "session-9", path: FILE_PATH, name: "index.html", address: RESOURCE },
    selector: "#hero",
    tag: "h1",
    className: "hero",
    textSample: "把成本算清",
    styles: { fontSize: "26px", color: "rgb(15, 23, 42)", backgroundColor: "rgba(0, 0, 0, 0)" },
    rect: { x: 10, y: 20, w: 300, h: 40 },
    note: "把标题改短一点",
    status: "pending",
    order: 0,
  };
  const save = (
    await invoke(prefix, "POST", `${ROUTE}/api`, { method: "saveFile", args: { url: RESOURCE, annotations: [annotation] } })
  ).json();
  assert.equal(save.ok, true, JSON.stringify(save));
  assert.equal(save.count, 1);

  const state = (await invoke(prefix, "POST", `${ROUTE}/api`, { method: "state", args: {} })).json();
  assert.equal(state.ok, true);
  assert.equal(state.annotations.length, 1);
  assert.equal(state.annotations[0].file.path, FILE_PATH);
  assert.equal(state.pages.length, 1);
  assert.equal(state.pages[0].url, RESOURCE);
  assert.equal(state.pages[0].pending, 1);

  const markdown = (
    await invoke(prefix, "POST", `${ROUTE}/api`, { method: "markdown", args: { pageUrl: RESOURCE } })
  ).json();
  assert.equal(markdown.ok, true);
  assert.equal(markdown.count, 1);
  assert.match(markdown.markdown, /文件：`notes\/index\.html`/);
  assert.match(markdown.markdown, /#hero/);
  assert.match(markdown.markdown, /把标题改短一点/);

  // --- model tools -------------------------------------------------------
  assert.deepEqual([...tools.keys()].sort(), ["clear_annotations", "read_annotations", "set_annotation_status"]);
  const read = await tools.get("read_annotations").execute({});
  assert.equal(read.count, 1);
  assert.match(read.markdown, /待处理/);
  assert.match(read.markdown, /文件：`notes\/index\.html`/);
  assert.equal(read.annotations[0].selector, "#hero");

  const updated = await tools.get("set_annotation_status").execute({ all: true, status: "applied" });
  assert.equal(updated.updated, 1);
  assert.equal((await tools.get("read_annotations").execute({})).count, 0);
  assert.equal((await tools.get("read_annotations").execute({ status: "applied" })).count, 1);

  // --- persisted v3 store ------------------------------------------------
  const disk = JSON.parse(await readFile(join(dir, "annotations.json"), "utf-8"));
  assert.equal(disk.version, 3);
  assert.equal(disk.annotations[0].file.name, "index.html");
  const markdownFile = await readFile(join(dir, "annotations.md"), "utf-8");
  assert.match(markdownFile, /文件：`notes\/index\.html`/);

  const cleared = await tools.get("clear_annotations").execute({});
  assert.equal(cleared.cleared, 1);
});
