# dsh-annotate-sync · 页面批注插件

> 在 DeepSeek Harness 右侧栏打开你正在开发的本地应用，点选页面元素写批注，
> 批注按页面分组保存，可一键发送到对话，也能被模型通过工具直接读取。

这是一个**完整闭环**的 DSH 插件：标注前端（页面内浮层）、预览代理、同步服务、
批注存储和模型工具都在同一个 npm 包里，安装后不需要再手工往页面里加 `<script>`。

- 右侧栏 **批注** 面板（`⌘/Ctrl + Shift + B`）
- 自动发现本地开发服务器（Vite / Next / CRA / 静态服务器等常见端口）
- 每个应用一个隔离的 loopback 预览 origin，root-absolute 资源、SPA 路由都能正常工作
- 页面内点选：悬停高亮、点击写批注、编号 Pin 跟随滚动/缩放/布局变化
- 批注状态：`待处理` / `已处理`，按页面分组、筛选、编辑、删除、排序、清空
- **发送批注**：把待处理批注合并成一条结构化消息发进当前对话
- **加入输入框**：合并进草稿，自己补充上下文再发
- 模型工具：`read_annotations` / `set_annotation_status` / `clear_annotations`
- 落盘：`~/.dsh/annotate-sync/annotations.json` + 人类可读的 `annotations.md`
- 旧版同步桥 `/api/annotate-sync/annotations` 仍然保留，已接入的老页面不用改

![icon](./icon.svg)

## 安装

### 从 npm 安装

> 已发布：https://www.npmjs.com/package/dsh-annotate-sync

```bash
# macOS Desktop 自带 CLI
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop add dsh-annotate-sync@1.0.0
```

然后把 `"dsh-annotate-sync"` 加入 `~/.dsh/profiles/desktop/package.json` 的
`dsh.profile.bundles` 数组（或在 DSH 设置 → 插件 中启用它），**完全退出并重启
DeepSeek Harness**。

### 从本地目录安装（开发/分享 tarball）

```bash
dsh plugin --profile desktop add link:/absolute/path/to/dsh-annotate-sync
# 同样把 dsh-annotate-sync 加入 dsh.profile.bundles，然后重启 DSH
```

分享给别人时也可以直接发 `npm pack` 生成的 `.tgz`：

```bash
npm pack                     # 生成 dsh-annotate-sync-1.0.0.tgz
dsh plugin --profile desktop add /path/to/dsh-annotate-sync-1.0.0.tgz
```

## 使用

1. 先启动你要改的本地应用，例如 `npm run dev`（Vite 默认 `http://127.0.0.1:5173`）。
2. 在 DSH 右侧栏打开 **批注**，或按 `⌘/Ctrl + Shift + B`。
3. 列表里会出现正在运行的服务；点击它打开预览。
4. 点工具栏的 **点选**（或页面右下角浮动按钮），点击任意元素，写批注，`Enter` 保存。
5. 在面板的批注列表里可以筛选、编辑、标记已处理、删除、上下排序。
6. 点 **发送批注**：待处理批注会作为一条消息进入当前对话；
   也可以点 **加入输入框**，补充上下文后自己发送。
7. 之后直接对模型说「按批注修改」，模型会调用 `read_annotations` 读取清单。

### 内置演示页

不想动自己的项目时，可以用包里的 demo：

```bash
python3 -m http.server 4173 -d demo
```

然后在 **批注** 面板里打开 `http://127.0.0.1:4173`。

## 配置

`cordis.patch.yml` 中的 `config` 字段（也可以在插件行覆盖）：

| 字段 | 默认值 | 说明 |
|---|---|---|
| `dir` | `~/.dsh/annotate-sync` | 批注落盘目录 |
| `route` | `/__dsh-annotate-sync` | 插件内部 API/静态资源前缀 |
| `legacyRoute` | `/api/annotate-sync/annotations` | 旧版同步桥；置空关闭 |
| `maxBodyBytes` | `262144` | 单次请求体上限 |
| `tool` | `true` | 是否注册 `read_annotations` 等工具 |
| `preview` | `true` | 是否启用本地服务预览 + 页面内点选 |
| `ports` | `[]` | 额外探测的端口 |

## 模型工具

| 工具 | 作用 |
|---|---|
| `read_annotations({ status?, pageUrl?, includeDone? })` | 读取批注；默认只给 `pending`，返回 `markdown` 与结构化数组 |
| `set_annotation_status({ ids?, status, all?, pageUrl? })` | 改完后标记 `applied`（或退回 `pending`） |
| `clear_annotations({ pageUrl? })` | 清空（可限定页面） |

## 数据格式

见 [docs/PROTOCOL.md](./docs/PROTOCOL.md)。简版：

```jsonc
{
  "version": 2,
  "updatedAt": "2026-10-28T03:35:40.757Z",
  "annotations": [{
    "id": "uuid",
    "page": { "url": "http://127.0.0.1:5173/pricing", "origin": "...", "path": "/pricing", "title": "Pricing" },
    "selector": "main > section:nth-of-type(2) > h2",
    "tag": "h2", "className": "section-title", "textSample": "Simple pricing",
    "styles": { "fontSize": "26px", "color": "rgb(248, 250, 252)", "backgroundColor": "rgba(0, 0, 0, 0)" },
    "rect": { "x": 120, "y": 340, "w": 420, "h": 32 },
    "note": "把标题改成更短的文案",
    "status": "pending", "order": 0,
    "createdAt": "...", "updatedAt": "..."
  }]
}
```

旧版 `annotations.json`（纯数组或 `{annotations:[...]}`）会在首次读取时自动迁移。

## 架构

```
DSH Web
├─ Client half (lib/client.js)      右侧栏 Tab + 预览 iframe + 批注列表 + 发送
├─ Host half  (lib/index.js)        路由 / store / 工具 / 服务探测 / 预览代理
└─ Overlay    (lib/overlay.js)      注入到被预览页面：点选、Pin、批注卡片
```

- 预览：每个目标应用一个 `127.0.0.1:<随机端口>` 的 loopback 代理，HTML 响应注入
  overlay 与 bootstrap；root-absolute 资源与 SPA 路由无需改写。
- 安全：只接受 loopback 目标；代理拒绝 harness 自身；批注只写入插件目录。
- 通信：panel ↔ overlay 用 `postMessage`（严格校验 origin），panel ↔ host 用 JSON API。

## 已知限制

- Chromium 为验证过的浏览器。
- 预览代理不转发 WebSocket upgrade：页面能正常加载，但 dev server 的 HMR socket
  仍然直连它自己的 origin（热更新可能不可用，刷新即可）。
- 只能预览 loopback 应用。
- 预览使用独立的 loopback origin，原站 cookie / localStorage 不会带过来；
  依赖已有登录态的应用可能显示不完整。
- 关闭 shadow root 内部、跨域 iframe 内部的元素无法点选。
- 安装或升级后需要重启 DSH（至少刷新页面）才能加载新插件。

## 开发

```bash
npm test          # node --test
npm run check     # node --check 所有运行时文件
npm run pack:check
```

协议契约：[docs/PROTOCOL.md](./docs/PROTOCOL.md)
发布说明：[docs/PUBLISH.md](./docs/PUBLISH.md)

## License

MIT
