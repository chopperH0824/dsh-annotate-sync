/**
 * Smoke test for the browser/Client half without a real Harness page.
 *
 * Loads lib/client.js as a classic script in a VM with a stubbed ModuleLoader,
 * React and DOM, then runs apply() against fake services and asserts that the
 * right-sidebar tab, panel and composer dock are registered. This catches
 * top-level crashes, a wrong ModuleLoader envelope and missing exports, which
 * `node --check` alone cannot.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const CLIENT_FILE = fileURLToPath(new URL("../lib/client.js", import.meta.url));

/** Minimal DOM node double. */
function makeElement(tag) {
  return {
    tagName: String(tag).toUpperCase(),
    style: {},
    dataset: {},
    children: [],
    attributes: Object.create(null),
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
      this.children.push(child);
      return child;
    },
    remove() {},
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
    location: { origin: "http://127.0.0.1:62605", href: "http://127.0.0.1:62605/", pathname: "/", search: "", hash: "" },
    localStorage: {
      getItem() {
        return null;
      },
      setItem() {},
      removeItem() {},
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
    requestAnimationFrame(fn) {
      return setTimeout(fn, 0);
    },
    cancelAnimationFrame(id) {
      clearTimeout(id);
    },
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

/** Fake React: registration never renders, so createElement is enough. */
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
    useEffect() {},
    useCallback(fn) {
      return fn;
    },
  };
}

test("client half loads through the ModuleLoader envelope and registers its UI", async () => {
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
  assert.deepEqual([...moduleExports.inject].sort(), ["sessions", "sidebarRight", "sidebarRightTabs", "slots", "timer"]);

  const registrations = { tabs: [], slots: [], styles: 0 };
  const disposers = [];
  const fakeCtx = {
    get(name) {
      if (name === "slots") {
        return {
          inject(key, callback) {
            disposers.push(callback());
            return () => {};
          },
          register(options) {
            registrations.slots.push(options);
            return () => {};
          },
        };
      }
      if (name === "sidebarRightTabs") {
        return {
          register(options) {
            registrations.tabs.push(options);
            return () => {};
          },
        };
      }
      if (name === "sidebarRight") return { openTab() {} };
      if (name === "sessions") return { scope: () => undefined, sessionOf: () => undefined };
      return undefined;
    },
    effect(factory) {
      const disposer = factory();
      if (typeof disposer === "function") disposers.push(disposer);
      return () => {};
    },
  };

  moduleExports.apply(fakeCtx);

  assert.equal(registrations.tabs.length, 1, "one right-sidebar tab is registered");
  assert.equal(registrations.tabs[0].id, "annotate-sync");
  assert.equal(registrations.tabs[0].kind, "annotate-sync");
  assert.equal(typeof registrations.tabs[0].title(), "string");
  assert.equal(registrations.tabs[0].guide.length, 1);
  assert.equal(typeof registrations.tabs[0].guide[0].icon, "function");
  assert.equal(registrations.tabs[0].guide[0].id, "annotate-sync");

  const slotNames = registrations.slots.map((options) => options.name).sort();
  assert.deepEqual(slotNames, ["conversation.input.dock", "sidebar.footer.action", "sidebar.right.pane.tab"]);
  const panel = registrations.slots.find((options) => options.name === "sidebar.right.pane.tab");
  assert.equal(panel.key, "annotate-sync");
  assert.equal(typeof panel.key, "string");

  assert.ok(
    env.head.children.some((child) => child.tagName === "STYLE"),
    "the panel stylesheet is injected through ctx.effect",
  );
  assert.ok(
    env.listeners.some((item) => item.type === "keydown"),
    "the keyboard shortcut listener is installed",
  );

  // The bundle must be disposable without throwing.
  for (const dispose of disposers.reverse()) {
    if (typeof dispose === "function") dispose();
  }
});
