/**
 * End-to-end integration test for the host plugin: discovery -> preview proxy ->
 * injected bootstrap/overlay route -> annotation API -> model tools.
 *
 * Hermetic: one mock app server on 127.0.0.1 and a fake Cordis context. No
 * profile, no DSH process, no external network.
 */

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { apply } from "../lib/index.js";

const ROUTE = "/__dsh-annotate-sync";
const HARNESS_ORIGIN = "http://127.0.0.1:62605";

/** Start a tiny app server that serves one HTML page and one JSON endpoint. */
async function startApp() {
  const server = http.createServer((req, res) => {
    if (req.url === "/data.json") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(
      "<!doctype html><html><head><title>Pricing - Acme</title></head>" +
        '<body><main><h1 id="hero">Simple pricing</h1></main></body></html>',
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { server, port, origin: `http://127.0.0.1:${port}` };
}

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
    setHeader(key, value) {
      res.headers[String(key).toLowerCase()] = value;
    },
    getHeader(key) {
      return res.headers[String(key).toLowerCase()];
    },
    end(chunk) {
      if (chunk !== undefined) res.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    },
    write(chunk) {
      res.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    },
    body() {
      return Buffer.concat(res.chunks).toString("utf-8");
    },
    json() {
      return JSON.parse(res.body());
    },
  };
  return res;
}

/** Build a fake Cordis context that records routes, tools and effects. */
function makeCtx() {
  const routes = new Map();
  const tools = new Map();
  const disposers = [];
  const ctx = {
    logger: { info() {}, warn() {} },
    webServer: {
      getOrigin: () => HARNESS_ORIGIN,
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

test("host + preview + overlay + tools work end to end", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-annotate-integration-"));
  const app = await startApp();
  t.after(async () => {
    await new Promise((resolve) => app.server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });

  const { ctx, routes, tools, disposers } = makeCtx();
  await apply(ctx, {
    dir,
    route: ROUTE,
    legacyRoute: "",
    tool: true,
    preview: true,
    ports: [app.port],
  });
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
  assert.equal(typeof routes.get(`${ROUTE}/api`), "undefined", "API lives under the prefix route");

  // --- discovery ---------------------------------------------------------
  const detectRes = await invoke(prefix, "POST", `${ROUTE}/api`, { method: "detect", args: {} });
  const detect = detectRes.json();
  assert.equal(detect.ok, true, JSON.stringify(detect));
  const found = detect.services.find((service) => service.port === app.port);
  assert.ok(found, `discovered mock app on ${app.port}: ${JSON.stringify(detect.services)}`);
  assert.equal(found.title, "Pricing - Acme");

  // --- preview proxy -----------------------------------------------------
  const lease = "integration-lease";
  const previewRes = await invoke(prefix, "POST", `${ROUTE}/api`, {
    method: "preview",
    args: { sid: "session-test", url: app.origin, lease },
  });
  const preview = previewRes.json();
  assert.equal(preview.ok, true, JSON.stringify(preview));
  assert.match(preview.origin, /^http:\/\/127\.0\.0\.1:\d+$/);

  const page = await fetch(`${preview.origin}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") ?? "", /text\/html/);
  const html = await page.text();
  assert.match(html, /window\.__DSH_ANNOTATE__=/);
  assert.match(html, new RegExp(`${ROUTE.replace(/\//g, "\\/")}\\/overlay\\.js`));
  const bootstrap = JSON.parse(html.match(/window\.__DSH_ANNOTATE__=(\{.*?\});<\/script>/s)?.[1] ?? "{}");
  assert.equal(bootstrap.parentOrigin, HARNESS_ORIGIN);
  assert.equal(bootstrap.lease, lease);
  assert.equal(bootstrap.target, app.origin);

  const json = await fetch(`${preview.origin}/data.json`);
  assert.equal(json.status, 200);
  assert.deepEqual(await json.json(), { ok: true });

  // --- overlay asset route ----------------------------------------------
  const overlayRes = await invoke(prefix, "GET", `${ROUTE}/overlay.js`);
  assert.equal(overlayRes.statusCode, 200);
  assert.match(String(overlayRes.headers["content-type"]), /text\/javascript/);
  const overlaySource = overlayRes.body();
  assert.ok(overlaySource.length > 10_000, "overlay.js is served");
  assert.match(overlaySource, /__DSH_ANNOTATE__/);

  // --- save + state + markdown ------------------------------------------
  const annotation = {
    id: "annotation-1",
    page: { url: `${app.origin}/`, origin: app.origin, path: "/", title: "Pricing - Acme" },
    selector: "#hero",
    tag: "h1",
    className: "hero",
    textSample: "Simple pricing",
    styles: { fontSize: "28px", color: "rgb(20, 20, 20)", backgroundColor: "rgba(0, 0, 0, 0)" },
    rect: { x: 10, y: 20, w: 300, h: 40 },
    note: "把标题改成更短的文案",
    status: "pending",
    order: 0,
  };
  const save = (
    await invoke(prefix, "POST", `${ROUTE}/api`, { method: "save", args: { sid: "session-test", annotations: [annotation] } })
  ).json();
  assert.equal(save.ok, true, JSON.stringify(save));
  assert.equal(save.count, 1);

  const state = (await invoke(prefix, "POST", `${ROUTE}/api`, { method: "state", args: { sid: "session-test" } })).json();
  assert.equal(state.ok, true);
  assert.equal(state.annotations.length, 1);
  assert.equal(state.annotations[0].note, annotation.note);
  assert.equal(state.pages.length, 1);
  assert.equal(state.pages[0].pending, 1);

  const markdown = (
    await invoke(prefix, "POST", `${ROUTE}/api`, { method: "markdown", args: { pageUrl: `${app.origin}/` } })
  ).json();
  assert.equal(markdown.ok, true);
  assert.match(markdown.markdown, /#hero/);
  assert.match(markdown.markdown, /把标题改成更短的文案/);

  // --- model tools -------------------------------------------------------
  assert.deepEqual([...tools.keys()].sort(), ["clear_annotations", "read_annotations", "set_annotation_status"]);
  const read = await tools.get("read_annotations").execute({});
  assert.equal(read.count, 1);
  assert.match(read.markdown, /待处理/);
  assert.equal(read.annotations[0].selector, "#hero");

  const updated = await tools.get("set_annotation_status").execute({ all: true, status: "applied" });
  assert.equal(updated.updated, 1);
  assert.equal((await tools.get("read_annotations").execute({})).count, 0);
  assert.equal((await tools.get("read_annotations").execute({ status: "applied" })).count, 1);

  const cleared = await tools.get("clear_annotations").execute({});
  assert.equal(cleared.cleared, 1);

  // --- release -----------------------------------------------------------
  const release = (
    await invoke(prefix, "POST", `${ROUTE}/api`, { method: "releasePreview", args: { sid: "session-test", lease } })
  ).json();
  assert.equal(release.ok, true);
  assert.equal(release.released, true);
});
