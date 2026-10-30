import { normalizePath } from "obsidian";

/** 统一的路径范围判断，避免每个组件各写一套。 */

export function normalizeFolder(value: unknown): string {
  return normalizePath(String(value ?? "").trim()).replace(/\/+$/g, "");
}

export function normalizeFolders(folders: readonly unknown[] | undefined): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of folders ?? []) {
    const folder = normalizeFolder(raw);
    if (!folder || seen.has(folder)) continue;
    seen.add(folder);
    result.push(folder);
  }
  result.sort();
  return result;
}

export function isPathUnder(path: string, folder: string): boolean {
  const normalized = normalizeFolder(folder);
  if (!normalized || normalized === "/") return true;
  return path === normalized || path.startsWith(`${normalized}/`);
}

export function isExcludedPath(path: string, excludes: readonly unknown[] | undefined): boolean {
  for (const raw of excludes ?? []) {
    const folder = normalizeFolder(raw);
    if (folder && isPathUnder(path, folder)) return true;
  }
  return false;
}

export function isHiddenPath(path: string): boolean {
  return path.split("/").some((part) => part.startsWith(".") && part !== "");
}

/** 判断文件路径是否落在某个 scope 文件夹内。空 scope 表示全库。 */
export function isInScopePath(path: string, scope: string): boolean {
  return isPathUnder(path, scope);
}
