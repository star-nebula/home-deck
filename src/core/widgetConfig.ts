/** 组件配置的纯函数工具：默认值合并、数值收敛、字符串列表清洗。 */

export function normalizeWith<C extends Record<string, unknown>>(defaults: C, raw: Record<string, unknown>): C {
  const result: Record<string, unknown> = { ...defaults };
  for (const [key, fallback] of Object.entries(defaults)) {
    const value = raw[key];
    if (value === undefined || value === null) continue;
    if (typeof fallback === "number") {
      const parsed = typeof value === "number" ? value : Number(value);
      if (Number.isFinite(parsed)) result[key] = parsed;
    } else if (typeof fallback === "boolean") {
      result[key] = value === true || value === "true";
    } else if (typeof fallback === "string") {
      result[key] = String(value);
    } else if (Array.isArray(fallback)) {
      if (Array.isArray(value)) result[key] = value;
    } else if (typeof fallback === "object" && fallback !== null) {
      if (typeof value === "object" && !Array.isArray(value)) result[key] = value;
    } else {
      result[key] = value;
    }
  }
  return result as C;
}

export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

export function toStringList(value: unknown, max = 50): string[] {
  const list = Array.isArray(value)
    ? value.map((item) => String(item ?? "").trim())
    : typeof value === "string"
      ? value.split(/[\n,，]/g).map((item) => item.trim())
      : [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of list) {
    if (!item || seen.has(item)) continue;
    seen.add(item);
    result.push(item);
    if (result.length >= max) break;
  }
  return result;
}
