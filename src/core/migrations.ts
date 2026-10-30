import { DATA_SCHEMA_VERSION } from "./identity";
import { createId } from "../utils/id";
import { MAX_COLUMNS, MAX_ROWS, type HomeDeckSettings, type HomePage, type WidgetInstance } from "./types";

export const DEFAULT_SETTINGS: HomeDeckSettings = {
  version: DATA_SCHEMA_VERSION,
  pages: [],
  activePageId: "",
  openOnStartup: true,
  openInNewTab: true,
  rowHeight: 40,
  gap: 16,
  maxWidth: 1400,
  alwaysShowPageTabs: true
};

export interface SettingsDeps {
  /** 新建默认首页；由 LayoutStore/WidgetRegistry 提供，保证组件默认尺寸一致。 */
  createDefaultPage(name?: string): HomePage;
  /** 未知/缺省尺寸时的组件默认大小。 */
  defaultSize?(kind: string): { w: number; h: number } | undefined;
}

export interface MigrationResult {
  settings: HomeDeckSettings;
  migrated: boolean;
  fromVersion: number;
}

function clampNumber(value: unknown, min: number, max: number): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function sanitizeWidget(raw: unknown, deps: SettingsDeps): WidgetInstance | null {
  if (!isRecord(raw)) return null;
  const kind = typeof raw.kind === "string" ? raw.kind.trim() : "";
  if (!kind) return null;
  const fallback = deps.defaultSize?.(kind);
  const widget: WidgetInstance = {
    id: typeof raw.id === "string" && raw.id ? raw.id : createId(kind),
    kind,
    w: clampNumber(raw.w, 1, MAX_COLUMNS) ?? fallback?.w ?? 6,
    h: clampNumber(raw.h, 1, MAX_ROWS) ?? fallback?.h ?? 6,
    config: isRecord(raw.config) ? raw.config : {}
  };
  if (typeof raw.title === "string" && raw.title.trim()) widget.title = raw.title.trim();
  if (typeof raw.provider === "string" && raw.provider.trim()) widget.provider = raw.provider.trim();
  return widget;
}

export function sanitizePage(raw: unknown, fallbackName: string, deps: SettingsDeps): HomePage | null {
  if (!isRecord(raw)) return null;
  const widgets = Array.isArray(raw.widgets)
    ? raw.widgets.map((widget) => sanitizeWidget(widget, deps)).filter((widget): widget is WidgetInstance => widget !== null)
    : [];
  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : createId("page"),
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : fallbackName,
    widgets
  };
}

/**
 * 清洗并升级设置。对旧版 payload 的兼容都集中在这里，便于测试与回滚。
 * 旧的 `customWidgetsFolder` / `autoAddCustomWidgets` / `seenCustomWidgetKinds`
 * 在 v2 中被故意丢弃：自定义 JS 脚本加载器已移除。
 */
export function sanitizeSettings(raw: unknown, deps: SettingsDeps, source?: string): HomeDeckSettings {
  const value = isRecord(raw) ? raw : {};
  const rawPages = Array.isArray(raw)
    ? raw
    : Array.isArray(value.pages)
      ? value.pages
      : Array.isArray(value.widgets)
        ? [{ name: "首页", widgets: value.widgets }]
        : [];

  const pages = rawPages
    .map((page, index) => sanitizePage(page, `页面 ${index + 1}`, deps))
    .filter((page): page is HomePage => page !== null);
  if (pages.length === 0) pages.push(deps.createDefaultPage());

  const settings: HomeDeckSettings = {
    version: DATA_SCHEMA_VERSION,
    pages,
    activePageId: typeof value.activePageId === "string" ? value.activePageId : "",
    openOnStartup: value.openOnStartup !== false,
    openInNewTab: value.openInNewTab !== false,
    rowHeight: clampNumber(value.rowHeight, 24, 96) ?? DEFAULT_SETTINGS.rowHeight,
    gap: clampNumber(value.gap, 4, 40) ?? DEFAULT_SETTINGS.gap,
    maxWidth: clampNumber(value.maxWidth, 0, 4000) ?? DEFAULT_SETTINGS.maxWidth,
    alwaysShowPageTabs: value.alwaysShowPageTabs !== false
  };
  if (source) settings.migratedFrom = source;
  else if (typeof value.migratedFrom === "string" && value.migratedFrom.trim()) {
    settings.migratedFrom = value.migratedFrom.trim();
  }
  if (!settings.pages.some((page) => page.id === settings.activePageId)) {
    settings.activePageId = settings.pages[0].id;
  }
  return settings;
}

/** 从任意旧 payload 迁移到当前 schema。幂等：v2 数据再跑一次结果不变。 */
export function migrateRawSettings(raw: unknown, deps: SettingsDeps, source?: string): MigrationResult {
  const value = isRecord(raw) ? raw : {};
  const fromVersion = typeof value.version === "number" ? value.version : 0;
  const migrated = fromVersion < DATA_SCHEMA_VERSION;
  return {
    settings: sanitizeSettings(raw, deps, migrated ? source : undefined),
    migrated,
    fromVersion
  };
}
