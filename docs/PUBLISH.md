# 发布与分享指南

本包已经按 npm 公开包 + GitHub 仓库的形态准备好。Agent 不会替你在 npm 上发布
（需要你的账号和 2FA），下面是可以直接照做的步骤。

## 0. 发布前检查

```bash
cd dsh-annotate-sync
npm run check        # node --check 所有运行时文件
npm test             # node --test
npm run pack:check   # 确认打包内容
```

`npm pack --dry-run` 的输出里必须包含：`lib/**`、`types/**`、`locale/*.json`、
`icon.svg`、`cordis.patch.yml`、`README*.md`、`CHANGELOG.md`、`LICENSE`、
`docs/PROTOCOL.md`。不应出现 `test/`、`node_modules/`、临时文件。

## 1. 推送到 GitHub

```bash
cd dsh-annotate-sync
git init
git add -A
git commit -m "feat: dsh-annotate-sync 1.0.0 — full annotation plugin for DeepSeek Harness"
git branch -M main
git remote add origin git@github.com:<your-account>/dsh-annotate-sync.git
git push -u origin main
git tag v1.0.0
git push --tags
```

发布前把 `package.json` 里的 `repository` / `homepage` / `bugs` 补成你的仓库地址
（本包刻意没有编造 URL）：

```jsonc
"repository": { "type": "git", "url": "git+https://github.com/<you>/dsh-annotate-sync.git" },
"homepage": "https://github.com/<you>/dsh-annotate-sync#readme",
"bugs": { "url": "https://github.com/<you>/dsh-annotate-sync/issues" }
```

## 2. 发布到 npm

包名 `dsh-annotate-sync` 目前未被占用（发布前可再确认）：

```bash
npm view dsh-annotate-sync version   # 404 = 可用
npm login
npm whoami
npm publish --access public
```

- 版本号已经设为 `1.0.0`，与 CHANGELOG 对应。
- 后续发布先改 `version` 与 `CHANGELOG.md`，再 `npm publish`。
- 若使用私有 registry，改 `publishConfig.registry` 后再发布。

## 3. 让别人安装

对方装好后**完全退出并重启 DSH**：

```bash
dsh plugin --profile desktop add dsh-annotate-sync@1.0.0
# 把 dsh-annotate-sync 加入 profile package.json 的 dsh.profile.bundles
```

或者直接分享 tarball：

```bash
npm pack
# 把 dsh-annotate-sync-1.0.0.tgz 发给对方
dsh plugin --profile desktop add /path/to/dsh-annotate-sync-1.0.0.tgz
```

## 4. 安装后的验收清单

- [ ] Settings → Plugins 里出现「页面批注 / Annotations」，图标正常。
- [ ] 右侧栏出现「批注」Tab，`⌘/Ctrl+Shift+B` 能打开。
- [ ] 启动任意 dev server，面板列表 5 秒内出现它。
- [ ] 打开预览，页面右下角出现浮动「点选」按钮。
- [ ] 点选元素 → 写批注 → `annotations.json` 落盘。
- [ ] 刷新预览页，Pin 与批注仍在。
- [ ] 点「发送批注」，对话里出现结构化 Markdown 块。
- [ ] 对模型说「按批注修改」，`read_annotations` 被调用并返回同一批批注。
- [ ] 模型改完后 `set_annotation_status` 能把批注标记为 `applied`。

## 5. 版本与兼容

- 语义化版本：新功能 minor，修 bug patch，破坏协议/数据结构 major。
- 协议改动必须同步更新 `docs/PROTOCOL.md` 与 `CHANGELOG.md`。
- 旧版 `annotations.json`（v0 数组 / v1 `{annotations}`）会继续被读取并迁移到 v2；
  删除迁移逻辑属于 major 变更。
