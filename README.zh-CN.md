# Home Deck · Obsidian 首页看板

Home Deck 是一个快速、可定制的 Obsidian 首页仪表盘：12 列自适应网格、可拖拽缩放的卡片、多页面，以及 19 个内置组件。布局和设置只保存在本地 `data.json`，没有遥测，也没有隐藏的后台上报。

> **项目来源：** Home Deck 是 [jepicaju862-lab/home-pages](https://github.com/jepicaju862-lab/home-pages)（GPL-3.0）的独立分支，由 [star-nebula](https://github.com/star-nebula) 维护。原项目的功劳归原作者所有。插件 id：`home-deck`。
>
> **从 Home Pages 升级：** 安装 Home Deck 并启用一次，布局会自动从 `.obsidian/plugins/home-pages-star-nebula/data.json` 复制过来；旧插件和旧数据保持原样。迁移前会写入备份 `.obsidian/plugins/home-deck/data.pre-migration.json`。

## 功能

| 分类 | 组件 |
| :--- | :--- |
| **首页基础** | 欢迎横幅（时钟 / 天气 / 库统计）、最近笔记、快捷入口、倒计时与纪念日、每日一言、笔记嵌入 |
| **专注与计划** | 番茄时钟、任务看板、习惯打卡、日记聚合、那年今日 |
| **库内洞察** | 全部笔记索引、知识地图、库统计 |
| **可选集成** | 多维表格摘要、批注收件箱、微信收件、聚合信息流、主流媒体 / RSS 阅读 |

亮点：

- **12 列自适应网格**：桌面、平板、手机自动重排。
- **所见即所得布局编辑**：拖动卡片、右下角缩放、复制/删除、页面排序。
- **多首页**（工作 / 生活 / 项目等），标签栏可拖动排序。
- **JSON 导入导出**，方便备份和跨库迁移。
- **按路径刷新**：文件变化时只重绘受影响的可见卡片，隐藏卡片保持空闲，大库也不卡。

## 安装

1. 从最新 Release 下载 `main.js`、`manifest.json`、`styles.css`。
2. 创建 `<vault>/.obsidian/plugins/home-deck/`。
3. 把三个文件复制进去。
4. 在 **设置 → 第三方插件** 中启用 **Home Deck**。

最低 Obsidian 版本：**1.7.2**，支持桌面端和移动端。

## 编辑布局

点击视图标题栏的 **编辑布局**：

- 拖动卡片标题/握把调整顺序；拖动右下角手柄调整尺寸。
- 卡片编辑条支持前移、后移、调宽高、配置、复制、删除。
- 拖动页面标签排序；右键标签可重命名、左右移动或删除。
- 按 `Esc` 取消拖动或缩放。

## 插件开发者 Host API

其他插件可以通过 Host API 注册组件，不需要改 Home Deck 源码：

```ts
const api = app.plugins.plugins["home-deck"]?.api;
// 也可以监听 workspace 事件 "home-deck:ready"。

const unregister = api.registerWidget(myWidgetDefinition, "my-plugin-id");

api.pinWidget("my-widget-kind", { ref: "note-path" }, {
  title: "固定视图",
  w: 6,
  h: 4,
  provider: "my-plugin-id"
});

api.refresh("my-widget-kind");
api.ui.renderKpi(containerEl, { label: "已完成", value: 12 });
api.ui.renderEmpty(containerEl, { message: "暂无数据" });
```

组件定义与 `src/core/ports.ts` 中的 `WidgetDefinition` 一致：`kind`、`name`、`description`、`icon`、`accent`、`defaultSize`、`defaultConfig`、`render`、`renderSettings`，以及可选的刷新策略 / `refreshScope`。

### 自定义组件（统一加载器）

把 `.js` 组件脚本放进设置里的组件目录（默认 `.obsidian/home-pages-widgets`）。脚本会被执行并注册到与内置组件相同的 `WidgetRegistry`，共用渲染、刷新、配置和 Host API。支持隐藏目录；改动由文件事件或 30 秒兜底扫描拾取。

> **安全提示：** 自定义脚本以插件权限执行任意 JavaScript，请只加载可信文件。

## 开发

```bash
npm install
npm run dev        # esbuild watch，并同步产物到 .dev-target
npm run lint
npm run build      # tsc + 生产打包 + 安全检查/身份校验
npm test           # 集成测试 + 迁移/索引测试
npm run test:sorting  # Playwright 布局测试（需要 playwright）
npm run deploy     # 复制产物到 HOME_DECK_DEV_PLUGIN_DIR
```

开发目标目录可用环境变量 `HOME_DECK_DEV_PLUGIN_DIR`，或在仓库根写一行 `.dev-target`（绝对路径）。详见 `docs/development.md`。

源码结构：

```text
src/core/        身份、持久化类型、端口、注册表、设置仓库、布局仓库、迁移
src/services/    增量 VaultIndex、mtime 缓存
src/widgets/     19 个内置组件 + builtins.ts
src/ui/          共享 DOM、弹窗、设置、排序工具
src/view.ts      HomeView + 每张卡片的 WidgetHost
src/main.ts      插件生命周期与服务装配
```

## 隐私

Home Deck 只读取本地库和本地插件数据。天气、媒体/RSS 与可选集成只会在卡片可见或被手动刷新时发起网络请求，不收集使用数据。

## 许可证

[GNU General Public License v3.0](LICENSE)。
