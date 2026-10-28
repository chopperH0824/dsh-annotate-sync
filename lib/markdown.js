/**
 * Human-readable Markdown rendering for annotation sets.
 *
 * Pure helpers only: no I/O, no dependencies. The same output is written to
 * `annotations.md` and rendered by the model tools, so keep it deterministic
 * (no clock reads) and safe for JSON/HTML-ish values (no raw interpolation of
 * untrusted markup beyond short inline code spans).
 */

/** Markdown shown when there is nothing to work on. Contract text: keep exact. */
export const EMPTY_MARKDOWN = "# 暂无未处理的页面批注\n";

/** Human labels for the two annotation statuses. */
export const STATUS_LABELS = Object.freeze({ pending: "待处理", applied: "已处理" });

/** Label for a status value; unknown values are treated as pending. */
export function statusLabel(status) {
  return status === "applied" ? STATUS_LABELS.applied : STATUS_LABELS.pending;
}

/** Grouping key for an annotation; mirrors store's `page.url` key. */
function pageKeyOf(annotation) {
  const url = annotation?.page?.url;
  return typeof url === "string" && url !== "" ? url : "unknown";
}

/** Sort key for an annotation; missing/invalid order sorts by array index. */
function orderOf(annotation, index) {
  const order = annotation?.order;
  return Number.isInteger(order) && order >= 0 ? order : index;
}

/** Stable page-then-order sort used by both the store and the Markdown view. */
export function sortAnnotations(annotations) {
  if (!Array.isArray(annotations)) return [];
  return annotations
    .map((annotation, index) => ({ annotation, index }))
    .sort((a, b) => {
      const byPage = pageKeyOf(a.annotation).localeCompare(pageKeyOf(b.annotation));
      if (byPage !== 0) return byPage;
      const byOrder = orderOf(a.annotation, a.index) - orderOf(b.annotation, b.index);
      if (byOrder !== 0) return byOrder;
      return String(a.annotation?.id ?? "").localeCompare(String(b.annotation?.id ?? ""));
    })
    .map((entry) => entry.annotation);
}

/** Collapse whitespace so one annotation always renders on one Markdown line. */
function inline(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

/** Inline code span; backticks inside a selector are broken up defensively. */
function code(value) {
  const text = inline(value);
  if (text === "") return "";
  return `\`${text.replace(/`/g, "'")}\``;
}

/** Quoted plain text for the sampled element text. */
function quote(value) {
  const text = inline(value);
  return text === "" ? "" : `“${text.replace(/[“”]/g, '"')}”`;
}

/** Render the styles line, or an empty string when no style was captured. */
function stylesLine(styles) {
  if (styles === null || typeof styles !== "object") return "";
  const parts = [];
  if (inline(styles.fontSize) !== "") parts.push(`字号 ${code(styles.fontSize)}`);
  if (inline(styles.color) !== "") parts.push(`颜色 ${code(styles.color)}`);
  if (inline(styles.backgroundColor) !== "") parts.push(`背景 ${code(styles.backgroundColor)}`);
  return parts.length === 0 ? "" : `- 当前样式：${parts.join(" · ")}`;
}

/** Element label, e.g. `<h2>` plus up to one class name. */
function elementLabel(annotation) {
  const tag = inline(annotation?.tag);
  const className = inline(annotation?.className);
  const base = tag === "" ? "元素" : `<${tag}>`;
  return className === "" ? `\`${base}\`` : `\`${base}\`（class：${code(className)}）`;
}

/** Render one annotation block. */
function renderAnnotation(annotation, index) {
  const lines = [];
  lines.push(`### ${index + 1}. [${statusLabel(annotation.status)}] ${code(annotation.selector)}`);
  lines.push(`- 元素：${elementLabel(annotation)}`);
  if (inline(annotation.textSample) !== "") lines.push(`- 当前文本：${quote(annotation.textSample)}`);
  const styles = stylesLine(annotation.styles);
  if (styles !== "") lines.push(styles);
  lines.push(`- 修改指令：**${inline(annotation.note)}**`);
  return lines;
}

/**
 * File metadata for a page group, from the first annotation that carries it.
 * v2 document annotations always share one file; legacy page annotations have
 * none and keep the old Markdown output.
 */
function fileOf(annotations) {
  for (const annotation of annotations) {
    const file = annotation?.file;
    if (file !== null && typeof file === "object") return file;
  }
  return null;
}

/** Render one page group (header, page line, annotation blocks). */
function renderPageGroup(page, annotations) {
  const lines = [];
  const file = fileOf(annotations);
  const fileName = file === null ? "" : inline(file.name);
  const fallbackTitle = annotations
    .map((annotation) => inline(annotation?.page?.title))
    .find((candidate) => candidate !== "");
  const title =
    inline(page.title) !== ""
      ? inline(page.title)
      : fileName !== ""
        ? fileName
        : fallbackTitle !== undefined
          ? fallbackTitle
          : page.url;
  lines.push(`## ${title}`);
  if (file !== null && inline(file.path) !== "") lines.push(`- 文件：${code(file.path)}`);
  if (title !== page.url) lines.push(`- 页面：${code(page.url)}`);
  const pending = annotations.filter((annotation) => annotation.status !== "applied").length;
  lines.push(`- 批注：${annotations.length} 处（待处理 ${pending} 处）`);
  lines.push("");
  annotations.forEach((annotation, index) => {
    lines.push(...renderAnnotation(annotation, index));
    lines.push("");
  });
  return lines;
}

/**
 * Build the Markdown task sheet for a set of annotations.
 *
 * @param {Array<object>} annotations annotations in any order
 * @param {{ heading?: string, emptyText?: string }} [opts]
 * @returns {string} Markdown ending with a newline
 */
export function buildMarkdown(annotations, opts = {}) {
  const list = Array.isArray(annotations) ? annotations : [];
  if (list.length === 0) {
    return typeof opts.emptyText === "string" ? opts.emptyText : EMPTY_MARKDOWN;
  }

  const sorted = sortAnnotations(list);
  const groups = [];
  for (const annotation of sorted) {
    const url = pageKeyOf(annotation);
    const current = groups[groups.length - 1];
    if (current !== undefined && current.url === url) {
      current.annotations.push(annotation);
      continue;
    }
    groups.push({
      url,
      page: annotation?.page ?? { url },
      annotations: [annotation],
    });
  }

  const total = sorted.length;
  const pending = sorted.filter((annotation) => annotation.status !== "applied").length;
  const heading = typeof opts.heading === "string" && opts.heading !== "" ? opts.heading : "页面批注清单";
  const lines = [`# ${heading}（共 ${total} 处）`, `待处理 ${pending} 处 · 已处理 ${total - pending} 处`, ""];
  for (const group of groups) lines.push(...renderPageGroup(group.page, group.annotations));
  return lines.join("\n").replace(/\n*$/, "\n");
}
