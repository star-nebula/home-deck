import type { WidgetInstance } from "./types";
import type { WidgetDefinition } from "./ports";
import { createId } from "../utils/id";

type AnyWidgetDefinition = WidgetDefinition<Record<string, unknown>>;

/**
 * 插件实例持有的组件注册表。
 *
 * 旧实现用模块级 Map，测试之间、插件重载之间会互相污染。这里改成实例类，
 * `main.ts` 只创建一次，视图 / API / 设置页共享同一个实例。
 */
export class WidgetRegistry {
  private readonly byKind = new Map<string, AnyWidgetDefinition>();
  private readonly providers = new Map<string, string>();
  private readonly builtinKinds = new Set<string>();
  private readonly listeners = new Set<(kind: string, registered: boolean) => void>();

  constructor(definitions: readonly AnyWidgetDefinition[]) {
    for (const definition of definitions) {
      this.byKind.set(definition.kind, definition);
      this.builtinKinds.add(definition.kind);
    }
  }

  list(): AnyWidgetDefinition[] {
    return [...this.byKind.values()];
  }

  get(kind: string): AnyWidgetDefinition | undefined {
    return this.byKind.get(kind);
  }

  getProvider(kind: string): string | undefined {
    return this.providers.get(kind);
  }

  isBuiltinKind(kind: string): boolean {
    return this.builtinKinds.has(kind);
  }

  isValidKind(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
  }

  register(definition: AnyWidgetDefinition, provider?: string): () => void {
    if (!this.isValidKind(definition.kind)) throw new Error("Widget kind must be a non-empty string");
    if (this.builtinKinds.has(definition.kind)) {
      throw new Error(`Widget kind "${definition.kind}" is built in and cannot be replaced`);
    }
    this.byKind.set(definition.kind, definition);
    if (provider) this.providers.set(definition.kind, provider);
    this.emit(definition.kind, true);
    return () => this.unregister(definition.kind, definition);
  }

  unregister(kind: string, definition?: AnyWidgetDefinition): void {
    if (this.builtinKinds.has(kind)) return;
    if (definition && this.byKind.get(kind) !== definition) return;
    this.byKind.delete(kind);
    this.providers.delete(kind);
    this.emit(kind, false);
  }

  onChange(listener: (kind: string, registered: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  createInstance(kind: string, overrides: Partial<WidgetInstance> = {}): WidgetInstance {
    const definition = this.byKind.get(kind);
    return {
      id: overrides.id ?? createId(kind),
      kind,
      title: overrides.title,
      w: overrides.w ?? definition?.defaultSize.w ?? 6,
      h: overrides.h ?? definition?.defaultSize.h ?? 6,
      config: { ...(definition?.defaultConfig() ?? {}), ...(overrides.config ?? {}) },
      ...(overrides.provider ? { provider: overrides.provider } : {})
    };
  }

  normalizeConfig<C = Record<string, unknown>>(widget: WidgetInstance): C {
    const definition = this.byKind.get(widget.kind);
    if (!definition) return { ...(widget.config ?? {}) } as C;
    const raw = widget.config ?? {};
    return (definition.normalizeConfig ? definition.normalizeConfig(raw) : { ...definition.defaultConfig(), ...raw }) as C;
  }

  displayTitle(widget: WidgetInstance): string {
    const custom = widget.title?.trim();
    if (custom) return custom;
    return this.byKind.get(widget.kind)?.name ?? widget.kind;
  }

  private emit(kind: string, registered: boolean): void {
    for (const listener of [...this.listeners]) listener(kind, registered);
  }
}
