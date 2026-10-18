# 开发与本地部署

本机只保留一个常驻源码工作区，开发、测试、集成和构建都在此完成。需要并行处理任务时才创建临时 worktree。

## 本机分工

| 用途 | 目录 | 分支与部署 |
| --- | --- | --- |
| 开发、测试、集成与构建 | `E:\Projects\Github\_frameworks\home-pages` | 从最新本地 `main` 建任务分支；完成后在同一目录合入 `main`；`.dev-target` 留空 |
| 临时并行任务 | 主工作区下的 `.worktrees/<任务名>` | 按需创建，用完移除；已被 Git 忽略 |
| Obsidian 实际运行目录 | `E:\knowledge\vault\.obsidian\plugins\home-pages` | 接收构建产物，保存真实 `data.json` |

常驻工作区承担全部源码操作，不再设置专用集成工作区。后续任务按用途从 `main` 新建分支，避免继续复用已合并的任务分支。

## 日常开发

在日常开发目录修改代码，然后运行：

```powershell
npm run lint
npm test
npm run build
```

验证：类型检查、构建与 bundle 检查通过；测试中缺外部夹具的 SKIP 须单独确认，不能当作完整覆盖。

`npm run build` 只在当前目录生成 `main.js`，不会部署。`npm run dev` 监听构建并尝试部署；本目录 `.dev-target` 留空时会提示跳过部署。环境变量 `HOME_PAGES_DEV_PLUGIN_DIR` 优先于文件配置，启动前须确认它没有指向日常库。

## 集成后部署

任务验证通过并提交后，在同一工作区切回 `main`，合入任务分支。确认没有未完成改动，再执行生产构建：

```powershell
Set-Location 'E:\Projects\Github\_frameworks\home-pages'
git status --short
git branch --show-current
Get-Content .dev-target
Get-Item Env:HOME_PAGES_DEV_PLUGIN_DIR -ErrorAction SilentlyContinue
npm run lint
npm test
npm run build
```

验证：工作区干净、分支为 `main`，类型检查、测试和生产构建通过；测试跳过项单独记录。如已在完全相同的源码树上验证过，可复用检查结果。

确认要更新日常库后，通过临时环境变量显式部署，并恢复此前的进程环境：

```powershell
$previousPluginTarget = $env:HOME_PAGES_DEV_PLUGIN_DIR
try {
    $env:HOME_PAGES_DEV_PLUGIN_DIR = 'E:\knowledge\vault\.obsidian\plugins\home-pages'
    npm run deploy
    if ($LASTEXITCODE -ne 0) { throw '插件部署失败，请检查部署输出' }
} finally {
    $env:HOME_PAGES_DEV_PLUGIN_DIR = $previousPluginTarget
}
```

验证：部署输出目标路径正确，随后在 Obsidian 重载插件或应用并检查主页和布局。

默认使用显式 `build` + `deploy`。`npm run dev` 会尝试向配置目标同步，连续调试优先使用独立测试 vault，并且只启动一个监听进程，结束后停止。部署复制 `main.js`、`styles.css`、`manifest.json`，保留目标中的 `data.json`；仓库根的旧 `data.json` 不作为当前布局来源。

## 并行开发

仅在需要并行任务时，从常驻工作区创建临时 worktree：

```powershell
git worktree add .worktrees/feature-example -b feature/example main
git worktree list
```

验证：新增目录检出独立任务分支；新工作区需要自己的依赖和本机配置。

其他任务工作区不配置日常库目标。需要验证未合并功能时，使用独立测试 vault 中的插件目录，通过该工作区的 `.dev-target` 或进程环境变量指定；不要在同一 vault 再建一个相同插件 id 的目录。

验证：测试目标与日常库不同，测试 vault 中只启用一份该插件。`.dev-target` 为本机配置，已被 Git 忽略，不随分支或提交传播。

任务提交并合并、停止监听且确认没有需要保留的未跟踪或被忽略文件后，从常驻工作区移除临时目录：

```powershell
git worktree remove .worktrees/feature-example
git worktree list
```

验证：临时目录及 worktree 登记均已移除。若工作区由某个工具管理，还需通过该工具清理登记。
