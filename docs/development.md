# 开发与本地部署

本文档描述 Home Deck（`home-deck`）在本机的开发、测试与部署流程。

## 目录

| 用途 | 路径 |
| --- | --- |
| 源码工作区 | `E:\Projects\forks\home-pages` |
| 构建产物 | 仓库根 `main.js`、`manifest.json`、`styles.css` |
| Obsidian 运行目录 | `<vault>/.obsidian/plugins/home-deck` |
| 开发目标配置 | 进程环境变量 `HOME_DECK_DEV_PLUGIN_DIR`，或仓库根一行 `.dev-target` |

`data.json`、`main.js`、`.dev-target` 已被 Git 忽略，不随提交传播。

## 日常开发

```bash
npm install
npm run dev        # esbuild watch；每次重建后同步到开发目标
npm run lint
npm test           # 集成测试 + core 迁移/索引测试
npm run build      # tsc + 生产打包 + verify-bundle
```

验证要求：

- `npm run lint` 无 error（现有 sentence-case / no-base-to-string 警告可保留）。
- `npm run build` 通过，且 `verify-bundle` 确认无 `eval` / `new Function` / `AsyncFunction`、manifest 身份为 Home Deck。
- `npm test` 全部 PASS；缺少外部夹具的 SKIP 需要单独确认，不能当作完整覆盖。
- 布局相关改动额外运行 `npm run test:sorting`（需要本机安装 Playwright；可用 `HOME_DECK_PLAYWRIGHT_MODULE` 指向其包路径）。

## 部署到 vault

`npm run build` 只生成产物，不部署。确认要更新日常库后，显式设置目标再部署：

```powershell
$previousPluginTarget = $env:HOME_DECK_DEV_PLUGIN_DIR
try {
    $env:HOME_DECK_DEV_PLUGIN_DIR = '<vault>\.obsidian\plugins\home-deck'
    npm run deploy
    if ($LASTEXITCODE -ne 0) { throw '插件部署失败，请检查部署输出' }
} finally {
    $env:HOME_DECK_DEV_PLUGIN_DIR = $previousPluginTarget
}
```

部署只复制 `main.js`、`styles.css`、`manifest.json`，保留目标中的 `data.json`。部署后在 Obsidian 中重载插件或重启应用，检查首页、拖拽和缩放。

## 从旧版迁移

首次启用 Home Deck 时会读取旧插件的 `data.json`：

1. 优先 `configDir/plugins/home-pages-star-nebula/data.json`。
2. 其次 `configDir/plugins/home-pages/data.json`。
3. 迁移前写入新插件目录的 `data.pre-migration.json`。
4. 旧文件只读，不会被修改或删除。

设置页 **备份与迁移 → 从旧版导入** 可手动重试。若旧插件仍启用，Home Deck 不会抢占它的视图标签，会提示先禁用旧插件。

## 代码结构

```text
src/core/        identity、types、ports、widgetRegistry、settingsRepository、layoutStore、migrations
src/services/    vaultIndex（增量索引）、mtimeCache
src/widgets/     19 个内置组件 + builtins.ts
src/ui/          dom、modals、settingHelpers、sortable、PathSuggest
src/view.ts      HomeView + WidgetHost（路径/可见性感知刷新）
src/main.ts      生命周期与服务装配
tests/           integrations.test.ts、core.test.ts、sorting-fixture.ts
scripts/         build/deploy/test/verify/audit 脚本
```

## 并行任务

需要并行时从 `main` 建临时分支或 worktree；临时工作区使用独立测试 vault 的 `home-deck` 目录，通过该工作区的 `.dev-target` 或环境变量指定，不要与日常库共用同一个插件 id 目录。
