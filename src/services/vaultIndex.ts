import type { App, TAbstractFile, TFile } from "obsidian";
import type {
  VaultChange,
  VaultChangeOperation,
  VaultChangeReason,
  VaultMarkdownSort,
  VaultStatsOptions,
  VaultStatsSnapshot
} from "../core/types";
import type { VaultDataService } from "../core/ports";
import { toIsoDate } from "../utils/date";
import { isHiddenPath, isPathUnder, normalizeFolder, normalizeFolders } from "../utils/paths";

interface CachedStats {
  dayKey: string;
  value: VaultStatsSnapshot;
}

export interface VaultIndexOptions {
  now?: () => number;
  notifyDebounceMs?: number;
  notifyMaxWaitMs?: number;
}

const DEFAULT_NOTIFY_DEBOUNCE_MS = 400;
const DEFAULT_NOTIFY_MAX_WAIT_MS = 3_000;

function localDayKey(time: number): string {
  return toIsoDate(new Date(time));
}

/**
 * 增量 vault 索引。
 *
 * 旧实现每次文件事件都清空 base、统计与排序缓存，下一次读取时全量重建。
 * 这里改为：
 * - 文件地图增量增删改，结构性变化才重建派生数组；
 * - modify 只更新 stat 并标记 dirty，不重建文件列表；
 * - 统计按天/排除项缓存，只有真正读取时才计算；
 * - 通知仍然合并，导入风暴只触发一次刷新。
 */
export class VaultIndex implements VaultDataService {
  private readonly filesByPath = new Map<string, TFile>();
  private readonly markdownByPath = new Map<string, TFile>();
  private loadedFiles: TAbstractFile[] = [];
  private filesList: TFile[] | null = null;
  private markdownList: TFile[] | null = null;
  private basenameMap: Map<string, TFile> | null = null;
  private readonly sortedCache = new Map<VaultMarkdownSort, TFile[]>();
  private readonly statsCache = new Map<string, CachedStats>();
  private readonly listeners = new Set<(change: VaultChange) => void>();

  private initialized = false;
  private loadedDirty = true;
  private statsDirty = true;
  private tagsDirty = true;
  private dayKey = "";
  private folderCount = 0;
  private tagCount = 0;
  private earliestMs: number | null | undefined;
  private generationCounter = 0;

  private pendingReason: VaultChange["reason"] | null = null;
  private readonly pendingPaths = new Set<string>();
  private readonly pendingOperations = new Set<VaultChangeOperation>();
  private pendingSince = 0;
  private notifyTimer: number | null = null;

  private readonly now: () => number;
  private readonly notifyDebounceMs: number;
  private readonly notifyMaxWaitMs: number;

  constructor(private readonly app: () => App, options: VaultIndexOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.notifyDebounceMs = options.notifyDebounceMs ?? DEFAULT_NOTIFY_DEBOUNCE_MS;
    this.notifyMaxWaitMs = options.notifyMaxWaitMs ?? DEFAULT_NOTIFY_MAX_WAIT_MS;
  }

  get generation(): number {
    return this.generationCounter;
  }

  getStats(options: VaultStatsOptions = {}): VaultStatsSnapshot {
    this.ensureInitialized();
    const excludes = normalizeFolders(options.excludeFolders);
    const key = `${options.excludeHidden === true ? "h" : "v"}|${excludes.join("\u0000")}`;
    const cached = this.statsCache.get(key);
    if (cached?.dayKey === this.dayKey && !this.statsDirty) return cached.value;

    let noteCount = 0;
    let fileCount = 0;
    let totalMarkdownBytes = 0;
    let todayNotes = 0;
    let weekNotes = 0;
    const activity = new Map<string, number>();
    const today = new Date(this.now());
    today.setHours(0, 0, 0, 0);
    const todayStart = today.getTime();
    const weekStart = this.now() - 7 * 86_400_000;

    for (const file of this.filesByPath.values()) {
      if (options.excludeHidden === true && isHiddenPath(file.path)) continue;
      if (excludes.some((folder) => isPathUnder(file.path, folder))) continue;
      fileCount += 1;
      if (file.extension.toLowerCase() !== "md") continue;
      noteCount += 1;
      totalMarkdownBytes += file.stat.size;
      if (file.stat.ctime >= todayStart) todayNotes += 1;
      if (file.stat.mtime >= weekStart) weekNotes += 1;
      const modifiedDay = localDayKey(file.stat.mtime);
      activity.set(modifiedDay, (activity.get(modifiedDay) ?? 0) + 1);
    }

    const value: VaultStatsSnapshot = Object.freeze({
      noteCount,
      fileCount,
      attachmentCount: Math.max(0, fileCount - noteCount),
      folderCount: this.ensureFolderCount(),
      wordEstimate: Math.round(totalMarkdownBytes / 3),
      tagCount: this.ensureTagCount(),
      earliestDay: this.ensureEarliestDay(),
      todayNotes,
      weekNotes,
      activityByDay: Object.freeze(Object.fromEntries(activity)) as Readonly<Record<string, number>>,
      generatedAt: this.now(),
      generation: this.generationCounter
    });
    this.statsCache.set(key, { dayKey: this.dayKey, value });
    this.statsDirty = false;
    return value;
  }

  getFiles(): readonly TFile[] {
    this.ensureInitialized();
    if (!this.filesList) this.filesList = [...this.filesByPath.values()];
    return this.filesList;
  }

  getMarkdownFiles(): readonly TFile[] {
    this.ensureInitialized();
    if (!this.markdownList) this.markdownList = [...this.markdownByPath.values()];
    return this.markdownList;
  }

  getAllLoadedFiles(): readonly TAbstractFile[] {
    this.ensureInitialized();
    this.ensureLoaded();
    return this.loadedFiles;
  }

  getMarkdownByBasename(): ReadonlyMap<string, TFile> {
    this.ensureInitialized();
    if (!this.basenameMap) {
      this.basenameMap = new Map();
      for (const file of this.markdownByPath.values()) {
        if (!this.basenameMap.has(file.basename)) this.basenameMap.set(file.basename, file);
      }
    }
    return this.basenameMap;
  }

  getMarkdownSorted(sortBy: VaultMarkdownSort): readonly TFile[] {
    this.ensureInitialized();
    const cached = this.sortedCache.get(sortBy);
    if (cached) return cached;
    const sorted = [...this.getMarkdownFiles()].sort((a, b) =>
      sortBy === "ctime" ? b.stat.ctime - a.stat.ctime : b.stat.mtime - a.stat.mtime
    );
    this.sortedCache.set(sortBy, sorted);
    return sorted;
  }

  getFilesUnder(folder: string): readonly TFile[] {
    const normalized = normalizeFolder(folder);
    if (!normalized) return this.getMarkdownFiles();
    return this.getMarkdownFiles().filter((file) => isPathUnder(file.path, normalized));
  }

  subscribe(listener: (change: VaultChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ---- 事件入口 ------------------------------------------------------------

  applyCreate(file: TAbstractFile): void {
    this.ensureInitialized();
    if (this.isFile(file)) {
      if (this.filesByPath.has(file.path)) {
        this.applyModify(file);
        return;
      }
      this.filesByPath.set(file.path, file);
      if (file.extension.toLowerCase() === "md") {
        this.markdownByPath.set(file.path, file);
        this.basenameMap = null;
        this.earliestMs = undefined;
      }
      this.markStructuralDirty();
    } else {
      this.loadedDirty = true;
    }
    this.bumpGeneration();
    this.scheduleNotification("files", "create", file.path);
  }

  applyModify(file: TAbstractFile): void {
    if (!this.isFile(file)) {
      this.loadedDirty = true;
      this.scheduleNotification("files", "modify", file.path);
      return;
    }
    this.ensureInitialized();
    const isNew = !this.filesByPath.has(file.path);
    this.filesByPath.set(file.path, file);
    if (file.extension.toLowerCase() === "md") {
      this.markdownByPath.set(file.path, file);
      if (isNew) {
        this.basenameMap = null;
        this.markStructuralDirty();
      }
      this.earliestMs = undefined;
    }
    this.invalidateStats();
    this.bumpGeneration();
    this.scheduleNotification("files", "modify", file.path);
  }

  applyDelete(file: TAbstractFile): void {
    this.ensureInitialized();
    if (this.isFile(file)) {
      this.filesByPath.delete(file.path);
      this.markdownByPath.delete(file.path);
    } else {
      const prefix = `${file.path}/`;
      for (const path of [...this.filesByPath.keys()]) {
        if (path.startsWith(prefix)) {
          this.filesByPath.delete(path);
          this.markdownByPath.delete(path);
        }
      }
    }
    this.markStructuralDirty();
    this.earliestMs = undefined;
    this.bumpGeneration();
    this.scheduleNotification("files", "delete", file.path);
  }

  applyRename(file: TAbstractFile, oldPath: string): void {
    this.ensureInitialized();
    if (this.isFile(file)) {
      const previous = this.filesByPath.get(oldPath);
      this.filesByPath.delete(oldPath);
      this.markdownByPath.delete(oldPath);
      this.filesByPath.set(file.path, file);
      if (file.extension.toLowerCase() === "md" || previous?.extension.toLowerCase() === "md") {
        this.markdownByPath.set(file.path, file);
      }
    } else {
      const oldPrefix = `${oldPath}/`;
      const newPrefix = `${file.path}/`;
      for (const [path, entry] of [...this.filesByPath.entries()]) {
        if (!path.startsWith(oldPrefix)) continue;
        const nextPath = `${newPrefix}${path.slice(oldPrefix.length)}`;
        this.filesByPath.delete(path);
        this.markdownByPath.delete(path);
        this.filesByPath.set(nextPath, entry);
        if (entry.extension.toLowerCase() === "md") this.markdownByPath.set(nextPath, entry);
      }
    }
    this.markStructuralDirty();
    this.basenameMap = null;
    this.earliestMs = undefined;
    this.bumpGeneration();
    this.scheduleNotification("files", "rename", file.path);
  }

  applyMetadata(path?: string): void {
    this.ensureInitialized();
    this.tagsDirty = true;
    // metadata 不改变 mtime，排序缓存仍然有效；只失效统计与 tag。
    this.statsDirty = true;
    this.statsCache.clear();
    this.bumpGeneration();
    this.scheduleNotification("metadata", "metadata", path);
  }

  /** 全量对账：只用于 layout ready 或显式修复，不参与日常事件。 */
  reconcile(): void {
    this.rebuild();
    this.scheduleNotification("files", "metadata");
  }

  dispose(): void {
    if (this.notifyTimer !== null) window.clearTimeout(this.notifyTimer);
    this.notifyTimer = null;
    this.listeners.clear();
    this.filesByPath.clear();
    this.markdownByPath.clear();
    this.loadedFiles = [];
    this.filesList = null;
    this.markdownList = null;
    this.basenameMap = null;
    this.sortedCache.clear();
    this.statsCache.clear();
    this.initialized = false;
  }

  // ---- 内部 ----------------------------------------------------------------

  private isFile(file: TAbstractFile): file is TFile {
    return "extension" in file && "stat" in file;
  }

  private ensureInitialized(): void {
    if (!this.initialized) this.rebuild();
    const day = localDayKey(this.now());
    if (day !== this.dayKey) {
      this.dayKey = day;
      this.statsCache.clear();
      this.statsDirty = true;
    }
  }

  private rebuild(): void {
    const app = this.app();
    this.filesByPath.clear();
    this.markdownByPath.clear();
    this.filesList = null;
    this.markdownList = null;
    this.basenameMap = null;
    this.sortedCache.clear();
    this.statsCache.clear();

    for (const file of app.vault.getFiles()) {
      this.filesByPath.set(file.path, file);
      if (file.extension.toLowerCase() === "md") this.markdownByPath.set(file.path, file);
    }
    this.loadedFiles = app.vault.getAllLoadedFiles();
    this.loadedDirty = false;
    this.folderCount = this.loadedFiles.filter((file) => !("extension" in file) && file.path !== "/").length;
    this.tagsDirty = true;
    this.statsDirty = true;
    this.earliestMs = undefined;
    this.dayKey = localDayKey(this.now());
    this.generationCounter += 1;
    this.initialized = true;
  }

  private markStructuralDirty(): void {
    this.filesList = null;
    this.markdownList = null;
    this.basenameMap = null;
    this.sortedCache.clear();
    this.loadedDirty = true;
    this.invalidateStats();
  }

  private invalidateStats(): void {
    this.statsDirty = true;
    this.statsCache.clear();
    this.sortedCache.clear();
  }

  private bumpGeneration(): void {
    this.generationCounter += 1;
  }

  private ensureLoaded(): void {
    if (!this.loadedDirty) return;
    this.loadedFiles = this.app().vault.getAllLoadedFiles();
    this.folderCount = this.loadedFiles.filter((file) => !("extension" in file) && file.path !== "/").length;
    this.loadedDirty = false;
  }

  private ensureFolderCount(): number {
    this.ensureLoaded();
    return this.folderCount;
  }

  private ensureTagCount(): number {
    if (!this.tagsDirty) return this.tagCount;
    const cache = this.app().metadataCache as unknown as { getTags?: () => Record<string, number> };
    this.tagCount = Object.keys(cache.getTags?.() ?? {}).length;
    this.tagsDirty = false;
    return this.tagCount;
  }

  private ensureEarliestDay(): string | undefined {
    if (this.earliestMs !== undefined) {
      return this.earliestMs === null ? undefined : toIsoDate(new Date(this.earliestMs));
    }
    let earliest = Infinity;
    for (const file of this.markdownByPath.values()) {
      if (file.stat.ctime > 0 && file.stat.ctime < earliest) earliest = file.stat.ctime;
    }
    this.earliestMs = Number.isFinite(earliest) ? earliest : null;
    return Number.isFinite(earliest) ? toIsoDate(new Date(earliest)) : undefined;
  }

  private scheduleNotification(reason: VaultChangeReason, operation: VaultChangeOperation, path?: string): void {
    if (path) this.pendingPaths.add(path);
    this.pendingOperations.add(operation);
    if (this.listeners.size === 0) {
      this.clearPending();
      return;
    }
    const nextReason = this.pendingReason && this.pendingReason !== reason ? "mixed" : reason;
    this.pendingReason = nextReason;
    if (this.pendingSince === 0) this.pendingSince = this.now();
    if (this.notifyTimer !== null) window.clearTimeout(this.notifyTimer);
    const maxWaitRemaining = Math.max(0, this.pendingSince + this.notifyMaxWaitMs - this.now());
    this.notifyTimer = window.setTimeout(() => this.flushNotification(), Math.min(this.notifyDebounceMs, maxWaitRemaining));
  }

  private flushNotification(): void {
    this.notifyTimer = null;
    const reason = this.pendingReason;
    const paths = [...this.pendingPaths];
    const operations = [...this.pendingOperations];
    this.clearPending();
    if (!reason) return;
    const change: VaultChange = { reason, changedAt: this.now(), paths, operations };
    for (const listener of [...this.listeners]) listener(change);
  }

  private clearPending(): void {
    this.pendingReason = null;
    this.pendingPaths.clear();
    this.pendingOperations.clear();
    this.pendingSince = 0;
    if (this.notifyTimer !== null) window.clearTimeout(this.notifyTimer);
    this.notifyTimer = null;
  }
}
