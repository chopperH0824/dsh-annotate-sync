# dsh-annotate-sync v2 契约（HTML 文档预览就地批注）

v2 是一次破坏性重构：去掉“本地服务列表 + 代理预览”的主路径，改为**接管 DSH 的 `.html` 文档预览**。
用户打开任意 HTML 文件（包括 Agent 刚生成的），预览里自动出现批注浮层；批注按文件路径保存，
一批写完自动发给当前对话的 Agent，Agent 直接改该文件；预览随文件变化自动刷新。

## 1. 体验

1. 在 DSH 里打开 `.html`（Files / 文档预览 / Agent 生成的预览）。
2. 右侧预览里自动出现「点选批注」浮层；不需要启动服务、不需要加 script。
3. 悬停高亮、点击元素、写批注、Pin、编辑/删除/状态，与旧 Agentation demo 一致。
4. 写完退出点选（Esc）或点「发送给 Agent」，整批批注作为一条结构化消息进入当前会话。
5. Agent 调 `read_annotations` 拿到 **文件路径 + selector + 当前样式 + 备注**，改源文件。
6. 文件变化后预览自动重建；Agent 改完调 `set_annotation_status` 标记 applied。

## 2. 标识

| 常量 | 值 |
|---|---|
| 包名 | `dsh-annotate-sync` |
| 插件行 | `annotate-sync` |
| 文档预览实现 id | `dsh-annotate-sync/html` |
| 文档预览 slot key | `dsh-annotate-sync/html` |
| Host 路由前缀 | `/__dsh-annotate-sync` |
| Overlay 脚本 | `/__dsh-annotate-sync/overlay.js` |
| postMessage channel | `dsh-annotate-sync` |
| 版本 | 2.0.0 |

`dsh.client.inject` 增加 `@deepseek-ai/dsh-client-ui-sidebar-documentpreview`，确保 `documentPreviews` 服务先于本插件可用。

## 3. 批注对象（v3 store）

```jsonc
{
  "id": "uuid",
  "page": {
    "url": "dsh-resource://file/session/<sessionId>/<encoded path>", // 唯一键
    "origin": "",
    "path": "<workspace-relative or absolute path>",
    "title": "index.html"
  },
  "file": {
    "sessionId": "<sessionId>",
    "path": "<path>",
    "name": "index.html",
    "address": "dsh-resource://file/session/<sessionId>/<encoded path>"
  },
  "selector": "#hero-title",
  "tag": "h1",
  "className": "hero-title",
  "textSample": "把成本算清",
  "styles": { "fontSize": "26px", "color": "rgb(15,23,42)", "backgroundColor": "rgba(0,0,0,0)" },
  "rect": { "x": 120, "y": 340, "w": 420, "h": 32 },
  "note": "把标题改短一点",
  "status": "pending",            // pending | applied
  "order": 0,
  "createdAt": "ISO",
  "updatedAt": "ISO"
}
```

- `page.url` 是文件资源地址，作为分组键；旧版 HTTP 页面批注仍可读取。
- `file` 缺失时按旧版处理；`file` 存在时 Markdown 必须输出 `文件：<path>`。
- 旧版 v2 store（`page.url` 为 http URL、无 `file`）自动迁移；写入 v3。

## 4. Store

路径不变：`~/.dsh/annotate-sync/annotations.json` + `annotations.md`。

```jsonc
{ "version": 3, "updatedAt": "ISO", "annotations": [ /* 见上 */ ] }
```

- 读取兼容：v0 数组、v1/v2 `{annotations}`、v3。
- 写入串行化；失败只告警。
- `replacePage(url, annotations)`：只替换 `page.url === url` 的一组，供文档预览保存。

## 5. Host API（panel/文档组件 → host）

`POST /__dsh-annotate-sync/api`，body `{method,args}`；只接受 loopback；统一 `{ok:true,...}` / `{ok:false,code,error}`；错误码沿用：`badMethod/badArgs/methodNotAllowed/loopbackOnly/internal`。

| method | args | 返回 |
|---|---|---|
| `state` | `{}` | `{ annotations, pages }` |
| `saveFile` | `{ url, annotations }` | `{ count, updatedAt, annotations }` |
| `save` | `{ annotations }` | 全量覆盖（兼容） |
| `setStatus` | `{ id, status }` | `{ annotation }` |
| `remove` | `{ id }` | `{ removed }` |
| `clear` | `{ pageUrl? }` | `{ cleared }` |
| `markdown` | `{ pageUrl? }` | `{ markdown, count }` |

## 6. 文档预览 renderer

客户端注册：

```js
ctx.documentPreviews.register({
  id: "dsh-annotate-sync/html",
  extensions: ["html", "htm"],
  priority: "external",          // 高于内置 html
  title: () => "HTML · 批注",
  loading: "bytes-complete",
  wrap: false
});
ctx.slots.inject("sidebar.right.tab.document", () => ctx.slots.register({
  name: "sidebar.right.tab.document",
  key: "dsh-annotate-sync/html",
  inject: () => ({ readRelated })
}, AnnotatedHtmlBody));
```

- 保留内置 HTML 预览的行为：complete bytes、相对 CSS/JS 打包、`loadRelated` 只读相对文件、`sandbox="allow-scripts"`、blob iframe、资源上限。
- 参考实现（可复制/改写，DSH 包为 MIT）：`/tmp/docpreview-client.js` 中 `packHtml`、`createHtmlDocument`、`createReadHtmlRelative`、`parseFileAddress`、`sessionFileAddress`、`HtmlFrame`。
- 在生成的 iframe HTML 末尾追加：
  ```html
  <script>window.__DSH_ANNOTATE__={"mode":"file","parentOrigin":"<harness origin>","apiOrigin":"<harness origin>","file":{"url":"<resourceAddress>","path":"<path>","name":"<name>","sessionId":"<sessionId>"},"overlaySrc":"<harness origin>/__dsh-annotate-sync/overlay.js"};</script>
  <script src="<harness origin>/__dsh-annotate-sync/overlay.js"></script>
  ```
- 文档组件持有 `resourceAddress`/`content`/`sessionId`/`inputActions`/`useInput`；从 `resourceAddress` 解析 `sessionId/path`（地址 grammar 如上）。
- 工具栏（React，位于 iframe 上方，约 34px）：文件名、`N 条待处理`、`发送给 Agent`、`自动发送` 复选框、清空。
- 启动时从 host `state` 过滤 `page.url === resourceAddress`，iframe onLoad/ready 后发 `init`。
- 收到 overlay `create/update/remove` → 更新本地列表 → 300ms 防抖 `saveFile` → 回发 `set-annotations`。
- 发送：`sessionId` 直接来自标准 props；`sessions.scope(sessionId)` → `sessionOf` → `beginSubmission({mode:'queue',text,attachments:[]})` → `prompt([{type:'text',text}],'queue',undefined,requestId)`；成功只提示“已发送”，**不**自动标记 applied（Agent 改完后标记）。
- 自动发送：`自动发送` 默认开启；overlay 发送 `mode:'idle'` 且有待处理批注时，自动发送一次（同一批不重复）；手动按钮随时可发。
- 文件内容变化时重建 blob/iframe；批注仍在 host store 中，重新 `init`。
- 组件卸载/文档 tab 关闭时清理监听与定时器。

## 7. Overlay（doc 模式）

- `CFG.mode === 'file'`：`page.url = CFG.file.url`，`page.path = CFG.file.path`，`page.title = document.title || file.name`；不再用 `location.pathname` 拼 URL。
- 父窗口是 DSH 页面（harness origin）：`postMessage(..., CFG.parentOrigin)`；接收时校验 `event.origin === CFG.parentOrigin` 与 `channel`。
- 无 `__DSH_ANNOTATE__` 时静默退出。
- 其余点选/Pin/卡片/状态逻辑保持；Esc 退出点选并 post `mode:'idle'`。
- 不读写 localStorage（opaque sandbox）。
- 保持与旧 preview 模式的兼容（`CFG.target` 存在时按旧逻辑）。

## 8. 工具

- `read_annotations({status?, pageUrl?, includeDone?})` → `{count, markdown, annotations}`；默认 pending；Markdown 每组输出 `文件：<path>`。
- `set_annotation_status({ids?, status, all?, pageUrl?})` → `{updated,count}`。
- `clear_annotations({pageUrl?})` → `{cleared}`。

## 9. 清理

- 删除 `lib/preview.js`、`lib/discover.js`、`test/preview.test.js`；host API 去掉 preview/detect/release 方法。
- 客户端删除旧右侧栏 Tab/Dock/Footer/auto-open/服务列表代码；不再注册 `sidebar.right.pane.tab`、`conversation.input.dock`、`sidebar.footer.action`。
- `legacyRoute` 可保留用于旧版外部页面，但不属于主路径。
