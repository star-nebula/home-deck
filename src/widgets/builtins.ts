import { annotationsWidget } from "./annotations";
import { allNotesWidget } from "./allnotes";
import { countdownWidget } from "./countdown";
import { diaryWidget } from "./diary";
import { duoweiWidget } from "./duowei";
import { habitWidget } from "./habit";
import { heroWidget } from "./hero";
import { insightsWidget } from "./insights";
import { kanbanWidget } from "./kanban";
import { knowledgeMapWidget } from "./knowledgeMap";
import { noteWidget } from "./note";
import { onThisDayWidget } from "./onthisday";
import { pomodoroWidget } from "./pomodoro";
import { quicklinksWidget } from "./quicklinks";
import { quoteWidget } from "./quote";
import { recentWidget } from "./recent";
import { mediaWidget } from "./media";
import { statsWidget } from "./stats";
import { vaultHeatmapWidget } from "./vaultHeatmap";
import { wechatWidget } from "./wechat";
import type { WidgetDefinition } from "../core/ports";

type AnyWidgetDefinition = WidgetDefinition<Record<string, unknown>>;

/** 内置组件的唯一清单；顺序决定“添加组件”面板的展示顺序。 */
export const BUILTIN_WIDGETS: AnyWidgetDefinition[] = [
  heroWidget,
  recentWidget,
  quicklinksWidget,
  countdownWidget,
  pomodoroWidget,
  quoteWidget,
  duoweiWidget,
  annotationsWidget,
  wechatWidget,
  mediaWidget,
  kanbanWidget,
  habitWidget,
  diaryWidget,
  allNotesWidget,
  knowledgeMapWidget,
  statsWidget,
  vaultHeatmapWidget,
  onThisDayWidget,
  noteWidget,
  insightsWidget
];
