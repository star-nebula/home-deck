/** 唯一的项目身份源：manifest、视图、事件、迁移路径都从这里取。 */

export const PLUGIN_ID = "home-deck";
export const PLUGIN_NAME = "Home Deck";
export const READY_EVENT = `${PLUGIN_ID}:ready`;

/** 首页视图类型。旧值用于接管升级前的工作区标签。 */
export const VIEW_TYPE_HOME = `${PLUGIN_ID}-view`;
export const LEGACY_VIEW_TYPE = "home-pages-view";

/** 可迁移的旧插件 id，按优先级排列。 */
export const LEGACY_ID = "home-pages-star-nebula";
export const UPSTREAM_ID = "home-pages";
export const LEGACY_IDS = [LEGACY_ID, UPSTREAM_ID] as const;

/** 当前设置 schema 版本。 */
export const DATA_SCHEMA_VERSION = 3;
