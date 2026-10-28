/**
 * Durable annotation store for dsh-annotate-sync.
 *
 * The store is the single in-process authority. It keeps annotations in memory,
 * mirrors them to a versioned JSON file and a human-readable Markdown file, and
 * migrates the legacy on-disk shapes described in docs/PROTOCOL.md section 4.
 *
 * Writes are serialized (Promise chain) and never reject: the HTTP layer must
 * never fail because the disk is unavailable, so persistence errors are only
 * logged through `log.warn`.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildMarkdown, sortAnnotations } from "./markdown.js";

/** Contract length limits (docs/PROTOCOL.md section 3). */
export const LIMITS = Object.freeze({
  note: 2000,
  textSample: 160,
  selector: 1000,
  className: 300,
  pageTitle: 120,
});

const FILE_JSON = "annotations.json";
const FILE_MARKDOWN = "annotations.md";

/** Whether a value is a plain object (not null / array). */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Trimmed string or `fallback` when the value is not a usable string. */
function asString(value, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

/** Trim then clamp to `max` characters. */
function clampText(value, max) {
  const text = asString(value);
  return text.length > max ? text.slice(0, max) : text;
}

/** Finite number or `fallback`. */
function asNumber(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Keep only `url` without its hash fragment. */
function stripHash(url) {
  const index = url.indexOf("#");
  return index === -1 ? url : url.slice(0, index);
}

/** Derive missing page fields from whatever the legacy writer produced. */
function normalizePage(value) {
  const raw = isPlainObject(value) ? value : {};
  let origin = asString(raw.origin);
  let path = asString(raw.path);
  let url = asString(raw.url);

  if (url === "") {
    if (origin !== "" && path !== "") {
      const base = origin.replace(/\/+$/, "");
      url = `${base}${path.startsWith("/") ? path : `/${path}`}`;
    } else {
      url = origin !== "" ? origin : path;
    }
  }
  url = url === "" ? "unknown" : stripHash(url);

  let parsed = null;
  if (url !== "unknown") {
    try {
      parsed = new URL(url);
    } catch {
      parsed = null;
    }
  }
  if (origin === "" && parsed !== null) origin = parsed.origin;
  if (path === "" && parsed !== null) path = parsed.pathname;

  return {
    url,
    origin,
    path,
    title: clampText(raw.title, LIMITS.pageTitle),
  };
}

/** Normalize the captured computed styles object. */
function normalizeStyles(value) {
  const raw = isPlainObject(value) ? value : {};
  return {
    fontSize: asString(raw.fontSize),
    color: asString(raw.color),
    backgroundColor: asString(raw.backgroundColor),
  };
}

/** Normalize the pin anchor rectangle (viewport coordinates). */
function normalizeRect(value) {
  const raw = isPlainObject(value) ? value : {};
  return {
    x: asNumber(raw.x),
    y: asNumber(raw.y),
    w: asNumber(raw.w),
    h: asNumber(raw.h),
  };
}

/** ISO timestamp fallback for records that predate `createdAt`. */
function nowIso() {
  return new Date().toISOString();
}

/**
 * Normalize one annotation record.
 *
 * Annotations without a selector or note are dropped (returns null), matching
 * the protocol rule that unusable records never enter the store. Unknown status
 * values fall back to `pending`, and `order` defaults to the array index.
 *
 * @param {unknown} value raw record from disk or panel
 * @param {number} [index] array index, used as the default order
 * @param {string} [timestamp] fallback timestamp for missing createdAt/updatedAt
 * @returns {object|null}
 */
export function normalizeAnnotation(value, index = 0, timestamp = nowIso()) {
  if (!isPlainObject(value)) return null;
  const selector = clampText(value.selector, LIMITS.selector);
  const note = clampText(value.note, LIMITS.note);
  if (selector === "" || note === "") return null;

  const id = asString(value.id) === "" ? randomUUID() : asString(value.id);
  const createdAt = asString(value.createdAt) === "" ? timestamp : asString(value.createdAt);
  const updatedAt = asString(value.updatedAt) === "" ? createdAt : asString(value.updatedAt);
  const order = Number.isInteger(value.order) && value.order >= 0 ? value.order : index;

  return {
    id,
    page: normalizePage(value.page),
    selector,
    tag: asString(value.tag),
    className: clampText(value.className, LIMITS.className),
    textSample: clampText(value.textSample, LIMITS.textSample),
    styles: normalizeStyles(value.styles),
    rect: normalizeRect(value.rect),
    note,
    status: value.status === "applied" ? "applied" : "pending",
    order,
    createdAt,
    updatedAt,
  };
}

/** Normalize an annotation array, dropping unusable records. */
export function normalizeAnnotations(values, timestamp = nowIso()) {
  if (!Array.isArray(values)) return [];
  const result = [];
  values.forEach((value) => {
    const annotation = normalizeAnnotation(value, result.length, timestamp);
    if (annotation !== null) result.push(annotation);
  });
  return result;
}

/** Defensive copy so callers cannot mutate the store's authority objects. */
function cloneAnnotation(annotation) {
  return {
    ...annotation,
    page: { ...annotation.page },
    styles: { ...annotation.styles },
    rect: { ...annotation.rect },
  };
}

/** Compare within the canonical (page.url, order) order. */
function compareForList(a, b) {
  const byPage = a.page.url.localeCompare(b.page.url);
  if (byPage !== 0) return byPage;
  if (a.order !== b.order) return a.order - b.order;
  return String(a.id).localeCompare(String(b.id));
}

/** Extract an annotation array from any supported on-disk shape. */
function migrate(raw) {
  if (Array.isArray(raw)) return raw;
  if (isPlainObject(raw) && Array.isArray(raw.annotations)) return raw.annotations;
  return [];
}

/**
 * Create the annotation store.
 *
 * @param {{ dir: string, log?: { warn?: Function, info?: Function } }} options
 * @returns {object} store facade (see task contract)
 */
export function createStore({ dir, log } = {}) {
  if (typeof dir !== "string" || dir === "") {
    throw new TypeError("createStore: dir must be a non-empty string");
  }

  const jsonFile = join(dir, FILE_JSON);
  const markdownFile = join(dir, FILE_MARKDOWN);
  const filePaths = Object.freeze({ dir, json: jsonFile, markdown: markdownFile });

  /** In-memory authority, canonical order maintained on write. */
  let annotations = [];
  /** Timestamp of the last in-memory mutation / load. */
  let updatedAt = null;
  /** Set once the initial disk read completed. */
  let loadPromise = null;
  /** Serialized disk writes; always settles. */
  let writeChain = Promise.resolve();

  const warn = (message) => {
    try {
      log?.warn?.(`annotate-sync: ${message}`);
    } catch {
      /* logging must never break the store */
    }
  };

  /** Sort the in-memory array in place and return it. */
  function canonicalize() {
    annotations.sort(compareForList);
    return annotations;
  }

  /** Write the current snapshot (JSON then Markdown) after any pending write. */
  function persist() {
    const timestamp = updatedAt ?? nowIso();
    const snapshot = JSON.stringify({ version: 2, updatedAt: timestamp, annotations }, null, 2);
    const markdown = buildMarkdown(annotations);
    writeChain = writeChain
      .then(async () => {
        await mkdir(dir, { recursive: true });
        await writeFile(jsonFile, snapshot, "utf-8");
        await writeFile(markdownFile, markdown, "utf-8");
      })
      .catch((error) => {
        warn(`failed to persist annotations: ${String(error?.message ?? error)}`);
      });
    return writeChain;
  }

  /** Load the persisted set once; never throws. */
  async function ensureLoaded() {
    if (loadPromise === null) {
      loadPromise = (async () => {
        try {
          const text = await readFile(jsonFile, "utf-8");
          const parsed = JSON.parse(text);
          annotations = normalizeAnnotations(migrate(parsed));
          if (isPlainObject(parsed) && asString(parsed.updatedAt) !== "") updatedAt = asString(parsed.updatedAt);
          canonicalize();
        } catch (error) {
          if (error?.code !== "ENOENT") {
            warn(`failed to read ${jsonFile}: ${String(error?.message ?? error)}`);
          }
          annotations = [];
        }
      })();
    }
    await loadPromise;
  }

  /** All annotations, cloned and sorted by page.url + order. */
  function list() {
    return canonicalize().map(cloneAnnotation);
  }

  /** Replace the whole set (the panel is the only writer). */
  async function replace(values) {
    if (!Array.isArray(values)) throw new TypeError("replace: annotations must be an array");
    await ensureLoaded();
    updatedAt = nowIso();
    annotations = normalizeAnnotations(values, updatedAt);
    canonicalize();
    await persist();
    return { count: annotations.length, updatedAt, annotations: list() };
  }

  /** Update one annotation's status; null when the id is unknown. */
  async function setStatus(id, status) {
    await ensureLoaded();
    const target = annotations.find((annotation) => annotation.id === id);
    if (target === undefined) return null;
    updatedAt = nowIso();
    target.status = status === "applied" ? "applied" : "pending";
    target.updatedAt = updatedAt;
    await persist();
    return cloneAnnotation(target);
  }

  /** Delete one annotation; false when the id is unknown. */
  async function remove(id) {
    await ensureLoaded();
    const index = annotations.findIndex((annotation) => annotation.id === id);
    if (index === -1) return false;
    annotations.splice(index, 1);
    updatedAt = nowIso();
    await persist();
    return true;
  }

  /** Re-apply the panel-provided order for one page. */
  async function reorder(pageUrl, ids) {
    if (typeof pageUrl !== "string" || pageUrl === "") throw new TypeError("reorder: pageUrl must be a string");
    if (!Array.isArray(ids)) throw new TypeError("reorder: ids must be an array");
    await ensureLoaded();

    const pageItems = canonicalize().filter((annotation) => annotation.page.url === pageUrl);
    const byId = new Map(pageItems.map((annotation) => [annotation.id, annotation]));
    const seen = new Set();
    let nextOrder = 0;
    for (const id of ids) {
      const annotation = byId.get(id);
      if (annotation === undefined || seen.has(id)) continue;
      seen.add(id);
      annotation.order = nextOrder;
      nextOrder += 1;
    }
    for (const annotation of pageItems) {
      if (seen.has(annotation.id)) continue;
      annotation.order = nextOrder;
      nextOrder += 1;
    }

    updatedAt = nowIso();
    await persist();
    return list();
  }

  /** Clear everything, or only one page when `pageUrl` is given. */
  async function clear(pageUrl) {
    await ensureLoaded();
    const scoped = typeof pageUrl === "string" && pageUrl !== "";
    const before = annotations.length;
    annotations = scoped ? annotations.filter((annotation) => annotation.page.url !== pageUrl) : [];
    updatedAt = nowIso();
    await persist();
    return before - annotations.length;
  }

  /** Derived page view for the panel / state method. */
  function pages() {
    const byUrl = new Map();
    for (const annotation of canonicalize()) {
      const url = annotation.page.url;
      let page = byUrl.get(url);
      if (page === undefined) {
        page = {
          url,
          origin: annotation.page.origin,
          path: annotation.page.path,
          title: annotation.page.title,
          count: 0,
          pending: 0,
        };
        byUrl.set(url, page);
      }
      page.count += 1;
      if (annotation.status === "pending") page.pending += 1;
      if (page.title === "" && annotation.page.title !== "") page.title = annotation.page.title;
    }
    return [...byUrl.values()];
  }

  /** Markdown for the current set, optionally scoped to one page URL. */
  async function markdown(pageUrl) {
    await ensureLoaded();
    const scoped = typeof pageUrl === "string" && pageUrl !== "";
    const items = scoped ? annotations.filter((annotation) => annotation.page.url === pageUrl) : annotations;
    return buildMarkdown(sortAnnotations(items));
  }

  return {
    ensureLoaded,
    list,
    replace,
    setStatus,
    remove,
    reorder,
    clear,
    pages,
    markdown,
    filePaths,
  };
}
