/** 兼容旧导入路径；组件契约现在由 core/ports.ts 与 core/widgetConfig.ts 维护。 */
export type {
  WidgetContext,
  WidgetDataPort,
  WidgetUiPort,
  WidgetSettingsContext,
  WidgetDefinition
} from "../core/ports";
export type { PathScope } from "../core/changeScope";
export { normalizeWith, clampInt, toStringList } from "../core/widgetConfig";
