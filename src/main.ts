import { Notice, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { createApi, type HomeDeckApi } from "./api";
import { createDefaultPage } from "./core/defaults";
import { LEGACY_ID, LEGACY_VIEW_TYPE, READY_EVENT, UPSTREAM_ID, VIEW_TYPE_HOME } from "./core/identity";
import { LayoutStore } from "./core/layoutStore";
import type { HomeDeckHost, WidgetServices } from "./core/ports";
import { SettingsRepository } from "./core/settingsRepository";
import type { HomeDeckSettings, HomePage, WidgetKind } from "./core/types";
import { WidgetRegistry } from "./core/widgetRegistry";
import { VaultIndex } from "./services/vaultIndex";
import { MtimeCache } from "./services/mtimeCache";
import { HomeDeckSettingTab } from "./settings";
import { HomeView } from "./view";
import { BUILTIN_WIDGETS } from "./widgets/builtins";
import { clearMocIndexCache } from "./widgets/allnotes";
import { clearDocCache } from "./widgets/duoweiCore";
import { disposeMediaCache } from "./widgets/media";
import { clearOnThisDayIndex } from "./widgets/onthisday";
import { resumePomodoroTimers } from "./widgets/pomodoro";

type SettingApp = { setting?: { open: () => void; openTabById: (id: string) => void } };
type PluginsApp = { plugins?: { enabledPlugins?: Set<string>; plugins?: Record<string, unknown> } };

export default class HomeDeckPlugin extends Plugin implements HomeDeckHost {
  /** 组件注册表：每个插件实例一份，避免模块级状态污染。 */
  readonly registry = new WidgetRegistry(BUILTIN_WIDGETS);
  repo!: SettingsRepository;
  layout!: LayoutStore;
  vaultIndex!: VaultIndex;
  services!: WidgetServices;
  api!: HomeDeckApi;

  get settings(): HomeDeckSettings {
    return this.repo.settings;
  }

  async onload(): Promise<void> {
    this.repo = new SettingsRepository(
      this.app,
      this.manifest,
      {
        loadData: () => this.loadData(),
        saveData: (data: unknown) => this.saveData(data)
      },
      {
        createDefaultPage: (name) => createDefaultPage(this.registry, name),
        defaultSize: (kind) => this.registry.get(kind)?.defaultSize
      }
    );
    await this.repo.load();
    this.layout = new LayoutStore(this.repo, this.registry);
    this.vaultIndex = new VaultIndex(() => this.app);
    this.services = { vault: this.vaultIndex, mtime: new MtimeCache(() => this.app) };
    this.api = createApi(this);

    this.registerVaultEvents();
    // 番茄时钟：恢复上次仍在运行的计时（首页没打开也会到点提醒）。
    resumePomodoroTimers(this);

    this.registerView(VIEW_TYPE_HOME, (leaf) => new HomeView(leaf, this));
    this.registerLegacyViewAlias();
    this.addRibbonIcon("home", "打开首页", () => void this.openHome());
    this.addCommand({ id: "open-home", name: "打开首页", callback: () => void this.openHome() });
    this.addCommand({
      id: "toggle-edit-layout",
      name: "编辑首页布局",
      checkCallback: (checking) => {
        const view = this.getActiveHomeView();
        if (!view) return false;
        if (!checking) view.toggleEditing();
        return true;
      }
    });
    this.addCommand({
      id: "next-page",
      name: "切换到下一个首页页面",
      checkCallback: (checking) => {
        const view = this.getActiveHomeView();
        if (!view || this.settings.pages.length < 2) return false;
        if (!checking) {
          const pages = this.settings.pages;
          const index = pages.findIndex((page) => page.id === this.settings.activePageId);
          void view.switchPage(pages[(index + 1) % pages.length].id);
        }
        return true;
      }
    });
    this.addCommand({
      id: "add-source-widgets",
      name: "把「待办与日程 / 批注与复习 / 微信收件」加入当前首页",
      callback: () => void this.addSourceWidgets()
    });
    this.addSettingTab(new HomeDeckSettingTab(this.app, this));

    // 通知晚于本插件加载 / 正在监听的插件：可以注册组件了。
    (this.app.workspace as unknown as { trigger(name: string, ...data: unknown[]): void }).trigger(READY_EVENT, this.api);

    this.app.workspace.onLayoutReady(() => {
      void this.onLayoutReady();
    });
  }

  onunload(): void {
    void this.repo?.flush();
    this.vaultIndex?.dispose();
    disposeMediaCache();
    clearMocIndexCache();
    clearDocCache();
    clearOnThisDayIndex();
  }

  // ---- Host 接口 -----------------------------------------------------------

  getActivePage(): HomePage {
    return this.layout.getActivePage();
  }

  getActiveHomeView(): HomeView | null {
    return this.app.workspace.getActiveViewOfType(HomeView);
  }

  saveSettings(): Promise<void> {
    return this.repo.saveSoon();
  }

  openSettings(): void {
    const setting = (this.app as unknown as SettingApp).setting;
    setting?.open();
    setting?.openTabById(this.manifest.id);
  }

  getHomeLeaves(): WorkspaceLeaf[] {
    return this.app.workspace.getLeavesOfType(VIEW_TYPE_HOME);
  }

  async openHome(): Promise<void> {
    const existing = this.getHomeLeaves()[0];
    if (existing) {
      await this.app.workspace.revealLeaf(existing);
      this.app.workspace.setActiveLeaf(existing, { focus: true });
      return;
    }
    const leaf = this.settings.openInNewTab ? this.app.workspace.getLeaf("tab") : this.app.workspace.getLeaf(false);
    await leaf.setViewState({ type: VIEW_TYPE_HOME, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  refreshViews(options: { layoutOnly?: boolean; kind?: string } = {}): void {
    for (const leaf of this.getHomeLeaves()) {
      const view = leaf.view;
      if (!(view instanceof HomeView)) continue;
      if (options.layoutOnly) view.applyLayout();
      else if (options.kind) view.refreshKind(options.kind);
      else view.render();
    }
  }

  // ---- 内部 ----------------------------------------------------------------

  private registerVaultEvents(): void {
    this.registerEvent(this.app.vault.on("create", (file) => {
      this.vaultIndex.applyCreate(file);
    }));
    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (file instanceof TFile) this.vaultIndex.applyModify(file);
    }));
    this.registerEvent(this.app.vault.on("delete", (file) => {
      this.vaultIndex.applyDelete(file);
    }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      this.vaultIndex.applyRename(file, oldPath);
    }));
    this.registerEvent(this.app.metadataCache.on("changed", (file) => {
      this.vaultIndex.applyMetadata(file.path);
    }));
    // `resolve` 在启动索引时会按文件连续触发；只保留一次 `resolved` 通知。
    this.registerEvent(this.app.metadataCache.on("resolved", () => {
      this.vaultIndex.applyMetadata();
    }));
  }

  private registerLegacyViewAlias(): void {
    if (this.isLegacyPluginEnabled()) return;
    this.registerView(LEGACY_VIEW_TYPE, (leaf) => new HomeView(leaf, this, LEGACY_VIEW_TYPE));
  }

  private async onLayoutReady(): Promise<void> {
    this.vaultIndex.reconcile();
    await this.adoptLegacyLeaves();
    if (this.settings.openOnStartup && this.getHomeLeaves().length === 0) void this.openHome();
  }

  private async adoptLegacyLeaves(): Promise<void> {
    let leaves: WorkspaceLeaf[];
    try {
      leaves = this.app.workspace.getLeavesOfType(LEGACY_VIEW_TYPE);
    } catch {
      return;
    }
    if (leaves.length === 0) return;
    if (this.isLegacyPluginEnabled()) {
      new Notice("Home Deck: 检测到旧版 Home Pages 仍在运行；请先禁用旧插件，再重新加载以接管旧首页标签。");
      return;
    }
    const active = this.app.workspace.activeLeaf;
    for (const leaf of leaves) {
      await leaf.setViewState({ type: VIEW_TYPE_HOME, active: leaf === active });
    }
  }

  private isLegacyPluginEnabled(): boolean {
    const plugins = (this.app as unknown as PluginsApp).plugins;
    // 只认真正加载起来的旧插件实例；community-plugins.json 里可能有已卸载的残留 id。
    return Boolean(plugins?.plugins?.[LEGACY_ID] || plugins?.plugins?.[UPSTREAM_ID]);
  }

  /** 老布局升级：把三个数据源组件补到当前页（已存在的跳过）。 */
  async addSourceWidgets(): Promise<void> {
    const page = this.getActivePage();
    const wanted: Array<[WidgetKind, string]> = [["duowei", "待办与日程"], ["annotations", "批注与复习"], ["wechat", "微信收件"]];
    let added = 0;
    for (const [kind, title] of wanted) {
      if (page.widgets.some((widget) => widget.kind === kind)) continue;
      this.layout.addWidget(kind, { w: 6, h: 7, title });
      added += 1;
    }
    await this.saveSettings();
    this.refreshViews();
    new Notice(added > 0 ? `已加入 ${added} 个组件，可在“编辑布局”里调整位置` : "这三个组件已经在当前页上了");
  }
}
