/**
 * Smoke test for the browser/Client half without a real Harness page.
 *
 * Loads lib/client.js as a classic script in a VM with a stubbed ModuleLoader,
 * React and DOM, then runs apply() against fake services. This catches
 * top-level crashes, a wrong ModuleLoader envelope, a missing export or a
 * regression back to the removed right-sidebar panel / composer dock / footer
 * action registrations — none of which `node --check` alone can see.
 *
 * v2 contract: the client registers the `dsh-annotate-sync/html` document
 * renderer and its `sidebar.right.tab.document` slot body; nothing else.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const CLIENT_FILE = fileURLToPath(new URL("../lib/client.js", import.meta.url));

/** Old v1 slot surfaces that v2 must not register again. */
const REMOVED_SLOTS = ["sidebar.right.pane.tab", "conversation.input.dock", "sidebar.footer.action"];

/** Minimal DOM node double. */
function makeElement(tag) {
  return {
    tagName: String(tag).toUpperCase(),
    style: {},
    dataset: {},
    children: [],
    attributes: Object.create(null),
    parentNode: null,
    removed: false,
    textContent: "",
    className: "",
    id: "",
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    getAttribute(name) {
      return this.attributes[name];
    },
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    remove() {
      this.removed = true;
      if (this.parentNode) {
        const index = this.parentNode.children.indexOf(this);
        if (index >= 0) this.parentNode.children.splice(index, 1);
      }
    },
    addEventListener() {},
    removeEventListener() {},
    querySelector() {
      return null;
    },
  };
}

/** Build the fake global environment for one client bundle load. */
function makeEnvironment() {
  let definition = null;
  const listeners = [];
  const head = makeElement("head");
  const body = makeElement("body");
  const document = {
    documentElement: Object.assign(makeElement("html"), { lang: "zh-CN" }),
    head,
    body,
    hidden: false,
    addEventListener(type, fn) {
      listeners.push({ type, fn });
    },
    removeEventListener(type, fn) {
      const index = listeners.findIndex((item) => item.type === type && item.fn === fn);
      if (index >= 0) listeners.splice(index, 1);
    },
    createElement: makeElement,
    querySelector() {
      return null;
    },
    getElementById() {
      return null;
    },
  };
  const window = {
    __ModuleLoader__: {
      load(value) {
        definition = value;
      },
    },
    document,
    location: {
      origin: "http://127.0.0.1:62605",
      href: "http://127.0.0.1:62605/",
      pathname: "/",
      search: "",
      hash: "",
    },
    addEventListener(type, fn) {
      listeners.push({ type, fn });
    },
    removeEventListener(type, fn) {
      const index = listeners.findIndex((item) => item.type === type && item.fn === fn);
      if (index >= 0) listeners.splice(index, 1);
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    crypto: globalThis.crypto,
    URL,
    AbortSignal,
    Promise,
  };
  window.window = window;
  window.self = window;
  window.globalThis = window;
  return { window, document, head, listeners, getDefinition: () => definition };
}

/** Fake React: registration never renders, but the hooks must exist. */
function makeReact() {
  return {
    createElement(type, props, ...children) {
      return { type, props: Object.assign({}, props, children.length ? { children } : {}) };
    },
    useState(initial) {
      return [typeof initial === "function" ? initial() : initial, () => {}];
    },
    useReducer(_reducer, initial) {
      return [initial, () => {}];
    },
    useRef(initial) {
      return { current: initial };
    },
    useEffect() {},
    useCallback(fn) {
      return fn;
    },
    useMemo(factory) {
      return factory();
    },
  };
}

/** Load the bundle and return the ModuleLoader definition plus exports. */
async function loadBundle() {
  const source = await readFile(CLIENT_FILE, "utf-8");
  const env = makeEnvironment();
  const context = vm.createContext(env.window);
  vm.runInContext(source, context, { filename: "client.js" });
  const definition = env.getDefinition();
  assert.ok(definition, "the bundle called window.__ModuleLoader__.load");
  assert.equal(definition.id, "dsh-annotate-sync");
  assert.equal(typeof definition.factory, "function");
  const moduleExports = definition.factory((name) => {
    if (name === "react") return makeReact();
    throw new Error(`unexpected require: ${name}`);
  });
  assert.equal(typeof moduleExports.apply, "function", "apply is exported");
  assert.ok(Array.isArray(moduleExports.inject), "inject is exported");
  return { env, source, moduleExports };
}

/** Record every service lookup, renderer registration and slot registration. */
function makeFakeCtx(services) {
  const records = {
    gets: [],
    renderers: [],
    injectViews: [],
    slots: [],
    disposers: [],
    remoteCalls: [],
  };
  const remote = {
    workspaceFiles: {
      readBytes(sessionId, relativePath, options, signal) {
        records.remoteCalls.push({ sessionId, relativePath, options, signal });
        return Promise.resolve({
          ok: true,
          value: { data: new TextEncoder().encode("/* packed */"), absolutePath: "src/app.js" },
        });
      },
    },
  };
  const table = Object.assign(
    {
      documentPreviews: {
        register(options) {
          records.renderers.push(options);
          return () => {};
        },
      },
      slots: {
        inject(view, callback) {
          records.injectViews.push(view);
          const dispose = callback();
          return () => {
            if (typeof dispose === "function") dispose();
          };
        },
        register(options, component) {
          records.slots.push({ options, component });
          return () => {};
        },
      },
      sessions: {
        scope(sessionId) {
          return { sessionId };
        },
        sessionOf() {
          return null;
        },
      },
      timer: { setTimeout, clearTimeout },
      remote,
    },
    services || {},
  );
  const ctx = {
    get(name) {
      records.gets.push(name);
      return table[name];
    },
    effect(factory) {
      const dispose = factory();
      if (typeof dispose === "function") records.disposers.push(dispose);
      return () => {};
    },
  };
  return { ctx, records, table };
}

test("client half loads through the ModuleLoader envelope and registers the HTML document renderer", async () => {
  const { env, moduleExports } = await loadBundle();

  assert.deepEqual(
    [...moduleExports.inject],
    ["documentPreviews", "slots", "sessions", "timer"],
    "v2 injects only the document-preview services",
  );

  const { ctx, records } = makeFakeCtx();
  moduleExports.apply(ctx);

  // --- renderer metadata -------------------------------------------------
  assert.equal(records.renderers.length, 1, "exactly one document renderer is registered");
  const renderer = records.renderers[0];
  assert.equal(renderer.id, "dsh-annotate-sync/html");
  assert.deepEqual([...renderer.extensions], ["html", "htm"]);
  assert.equal(renderer.priority, "external", "external priority beats the builtin html renderer");
  assert.equal(renderer.loading, "bytes-complete");
  assert.equal(renderer.wrap, false);
  assert.equal(typeof renderer.title, "function");
  assert.equal(typeof renderer.title(), "string");
  assert.ok(renderer.title().length > 0);

  // --- document slot body ------------------------------------------------
  assert.deepEqual(records.injectViews, ["sidebar.right.tab.document"]);
  assert.equal(records.slots.length, 1, "exactly one slot body is registered");
  const slot = records.slots[0];
  assert.equal(slot.options.name, "sidebar.right.tab.document");
  assert.equal(slot.options.key, "dsh-annotate-sync/html");
  assert.equal(typeof slot.component, "function");
  assert.equal(typeof slot.options.inject, "function");
  const injected = slot.options.inject();
  assert.equal(typeof injected.readRelated, "function", "the slot injects the workspace file reader");

  // --- no old v1 panel/cockpit registrations -----------------------------
  assert.deepEqual(
    [...new Set(records.injectViews)],
    ["sidebar.right.tab.document"],
    "no right-sidebar tab / composer dock / footer action slots",
  );
  for (const removed of REMOVED_SLOTS) {
    assert.ok(
      !records.injectViews.includes(removed) && !records.slots.some((item) => item.options.name === removed),
      `v1 registration ${removed} must stay removed`,
    );
  }
  // Only the v2 services are ever resolved; sidebarRight/sidebarRightTabs are gone.
  assert.deepEqual(
    [...new Set(records.gets)].sort(),
    ["documentPreviews", "slots", "sessions", "timer"].sort(),
    "no legacy right-sidebar service is resolved",
  );

  // --- one stylesheet, injected through ctx.effect ----------------------
  const styles = env.head.children.filter((child) => child.tagName === "STYLE");
  assert.equal(styles.length, 1, "exactly one renderer stylesheet is injected");
  assert.ok("data-dsh-annotate-sync" in styles[0].attributes);
  assert.ok(styles[0].textContent.includes(".das-bar"));

  // --- the injected readRelated mirrors the builtin reader --------------
  const address = "dsh-resource://file/session/session-1/src/index.html";
  const result = await injected.readRelated(address, "./app.js", undefined);
  assert.equal(result.ok, true);
  assert.equal(records.remoteCalls.length, 1);
  assert.equal(records.remoteCalls[0].sessionId, "session-1");
  assert.equal(records.remoteCalls[0].relativePath, "./app.js");
  assert.equal(records.remoteCalls[0].options.baseFile, "src/index.html");

  const bad = await injected.readRelated("https://example.com/page.html", "./app.js", undefined);
  assert.equal(bad.ok, false);
  assert.equal(records.remoteCalls.length, 1, "a non-session address never reaches the Remote");

  // --- disposal is safe and removes the stylesheet ----------------------
  for (const dispose of records.disposers.reverse()) dispose();
  assert.ok(styles[0].removed, "the stylesheet is removed on dispose");
});

test("apply never throws when every optional service is missing", async () => {
  const { moduleExports } = await loadBundle();
  const ctx = {
    get() {
      return undefined;
    },
    effect(factory) {
      const dispose = factory();
      if (typeof dispose === "function") dispose();
      return () => {};
    },
  };
  assert.doesNotThrow(() => moduleExports.apply(ctx));
});

test("apply degrades when only the renderer registry exists", async () => {
  const { moduleExports } = await loadBundle();
  const records = { renderers: [], injectViews: [] };
  const ctx = {
    get(name) {
      if (name === "documentPreviews") {
        return {
          register(options) {
            records.renderers.push(options);
            return () => {};
          },
        };
      }
      return undefined;
    },
    effect(factory) {
      factory();
      return () => {};
    },
  };
  assert.doesNotThrow(() => moduleExports.apply(ctx));
  assert.equal(records.renderers.length, 1);
  assert.equal(records.renderers[0].id, "dsh-annotate-sync/html");
});
