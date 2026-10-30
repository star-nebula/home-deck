import { MAX_COLUMNS, MAX_ROWS, type HomePage, type WidgetInstance } from "./types";
import { createId } from "../utils/id";
import { createDefaultPage } from "./defaults";
import type { SettingsRepository } from "./settingsRepository";
import type { WidgetRegistry } from "./widgetRegistry";

function clampSpan(value: number, max: number): number {
  return Math.min(max, Math.max(1, Math.round(Number.isFinite(value) ? value : 1)));
}

function moveBefore<T extends { id: string }>(items: T[], id: string, beforeId: string | null): boolean {
  const from = items.findIndex((item) => item.id === id);
  if (from < 0) return false;
  const [item] = items.splice(from, 1);
  const to = beforeId ? items.findIndex((entry) => entry.id === beforeId) : items.length;
  items.splice(to < 0 ? items.length : to, 0, item);
  return true;
}

/**
 * 页面与组件的唯一写入口。视图、设置页、API 都不再直接改 plugin.settings.pages。
 */
export class LayoutStore {
  constructor(
    private readonly repo: SettingsRepository,
    private readonly registry: WidgetRegistry
  ) {}

  get settings() {
    return this.repo.settings;
  }

  getActivePage(): HomePage {
    const settings = this.repo.settings;
    const page = settings.pages.find((item) => item.id === settings.activePageId);
    if (page) return page;
    if (settings.pages.length === 0) {
      const created = createDefaultPage(this.registry);
      settings.pages.push(created);
      settings.activePageId = created.id;
      return created;
    }
    settings.activePageId = settings.pages[0].id;
    return settings.pages[0];
  }

  createPage(name: string, template: "empty" | "default" = "empty"): HomePage {
    return template === "default"
      ? createDefaultPage(this.registry, name)
      : { id: createId("page"), name, widgets: [] };
  }

  addPage(name: string, template: "empty" | "default" = "empty"): HomePage {
    const page = this.createPage(name, template);
    this.repo.update((settings) => {
      settings.pages.push(page);
      settings.activePageId = page.id;
    });
    void this.repo.saveSoon();
    return page;
  }

  removePage(id: string): boolean {
    let removed = false;
    this.repo.update((settings) => {
      const next = settings.pages.filter((page) => page.id !== id);
      if (next.length === settings.pages.length) return;
      removed = true;
      if (next.length === 0) next.push(createDefaultPage(this.registry));
      settings.pages = next;
      if (!settings.pages.some((page) => page.id === settings.activePageId)) {
        settings.activePageId = settings.pages[0].id;
      }
    });
    if (removed) void this.repo.saveSoon();
    return removed;
  }

  renamePage(id: string, name: string): boolean {
    const page = this.repo.settings.pages.find((item) => item.id === id);
    if (!page || !name.trim()) return false;
    page.name = name.trim();
    void this.repo.saveSoon();
    return true;
  }

  setActivePage(id: string): boolean {
    if (!this.repo.settings.pages.some((page) => page.id === id)) return false;
    this.repo.settings.activePageId = id;
    void this.repo.saveSoon();
    return true;
  }

  movePage(id: string, delta: number): boolean {
    const pages = this.repo.settings.pages;
    const index = pages.findIndex((page) => page.id === id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= pages.length) return false;
    [pages[index], pages[target]] = [pages[target], pages[index]];
    void this.repo.saveSoon();
    return true;
  }

  movePageBefore(id: string, beforeId: string | null): boolean {
    if (!moveBefore(this.repo.settings.pages, id, beforeId)) return false;
    void this.repo.saveSoon();
    return true;
  }

  duplicatePage(id: string): HomePage | null {
    const source = this.repo.settings.pages.find((page) => page.id === id);
    if (!source) return null;
    const copy: HomePage = {
      id: createId("page"),
      name: `${source.name} 副本`,
      widgets: source.widgets.map((widget) => ({
        ...widget,
        id: createId(widget.kind),
        config: JSON.parse(JSON.stringify(widget.config)) as Record<string, unknown>
      }))
    };
    this.repo.settings.pages.push(copy);
    void this.repo.saveSoon();
    return copy;
  }

  addWidget(kind: string, overrides: Partial<WidgetInstance> = {}): WidgetInstance {
    const widget = this.registry.createInstance(kind, overrides);
    this.getActivePage().widgets.push(widget);
    void this.repo.saveSoon();
    return widget;
  }

  updateWidget(id: string, patch: Partial<WidgetInstance>): WidgetInstance | null {
    const widget = this.findWidget(id);
    if (!widget) return null;
    Object.assign(widget, patch);
    void this.repo.saveSoon();
    return widget;
  }

  duplicateWidget(id: string): WidgetInstance | null {
    const page = this.getActivePage();
    const index = page.widgets.findIndex((widget) => widget.id === id);
    if (index < 0) return null;
    const source = page.widgets[index];
    const copy: WidgetInstance = {
      ...source,
      id: createId(source.kind),
      config: JSON.parse(JSON.stringify(source.config)) as Record<string, unknown>
    };
    page.widgets.splice(index + 1, 0, copy);
    void this.repo.saveSoon();
    return copy;
  }

  removeWidget(id: string): boolean {
    const page = this.getActivePage();
    const next = page.widgets.filter((widget) => widget.id !== id);
    if (next.length === page.widgets.length) return false;
    page.widgets = next;
    void this.repo.saveSoon();
    return true;
  }

  moveWidget(id: string, delta: number): boolean {
    const widgets = this.getActivePage().widgets;
    const index = widgets.findIndex((widget) => widget.id === id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= widgets.length) return false;
    [widgets[index], widgets[target]] = [widgets[target], widgets[index]];
    void this.repo.saveSoon();
    return true;
  }

  moveWidgetBefore(id: string, beforeId: string | null): boolean {
    if (!moveBefore(this.getActivePage().widgets, id, beforeId)) return false;
    void this.repo.saveSoon();
    return true;
  }

  resizeWidget(id: string, w: number, h: number): WidgetInstance | null {
    const widget = this.findWidget(id);
    if (!widget) return null;
    widget.w = clampSpan(w, MAX_COLUMNS);
    widget.h = clampSpan(h, MAX_ROWS);
    void this.repo.saveSoon();
    return widget;
  }

  findWidget(id: string): WidgetInstance | null {
    return this.getActivePage().widgets.find((widget) => widget.id === id) ?? null;
  }

  resetToDefault(): void {
    const page = createDefaultPage(this.registry);
    this.repo.replace({ ...this.repo.settings, pages: [page], activePageId: page.id });
    void this.repo.saveSoon();
  }
}
