# dsh-annotate-sync · HTML 文档就地批注

> 打开一个 HTML 预览，批注浮层就在页面里；点选元素写批注，整批交给 Agent，
> Agent 按文件路径直接改源码。不需要起服务，不需要加 `<script>`，不需要选目标。

![icon](./icon.svg)

## 这是什么

一个 DeepSeek Harness 插件，接管 `.html` / `.htm` 的文档预览：

- 在 DSH 右侧 **Files** 里打开任意 HTML（包括 Agent 刚生成的），预览里自动出现
  **「点选批注」** 浮层；
- 悬停高亮，点击元素写批注，编号 Pin 跟随滚动/缩放/布局变化；
- 批注按 **文件路径** 保存，带 selector、当前文本、计算样式和修改指令；
- 退出点选（`Esc`）或点 **发送给 Agent**，整批作为一条结构化消息进入当前对话；
- Agent 调 `read_annotations` 拿到 **文件路径 + selector + 备注**，直接改那个 HTML/CSS；
- 文件变化后预览自动重建，批注仍在；Agent 改完可 `set_annotation_status` 标记已处理。

之前 Agentation demo 的体验保留了下来，但不再需要手工引入 `agentation.js`、不再需要
8765 同步服务，也没有“本地服务列表”要先选。

## 安装

```bash
# macOS Desktop 自带 CLI
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop add dsh-annotate-sync@2.0.0
```

把 `"dsh-annotate-sync"` 加入 `~/.dsh/profiles/desktop/package.json` 的
`dsh.profile.bundles`，然后**完全退出并重启 DeepSeek Harness**。

本地开发/分享 tarball：

```bash
npm pack
dsh plugin --profile desktop add /absolute/path/to/dsh-annotate-sync-2.0.0.tgz
```

## 使用

1. 重启 DSH。
2. 在右侧 **Files** 面板里打开任意 `.html` 文件（或直接打开包里的
   [`demo/index.html`](./demo/index.html) 试一下）。
3. 预览里右下角出现 **「点选批注」**；点它，然后点击页面元素。
4. 写备注，`Enter` 保存；`Esc` 退出点选。
5. 默认开启 **自动发送**：退出点选时，这一批批注会自动发进当前对话；
   也可以随时点工具栏的 **发送给 Agent**，或关掉自动发送手动发。
6. 之后 Agent 会读取批注并改源码；打开预览的文件变化后自动刷新。
7. 如果 Agent 没有自动标记，直接说「按批注修改」，它会调用 `read_annotations`。

工具栏在预览上方：文件名、待处理数量、发送、自动发送、清空。

## 批注数据

```jsonc
{
  "id": "uuid",
  "page": {
    "url": "dsh-resource://file/session/<sessionId>/<encoded path>",
    "origin": "",
    "path": "demo/index.html",
    "title": "index.html"
  },
  "file": { "sessionId": "...", "path": "demo/index.html", "name": "index.html", "address": "dsh-resource://..." },
  "selector": "#hero-title",
  "tag": "h1",
  "className": "hero-title",
  "textSample": "把成本算清",
  "styles": { "fontSize": "26px", "color": "rgb(15,23,42)", "backgroundColor": "rgba(0,0,0,0)" },
  "rect": { "x": 120, "y": 340, "w": 420, "h": 32 },
  "note": "把标题改短一点",
  "status": "pending",
  "order": 0,
  "createdAt": "ISO",
  "updatedAt": "ISO"
}
```

落盘：`~/.dsh/annotate-sync/annotations.json` + 人类可读的 `annotations.md`。
旧版 v0/v1/v2 文件自动迁移到 v3；旧 HTTP 页面批注仍可读取。

## 模型工具

| 工具 | 作用 |
|---|---|
| `read_annotations({ status?, pageUrl?, includeDone? })` | 读取批注；默认只给 `pending`；Markdown 每组带 `文件：<path>` |
| `set_annotation_status({ ids?, status, all?, pageUrl? })` | 改完后标记 `applied`（或退回 `pending`） |
| `clear_annotations({ pageUrl? })` | 清空（可限定文件） |

## 配置

`cordis.patch.yml` 中的 `config`：

| 字段 | 默认值 | 说明 |
|---|---|---|
| `dir` | `~/.dsh/annotate-sync` | 批注落盘目录 |
| `route` | `/__dsh-annotate-sync` | 插件内部 API/overlay 前缀 |
| `legacyRoute` | `/api/annotate-sync/annotations` | 旧版同步桥；置空关闭 |
| `maxBodyBytes` | `262144` | 单次请求体上限 |
| `tool` | `true` | 是否注册模型工具 |

## 架构

```
DSH Web
└─ Client: 自定义 HTML 文档预览 renderer（priority: external）
   ├─ 复用内置 HTML 预览的 bytes-complete + 相对 CSS/JS 打包 + opaque blob iframe
   ├─ 注入 window.__DSH_ANNOTATE__ + overlay.js
   ├─ toolbar：发送 / 自动发送 / 清空
   └─ postMessage 桥：overlay ↔ 文档组件
Host: 路由 + v3 批注 store + 三个模型工具
Overlay: 点选、Pin、批注卡片、状态
```

- 预览 iframe 仍是 `sandbox="allow-scripts"` 的 opaque origin；overlay 与文档组件只通过
  `postMessage` 通信，父侧校验 `event.source` + channel。
- 相对 CSS/JS 由 DSH 的 workspaceFiles 读取并打包进 blob，和内置预览一致。
- 不启动任何额外 HTTP 服务，不向被预览页面注入网络请求。

## 已知限制

- 页面自带 CSP 且禁止外部脚本时，overlay 会被拦截；预览本身仍可用。
- 自定义 renderer 总是允许页面脚本执行（overlay 需要），不受内置“交互式预览”开关控制。
- 跨域 iframe、closed shadow root 内的元素无法点选。
- 只接管 `.html` / `.htm`；其他文档类型仍用内置预览。
- 批注定位依赖 CSS selector 与几何矩形；元素结构大改后可能定位不准，但备注和文件路径仍在。

## 从 1.x 升级

v2 移除了“本地服务预览 + 右侧栏批注面板”。旧的 `annotations.json` 会迁移；旧的
`/api/annotate-sync/annotations` 同步桥仍保留。无需再启动 `sync-server.mjs`。

## 开发

```bash
npm test          # node --test
npm run check     # node --check 所有运行时文件
npm run pack:check
```

协议契约：[docs/PROTOCOL.md](./docs/PROTOCOL.md) · 发布：[docs/PUBLISH.md](./docs/PUBLISH.md)

## License

MIT。HTML 渲染器部分改编自 DeepSeek Harness（MIT），见 [NOTICE](./NOTICE)。
