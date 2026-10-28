# dsh-annotate-sync — 实现契约（v1）

本文件是 Host、Client、Overlay 三半之间唯一的共享契约。任何一方改动都必须先改本文件，
并且保持向后兼容（外部页面、旧版同步桥、旧版 annotations.json）。

## 1. 产品模型

```
┌────────────────────────── DeepSeek Harness Web ──────────────────────────┐
│  Client half: 右侧栏「批注」tab                                           │
│   ├─ 列表页：探测到的本地服务（http://127.0.0.1:<port>）                    │
│   └─ 预览页：iframe -> 每目标一个 loopback 代理 origin                     │
│        └─ 代理向 HTML 注入 overlay.js + bootstrap                         │
│  Host half: 路由、store、工具、服务探测、预览代理                          │
└───────────────────────────────────────────────────────────────────────────┘
       overlay 与 panel 通过 postMessage 通信（跨 origin，不读 DOM）
       panel 与 host 通过 POST /__dsh-annotate-sync/api 通信
```

- panel 从不直接读 iframe 的 DOM；overlay 是唯一能读预览页 DOM 的代码。
- overlay 是独立 classic script（无 ESM、无构建、无依赖），由代理注入。
- 所有批注持久化在 host 的 store 中；panel 是唯一写入者（overlay 只上报变更）。

## 2. 标识与路由

| 常量 | 值 |
|---|---|
| 包名 | `dsh-annotate-sync` |
| 插件行 id | `annotate-sync` |
| 右侧栏 tab id / kind | `annotate-sync` |
| Host 前缀 | `/__dsh-annotate-sync` |
| Host API | `POST /__dsh-annotate-sync/api` |
| Overlay 脚本 | `GET /__dsh-annotate-sync/overlay.js` |
| 旧版同步桥 | `/api/annotate-sync/annotations`（GET/POST/DELETE/OPTIONS，CORS `*`） |
| postMessage channel | `dsh-annotate-sync` |

overlay 的 bootstrap（代理注入，先于 overlay.js）：

```html
<script>window.__DSH_ANNOTATE__={parentOrigin:"http://127.0.0.1:62605",apiOrigin:"http://127.0.0.1:62605",lease:"<uuid>",target:"http://127.0.0.1:5173"}</script>
<script src="http://127.0.0.1:62605/__dsh-annotate-sync/overlay.js"></script>
```

## 3. 批注对象

```jsonc
{
  "id": "uuid",                     // overlay 生成，host 不重写
  "page": {
    "url": "http://127.0.0.1:5173/pricing", // 去掉 hash；分组键 = url
    "origin": "http://127.0.0.1:5173",
    "path": "/pricing",
    "title": "Pricing - Acme"
  },
  "selector": "main > section:nth-of-type(2) > h2", // CSS 选择器，唯一性未保证
  "tag": "h2",
  "className": "section-title",
  "textSample": "Simple pricing",   // 最多 160 字符
  "styles": {
    "fontSize": "26px",
    "color": "rgb(248, 250, 252)",
    "backgroundColor": "rgba(0, 0, 0, 0)"
  },
  "rect": { "x": 120, "y": 340, "w": 420, "h": 32 },  // 视口坐标，pin 初始定位
  "note": "把标题改成更短的文案",      // 1..2000 字符，必填
  "status": "pending",               // pending | applied
  "order": 0,                        // 同一 page 内从 0 递增
  "createdAt": "2026-10-28T03:35:40.757Z",
  "updatedAt": "2026-10-28T03:35:40.757Z"
}
```

规则：

- `selector` 与 `note` 为空的对象被丢弃。
- `status` 缺省 `pending`；未知值按 `pending`。
- `order` 缺省按数组下标补齐；host 读取时按 `page.url` + `order` 排序。
- `page.url` 缺省时回退到 `page.origin + page.path`，再缺省为 `unknown`。
- 文本长度上限：note 2000，textSample 160，selector 1000，className 300。

## 4. Store 文件

路径：`<config.dir>/annotations.json`（默认 `~/.dsh/annotate-sync/annotations.json`），
另写人类可读的 `annotations.md`。

```jsonc
{
  "version": 2,
  "updatedAt": "2026-10-28T03:35:40.757Z",
  "annotations": [ /* 批注对象 */ ]
}
```

兼容读取：

- 旧版 `[{...}]`（v0 数组）：整体按批注数组读取，`page` 缺失时补
  `{url:"unknown",origin:"",path:"",title:""}`，`status` 补 `pending`。
- 旧版 `{updatedAt, dir, annotations:[...]}`：读取 `annotations`。
- 写入一律用 v2 结构。
- 写盘串行化（Promise chain），先写 JSON 再写 Markdown，任何失败只告警不抛给 HTTP。

## 5. Host API（panel → host）

`POST /__dsh-annotate-sync/api`，`content-type: application/json`，
body `{ "method": string, "args": object }`。远端地址非 loopback → 403。

统一响应：`{ ok: true, ...data }` 或 `{ ok: false, code, error }`。
`code` 取值：`badMethod`、`badArgs`、`notLocalTarget`、`previewFailed`、
`tooManyPreviews`、`methodNotAllowed`、`loopbackOnly`、`internal`。

| method | args | 成功返回 |
|---|---|---|
| `state` | `{ sid }` | `{ root, services, annotations, pages }` |
| `detect` | `{ sid, ports? }` | `{ services: Service[] }` |
| `preview` | `{ sid, url, lease?, parentOrigin? }` | `{ origin, lease, target }` |
| `releasePreview` | `{ sid, lease }` | `{ released: boolean }` |
| `save` | `{ sid, annotations }` | `{ count, updatedAt }` |
| `setStatus` | `{ sid, id, status }` | `{ annotation }` |
| `remove` | `{ sid, id }` | `{ removed: boolean }` |
| `reorder` | `{ sid, pageUrl, ids }` | `{ annotations }` |
| `clear` | `{ sid, pageUrl? }` | `{ cleared: number }` |
| `markdown` | `{ pageUrl? }` | `{ markdown, count }` |

- `sid` 是 DSH session id，仅用于日志/隔离；store 当前是 profile 级共享。
- `save` 是覆盖式保存（panel 是唯一写入者）。
- `pages` 是 `[{ url, origin, path, title, count, pending }]` 派生视图。

Service：

```jsonc
{ "port": 5173, "origin": "http://127.0.0.1:5173", "url": "http://127.0.0.1:5173/",
  "title": "Vite + React", "kind": "dev", "responseMs": 23 }
```

## 6. Overlay ↔ Panel 消息

全部使用 `window.postMessage(message, "*")`，消息带 `channel: "dsh-annotate-sync"`。
panel 必须校验 `event.origin === previewOrigin`；overlay 必须校验
`event.origin === window.__DSH_ANNOTATE__.parentOrigin`。

### panel → overlay（targetOrigin = previewOrigin）

| type | payload | 说明 |
|---|---|---|
| `init` | `{ annotations, pageUrl, mode }` | iframe onLoad 后发送；overlay 据此渲染 pins |
| `set-annotations` | `{ annotations }` | 批注列表变化（新增/编辑/状态/删除/排序） |
| `set-mode` | `{ mode: "idle"\|"picking" }` | 进入/退出点选 |
| `focus` | `{ id }` | 滚动到 pin 并高亮 |
| `navigate` | `{ delta: -1\|1 }` | 预览页历史前进/后退 |
| `reload` | `{}` | 刷新预览页 |
| `ping` | `{}` | 握手/探活 |

### overlay → panel（targetOrigin = parentOrigin）

| type | payload | 说明 |
|---|---|---|
| `ready` | `{ page: Page, viewport: {w,h} }` | 脚本就绪；每次导航后重发 |
| `create` | `{ annotation }` | 用户点选并保存了一条新批注 |
| `update` | `{ annotation }` | 修改 note / 状态 |
| `remove` | `{ id }` | 用户删除 |
| `mode` | `{ mode }` | 点选模式变化（Esc 退出等） |
| `focus` | `{ id }` | 用户点 pin，panel 打开批注列表并高亮 |
| `notice` | `{ message }` | 非致命提示 |

panel 收到 `create/update/remove` 后：更新本地状态 → 防抖 300ms 调 `save` →
再向 overlay 回发 `set-annotations`（保证 id/order 一致）。

## 7. 预览代理（host 内部）

- 每个 `(sid, target)` 一个 `http.createServer`，绑定 `127.0.0.1:0`（随机端口），
  记录 `{ origin, target, lease, lastUsedAt, server }`。
- 只允许 loopback target；拒绝 file://、非 http(s)、harness 自身 origin。
- 转发：`Host` 改为 target.host；删除 `accept-encoding`（取明文便于注入）、
  `connection` 等 hop-by-hop 头；透传状态码与其余头。
- 删除 `content-security-policy`、`x-frame-options`（允许被 panel iframe 嵌入）；
  代理响应加 `cache-control: no-store`。
- GET 且 `content-type: text/html` 时注入 bootstrap + overlay `<script>`（在
  `</body>` 前，找不到则追加）。非 HTML 原样流式返回。
- 3xx 的绝对 Location 若指向 target origin，改写为代理 origin 的同路径 URL。
- 空闲 5 分钟且**没有租约**时关闭；`releasePreview` 释放最后一个租约时立即关闭；
  最多 12 个活跃预览。面板打开期间持有租约，因此空闲浏览不会拆掉代理。
- 不实现 WebSocket relay（v1 限制，写进 README）。
- 安全：只代理 loopback；不缓存；不读写 cookie 之外的存储；不暴露任意 URL。

## 8. 工具（host → model）

- `read_annotations({ status?, pageUrl?, includeDone? })`
  → `{ count, markdown, annotations }`，默认只返回 `pending`，除非
  `includeDone: true` 或 `status: "applied"`。
- `set_annotation_status({ ids?, status, all?, pageUrl? })`
  → `{ updated, count }`；`all: true` 时把范围内批注全部置为目标状态。
- `clear_annotations({ pageUrl? })` → `{ cleared }`。

工具描述必须写清“用户说按批注修改时调用”，并把 `markdown` 作为 render 文本。
工具注册失败只告警，不影响插件激活。

## 9. Client 注册

```js
const inject = ['timer', 'sessions', 'slots', 'sidebarRight', 'sidebarRightTabs']
sidebarRightTabs.register({ id: 'annotate-sync', kind: 'annotate-sync',
  priority: 'extension', title: () => '批注', guide: [{...}] })
slots.inject('sidebar.right.pane.tab', () => slots.register({ name,
  key: 'annotate-sync', id: 'annotate-sync' }, Panel))
slots.inject('conversation.input.dock', () => slots.register({ name,
  id: 'annotate-sync-dock' }, Dock))
```

快捷键：`⌘/Ctrl + Shift + B` 打开 tab；`Esc` 退出点选/关闭面板内弹层。
所有监听用 `ctx.effect(() => () => remove())` 清理。

发送到对话（参考已安装 API）：

```js
const sessions = ctx.get('sessions')
const scope = sessions?.scope?.(sessionId)
const session = scope && sessions.sessionOf(scope)
const submission = session.beginSubmission({ mode: 'queue', text, attachments: [] })
await session.prompt([{ type: 'text', text }], 'queue', undefined, submission.requestId)
```

失败时保留批注并提示；成功后把这些批注标记 `applied` 并清空面板 pending 视图。

## 10. 文件所有权

| 文件 | 负责人 |
|---|---|
| `lib/index.js` `lib/store.js` `lib/markdown.js` `lib/api.js` | host-core |
| `lib/discover.js` `lib/preview.js` | preview-proxy |
| `lib/client.js` | panel-ui |
| `lib/overlay.js` `demo/*` | overlay-ui |
| `package.json` `cordis.patch.yml` `locale/*` `icon.svg` `LICENSE` `docs/*` `README*` | lead |

任何跨文件改动先在任务里说明，Lead 统一收口。
