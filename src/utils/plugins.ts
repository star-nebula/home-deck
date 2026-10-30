import { App, Keymap, TFile, normalizePath } from "obsidian";
import type { MtimeService } from "../core/ports";

type PluginsApp = App & {
  plugins?: {
    enabledPlugins?: Set<string>;
    plugins?: Record<string, unknown>;
  };
  commands?: {
    commands?: Record<string, { id: string; name: string }>;
    executeCommandById?: (id: string) => boolean;
  };
};

/** 任一 id 的第三方插件已启用。 */
export function isAnyPluginEnabled(app: App, ids: string[]): boolean {
  const plugins = (app as PluginsApp).plugins;
  if (!plugins) return false;
  return ids.some((id) => plugins.enabledPlugins?.has(id) || Boolean(plugins.plugins?.[id]));
}

/** 按名称（不区分大小写、子串）查找命令；可限定插件 id 前缀。混淆过的插件命令 id 不稳定，靠名称更可靠。 */
export function findCommandId(app: App, options: { pluginId?: string; nameIncludes: string[] }): string | null {
  const commands = (app as PluginsApp).commands?.commands ?? {};
  const needles = options.nameIncludes.map((name) => name.toLowerCase());
  for (const command of Object.values(commands)) {
    if (options.pluginId && !command.id.startsWith(`${options.pluginId}:`)) continue;
    const name = command.name.toLowerCase();
    if (needles.some((needle) => name.includes(needle))) return command.id;
  }
  return null;
}

export function runCommand(app: App, id: string): boolean {
  return (app as PluginsApp).commands?.executeCommandById?.(id) ?? false;
}

/** 读取某个插件的 data.json（位于 .obsidian 下，vault API 看不见，走 adapter）。 */
export async function readPluginData(
  app: App,
  pluginId: string,
  cache?: MtimeService
): Promise<Record<string, unknown> | null> {
  return readJsonFile<Record<string, unknown>>(app, `${app.vault.configDir}/plugins/${pluginId}/data.json`, cache);
}

export async function readJsonFile<T>(app: App, path: string, cache?: MtimeService): Promise<T | null> {
  const normalized = normalizePath(path);
  if (cache) return cache.readJson<T>(normalized);
  try {
    if (!(await app.vault.adapter.exists(normalized))) return null;
    return JSON.parse(await app.vault.adapter.read(normalized)) as T;
  } catch (error) {
    console.error(`Home Deck: failed to read ${normalized}`, error);
    return null;
  }
}

/** 库内资源（图片）的可显示 URL；隐藏目录下的文件走 adapter。 */
export function resourceUrl(app: App, path: string): string {
  const file = app.vault.getAbstractFileByPath(normalizePath(path));
  if (file instanceof TFile) return app.vault.getResourcePath(file);
  return app.vault.adapter.getResourcePath(normalizePath(path));
}

/** MarkdownRenderer 渲染出来的内部链接在自定义视图里不会自动跳转，这里统一接管。 */
export function bindInternalLinks(wrap: HTMLElement, app: App, sourcePath: string): void {
  wrap.addEventListener("click", (event) => {
    const link = (event.target as HTMLElement).closest<HTMLAnchorElement>("a.internal-link");
    if (!link) return;
    event.preventDefault();
    const href = link.dataset.href ?? link.getAttribute("href") ?? "";
    if (href) void app.workspace.openLinkText(href, sourcePath, Keymap.isModEvent(event));
  });
}
