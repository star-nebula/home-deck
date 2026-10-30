import { normalizePath, type App } from "obsidian";
import type { MtimeService } from "../core/ports";

interface TextEntry {
  mtime: number;
  size: number;
  value: string;
}

interface JsonEntry {
  mtime: number;
  size: number;
  value: unknown;
}

/**
 * 以 (mtime, size) 为键的 adapter 缓存。
 *
 * 组件每次重绘都读 JSON（批注索引、.duowei、插件 data.json）时，先 stat 再决定
 * 是否 read/parse，避免重复磁盘 IO 与 JSON.parse。
 */
export class MtimeCache implements MtimeService {
  private readonly textEntries = new Map<string, TextEntry>();
  private readonly jsonEntries = new Map<string, JsonEntry>();

  constructor(private readonly app: () => App) {}

  async readText(path: string): Promise<string | null> {
    const normalized = normalizePath(path);
    const stat = await this.stat(normalized);
    if (!stat) {
      this.textEntries.delete(normalized);
      return null;
    }
    const cached = this.textEntries.get(normalized);
    if (cached && cached.mtime === stat.mtime && cached.size === stat.size) return cached.value;
    try {
      const value = await this.app().vault.adapter.read(normalized);
      this.textEntries.set(normalized, { mtime: stat.mtime, size: stat.size, value });
      return value;
    } catch (error) {
      console.error(`Home Deck: failed to read ${normalized}`, error);
      return null;
    }
  }

  async readJson<T>(path: string): Promise<T | null> {
    const normalized = normalizePath(path);
    const stat = await this.stat(normalized);
    if (!stat) {
      this.jsonEntries.delete(normalized);
      return null;
    }
    const cached = this.jsonEntries.get(normalized);
    if (cached && cached.mtime === stat.mtime && cached.size === stat.size) return cached.value as T;
    const text = await this.readText(normalized);
    if (text === null) return null;
    try {
      const value = JSON.parse(text) as T;
      this.jsonEntries.set(normalized, { mtime: stat.mtime, size: stat.size, value });
      return value;
    } catch (error) {
      console.error(`Home Deck: failed to parse ${normalized}`, error);
      return null;
    }
  }

  invalidate(path?: string): void {
    if (!path) {
      this.textEntries.clear();
      this.jsonEntries.clear();
      return;
    }
    const normalized = normalizePath(path);
    this.textEntries.delete(normalized);
    this.jsonEntries.delete(normalized);
  }

  private async stat(path: string): Promise<{ mtime: number; size: number } | null> {
    try {
      const stat = await this.app().vault.adapter.stat(path);
      if (!stat) return null;
      return { mtime: stat.mtime, size: stat.size };
    } catch {
      return null;
    }
  }
}
