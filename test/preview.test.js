/**
 * dsh-annotate-sync — preview proxy + local discovery tests.
 *
 * Everything here is hermetic: the only sockets are 127.0.0.1 mock servers
 * started by the test itself, plus the loopback probing that discovery is
 * supposed to do. No external network and no dependencies.
 */

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { createPreviewManager } from "../lib/preview.js";
import { detectServices } from "../lib/discover.js";

const HARNESS = "http://127.0.0.1:62605";
const LARGE_HTML_LENGTH = 4 * 1024 * 1024 + 32;
const HTML_DOCUMENT =
  '<!doctype html><html><head><title>Mock App</title></head><body><h1>hello preview</h1></body></html>';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Start a loopback mock server and resolve once it is actually listening. */
function startServer(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    const onError = (error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      const port = server.address().port;
      resolve({
        server,
        port,
        origin: `http://127.0.0.1:${port}`,
        close: () => stopServer(server),
      });
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
}

/** Close a mock server, including any keep-alive sockets the proxy left open. */
function stopServer(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

/** Read a request body as UTF-8 text. */
function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

/** Resolve a currently unused loopback port (listened on, then released). */
async function freePort() {
  const probe = await startServer((_request, response) => response.end("probe"));
  const port = probe.port;
  await probe.close();
  return port;
}

/** Poll until a preview origin stops accepting connections. */
async function waitUntilClosed(origin, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(origin, { signal: AbortSignal.timeout(500) });
      await response.arrayBuffer().catch(() => {});
    } catch {
      return true;
    }
    await delay(25);
  }
  return false;
}

/** A mock upstream that exercises every response shape the proxy handles. */
function createContentHandler() {
  const seen = [];
  const handler = async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    seen.push({
      method: request.method,
      path: `${url.pathname}${url.search}`,
      headers: { ...request.headers },
    });

    if (request.method === "HEAD") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": String(HTML_DOCUMENT.length),
      });
      response.end();
      return;
    }

    switch (url.pathname) {
      case "/": {
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": "default-src 'none'",
          "x-frame-options": "DENY",
          "x-mock": "yes",
        });
        response.end(HTML_DOCUMENT);
        return;
      }
      case "/data.json": {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"hello":"world"}');
        return;
      }
      case "/redirect": {
        // Absolute redirect back to the upstream origin; must become the proxy.
        response.writeHead(302, { location: `http://${request.headers.host}/target` });
        response.end();
        return;
      }
      case "/relative": {
        response.writeHead(302, { location: "/target" });
        response.end();
        return;
      }
      case "/target": {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end("<html><body>target page</body></html>");
        return;
      }
      case "/echo": {
        const body = await readRequestBody(request);
        response.writeHead(200, { "content-type": "text/plain" });
        response.end(body);
        return;
      }
      case "/large": {
        // No content-length: the proxy must hit its buffer cap and switch to
        // streaming instead of buffering the whole document.
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end("a".repeat(LARGE_HTML_LENGTH));
        return;
      }
      case "/fragment": {
        // No closing body tag: the injection must be appended.
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end("<html><body><p>fragment");
        return;
      }
      default: {
        response.writeHead(404, { "content-type": "text/plain" });
        response.end("not found");
      }
    }
  };
  return { handler, seen };
}

/** Run `run` against a live proxy for a fresh content mock. */
async function withContentPreview(run) {
  const { handler, seen } = createContentHandler();
  const upstream = await startServer(handler);
  const manager = createPreviewManager({ getHarnessOrigin: () => HARNESS });
  try {
    const preview = await manager.preview({ target: upstream.origin, lease: "lease-1", parentOrigin: HARNESS });
    await run({ upstream, manager, preview, seen });
  } finally {
    manager.closeAll();
    await upstream.close();
  }
}

test("injects the overlay bootstrap into HTML and strips framing headers", async () => {
  await withContentPreview(async ({ upstream, preview, seen }) => {
    const response = await fetch(`${preview.origin}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("content-security-policy"), null);
    assert.equal(response.headers.get("x-frame-options"), null);
    assert.equal(response.headers.get("x-mock"), "yes");

    const body = await response.text();
    assert.ok(body.includes("window.__DSH_ANNOTATE__"), "bootstrap config is injected");
    assert.ok(body.includes(`"parentOrigin":"${HARNESS}"`));
    assert.ok(body.includes(`"apiOrigin":"${HARNESS}"`));
    assert.ok(body.includes('"lease":"lease-1"'));
    assert.ok(body.includes(`"target":"${upstream.origin}"`));
    assert.ok(body.includes(`${HARNESS}/__dsh-annotate-sync/overlay.js`), "overlay script is loaded from the Harness");
    assert.ok(body.includes("<title>Mock App</title>"), "original document is preserved");

    const injectionAt = body.indexOf("window.__DSH_ANNOTATE__");
    const bodyEndAt = body.lastIndexOf("</body>");
    assert.ok(injectionAt >= 0 && injectionAt < bodyEndAt, "bootstrap is injected before </body>");

    const upstreamRequest = seen.at(-1);
    assert.equal(upstreamRequest.headers.host, `127.0.0.1:${upstream.port}`);
    assert.equal(upstreamRequest.headers["accept-encoding"], undefined, "accept-encoding is stripped");
  });
});

test("passes non-HTML bodies through untouched", async () => {
  await withContentPreview(async ({ preview }) => {
    const response = await fetch(`${preview.origin}/data.json`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/json");
    assert.equal(response.headers.get("cache-control"), "no-store");
    const text = await response.text();
    assert.equal(text, '{"hello":"world"}');
    assert.equal(text.includes("__DSH_ANNOTATE__"), false);
  });
});

test("rewrites absolute upstream redirects to the preview origin", async () => {
  await withContentPreview(async ({ preview }) => {
    const response = await fetch(`${preview.origin}/redirect`, { redirect: "manual" });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), `${preview.origin}/target`);

    const relative = await fetch(`${preview.origin}/relative`, { redirect: "manual" });
    assert.equal(relative.status, 302);
    assert.equal(relative.headers.get("location"), "/target", "relative redirects stay relative");
  });
});

test("does not inject into HEAD responses", async () => {
  await withContentPreview(async ({ preview }) => {
    const response = await fetch(`${preview.origin}/`, { method: "HEAD" });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-length"), String(HTML_DOCUMENT.length));
    assert.equal(await response.text(), "");
  });
});

test("leaves HTML larger than the 4MB buffer cap uninjected", async () => {
  await withContentPreview(async ({ preview }) => {
    const response = await fetch(`${preview.origin}/large`);
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.equal(body.length, LARGE_HTML_LENGTH, "oversized document is streamed in full");
    assert.equal(body.includes("__DSH_ANNOTATE__"), false, "oversized document is not buffered for injection");
  });
});

test("proxies request bodies and methods", async () => {
  await withContentPreview(async ({ preview }) => {
    const response = await fetch(`${preview.origin}/echo`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "hello-proxy",
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "hello-proxy");
    assert.equal(response.headers.get("cache-control"), "no-store");
  });
});

test("rejects non-loopback, file, credential and Harness targets", async () => {
  const manager = createPreviewManager({ getHarnessOrigin: () => HARNESS });
  try {
    const targets = [
      "http://10.0.0.1:3000/",
      "http://example.com/",
      "file:///tmp/index.html",
      "http://user:pass@127.0.0.1:3000/",
      HARNESS,
    ];
    for (const target of targets) {
      await assert.rejects(
        () => manager.preview({ target }),
        (error) => error.code === "notLocalTarget",
        `rejects ${target}`,
      );
    }
    assert.deepEqual(manager.stats(), []);
  } finally {
    manager.closeAll();
  }
});

test("enforces maxPreviews and reuses one proxy per target", async () => {
  const alpha = await startServer((_request, response) => response.end("alpha"));
  const beta = await startServer((_request, response) => response.end("beta"));
  const manager = createPreviewManager({ getHarnessOrigin: () => HARNESS, maxPreviews: 1 });
  try {
    const first = await manager.preview({ target: alpha.origin, lease: "alpha" });
    await assert.rejects(
      () => manager.preview({ target: beta.origin, lease: "beta" }),
      (error) => error.code === "tooManyPreviews",
    );
    assert.equal(manager.release("alpha"), true);
    const second = await manager.preview({ target: beta.origin, lease: "beta" });
    assert.equal(second.target, beta.origin);
    assert.notEqual(second.origin, first.origin);
  } finally {
    manager.closeAll();
    await alpha.close();
    await beta.close();
  }
});

test("release closes the proxy only after the last lease", async () => {
  const upstream = await startServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(HTML_DOCUMENT);
  });
  const manager = createPreviewManager({ getHarnessOrigin: () => HARNESS });
  try {
    const one = await manager.preview({ target: upstream.origin, lease: "one" });
    const two = await manager.preview({ target: upstream.origin, lease: "two" });
    assert.equal(one.origin, two.origin, "the same target reuses one proxy origin");
    assert.equal((await fetch(`${one.origin}/`)).status, 200);

    assert.equal(manager.release("one"), true);
    assert.equal(manager.stats()[0].leases, 1);
    assert.equal((await fetch(`${two.origin}/`)).status, 200, "proxy stays alive for the second lease");

    assert.equal(manager.release("two"), true);
    assert.equal(manager.release("two"), false, "releasing twice reports nothing released");
    assert.deepEqual(manager.stats(), []);
    assert.equal(await waitUntilClosed(one.origin), true, "proxy is closed with its last lease");
  } finally {
    manager.closeAll();
    await upstream.close();
  }
});

test("keeps a leased preview alive past idleMs and closes it on release", async () => {
  const upstream = await startServer((_request, response) => response.end("idle"));
  const manager = createPreviewManager({ getHarnessOrigin: () => HARNESS, idleMs: 120 });
  try {
    const preview = await manager.preview({ target: upstream.origin, lease: "idle-lease" });
    assert.equal(manager.stats().length, 1);
    // The panel holds this lease while it shows the preview: idle HTTP traffic
    // must not tear the proxy down underneath it.
    await delay(400);
    assert.equal(manager.stats().length, 1, "leased preview survives the idle timeout");
    manager.release("idle-lease");
    assert.equal(manager.stats().length, 0, "release closes the proxy");
    assert.equal(await waitUntilClosed(preview.origin), true);
  } finally {
    manager.closeAll();
    await upstream.close();
  }
});

test("closeAll closes every preview", async () => {
  const alpha = await startServer((_request, response) => response.end("alpha"));
  const beta = await startServer((_request, response) => response.end("beta"));
  const manager = createPreviewManager({ getHarnessOrigin: () => HARNESS });
  try {
    const one = await manager.preview({ target: alpha.origin, lease: "one" });
    const two = await manager.preview({ target: beta.origin, lease: "two" });
    assert.equal(manager.stats().length, 2);
    manager.closeAll();
    assert.deepEqual(manager.stats(), []);
    assert.equal(await waitUntilClosed(one.origin), true);
    assert.equal(await waitUntilClosed(two.origin), true);
  } finally {
    manager.closeAll();
    await alpha.close();
    await beta.close();
  }
});

test("honours a custom overlay path and the caller's parent origin", async () => {
  const parentOrigin = "http://127.0.0.1:61000";
  for (const options of [{ overlayPath: "/custom/overlay.js" }, { overlaySrc: "/alias/overlay.js" }]) {
    const upstream = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(HTML_DOCUMENT);
    });
    const manager = createPreviewManager({ getHarnessOrigin: () => HARNESS, ...options });
    try {
      const preview = await manager.preview({ target: upstream.origin, lease: "custom", parentOrigin });
      const body = await (await fetch(`${preview.origin}/`)).text();
      const expectedPath = options.overlayPath ?? options.overlaySrc;
      assert.ok(body.includes(`${HARNESS}${expectedPath}`), `injects ${expectedPath}`);
      assert.ok(body.includes(`"parentOrigin":"${parentOrigin}"`));
      assert.ok(body.includes(`"apiOrigin":"${HARNESS}"`));
    } finally {
      manager.closeAll();
      await upstream.close();
    }
  }
});

test("falls back to the default bootstrap when a custom renderer throws", async () => {
  const upstream = await startServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(HTML_DOCUMENT);
  });
  const manager = createPreviewManager({
    getHarnessOrigin: () => HARNESS,
    overlayBootstrap: () => {
      throw new Error("boom");
    },
    log: () => {},
  });
  try {
    const preview = await manager.preview({ target: upstream.origin, lease: "boom" });
    const body = await (await fetch(`${preview.origin}/`)).text();
    assert.ok(body.includes("window.__DSH_ANNOTATE__"));
    assert.ok(body.includes(`${HARNESS}/__dsh-annotate-sync/overlay.js`));
  } finally {
    manager.closeAll();
    await upstream.close();
  }
});

test("appends the injection when the document has no closing body tag", async () => {
  await withContentPreview(async ({ preview }) => {
    const body = await (await fetch(`${preview.origin}/fragment`)).text();
    assert.ok(body.startsWith("<html><body><p>fragment"));
    assert.ok(body.includes("window.__DSH_ANNOTATE__"));
    assert.ok(body.indexOf("window.__DSH_ANNOTATE__") > body.indexOf("<p>fragment"));
  });
});

test("detectServices finds loopback services, titles and 5xx servers", async () => {
  const alpha = await startServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<html><head><title>  Alpha   Dev  </title></head><body></body></html>");
  });
  const beta = await startServer((_request, response) => {
    response.writeHead(500, { "content-type": "text/html; charset=utf-8" });
    response.end("<title>Beta Down</title>");
  });
  const gamma = await startServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"status":"ok"}');
  });
  const longTitle = await startServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<title>${"x".repeat(200)}</title>`);
  });
  try {
    const services = await detectServices({
      ports: [alpha.port, beta.port, gamma.port, longTitle.port],
      timeoutMs: 300,
      limit: 50,
    });
    assert.ok(Array.isArray(services));
    const byPort = new Map(services.map((service) => [service.port, service]));

    const foundAlpha = byPort.get(alpha.port);
    assert.ok(foundAlpha, "running HTML service is found");
    assert.equal(foundAlpha.origin, alpha.origin);
    assert.equal(foundAlpha.url, `${alpha.origin}/`);
    assert.equal(foundAlpha.title, "Alpha Dev");
    assert.equal(foundAlpha.kind, "dev");
    assert.ok(Number.isInteger(foundAlpha.responseMs) && foundAlpha.responseMs >= 0);

    const foundBeta = byPort.get(beta.port);
    assert.ok(foundBeta, "5xx responses still count as a running service");
    assert.equal(foundBeta.title, "Beta Down");

    const foundGamma = byPort.get(gamma.port);
    assert.ok(foundGamma, "non-HTML services are reported too");
    assert.equal(foundGamma.title, `127.0.0.1:${gamma.port}`);

    const foundLong = byPort.get(longTitle.port);
    assert.ok(foundLong);
    assert.equal(foundLong.title.length, 120, "titles are capped at 120 characters");

    const unused = await freePort();
    const withUnused = await detectServices({ ports: [alpha.port, unused], timeoutMs: 250, limit: 50 });
    assert.equal(withUnused.some((service) => service.port === unused), false, "closed port is absent");
  } finally {
    await alpha.close();
    await beta.close();
    await gamma.close();
    await longTitle.close();
  }
});

test("detectServices honours excludePorts and limit and never throws", async () => {
  const alpha = await startServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<title>Alpha</title>");
  });
  try {
    const excluded = await detectServices({
      ports: [alpha.port],
      excludePorts: [alpha.port],
      timeoutMs: 150,
      limit: 50,
    });
    assert.equal(excluded.some((service) => service.port === alpha.port), false);

    const limited = await detectServices({ ports: [alpha.port], timeoutMs: 150, limit: 1 });
    assert.ok(limited.length <= 1);

    assert.deepEqual(await detectServices({ ports: [alpha.port], limit: 0 }), []);
    assert.ok(Array.isArray(await detectServices({ ports: ["nope", -5, 70000], timeoutMs: 100 })));
  } finally {
    await alpha.close();
  }
});
