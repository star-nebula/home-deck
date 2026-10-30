import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { migrateRawSettings, sanitizeSettings, type SettingsDeps } from "../src/core/migrations";
import { SettingsRepository, type PluginStorage } from "../src/core/settingsRepository";
import { isChangeRelevant } from "../src/core/changeScope";
import { WidgetRegistry } from "../src/core/widgetRegistry";
import { BUILTIN_WIDGETS } from "../src/widgets/builtins";
import { evaluateWidgetScript } from "../src/services/customWidgets";
import type { HomeDeckSettings, VaultChange } from "../src/core/types";

const KINDS = [
  "hero", "recent", "quicklinks", "countdown", "pomodoro", "quote", "habit", "diary",
  "allnotes", "kanban", "stats", "onthisday", "note", "duowei", "annotations", "insights",
  "wechat", "media", "knowledgemap"
];

const deps: SettingsDeps = {
  createDefaultPage: () => ({ id: "default-page", name: "首页", widgets: [] }),
  defaultSize: (kind) => (kind === "hero" ? { w: 12, h: 4 } : undefined)
};

function legacyPayload(): Record<string, unknown> {
  return {
    version: 1,
    pages: [
      {
        id: "page-1",
        name: "工作台",
        widgets: KINDS.map((kind, index) => ({
          id: `widget-${index}`,
          kind,
          w: (index % 12) + 1,
          h: (index % 6) + 1,
          config: { marker: kind }
        })).concat([
          { id: "unknown-1", kind: "vault-heatmap", w: 5, h: 3, config: { ref: "a#b" }, provider: "heatmap-plugin" }
        ])
      }
    ],
    activePageId: "page-1",
    rowHeight: 44,
    gap: 12,
    maxWidth: 1600,
    alwaysShowPageTabs: false,
    customWidgetsFolder: ".scripts/home-pages",
    autoAddCustomWidgets: true,
    seenCustomWidgetKinds: ["a", "b"]
  };
}

function testMigration(): void {
  const raw = legacyPayload();
  const result = migrateRawSettings(raw, deps, "home-pages-star-nebula");
  assert.equal(result.migrated, true);
  assert.equal(result.settings.version, 3);
  assert.equal(result.settings.migratedFrom, "home-pages-star-nebula");
  assert.equal(result.settings.pages.length, 1);
  assert.equal(result.settings.pages[0].widgets.length, KINDS.length + 1);
  assert.deepEqual(result.settings.pages[0].widgets.map((widget) => widget.kind), [...KINDS, "vault-heatmap"]);
  assert.equal(result.settings.pages[0].widgets[0].w, 1);
  assert.equal(result.settings.pages[0].widgets[0].config.marker, "hero");
  const unknown = result.settings.pages[0].widgets[KINDS.length];
  assert.equal(unknown.provider, "heatmap-plugin");
  assert.deepEqual(unknown.config, { ref: "a#b" });
  assert.equal(result.settings.rowHeight, 44);
  assert.equal(result.settings.alwaysShowPageTabs, false);
  assert.equal(result.settings.customWidgetsFolder, ".scripts/home-pages");
  // 旧版默认自动加卡片；升级时必须关掉，避免凭空多出组件。
  assert.equal(result.settings.autoAddCustomWidgets, false);
  assert.deepEqual(result.settings.seenCustomWidgetKinds, ["a", "b"]);

  // 幂等：再次迁移 v2 数据不改变结构。
  const again = migrateRawSettings(result.settings, deps);
  assert.equal(again.migrated, false);
  assert.deepEqual(again.settings.pages, result.settings.pages);
  assert.equal(again.settings.migratedFrom, "home-pages-star-nebula");
  console.log("PASS migration keeps all kinds, config, provider and custom-widget fields");

  const fresh = sanitizeSettings({}, deps);
  assert.equal(fresh.pages.length, 1);
  assert.equal(fresh.pages[0].id, "default-page");
  assert.equal(fresh.version, 3);
  assert.equal(fresh.customWidgetsFolder, ".obsidian/home-pages-widgets");
  console.log("PASS empty payload falls back to one default page");
}

function testChangeScope(): void {
  const fileChange: VaultChange = { reason: "files", changedAt: 0, paths: ["Knowledge/a.md"], operations: ["modify"] };
  assert.equal(isChangeRelevant(fileChange, undefined), true);
  assert.equal(isChangeRelevant(fileChange, { folders: ["Knowledge"] }), true);
  assert.equal(isChangeRelevant(fileChange, { folders: ["Daily"] }), false);
  assert.equal(isChangeRelevant(fileChange, { paths: ["Knowledge/a.md"] }), true);
  assert.equal(isChangeRelevant(fileChange, { paths: ["Other.md"] }), false);
  assert.equal(isChangeRelevant(fileChange, { all: true }), true);
  const metadata: VaultChange = { reason: "metadata", changedAt: 0, paths: ["Knowledge/a.md"], operations: ["metadata"] };
  assert.equal(isChangeRelevant(metadata, { folders: ["Knowledge"] }), true);
  assert.equal(isChangeRelevant(metadata, { folders: ["Knowledge"], includeMetadata: false }), false);
  const bulk: VaultChange = { reason: "files", changedAt: 0, paths: [], operations: ["metadata"] };
  assert.equal(isChangeRelevant(bulk, { folders: ["Daily"] }), true);
  console.log("PASS path scope relevance");
}

async function testRepositoryMigration(): Promise<void> {
  const legacyId = "home-pages-star-nebula";
  const newDir = ".obsidian/plugins/home-deck";
  const legacyPath = `.obsidian/plugins/${legacyId}/data.json`;
  const files = new Map<string, string>();
  const legacyText = JSON.stringify(legacyPayload(), null, 2);
  files.set(legacyPath, legacyText);
  let reads: string[] = [];

  const app = {
    vault: {
      configDir: ".obsidian",
      adapter: {
        exists: async (path: string) => files.has(path),
        read: async (path: string) => {
          reads.push(path);
          const value = files.get(path);
          if (value === undefined) throw new Error(`missing ${path}`);
          return value;
        },
        write: async (path: string, content: string) => {
          files.set(path, content);
        },
        mkdir: async () => undefined,
        stat: async () => null,
        list: async () => ({ files: [], folders: [] })
      }
    }
  };
  const manifest = { id: "home-deck", dir: newDir } as never;
  let saved: unknown = null;
  const storage: PluginStorage = {
    loadData: async () => null,
    saveData: async (data) => {
      saved = JSON.parse(JSON.stringify(data)) as unknown;
    }
  };

  const repo = new SettingsRepository(app as never, manifest, storage, deps);
  const result = await repo.load();
  assert.equal(result.imported, true);
  assert.equal(result.source, legacyId);
  assert.equal(files.get(legacyPath), legacyText, "legacy file must stay byte-identical");
  assert.ok(files.has(`${newDir}/data.pre-migration.json`), "backup should be written");
  const persisted = saved as HomeDeckSettings;
  assert.equal(persisted.version, 3);
  assert.equal(persisted.migratedFrom, legacyId);
  assert.equal(persisted.pages[0].widgets.length, KINDS.length + 1);
  console.log("PASS repository migrates legacy data, writes backup, leaves old file intact");

  // 新数据已存在时不再读取旧插件。
  reads = [];
  const second = new SettingsRepository(app as never, manifest, {
    loadData: async () => persisted,
    saveData: async () => undefined
  }, deps);
  const secondResult = await second.load();
  assert.equal(secondResult.imported, false);
  assert.equal(reads.length, 0, "legacy data must not be read when new data exists");
  assert.equal(second.settings.pages[0].widgets.length, KINDS.length + 1);
  console.log("PASS new data wins and legacy is not re-read");
}

async function testCustomWidgetRegistration(): Promise<void> {
  const script = `
    module.exports = {
      kind: "custom-demo",
      name: "自定义示例",
      description: "test",
      defaultSize: { w: 4, h: 3 },
      defaultConfig() { return { text: "hi" }; },
      render(body, ctx) { body.setText(ctx.config.text); },
      renderSettings() {}
    };
  `;
  const definition = await evaluateWidgetScript(script, {} as never, "demo.js");
  assert.equal(definition.kind, "custom-demo");
  assert.equal(definition.defaultSize.w, 4);
  const registry = new WidgetRegistry(BUILTIN_WIDGETS);
  const unregister = registry.register(definition, "user-script:demo.js");
  assert.equal(registry.get("custom-demo")?.name, "自定义示例");
  assert.equal(registry.normalizeConfig<{ text: string }>(registry.createInstance("custom-demo")).text, "hi");
  unregister();
  assert.equal(registry.get("custom-demo"), undefined);
  console.log("PASS custom widget registers through the same registry as built-ins");

  const realScript = process.env.HOME_DECK_TEST_CUSTOM_SCRIPT;
  if (realScript) {
    const source = await readFile(realScript, "utf8");
    const realDefinition = await evaluateWidgetScript(source, {} as never, realScript);
    assert.equal(realDefinition.kind, "vault-heatmap");
    console.log(`PASS real custom script evaluates: ${realScript}`);
  }
}

testMigration();
testChangeScope();
await testRepositoryMigration();
await testCustomWidgetRegistration();
console.log("ALL CORE TESTS PASSED");
