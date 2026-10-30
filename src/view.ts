import { ItemView, Menu, WorkspaceLeaf, setIcon } from "obsidian";
import type { HomeDeckHost, WidgetContext } from "./core/ports";
import { VIEW_TYPE_HOME } from "./core/identity";
import { isChangeRelevant } from "./core/changeScope";
import type { HomePage, VaultChange, WidgetInstance } from "./core/types";
import { MAX_COLUMNS, MAX_ROWS } from "./core/types";
import { createId } from "./utils/id";
import { openPath } from "./utils/vault";
import { AddWidgetModal, ConfirmModal, PromptModal, WidgetSettingsModal } from "./ui/modals";
import { renderEmpty } from "./ui/dom";
import { animateLayout, moveBefore, PointerSorter } from "./ui/sortable";

export { VIEW_TYPE_HOME };

const SCROLL_SELECTORS = ["[data-hp-scroll]", ".hp-media-list", ".hp-allnotes-groups"];

const clampSpan = (value: number, max: number): number => Math.min(max, Math.max(1, Math.round(value)));

function captureScroll(root: HTMLElement): Map<string, number> {
  const positions = new Map<string, number>();
  for (const selector of SCROLL_SELECTORS) {
    root.querySelectorAll<HTMLElement>(selector).forEach((element, index) => {
      positions.set(`${selector}#${index}`, element.scrollTop);
    });
  }
  return positions;
}

function restoreScroll(root: HTMLElement, positions: Map<string, number>): void {
  for (const selector of SCROLL_SELECTORS) {
    root.querySelectorAll<HTMLElement>(selector).forEach((element, index) => {
      const value = positions.get(`${selector}#${index}`);
      if (value !== undefined) element.scrollTop = value;
    });
  }
}

/** 一张卡片的渲染宿主：负责组件的生命周期（定时器、清理、异步渲染的失效判断）。 */
class WidgetHost {
  private lifecycleCleanups: Array<() => void> = [];
  private renderCleanups: Array<() => void> = [];
  private token = 0;
  private visible = true;
  private dirty = false;
  private observer: IntersectionObserver | null = null;
  private initialized = false;
  bodyEl: HTMLElement;

  constructor(
    private readonly view: HomeView,
    public widget: WidgetInstance,
    public readonly cardEl: HTMLElement,
    private readonly subtitleEl: HTMLElement,
    private readonly actionsEl: HTMLElement,
    private readonly headerContentEl: HTMLElement
  ) {
    this.bodyEl = cardEl.createDiv({ cls: "hp-card-body" });
  }

  /** 只调用一次：订阅共享索引、观察可见性。 */
  init(): void {
    if (this.initialized) return;
    this.initialized = true;
    const unsubscribe = this.view.host.services.vault.subscribe((change) => this.handleVaultChange(change));
    this.lifecycleCleanups.push(unsubscribe);
    this.observeVisibility();
  }

  async render(): Promise<void> {
    if (!this.visible) {
      this.dirty = true;
      return;
    }
    this.dispose();
    this.dirty = false;
    this.token += 1;
    const token = this.token;
    const body = this.bodyEl;
    const scrollPositions = captureScroll(body);
    body.empty();
    this.subtitleEl.setText("");
    this.actionsEl.empty();
    this.headerContentEl.empty();

    try {
      const definition = this.view.host.registry.get(this.widget.kind);
      if (!definition) {
        const provider = this.widget.provider ?? this.view.host.registry.getProvider(this.widget.kind);
        this.subtitleEl.setText("等待插件");
        renderEmpty(body, {
          icon: "plug",
          text: provider
            ? `此组件由插件「${provider}」提供，启用该插件后会自动显示。`
            : `组件类型「${this.widget.kind}」由第三方插件提供，插件尚未加载；配置已保留。`
        });
        return;
      }

      const view = this.view;
      const config = this.view.host.registry.normalizeConfig<Record<string, unknown>>(this.widget);
      const ctx: WidgetContext<Record<string, unknown>> = {
        app: view.app,
        host: view.host,
        widget: this.widget,
        config,
        services: view.host.services,
        saveConfig: async (patch) => {
          Object.assign(config, patch);
          this.widget.config = { ...this.widget.config, ...patch };
          await view.host.saveSettings();
        },
        rerender: () => void this.render(),
        openPath: (path, options) => openPath(view.app, path, options),
        setSubtitle: (text) => {
          if (token === this.token) this.subtitleEl.setText(text);
        },
        addHeaderContent: (className) => {
          const el = createDiv({ cls: className ?? "hp-card-header-content" });
          this.headerContentEl.appendChild(el);
          return el;
        },
        addHeaderAction: (icon, label, onClick) => {
          const button = this.actionsEl.createEl("button", {
            cls: "hp-card-action clickable-icon",
            attr: { type: "button", "aria-label": label, title: label }
          });
          setIcon(button, icon);
          button.addEventListener("click", (event) => {
            event.stopPropagation();
            onClick(event);
          });
          return button;
        },
        registerInterval: (callback, ms) => {
          const id = window.setInterval(callback, ms);
          this.renderCleanups.push(() => window.clearInterval(id));
        },
        scheduleIdle: (callback, timeoutMs = 800) => {
          const idleWindow = window as Window & {
            requestIdleCallback?: (cb: () => void, options?: { timeout: number }) => number;
            cancelIdleCallback?: (id: number) => void;
          };
          if (idleWindow.requestIdleCallback) {
            const id = idleWindow.requestIdleCallback(() => {
              if (token === this.token && body.isConnected) callback();
            }, { timeout: timeoutMs });
            this.renderCleanups.push(() => idleWindow.cancelIdleCallback?.(id));
            return;
          }
          const id = window.setTimeout(() => {
            if (token === this.token && body.isConnected) callback();
          }, 0);
          this.renderCleanups.push(() => window.clearTimeout(id));
        },
        registerCleanup: (callback) => this.renderCleanups.push(callback),
        getVaultStats: (options) => view.host.services.vault.getStats(options),
        getMarkdownFiles: () => view.host.services.vault.getMarkdownFiles(),
        getMarkdownByBasename: () => view.host.services.vault.getMarkdownByBasename(),
        getMarkdownSorted: (sortBy) => view.host.services.vault.getMarkdownSorted(sortBy),
        getFiles: () => view.host.services.vault.getFiles(),
        getAllLoadedFiles: () => view.host.services.vault.getAllLoadedFiles(),
        onVaultChange: (listener, options) => {
          const unsubscribe = view.host.services.vault.subscribe((change) => {
            if (options?.includeMetadata === false && change.reason === "metadata") return;
            listener(change);
          });
          this.renderCleanups.push(unsubscribe);
          return unsubscribe;
        },
        isAlive: () => token === this.token && body.isConnected,
        isVisible: () => this.visible,
        component: view,
        isEditing: () => view.isEditing()
      };
      await definition.render(body, ctx);
    } catch (error) {
      console.error(`Home Deck: widget "${this.widget.kind}" failed to render`, error);
      if (token === this.token) {
        body.empty();
        body.createDiv({ cls: "hp-empty", text: "组件渲染失败，请检查配置" });
      }
    } finally {
      restoreScroll(body, scrollPositions);
    }
  }

  /** 清理一次渲染产生的定时器、订阅与标题栏内容。 */
  dispose(): void {
    const cleanups = this.renderCleanups;
    this.renderCleanups = [];
    for (const cleanup of cleanups) {
      try {
        cleanup();
      } catch (error) {
        console.error("Home Deck: cleanup failed", error);
      }
    }
  }

  /** 卡片从页面移除时调用：释放长期订阅与观察器。 */
  destroy(): void {
    this.dispose();
    this.observer?.disconnect();
    this.observer = null;
    for (const cleanup of this.lifecycleCleanups) {
      try {
        cleanup();
      } catch (error) {
        console.error("Home Deck: lifecycle cleanup failed", error);
      }
    }
    this.lifecycleCleanups = [];
  }

  private handleVaultChange(change: VaultChange): void {
    const definition = this.view.host.registry.get(this.widget.kind);
    if (!definition || definition.liveRefresh === false) return;
    const allowsReason =
      change.reason === "metadata"
        ? definition.refreshOnMetadataChange !== false
        : change.reason === "files"
          ? definition.refreshOnVaultChange !== false
          : definition.refreshOnMetadataChange !== false || definition.refreshOnVaultChange !== false;
    if (!allowsReason) return;

    if (definition.refreshScope) {
      const config = this.view.host.registry.normalizeConfig(this.widget);
      if (!isChangeRelevant(change, definition.refreshScope(config, this.widget))) return;
    }
    if (!this.visible) {
      this.dirty = true;
      return;
    }
    void this.render();
  }

  private observeVisibility(): void {
    if (typeof IntersectionObserver === "undefined") return;
    this.observer = new IntersectionObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      this.setVisible(entry.isIntersecting);
    }, { rootMargin: "200px 0px" });
    this.observer.observe(this.cardEl);
  }

  private setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    if (visible && this.dirty) {
      this.dirty = false;
      void this.render();
    }
  }
}

export class HomeView extends ItemView {
  private editing = false;
  private hosts = new Map<string, WidgetHost>();
  private rootEl!: HTMLElement;
  private tabsEl!: HTMLElement;
  private toolbarEl!: HTMLElement;
  private gridEl!: HTMLElement;
  private cardSorter?: PointerSorter;
  private tabSorter?: PointerSorter;
  /** 正在拖动缩放时，取消并恢复原尺寸。 */
  private stopResize: (() => void) | null = null;

  constructor(leaf: WorkspaceLeaf, readonly host: HomeDeckHost, private readonly viewType: string = VIEW_TYPE_HOME) {
    super(leaf);
    this.navigation = true;
  }

  getViewType(): string {
    return this.viewType;
  }

  getDisplayText(): string {
    return this.host.getActivePage().name || "首页";
  }

  getIcon(): string {
    return "home";
  }

  isEditing(): boolean {
    return this.editing;
  }

  /** 标签页标题跟随页面名（updateHeader 不在公开类型里）。 */
  private updateHeader(): void {
    (this.leaf as WorkspaceLeaf & { updateHeader?: () => void }).updateHeader?.();
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("hp-view");
    this.rootEl = this.contentEl.createDiv({ cls: "hp-root" });
    this.tabsEl = this.rootEl.createDiv({ cls: "hp-tabs" });
    this.toolbarEl = this.rootEl.createDiv({ cls: "hp-toolbar" });
    this.gridEl = this.rootEl.createDiv({ cls: "hp-grid" });

    this.addAction("refresh-cw", "刷新", () => this.refreshWidgets());
    this.addAction("pencil", "编辑布局", () => this.toggleEditing());
    this.addAction("settings", "插件设置", () => this.host.openSettings());

    const offRegistry = this.host.registry.onChange((kind) => this.refreshKind(kind));
    this.register(offRegistry);

    this.bindSorting();
    this.render();
  }

  async onClose(): Promise<void> {
    this.stopResize?.();
    this.cardSorter?.destroy();
    this.tabSorter?.destroy();
    for (const host of this.hosts.values()) host.destroy();
    this.hosts.clear();
  }

  // ---- 渲染 ----------------------------------------------------------------

  get page(): HomePage {
    return this.host.getActivePage();
  }

  /** 全量重绘：页面标签、工具栏、网格与全部组件。 */
  render(): void {
    this.applyLayout();
    this.renderToolbar();
    this.renderGrid();
  }

  /** 只更新布局相关的样式与标签栏，不重绘组件。 */
  applyLayout(): void {
    const { rowHeight, gap, maxWidth } = this.host.settings;
    this.rootEl.style.setProperty("--hp-row", `${rowHeight}px`);
    this.rootEl.style.setProperty("--hp-gap", `${gap}px`);
    this.rootEl.style.setProperty("--hp-max-width", maxWidth > 0 ? `${maxWidth}px` : "none");
    this.rootEl.toggleClass("is-editing", this.editing);
    this.renderTabs();
    this.updateHeader();
  }

  private renderTabs(): void {
    this.tabSorter?.cancel();
    const { pages, alwaysShowPageTabs } = this.host.settings;
    this.tabsEl.empty();
    const show = alwaysShowPageTabs || pages.length > 1 || this.editing;
    this.tabsEl.toggleClass("is-hidden", !show);
    if (!show) return;
    for (const page of pages) {
      const tab = this.tabsEl.createEl("button", {
        cls: `hp-tab${page.id === this.page.id ? " is-active" : ""}`,
        text: page.name,
        attr: { type: "button", "data-id": page.id, title: this.editing ? "拖动标签调整页面顺序" : page.name }
      });
      tab.addEventListener("click", () => void this.switchPage(page.id));
      tab.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        this.showPageMenu(page, event);
      });
    }
    const add = this.tabsEl.createEl("button", {
      cls: "hp-tab hp-tab-add",
      attr: { type: "button", "aria-label": "新建页面", title: "新建页面" }
    });
    setIcon(add, "plus");
    add.addEventListener("click", () => {
      new PromptModal(this.app, { title: "新建页面", placeholder: "页面名称" }, async (name) => {
        this.host.layout.addPage(name, "empty");
        await this.host.saveSettings();
        this.render();
      }).open();
    });
  }

  private renderToolbar(): void {
    this.toolbarEl.empty();
    this.toolbarEl.toggleClass("is-hidden", !this.editing);
    if (!this.editing) return;
    const hint = this.toolbarEl.createDiv({ cls: "hp-toolbar-hint" });
    setIcon(hint.createSpan({ cls: "hp-toolbar-hint-icon" }), "move");
    hint.createSpan({
      text: "拖动卡片标题或页面标签调整顺序，拖右下角手柄调整尺寸（均支持触屏）；齿轮配置内容。"
    });
    const actions = this.toolbarEl.createDiv({ cls: "hp-toolbar-actions" });
    const add = actions.createEl("button", { cls: "hp-button", attr: { type: "button" } });
    setIcon(add.createSpan({ cls: "hp-button-icon" }), "plus");
    add.createSpan({ text: "添加组件" });
    add.addEventListener("click", () => this.promptAddWidget());

    const done = actions.createEl("button", { cls: "hp-button mod-cta", attr: { type: "button" } });
    setIcon(done.createSpan({ cls: "hp-button-icon" }), "check");
    done.createSpan({ text: "完成" });
    done.addEventListener("click", () => this.toggleEditing(false));
  }

  private renderGrid(): void {
    this.stopResize?.();
    this.cardSorter?.cancel();
    for (const host of this.hosts.values()) host.destroy();
    this.hosts.clear();
    this.gridEl.empty();
    const widgets = this.page.widgets;
    if (widgets.length === 0) {
      const empty = this.gridEl.createDiv({ cls: "hp-grid-empty" });
      setIcon(empty.createDiv({ cls: "hp-grid-empty-icon" }), "layout-dashboard");
      empty.createDiv({ text: "这个页面还没有组件" });
      const button = empty.createEl("button", { cls: "hp-button mod-cta", text: "添加组件", attr: { type: "button" } });
      button.addEventListener("click", () => {
        if (!this.editing) this.toggleEditing(true);
        this.promptAddWidget();
      });
      return;
    }
    for (const widget of widgets) this.createCard(widget);
  }

  private createCard(widget: WidgetInstance, before?: HTMLElement): WidgetHost {
    const definition = this.host.registry.get(widget.kind);
    const card = createDiv({ cls: `hp-card hp-card-${widget.kind}`, attr: { "data-id": widget.id } });
    if (before) this.gridEl.insertBefore(card, before);
    else this.gridEl.appendChild(card);
    card.style.setProperty("--hp-accent", definition?.accent ?? "#64748b");
    this.applyCardSize(card, widget);

    const header = card.createDiv({ cls: "hp-card-header" });
    const titleWrap = header.createDiv({ cls: "hp-card-title" });
    const grip = titleWrap.createSpan({ cls: "hp-card-grip", attr: { "aria-label": "拖动排序", title: "拖动调整组件顺序" } });
    setIcon(grip, "grip-vertical");
    setIcon(titleWrap.createSpan({ cls: "hp-card-icon" }), definition?.icon ?? "plug");
    titleWrap.createSpan({ cls: "hp-card-title-text", text: this.host.registry.displayTitle(widget) });
    const headerContent = header.createDiv({ cls: "hp-card-header-slot" });
    const right = header.createDiv({ cls: "hp-card-header-right" });
    const subtitle = right.createSpan({ cls: "hp-card-subtitle" });
    const actions = right.createSpan({ cls: "hp-card-actions" });
    const gear = right.createEl("button", {
      cls: "hp-card-gear clickable-icon",
      attr: { type: "button", "aria-label": "配置组件" }
    });
    setIcon(gear, "settings");
    gear.addEventListener("click", (event) => {
      event.stopPropagation();
      this.openWidgetSettings(widget.id);
    });

    const host = new WidgetHost(this, widget, card, subtitle, actions, headerContent);
    this.hosts.set(widget.id, host);
    this.renderEditBar(card, widget);
    const handle = card.createDiv({
      cls: "hp-card-resize",
      attr: { role: "button", tabindex: "0", "aria-label": "拖动调整尺寸（方向键逐格调整）", title: "拖动调整宽高" }
    });
    setIcon(handle, "move-diagonal-2");
    this.bindResize(handle, card, widget.id);
    host.init();
    void host.render();
    return host;
  }

  private applyCardSize(card: HTMLElement, widget: WidgetInstance): void {
    const w = Math.min(MAX_COLUMNS, Math.max(1, widget.w));
    const h = Math.min(MAX_ROWS, Math.max(1, widget.h));
    card.setAttribute("data-w", String(w));
    card.setAttribute("data-h", String(h));
    card.style.setProperty("--hp-card-w", String(w));
    card.style.setProperty("--hp-card-h", String(h));
  }

  private renderEditBar(card: HTMLElement, widget: WidgetInstance): void {
    card.querySelector(".hp-card-editbar")?.remove();
    const bar = card.createDiv({ cls: "hp-card-editbar" });
    const button = (icon: string, label: string, onClick: () => void, cls = ""): HTMLButtonElement => {
      const el = bar.createEl("button", {
        cls: `hp-editbtn ${cls}`.trim(),
        attr: { type: "button", "aria-label": label, title: label }
      });
      setIcon(el, icon);
      el.addEventListener("click", (event) => {
        event.stopPropagation();
        onClick();
      });
      return el;
    };
    const group = (): HTMLElement => bar.createDiv({ cls: "hp-editbtn-group" });
    const order = group();
    order.appendChild(button("arrow-left", "前移", () => void this.moveWidget(widget.id, -1)));
    order.appendChild(button("arrow-right", "后移", () => void this.moveWidget(widget.id, 1)));
    const width = group();
    width.createSpan({ cls: "hp-editbtn-label", text: "宽" });
    width.appendChild(button("minus", "减小宽度", () => void this.resizeWidget(widget.id, -1, 0)));
    width.createSpan({ cls: "hp-editbtn-value", text: String(widget.w) });
    width.appendChild(button("plus", "增加宽度", () => void this.resizeWidget(widget.id, 1, 0)));
    const height = group();
    height.createSpan({ cls: "hp-editbtn-label", text: "高" });
    height.appendChild(button("minus", "减小高度", () => void this.resizeWidget(widget.id, 0, -1)));
    height.createSpan({ cls: "hp-editbtn-value", text: String(widget.h) });
    height.appendChild(button("plus", "增加高度", () => void this.resizeWidget(widget.id, 0, 1)));
    const misc = group();
    misc.appendChild(button("settings", "配置", () => this.openWidgetSettings(widget.id)));
    misc.appendChild(button("copy", "复制组件", () => void this.duplicateWidget(widget.id)));
    misc.appendChild(button("trash-2", "删除组件", () => this.removeWidget(widget.id), "hp-danger"));
  }

  // ---- 编辑操作 -------------------------------------------------------------

  toggleEditing(force?: boolean): void {
    const next = force ?? !this.editing;
    if (next === this.editing) return;
    this.stopResize?.();
    this.cardSorter?.cancel();
    this.tabSorter?.cancel();
    this.editing = next;
    this.rootEl.toggleClass("is-editing", this.editing);
    this.renderTabs();
    this.renderToolbar();
    if (this.page.widgets.length === 0) this.renderGrid();
  }

  promptAddWidget(): void {
    new AddWidgetModal(this.app, this.host, (kind) => this.insertWidget(kind), new Set(this.page.widgets.map((widget) => widget.kind))).open();
  }

  private insertWidget(kind: string): void {
    const page = this.page;
    const widget = this.host.layout.addWidget(kind);
    void this.host.saveSettings().then(() => {
      if (page.widgets.length === 1) this.renderGrid();
      else this.createCard(widget);
      this.updateHeader();
      this.openWidgetSettings(widget.id);
    });
  }

  openWidgetSettings(id: string): void {
    const widget = this.page.widgets.find((item) => item.id === id);
    if (!widget) return;
    new WidgetSettingsModal(this.app, this.host, widget, async (updated) => {
      const page = this.page;
      const index = page.widgets.findIndex((item) => item.id === id);
      if (index < 0) return;
      page.widgets[index] = updated;
      await this.host.saveSettings();
      this.replaceCard(updated);
    }).open();
  }

  /** 用新的实例数据重绘单张卡片（尺寸、标题、内容）。 */
  private replaceCard(widget: WidgetInstance): void {
    const host = this.hosts.get(widget.id);
    if (!host) {
      this.createCard(widget);
      return;
    }
    host.widget = widget;
    this.applyCardSize(host.cardEl, widget);
    host.cardEl.querySelector(".hp-card-title-text")?.setText(this.host.registry.displayTitle(widget));
    this.renderEditBar(host.cardEl, widget);
    void host.render();
  }

  private async resizeWidget(id: string, dw: number, dh: number): Promise<void> {
    const widget = this.page.widgets.find((item) => item.id === id);
    if (!widget) return;
    await this.setWidgetSize(id, widget.w + dw, widget.h + dh);
  }

  private async setWidgetSize(id: string, w: number, h: number): Promise<void> {
    const widget = this.host.layout.resizeWidget(id, w, h);
    if (!widget) return;
    const host = this.hosts.get(id);
    if (host) {
      this.animateCards(() => this.applyCardSize(host.cardEl, widget));
      this.renderEditBar(host.cardEl, widget);
    }
    await this.host.saveSettings();
  }

  private async moveWidget(id: string, delta: number): Promise<void> {
    if (!this.host.layout.moveWidget(id, delta)) return;
    this.animateCards(() => this.reorderCards());
    await this.host.saveSettings();
  }

  private async reorderWidget(id: string, beforeId: string | null): Promise<void> {
    if (!this.host.layout.moveWidgetBefore(id, beforeId)) return;
    this.reorderCards();
    await this.host.saveSettings();
  }

  /** 改布局时让其它卡片从原位置平滑滑到新位置（系统要求减少动态效果时直接跳变）。 */
  private animateCards(mutate: () => void): void {
    animateLayout(this.gridEl, ".hp-card", mutate);
  }

  /** 按 widgets 数组顺序重新排列已存在的卡片 DOM，不重绘内容。 */
  private reorderCards(): void {
    for (const widget of this.page.widgets) {
      const host = this.hosts.get(widget.id);
      if (host) this.gridEl.appendChild(host.cardEl);
    }
  }

  private async duplicateWidget(id: string): Promise<void> {
    const copy = this.host.layout.duplicateWidget(id);
    if (!copy) return;
    await this.host.saveSettings();
    const widgets = this.page.widgets;
    const index = widgets.findIndex((widget) => widget.id === copy.id);
    const next = widgets[index + 1];
    this.createCard(copy, next ? this.hosts.get(next.id)?.cardEl : undefined);
  }

  private removeWidget(id: string): void {
    const widget = this.page.widgets.find((item) => item.id === id);
    if (!widget) return;
    new ConfirmModal(
      this.app,
      { title: "删除组件", message: `确定删除“${this.host.registry.displayTitle(widget)}”？`, confirmText: "删除", danger: true },
      async () => {
        this.host.layout.removeWidget(id);
        await this.host.saveSettings();
        const host = this.hosts.get(id);
        host?.destroy();
        host?.cardEl.remove();
        this.hosts.delete(id);
        if (this.page.widgets.length === 0) this.renderGrid();
      }
    ).open();
  }

  // ---- 页面 ----------------------------------------------------------------

  async switchPage(id: string): Promise<void> {
    if (!this.host.layout.setActivePage(id)) return;
    this.stopResize?.();
    this.cardSorter?.cancel();
    this.tabSorter?.cancel();
    await this.host.saveSettings();
    this.render();
  }

  private showPageMenu(page: HomePage, event: MouseEvent): void {
    const menu = new Menu();
    menu.addItem((item) => item.setTitle("重命名").setIcon("pencil").onClick(() => {
      new PromptModal(this.app, { title: "重命名页面", value: page.name }, async (name) => {
        this.host.layout.renamePage(page.id, name);
        await this.host.saveSettings();
        this.applyLayout();
      }).open();
    }));
    menu.addItem((item) => item.setTitle("向左移动").setIcon("arrow-left").onClick(() => void this.movePage(page.id, -1)));
    menu.addItem((item) => item.setTitle("向右移动").setIcon("arrow-right").onClick(() => void this.movePage(page.id, 1)));
    menu.addSeparator();
    menu.addItem((item) => item.setTitle("删除页面").setIcon("trash-2").setDisabled(this.host.settings.pages.length <= 1).onClick(() => {
      new ConfirmModal(
        this.app,
        { title: "删除页面", message: `确定删除页面“${page.name}”及其 ${page.widgets.length} 个组件？`, confirmText: "删除", danger: true },
        async () => {
          this.host.layout.removePage(page.id);
          await this.host.saveSettings();
          this.render();
        }
      ).open();
    }));
    menu.showAtMouseEvent(event);
  }

  private async movePage(id: string, delta: number): Promise<void> {
    if (!this.host.layout.movePage(id, delta)) return;
    this.renderTabs();
    await this.host.saveSettings();
  }

  private async reorderPage(id: string, beforeId: string | null): Promise<void> {
    if (!this.host.layout.movePageBefore(id, beforeId)) return;
    this.renderTabs();
    await this.host.saveSettings();
  }

  // ---- 刷新 ----------------------------------------------------------------

  /** 只重绘某一类组件（含标题栏图标 / 名称）。 */
  refreshKind(kind: string): void {
    for (const host of this.hosts.values()) {
      if (host.widget.kind !== kind) continue;
      const definition = this.host.registry.get(kind);
      const icon = host.cardEl.querySelector(".hp-card-icon");
      if (icon instanceof HTMLElement) {
        icon.empty();
        setIcon(icon, definition?.icon ?? "plug");
      }
      host.cardEl.style.setProperty("--hp-accent", definition?.accent ?? "#64748b");
      host.cardEl.querySelector(".hp-card-title-text")?.setText(this.host.registry.displayTitle(host.widget));
      void host.render();
    }
  }

  /** 显式刷新（工具栏按钮 / API）：重绘所有组件内容，不动布局。 */
  refreshWidgets(): void {
    for (const host of this.hosts.values()) void host.render();
  }

  // ---- 拖拽缩放 -------------------------------------------------------------

  /**
   * 右下角手柄：按住拖动，宽度按列、高度按行吸附，松手保存；Esc 或指针中断则恢复原尺寸。
   * 窄屏时网格不是 12 列、卡片总是占满一行，只允许调高度。键盘聚焦手柄后可用方向键逐格调整。
   */
  private bindResize(handle: HTMLElement, card: HTMLElement, id: string): void {
    handle.addEventListener("keydown", (event) => {
      if (!this.editing) return;
      const widget = this.page.widgets.find((item) => item.id === id);
      const delta: Record<string, [number, number]> = {
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
        ArrowUp: [0, -1],
        ArrowDown: [0, 1]
      };
      const step = delta[event.key];
      if (!widget || !step) return;
      event.preventDefault();
      void this.setWidgetSize(id, widget.w + step[0], widget.h + step[1]);
    });
    handle.addEventListener("pointerdown", (event) => {
      if (!this.editing || event.button !== 0 || !event.isPrimary || this.stopResize) return;
      const widget = this.page.widgets.find((item) => item.id === id);
      if (!widget) return;
      event.preventDefault();
      event.stopPropagation();
      this.cardSorter?.cancel();

      const grid = getComputedStyle(this.gridEl);
      const tracks = grid.gridTemplateColumns.split(" ").filter(Boolean);
      const colUnit = (parseFloat(tracks[0]) || 0) + (parseFloat(grid.columnGap) || 0);
      const rowUnit = (parseFloat(grid.gridAutoRows) || this.host.settings.rowHeight) + (parseFloat(grid.rowGap) || 0);
      const lockWidth = tracks.length !== MAX_COLUMNS || colUnit <= 0;
      const start = { x: event.clientX, y: event.clientY, w: widget.w, h: widget.h };
      let size = { w: widget.w, h: widget.h };

      const badge = card.createDiv({ cls: "hp-card-size-badge" });
      // 虚线框逐像素跟着指针，卡片本身按列 / 行吸附，其它卡片平滑让位。
      const startRect = card.getBoundingClientRect();
      const frame = this.rootEl.createDiv({ cls: "hp-resize-frame" });
      const minWidth = lockWidth ? startRect.width : Math.max(24, colUnit - (parseFloat(grid.columnGap) || 0));
      const minHeight = Math.max(24, rowUnit - (parseFloat(grid.rowGap) || 0));
      const moveFrame = (x: number, y: number): void => {
        const root = this.rootEl.getBoundingClientRect();
        frame.style.transform = `translate3d(${startRect.left - root.left}px, ${startRect.top - root.top}px, 0)`;
        frame.style.width = `${Math.max(minWidth, lockWidth ? startRect.width : startRect.width + x - start.x)}px`;
        frame.style.height = `${Math.max(minHeight, startRect.height + y - start.y)}px`;
      };
      const paint = (): void => {
        badge.setText(lockWidth ? `高 ${size.h} 行` : `${size.w} 列 × ${size.h} 行`);
        this.animateCards(() => this.applyCardSize(card, { ...widget, ...size }));
      };
      card.addClass("is-resizing");
      this.rootEl.addClass("is-resizing");
      handle.setPointerCapture(event.pointerId);
      moveFrame(start.x, start.y);
      badge.setText(lockWidth ? `高 ${size.h} 行` : `${size.w} 列 × ${size.h} 行`);

      const onMove = (move: PointerEvent): void => {
        if (move.pointerId !== event.pointerId) return;
        move.preventDefault();
        moveFrame(move.clientX, move.clientY);
        const w = lockWidth ? start.w : clampSpan(start.w + Math.round((move.clientX - start.x) / colUnit), MAX_COLUMNS);
        const h = clampSpan(start.h + Math.round((move.clientY - start.y) / rowUnit), MAX_ROWS);
        if (w === size.w && h === size.h) return;
        size = { w, h };
        paint();
      };
      const finish = (commit: boolean): void => {
        this.stopResize = null;
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        handle.removeEventListener("pointercancel", onCancel);
        handle.removeEventListener("lostpointercapture", onCancel);
        handle.ownerDocument.removeEventListener("keydown", onKey, true);
        if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
        badge.remove();
        frame.remove();
        card.removeClass("is-resizing");
        this.rootEl.removeClass("is-resizing");
        if (commit && (size.w !== start.w || size.h !== start.h)) void this.setWidgetSize(id, size.w, size.h);
        else this.animateCards(() => this.applyCardSize(card, widget));
      };
      const onUp = (up: PointerEvent): void => {
        if (up.pointerId === event.pointerId) finish(true);
      };
      const onCancel = (cancel: PointerEvent): void => {
        if (cancel.pointerId === event.pointerId) finish(false);
      };
      const onKey = (key: KeyboardEvent): void => {
        if (key.key !== "Escape") return;
        key.preventDefault();
        key.stopPropagation();
        finish(false);
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
      handle.addEventListener("pointercancel", onCancel);
      handle.addEventListener("lostpointercapture", onCancel);
      handle.ownerDocument.addEventListener("keydown", onKey, true);
      this.stopResize = () => finish(false);
    });
  }

  // ---- 拖拽排序 -------------------------------------------------------------

  private bindSorting(): void {
    this.cardSorter = new PointerSorter(this.gridEl, {
      itemSelector: ".hp-card",
      canStart: (event, card) => {
        if (!this.editing) return false;
        const target = event.target as Element;
        if (target.closest("button, input, textarea, select, a, [contenteditable], .hp-card-editbar, .hp-card-resize")) return false;
        // Touch scrolling remains available in the body; the title/grip starts a drag.
        return event.pointerType === "mouse" || target.closest(".hp-card-header")?.closest(".hp-card") === card;
      },
      onReorder: (id, beforeId) => void this.reorderWidget(id, beforeId),
      scrollContainer: this.contentEl
    });
    this.tabSorter = new PointerSorter(this.tabsEl, {
      itemSelector: ".hp-tab[data-id]",
      canStart: () => this.editing,
      onReorder: (id, beforeId) => void this.reorderPage(id, beforeId),
      scrollContainer: this.contentEl
    });
  }
}
