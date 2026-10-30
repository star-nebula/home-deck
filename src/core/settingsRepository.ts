import { normalizePath, type App, type PluginManifest } from "obsidian";
import { DATA_SCHEMA_VERSION, LEGACY_IDS } from "./identity";
import { DEFAULT_SETTINGS, migrateRawSettings, type SettingsDeps } from "./migrations";
import type { HomeDeckSettings } from "./types";

export interface PluginStorage {
  loadData(): Promise<unknown>;
  saveData(data: unknown): Promise<void>;
}

export interface LegacyImportResult {
  imported: boolean;
  source?: string;
  reason?: string;
}

interface LegacyPayload {
  source: string;
  raw: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasUsableData(raw: unknown): boolean {
  if (!isRecord(raw)) return Array.isArray(raw) && raw.length > 0;
  return (
    (Array.isArray(raw.pages) && raw.pages.length > 0) ||
    (Array.isArray(raw.widgets) && raw.widgets.length > 0) ||
    typeof raw.version === "number"
  );
}

/**
 * 设置的唯一持久化入口：加载、迁移、防抖保存、订阅。
 *
 * 迁移只读旧插件目录，绝不覆盖；新数据写入本插件目录的 data.json。
 */
export class SettingsRepository {
  private current: HomeDeckSettings;
  private readonly listeners = new Set<(settings: HomeDeckSettings) => void>();
  private saveTimer: number | null = null;
  private pendingSave: Promise<void> | null = null;
  private resolveSave: (() => void) | null = null;

  constructor(
    private readonly app: App,
    private readonly manifest: PluginManifest,
    private readonly storage: PluginStorage,
    private readonly deps: SettingsDeps
  ) {
    this.current = this.defaults();
  }

  get settings(): HomeDeckSettings {
    return this.current;
  }

  get pluginDir(): string {
    return normalizePath(this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`);
  }

  async load(): Promise<LegacyImportResult> {
    const raw = await this.storage.loadData();
    if (hasUsableData(raw)) {
      this.current = migrateRawSettings(raw, this.deps).settings;
      return { imported: false };
    }

    const legacy = await this.readLegacy();
    if (!legacy) {
      this.current = this.defaults();
      return { imported: false, reason: "no-legacy-data" };
    }
    return this.importLegacyPayload(legacy);
  }

  /** 设置页“从旧版导入”按钮：重新读取并替换当前设置。 */
  async importLegacy(): Promise<LegacyImportResult> {
    const legacy = await this.readLegacy();
    if (!legacy) return { imported: false, reason: "no-legacy-data" };
    return this.importLegacyPayload(legacy);
  }

  update(mutator: (settings: HomeDeckSettings) => void): HomeDeckSettings {
    mutator(this.current);
    for (const listener of [...this.listeners]) listener(this.current);
    return this.current;
  }

  replace(settings: HomeDeckSettings): void {
    this.current = settings;
    for (const listener of [...this.listeners]) listener(this.current);
  }

  subscribe(listener: (settings: HomeDeckSettings) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 合并短时间内的多次保存，避免拖拽/打卡时频繁写盘。 */
  saveSoon(): Promise<void> {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    if (!this.pendingSave) {
      this.pendingSave = new Promise<void>((resolve) => {
        this.resolveSave = resolve;
      });
    }
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      const resolve = this.resolveSave;
      this.pendingSave = null;
      this.resolveSave = null;
      this.saveNow()
        .catch((error) => console.error("Home Deck: failed to save settings", error))
        .finally(() => resolve?.());
    }, 200);
    return this.pendingSave;
  }

  async saveNow(): Promise<void> {
    await this.storage.saveData(this.current);
  }

  async flush(): Promise<void> {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const resolve = this.resolveSave;
    this.pendingSave = null;
    this.resolveSave = null;
    try {
      await this.saveNow();
    } catch (error) {
      console.error("Home Deck: failed to flush settings", error);
    } finally {
      resolve?.();
    }
  }

  private defaults(): HomeDeckSettings {
    const page = this.deps.createDefaultPage();
    return { ...DEFAULT_SETTINGS, pages: [page], activePageId: page.id, version: DATA_SCHEMA_VERSION };
  }

  private async readLegacy(): Promise<LegacyPayload | null> {
    const adapter = this.app.vault.adapter;
    for (const source of LEGACY_IDS) {
      const path = normalizePath(`${this.app.vault.configDir}/plugins/${source}/data.json`);
      try {
        if (!(await adapter.exists(path))) continue;
        const parsed = JSON.parse(await adapter.read(path)) as unknown;
        if (hasUsableData(parsed)) return { source, raw: parsed };
      } catch (error) {
        console.error(`Home Deck: failed to read legacy data of ${source}`, error);
      }
    }
    return null;
  }

  private async importLegacyPayload(legacy: LegacyPayload): Promise<LegacyImportResult> {
    try {
      await this.backupLegacy(legacy.raw);
    } catch (error) {
      console.error("Home Deck: failed to back up legacy data", error);
      this.current = this.defaults();
      return { imported: false, reason: "backup-failed" };
    }
    this.current = migrateRawSettings(legacy.raw, this.deps, legacy.source).settings;
    await this.saveNow();
    for (const listener of [...this.listeners]) listener(this.current);
    return { imported: true, source: legacy.source };
  }

  private async backupLegacy(raw: unknown): Promise<void> {
    const adapter = this.app.vault.adapter;
    const dir = this.pluginDir;
    try {
      await adapter.mkdir(dir);
    } catch {
      // 目录已存在时忽略。
    }
    const backupPath = normalizePath(`${dir}/data.pre-migration.json`);
    await adapter.write(backupPath, JSON.stringify(raw, null, 2));
  }
}
