import type { VaultChange } from "./types";
import { isPathUnder } from "../utils/paths";

/** 一个组件关心的路径范围。省略 scope 表示“任何变更都可能相关”。 */
export interface PathScope {
  /** 明确忽略路径，直接全量刷新。 */
  all?: boolean;
  /** 只关心这些文件夹（含子目录）。 */
  folders?: readonly string[];
  /** 只关心这些具体路径。 */
  paths?: readonly string[];
  /** metadata 变化是否也算相关（默认 true）。 */
  includeMetadata?: boolean;
}

function matchesPath(path: string, scope: PathScope): boolean {
  for (const exact of scope.paths ?? []) {
    if (path === exact) return true;
  }
  for (const folder of scope.folders ?? []) {
    if (isPathUnder(path, folder)) return true;
  }
  return false;
}

export function isChangeRelevant(change: VaultChange, scope?: PathScope | null): boolean {
  if (!scope || scope.all) return true;
  if (change.reason === "metadata") return scope.includeMetadata !== false;

  const hasScope = (scope.paths?.length ?? 0) > 0 || (scope.folders?.length ?? 0) > 0;
  if (!hasScope) return true;
  // 没有携带路径的批量通知（例如全库 reconcile）保守地视为相关。
  if (change.paths.length === 0) return true;
  return change.paths.some((path) => matchesPath(path, scope));
}
