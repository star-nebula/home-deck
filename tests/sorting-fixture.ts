import { HomeView } from "../src/view";
import { moveBefore } from "../src/ui/sortable";
import { WidgetRegistry } from "../src/core/widgetRegistry";
import { LayoutStore } from "../src/core/layoutStore";
import type { SettingsRepository } from "../src/core/settingsRepository";
import type { HomeDeckHost } from "../src/core/ports";
import { BUILTIN_WIDGETS } from "../src/widgets/builtins";
import type { HomeDeckSettings, HomePage, WidgetInstance } from "../src/core/types";
import type { WorkspaceLeaf } from "obsidian";

// Minimal Obsidian DOM helpers; the view and sorting controller are the real implementations.
function createElement(tag: string, options: DomElementInfo = {}): HTMLElement {
  const element = document.createElement(tag);
  if (options.cls) element.className = Array.isArray(options.cls) ? options.cls.join(" ") : options.cls;
  if (options.text) element.textContent = options.text;
  for (const [key, value] of Object.entries(options.attr ?? {})) element.setAttribute(key, String(value));
  return element;
}
Object.assign(HTMLElement.prototype, {
  createEl(this: HTMLElement, tag: string, options: DomElementInfo) { return this.appendChild(createElement(tag, options)); },
  createDiv(this: HTMLElement, options: DomElementInfo) { return this.appendChild(createElement("div", options)); },
  createSpan(this: HTMLElement, options: DomElementInfo) { return this.appendChild(createElement("span", options)); },
  empty(this: HTMLElement) { this.replaceChildren(); },
  addClass(this: HTMLElement, ...names: string[]) { this.classList.add(...names); },
  removeClass(this: HTMLElement, ...names: string[]) { this.classList.remove(...names); },
  toggleClass(this: HTMLElement, name: string, enabled: boolean) { this.classList.toggle(name, enabled); },
  setText(this: HTMLElement, value: string) { this.textContent = value; }
});
Object.assign(globalThis, { createDiv: (options: DomElementInfo) => createElement("div", options) });

let view: HomeView | undefined;
let saved: string[][] = [];
let pages: HomePage[];
let settings: HomeDeckSettings;
let host: HomeDeckHost;

function createHost(): HomeDeckHost {
  const registry = new WidgetRegistry(BUILTIN_WIDGETS);
  const savedForSession = saved;
  const repo = {
    get settings() { return settings; },
    update(mutator: (value: HomeDeckSettings) => void) { mutator(settings); },
    saveSoon() { return Promise.resolve(); },
    replace(next: HomeDeckSettings) { settings = next; },
    async importLegacy() { return { imported: false }; }
  } as unknown as SettingsRepository;
  const layout = new LayoutStore(repo, registry);
  const app = { vault: { on: () => ({}) }, metadataCache: { on: () => ({}) } };
  return {
    app: app as never,
    manifest: { id: "home-deck", name: "Home Deck", version: "1.0.0", minAppVersion: "1.7.2", author: "star-nebula" },
    get settings() { return settings; },
    registry,
    layout,
    repo,
    services: {
      vault: {
        subscribe: () => () => undefined,
        getStats: () => ({}) as never,
        getMarkdownFiles: () => [],
        getMarkdownByBasename: () => new Map(),
        getMarkdownSorted: () => [],
        getFiles: () => [],
        getAllLoadedFiles: () => [],
        getFilesUnder: () => [],
        generation: 0
      },
      mtime: {
        readJson: async () => null,
        readText: async () => null,
        invalidate: () => undefined
      }
    },
    register: () => undefined,
    customWidgets: {
      loadAll: async () => 0,
      getLoadedWidgets: () => [],
      dispose: () => undefined,
      startPolling: () => undefined,
      handleFileEvent: () => undefined,
      handleRename: () => undefined,
      hasKind: () => false
    } as never,
    saveSettings: async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      savedForSession.push(layout.getActivePage().widgets.map((item) => item.id));
    },
    refreshViews: () => undefined,
    openHome: async () => undefined,
    openSettings: () => undefined,
    getActivePage: () => layout.getActivePage(),
    getActiveHomeView: () => view ?? null
  };
}

async function reset(options: { editing?: boolean; widths?: number[]; count?: number } = {}): Promise<void> {
  await view?.onClose();
  document.body.replaceChildren();
  saved = [];
  const widths = options.widths ?? Array(options.count ?? 4).fill(6) as number[];
  const widgets: WidgetInstance[] = widths.map((w, index) => ({
    id: String.fromCharCode(97 + index), kind: "test-missing-widget", title: `Card ${index + 1}`, w, h: 4, config: { preserved: index }
  }));
  pages = [
    { id: "p1", name: "Page 1", widgets },
    { id: "p2", name: "Page 2", widgets: [{ ...widgets[0], id: "other", config: { other: true } }] },
    { id: "p3", name: "Page 3", widgets: [] }
  ];
  settings = {
    version: 2,
    pages,
    activePageId: "p1",
    rowHeight: 40,
    gap: 16,
    maxWidth: 1400,
    alwaysShowPageTabs: true,
    openOnStartup: false,
    openInNewTab: true,
    customWidgetsFolder: "",
    autoAddCustomWidgets: false,
    seenCustomWidgetKinds: []
  };
  const contentEl = document.body.appendChild(createElement("div"));
  contentEl.style.height = "550px";
  host = createHost();
  view = new HomeView({ app: host.app, contentEl, updateHeader: () => undefined } as unknown as WorkspaceLeaf, host);
  await view.onOpen();
  if (options.editing !== false) view.toggleEditing(true);
}

Object.assign(window, { fixture: {
  reset,
  order: () => pages[0].widgets.map((item) => item.id),
  pageOrder: () => pages.map((page) => page.id),
  saved: () => saved,
  activePage: () => settings.activePageId,
  configs: () => pages[0].widgets.map((item) => item.config),
  sizes: () => pages[0].widgets.map((item) => `${item.w}x${item.h}`).join(" "),
  editing: (enabled: boolean) => view?.toggleEditing(enabled),
  switchPage: (id: string) => view?.switchPage(id),
  close: () => view?.onClose(),
  moveBefore
} });
