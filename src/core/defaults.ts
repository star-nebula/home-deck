import type { WidgetRegistry } from "./widgetRegistry";
import type { HomePage } from "./types";
import { createId } from "../utils/id";

/** 默认首页：复刻“场景·首页｜个人主页”的布局。 */
export function createDefaultPage(registry: WidgetRegistry, name = "首页"): HomePage {
  return {
    id: createId("page"),
    name,
    widgets: [
      registry.createInstance("hero", { w: 12, h: 4, title: "欢迎回来" }),
      registry.createInstance("recent", { w: 4, h: 6 }),
      registry.createInstance("quicklinks", { w: 4, h: 6 }),
      registry.createInstance("countdown", { w: 4, h: 3, title: "产品发布" }),
      registry.createInstance("quote", { w: 4, h: 3 }),
      registry.createInstance("duowei", { w: 6, h: 7, title: "待办与日程" }),
      registry.createInstance("annotations", { w: 6, h: 7, title: "批注与复习" }),
      registry.createInstance("wechat", { w: 6, h: 7, title: "微信收件" }),
      registry.createInstance("kanban", { w: 6, h: 7, title: "今日任务看板" }),
      registry.createInstance("habit", { w: 6, h: 7 }),
      registry.createInstance("stats", { w: 6, h: 4 }),
      registry.createInstance("onthisday", { w: 6, h: 3 })
    ]
  };
}
