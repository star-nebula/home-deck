import { normalizePath, type App, type TAbstractFile, type TFile } from "obsidian";
import { toIsoDate } from "./date";

export type VaultChangeReason = "files" | "metadata";
export type VaultChangeOperation = "create" | "modify" | "delete" | "rename" | "metadata" | "resolve";
export type VaultMarkdownSort = "mtime" | "ctime";

export interface VaultChangeDetail {
  operation: VaultChangeOperation;
  path?: string;
  oldPath?: string;
}

export interface VaultChange {
  reason: VaultChangeReason | "mixed";
  changedAt: number;
  paths: readonly string[];
  operations: readonly VaultChangeOperation[];
}

export interface VaultStatsOptions {
  excludeFolders?: string[];
  excludeHidden?: boolean;
}

export interface VaultStatsSnapshot {
  noteCount: number;
  fileCount: number;
  attachmentCount: number;
  folderCount: number;
  wordEstimate: number;
  tagCount: number;
  earliestDay?: string;
  todayNotes: number;
  weekNotes: number;
  activityByDay: Readonly<Record<string, number>>;
  generatedAt: number;
  generation: number;
}

interface VaultBaseSnapshot {
  files: TFile[];
  markdownFiles: TFile[];
  markdownByBasename: ReadonlyMap<string, TFile>;
  loadedFiles: TAbstractFile[];
  folderCount: number;
  tagCount: number;
  earliestDay?: string;
  generation: number;
  dayKey: string;
}

interface CachedStats {
  dayKey: string;
  value: VaultStatsSnapshot;
}

interface VaultStatsServiceOptions {
  now?: () => number;
  notifyDebounceMs?: number;
  notifyMaxWaitMs?: number;
}

const DEFAULT_NOTIFY_DEBOUNCE_MS = 1_200;
const DEFAULT_NOTIFY_MAX_WAIT_MS = 5_000;

function normalizeExcludes(folders: string[] | undefined): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of folders ?? []) {
    const folder = normalizePath(String(raw ?? "").trim()).replace(/\/+$/g, "");
    if (!folder || seen.has(folder)) continue;
    seen.add(folder);
    result.push(folder);
  }
  result.sort();
  return result;
}

function isUnderPath(path: string, folder: string): boolean {
  return path === folder || path.startsWith(`${folder}/`);
}

function isHiddenPath(path: string): boolean {
  return path.split("/").some((part) => part.startsWith(".") && part !== "");
}

function localDayKey(time: number): string {
  return toIsoDate(new Date(time));
}

/**
 * Vault-wide data is cached for one invalidation generation. File events invalidate
 * immediately, but subscriber notifications are merged so an import burst causes one
 * dashboard refresh instead of one refresh per file.
 */
export class VaultStatsService {
  private base: VaultBaseSnapshot | null = null;
  private readonly statsCache = new Map<string, CachedStats>();
  private readonly sortedMarkdownCache = new Map<VaultMarkdownSort, TFile[]>();
  private readonly listeners = new Set<(change: VaultChange) => void>();
  private generation = 0;
  private pendingReason: VaultChange["reason"] | null = null;
  private readonly pendingPaths = new Set<string>();
  private readonly pendingOperations = new Set<VaultChangeOperation>();
  private pendingSince = 0;
  private notifyTimer: number | null = null;
  private readonly now: () => number;
  private readonly notifyDebounceMs: number;
  private readonly notifyMaxWaitMs: number;

  constructor(private readonly app: () => App, options: VaultStatsServiceOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.notifyDebounceMs = options.notifyDebounceMs ?? DEFAULT_NOTIFY_DEBOUNCE_MS;
    this.notifyMaxWaitMs = options.notifyMaxWaitMs ?? DEFAULT_NOTIFY_MAX_WAIT_MS;
  }

  getFiles(): readonly TFile[] {
    return this.ensureBase().files;
  }

  getMarkdownFiles(): readonly TFile[] {
    return this.ensureBase().markdownFiles;
  }

  getAllLoadedFiles(): readonly TAbstractFile[] {
    return this.ensureBase().loadedFiles;
  }

  getMarkdownByBasename(): ReadonlyMap<string, TFile> {
    return this.ensureBase().markdownByBasename;
  }

  getMarkdownSorted(sortBy: VaultMarkdownSort): readonly TFile[] {
    const cached = this.sortedMarkdownCache.get(sortBy);
    if (cached) return cached;
    const sorted = [...this.ensureBase().markdownFiles].sort((a, b) =>
      sortBy === "ctime" ? b.stat.ctime - a.stat.ctime : b.stat.mtime - a.stat.mtime
    );
    this.sortedMarkdownCache.set(sortBy, sorted);
    return sorted;
  }

  getStats(options: VaultStatsOptions = {}): VaultStatsSnapshot {
    const excludes = normalizeExcludes(options.excludeFolders);
    const key = `${options.excludeHidden === true ? "h" : "v"}|${excludes.join("\u0000")}`;
    const dayKey = localDayKey(this.now());
    const base = this.ensureBase();
    const cached = this.statsCache.get(key);
    if (cached?.dayKey === dayKey) return cached.value;

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

    for (const file of base.files) {
      if (options.excludeHidden === true && isHiddenPath(file.path)) continue;
      if (excludes.some((folder) => isUnderPath(file.path, folder))) continue;
      fileCount += 1;
      if (file.extension.toLowerCase() !== "md") continue;
      noteCount += 1;
      totalMarkdownBytes += file.stat.size;
      if (file.stat.ctime >= todayStart) todayNotes += 1;
      if (file.stat.mtime >= weekStart) weekNotes += 1;
      const modifiedDay = localDayKey(file.stat.mtime);
      activity.set(modifiedDay, (activity.get(modifiedDay) ?? 0) + 1);
    }

    const frozenActivity = Object.freeze(Object.fromEntries(activity)) as Readonly<Record<string, number>>;
    const value: VaultStatsSnapshot = Object.freeze({
      noteCount,
      fileCount,
      attachmentCount: Math.max(0, fileCount - noteCount),
      folderCount: base.folderCount,
      wordEstimate: Math.round(totalMarkdownBytes / 3),
      tagCount: base.tagCount,
      earliestDay: base.earliestDay,
      todayNotes,
      weekNotes,
      activityByDay: frozenActivity,
      generatedAt: this.now(),
      generation: base.generation
    });
    this.statsCache.set(key, { dayKey, value });
    return value;
  }

  /** File events can refresh general widgets without forcing a stats rescan for non-Markdown edits. */
  invalidate(reason: VaultChangeReason, affectsStats = true, detail?: VaultChangeDetail): void {
    if (affectsStats) {
      this.base = null;
      this.statsCache.clear();
      this.sortedMarkdownCache.clear();
    }
    if (detail?.path) this.pendingPaths.add(detail.path);
    if (detail?.oldPath) this.pendingPaths.add(detail.oldPath);
    if (detail) this.pendingOperations.add(detail.operation);
    if (this.listeners.size === 0) {
      this.pendingReason = null;
      this.pendingPaths.clear();
      this.pendingOperations.clear();
      this.pendingSince = 0;
      if (this.notifyTimer !== null) window.clearTimeout(this.notifyTimer);
      this.notifyTimer = null;
      return;
    }
    const nextReason = this.pendingReason && this.pendingReason !== reason ? "mixed" : reason;
    this.pendingReason = nextReason;
    if (this.pendingSince === 0) this.pendingSince = this.now();
    this.scheduleNotification();
  }

  subscribe(listener: (change: VaultChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    if (this.notifyTimer !== null) window.clearTimeout(this.notifyTimer);
    this.notifyTimer = null;
    this.listeners.clear();
    this.base = null;
    this.statsCache.clear();
    this.sortedMarkdownCache.clear();
  }

  private ensureBase(): VaultBaseSnapshot {
    const dayKey = localDayKey(this.now());
    if (this.base?.dayKey === dayKey) return this.base;

    const app = this.app();
    const files = app.vault.getFiles();
    const loadedFiles = app.vault.getAllLoadedFiles();
    const markdownFiles: TFile[] = [];
    const markdownByBasename = new Map<string, TFile>();
    let folderCount = 0;
    let earliest = Infinity;
    for (const file of loadedFiles) {
      if (!("extension" in file) && file.path !== "/") folderCount += 1;
    }
    for (const file of files) {
      if (file.extension.toLowerCase() !== "md") continue;
      markdownFiles.push(file);
      if (!markdownByBasename.has(file.basename)) markdownByBasename.set(file.basename, file);
      if (file.stat.ctime > 0 && file.stat.ctime < earliest) earliest = file.stat.ctime;
    }
    const cache = app.metadataCache as unknown as { getTags?: () => Record<string, number> };
    const tagCount = Object.keys(cache.getTags?.() ?? {}).length;
    this.generation += 1;
    this.statsCache.clear();
    this.sortedMarkdownCache.clear();
    this.base = {
      files,
      markdownFiles,
      markdownByBasename,
      loadedFiles,
      folderCount,
      tagCount,
      earliestDay: Number.isFinite(earliest) ? toIsoDate(new Date(earliest)) : undefined,
      generation: this.generation,
      dayKey
    };
    return this.base;
  }

  private scheduleNotification(): void {
    if (this.notifyTimer !== null) window.clearTimeout(this.notifyTimer);
    const now = this.now();
    const maxWaitRemaining = Math.max(0, this.pendingSince + this.notifyMaxWaitMs - now);
    const delay = Math.min(this.notifyDebounceMs, maxWaitRemaining);
    this.notifyTimer = window.setTimeout(() => this.flushNotification(), delay);
  }

  private flushNotification(): void {
    this.notifyTimer = null;
    const reason = this.pendingReason;
    const paths = [...this.pendingPaths];
    const operations = [...this.pendingOperations];
    this.pendingReason = null;
    this.pendingPaths.clear();
    this.pendingOperations.clear();
    this.pendingSince = 0;
    if (!reason) return;
    const change: VaultChange = { reason, changedAt: this.now(), paths, operations };
    for (const listener of [...this.listeners]) listener(change);
  }
}
