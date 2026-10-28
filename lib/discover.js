/**
 * dsh-annotate-sync — loopback development service discovery.
 *
 * The sidebar panel needs a list of local dev servers it can preview. We probe
 * a fixed set of popular development ports plus whatever the profile
 * configured, in parallel, and treat *any* HTTP response as "a server is
 * listening there". Discovery is deliberately conservative: it only ever
 * connects to 127.0.0.1, it never follows redirects, each probe has a hard
 * timeout, and the whole function resolves to an empty list instead of throwing.
 */

import http from "node:http";

/**
 * Ports people actually run dev servers on, in display-preference order.
 * (Vite, CRA, Vue CLI, Angular, Astro, Storybook, Next/Nuxt defaults, …)
 */
export const COMMON_PORTS = Object.freeze([
  5173, 3000, 3001, 4173, 4200, 4321, 5000, 5174, 5180, 5500, 6006, 7000, 8000, 8001, 8080, 8081, 8888, 9000, 1234,
]);

const COMMON_RANK = new Map(COMMON_PORTS.map((port, index) => [port, index]));

const PROBE_HOST = "127.0.0.1";
const DEFAULT_TIMEOUT_MS = 400;
const DEFAULT_LIMIT = 12;
const MAX_TIMEOUT_MS = 30_000;
const MAX_LIMIT = 1000;
const MAX_HTML_BYTES = 64 * 1024;
const MAX_TITLE_LENGTH = 120;

/** Coerce one candidate port; null when it is unusable. */
function normalizePort(value) {
  const port = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return port;
}

/** Coerce a scalar or array of ports into a de-duplicated numeric list. */
function normalizePortList(value) {
  const input = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  const ports = [];
  for (const entry of input) {
    const port = normalizePort(entry);
    if (port !== null) ports.push(port);
  }
  return ports;
}

/** Clamp the caller's result limit; 0 disables probing entirely. */
function normalizeLimit(value) {
  const limit = Number(value);
  if (!Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.max(0, Math.min(MAX_LIMIT, Math.floor(limit)));
}

/** Clamp the caller's per-port timeout. */
function normalizeTimeout(value) {
  const timeout = Number(value);
  if (!Number.isFinite(timeout) || timeout <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.max(1, Math.min(MAX_TIMEOUT_MS, Math.floor(timeout)));
}

/** Extract a trimmed, single-line document title. */
function extractTitle(html) {
  const match = /<title[^>]*>([\s\S]{0,2000}?)<\/title>/i.exec(html);
  if (!match) return "";
  return match[1].replace(/\s+/g, " ").trim().slice(0, MAX_TITLE_LENGTH);
}

/** Whether the port is one of the well-known development ports. */
function rankOf(port) {
  return COMMON_RANK.get(port) ?? COMMON_PORTS.length;
}

/**
 * Probe one loopback port.
 *
 * Resolves to a Service on any HTTP response (including 4xx/5xx) and to null
 * when the connection fails or no headers arrive before `timeoutMs`. The
 * promise never rejects.
 *
 * @param {number} port
 * @param {number} timeoutMs
 * @returns {Promise<{port:number,origin:string,url:string,title:string,kind:'dev',responseMs:number}|null>}
 */
function probePort(port, timeoutMs) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    /** @type {import("node:http").ClientRequest | null} */
    let request = null;
    /** @type {NodeJS.Timeout | null} */
    let timer = null;
    let settled = false;
    let sawResponse = false;
    let responseMs = 0;
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      try {
        request?.destroy();
      } catch {
        /* already gone */
      }
      resolve(value);
    };

    const service = () => ({
      port,
      origin: `http://${PROBE_HOST}:${port}`,
      url: `http://${PROBE_HOST}:${port}/`,
      title: extractTitle(Buffer.concat(chunks).toString("utf8")) || `${PROBE_HOST}:${port}`,
      kind: /** @type {const} */ ("dev"),
      responseMs: Math.max(0, Math.round(responseMs)),
    });

    timer = setTimeout(() => {
      // Headers already arrived: the service is up even if the body is slow.
      finish(sawResponse ? service() : null);
    }, timeoutMs);

    try {
      request = http.request(
        {
          host: PROBE_HOST,
          port,
          path: "/",
          method: "GET",
          headers: {
            accept: "text/html,application/xhtml+xml",
            "user-agent": "dsh-annotate-sync",
          },
        },
        (response) => {
          sawResponse = true;
          responseMs = Date.now() - startedAt;
          const type = String(response.headers["content-type"] ?? "").toLowerCase();
          if (!type.includes("html")) {
            response.resume();
            finish(service());
            return;
          }
          response.on("data", (chunk) => {
            if (settled) return;
            chunks.push(chunk);
            size += chunk.length;
            if (size >= MAX_HTML_BYTES) finish(service());
          });
          response.on("end", () => finish(service()));
          response.on("error", () => finish(service()));
          response.on("aborted", () => finish(service()));
        },
      );
      request.on("error", () => finish(null));
      request.end();
    } catch {
      finish(null);
    }
  });
}

/**
 * Detect local HTTP services on loopback.
 *
 * @param {{
 *   ports?: Array<number|string>,
 *   timeoutMs?: number,
 *   limit?: number,
 *   excludePorts?: Array<number|string>,
 * }} [options]
 * @returns {Promise<Array<{port:number,origin:string,url:string,title:string,kind:'dev',responseMs:number}>>}
 */
export async function detectServices({ ports = [], timeoutMs = DEFAULT_TIMEOUT_MS, limit = DEFAULT_LIMIT, excludePorts = [] } = {}) {
  try {
    const max = normalizeLimit(limit);
    if (max === 0) return [];
    const timeout = normalizeTimeout(timeoutMs);
    const excluded = new Set(normalizePortList(excludePorts));
    const candidates = [...new Set([...normalizePortList(ports), ...COMMON_PORTS])]
      .filter((port) => !excluded.has(port))
      .sort((a, b) => rankOf(a) - rankOf(b) || a - b);

    const probed = await Promise.all(candidates.map((port) => probePort(port, timeout)));
    return probed.filter((service) => service !== null).slice(0, max);
  } catch {
    // Discovery is best-effort: a broken environment must never break the panel.
    return [];
  }
}
