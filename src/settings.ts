import { App, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile } from "obsidian";
import type { HomeDeckHost } from "./core/ports";
import { DATA_SCHEMA_VERSION } from "./core/identity";
import {
  DEFAULT_SETTINGS,
  sanitizePage as sanitizePageWithDeps,
  sanitizeSettings as sanitizeSettingsWithDeps,
  sanitizeWidget as sanitizeWidgetWithDeps,
  type SettingsDeps
} from "./core/migrations";
import type { HomeDeckSettings, HomePage, WidgetInstance } from "./core/types";
import { createId } from "./utils/id";
import { ConfirmModal, MAX_COLUMNS, MAX_ROWS, PromptModal } from "./ui/modals";

export const SETTINGS_VERSION = DATA_SCHEMA_VERSION;
export { DEFAULT_SETTINGS };

function compatDeps(): SettingsDeps {
  return {
    createDefaultPage: () => ({ id: createId("page"), name: "首页", widgets: [] })
  };
}

/** 兼容测试与旧调用点的单参数版本；生产路径使用 SettingsRepository。 */
export function sanitizeWidget(raw: unknown): WidgetInstance | null {
  return sanitizeWidgetWithDeps(raw, compatDeps());
}

export function sanitizePage(raw: unknown, fallbackName = "页面"): HomePage | null {
  return sanitizePageWithDeps(raw, fallbackName, compatDeps());
}

export function sanitizeSettings(raw: unknown): HomeDeckSettings {
  return sanitizeSettingsWithDeps(raw, compatDeps());
}

export class HomeDeckSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly host: HomeDeckHost) {
    super(app, host as unknown as Plugin);
  }

  private deps(): SettingsDeps {
    return {
      createDefaultPage: () => this.host.layout.createPage("首页", "default"),
      defaultSize: (kind) => this.host.registry.get(kind)?.defaultSize
    };
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("hp-settings-tab");
    const settings = this.host.settings;

    new Setting(containerEl).setName("启动时打开首页")
      .setDesc("Obsidian 启动完成后自动打开首页看板。")
      .addToggle((toggle) => toggle.setValue(settings.openOnStartup).onChange(async (value) => {
        settings.openOnStartup = value;
        await this.host.saveSettings();
      }));
    new Setting(containerEl).setName("在新标签页中打开")
      .setDesc("关闭后，打开首页会复用当前标签页。")
      .addToggle((toggle) => toggle.setValue(settings.openInNewTab).onChange(async (value) => {
        settings.openInNewTab = value;
        await this.host.saveSettings();
      }));

    new Setting(containerEl).setName("网格布局").setHeading();
    new Setting(containerEl).setName("行高").setDesc("组件高度以“行”为单位，这里决定一行多少像素。")
      .addSlider((slider) => slider.setLimits(24, 96, 2).setValue(settings.rowHeight).setDynamicTooltip().onChange(async (value) => {
        settings.rowHeight = value;
        await this.host.saveSettings();
        this.host.refreshViews({ layoutOnly: true });
      }));
    new Setting(containerEl).setName("间距").setDesc("组件之间的间隔（像素）。")
      .addSlider((slider) => slider.setLimits(4, 40, 2).setValue(settings.gap).setDynamicTooltip().onChange(async (value) => {
        settings.gap = value;
        await this.host.saveSettings();
        this.host.refreshViews({ layoutOnly: true });
      }));
    new Setting(containerEl).setName("内容最大宽度").setDesc("像素；0 表示铺满窗口。")
      .addText((text) => text.setValue(String(settings.maxWidth)).onChange(async (value) => {
        const parsed = clampNumber(value, 0, 4000);
        if (parsed === undefined) return;
        settings.maxWidth = parsed;
        await this.host.saveSettings();
        this.host.refreshViews({ layoutOnly: true });
      }));
    new Setting(containerEl).setName("始终显示页面标签栏")
      .setDesc("关闭后，只有多个页面或处于编辑模式时才显示。标签栏末尾的“+”可直接新建页面。")
      .addToggle((toggle) => toggle.setValue(settings.alwaysShowPageTabs).onChange(async (value) => {
        settings.alwaysShowPageTabs = value;
        await this.host.saveSettings();
        this.host.refreshViews({ layoutOnly: true });
      }));

    new Setting(containerEl).setName("页面").setHeading();
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "可以创建多个首页（例如“工作”“生活”），在首页顶部的标签栏切换。组件的添加、排序、尺寸与配置请在首页中点击“编辑布局”完成。"
    });
    for (const page of settings.pages) {
      const row = new Setting(containerEl).setName(page.name).setDesc(`${page.widgets.length} 个组件${page.id === settings.activePageId ? " · 当前" : ""}`);
      row.addButton((button) => button.setButtonText("重命名").onClick(() => {
        new PromptModal(this.app, { title: "重命名页面", value: page.name }, async (value) => {
          this.host.layout.renamePage(page.id, value);
          await this.host.saveSettings();
          this.host.refreshViews({ layoutOnly: true });
          this.display();
        }).open();
      }));
      row.addButton((button) => button.setButtonText("复制").onClick(async () => {
        this.host.layout.duplicatePage(page.id);
        await this.host.saveSettings();
        this.host.refreshViews({ layoutOnly: true });
        this.display();
      }));
      row.addButton((button) => {
        button.setButtonText("删除").setWarning().onClick(() => {
          new ConfirmModal(
            this.app,
            { title: "删除页面", message: `确定删除页面“${page.name}”及其 ${page.widgets.length} 个组件？`, confirmText: "删除", danger: true },
            async () => {
              this.host.layout.removePage(page.id);
              await this.host.saveSettings();
              this.host.refreshViews();
              this.display();
            }
          ).open();
        });
        button.setDisabled(settings.pages.length <= 1);
      });
    }
    new Setting(containerEl)
      .addButton((button) => button.setButtonText("＋ 新建空白页面").onClick(() => {
        new PromptModal(this.app, { title: "新建页面", placeholder: "页面名称" }, async (value) => {
          this.host.layout.addPage(value, "empty");
          await this.host.saveSettings();
          this.host.refreshViews({ layoutOnly: true });
          this.display();
        }).open();
      }))
      .addButton((button) => button.setButtonText("＋ 新建默认布局页面").onClick(() => {
        new PromptModal(this.app, { title: "新建页面", placeholder: "页面名称", value: "首页" }, async (value) => {
          this.host.layout.addPage(value, "default");
          await this.host.saveSettings();
          this.host.refreshViews({ layoutOnly: true });
          this.display();
        }).open();
      }));

    new Setting(containerEl).setName("自定义组件").setHeading();
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "自定义 JS 组件与内置组件注册到同一个加载器，共用渲染、刷新和配置服务。脚本固定放在插件自己的 widgets/ 目录，不再依赖外部文件夹。脚本会执行任意 JavaScript，请只加载可信文件。"
    });
    const widgetsDir = `${this.host.pluginDir}/widgets`;
    new Setting(containerEl)
      .setName("组件目录（插件内）")
      .setDesc(`${widgetsDir} — 首次升级会把旧外部目录的脚本复制进来，旧目录保留作备份。`)
      .addButton((button) => button.setButtonText("复制路径").onClick(async () => {
        try {
          await navigator.clipboard.writeText(widgetsDir);
          new Notice("组件目录已复制");
        } catch {
          new Notice(widgetsDir);
        }
      }));
    new Setting(containerEl).setName("新组件自动加入首页")
      .setDesc("关闭时不会自动添加卡片；可在“添加组件”面板里手动加入。默认关闭，避免升级后凭空多出组件。")
      .addToggle((toggle) => toggle.setValue(settings.autoAddCustomWidgets).onChange(async (value) => {
        settings.autoAddCustomWidgets = value;
        await this.host.saveSettings();
      }));
    new Setting(containerEl)
      .setName("重新扫描")
      .setDesc("立即重新读取组件目录，应用脚本改动。")
      .addButton((button) => button.setButtonText("重新扫描加载").onClick(async () => {
        await this.host.customWidgets.ensureMigrated();
        const count = await this.host.customWidgets.loadAll();
        new Notice(`Home Deck: 已加载 ${count} 个组件`);
        this.display();
      }));

    const loadedWidgets = this.host.customWidgets.getLoadedWidgets();
    new Setting(containerEl).setName("已加载的自定义组件").setHeading();
    if (loadedWidgets.length === 0) {
      new Setting(containerEl)
        .setName("暂无已加载的自定义组件")
        .setDesc("把 .js 组件脚本放进上面的目录，或点击“重新扫描加载”。");
    } else {
      for (const widget of loadedWidgets) {
        new Setting(containerEl)
          .setName(widget.name)
          .setDesc(`${widget.description ? `${widget.description} — ` : ""}标识: ${widget.kind} | 文件: ${widget.filePath}`)
          .addButton((button) => button.setButtonText("复制路径").onClick(async () => {
            try {
              await navigator.clipboard.writeText(widget.filePath);
              new Notice("组件路径已复制");
            } catch {
              new Notice(widget.filePath);
            }
          }));
      }
    }

    new Setting(containerEl).setName("备份与迁移").setHeading();
    new Setting(containerEl).setName("导出布局").setDesc("把所有页面与组件配置复制为 JSON。")
      .addButton((button) => button.setButtonText("复制到剪贴板").onClick(async () => {
        const payload = JSON.stringify({ version: SETTINGS_VERSION, pages: settings.pages }, null, 2);
        try {
          await navigator.clipboard.writeText(payload);
          new Notice("布局 JSON 已复制");
        } catch {
          new TextModal(this.app, "导出布局", payload).open();
        }
      }));
    new Setting(containerEl).setName("导入布局").setDesc("粘贴之前导出的 JSON；导入的页面会追加到现有页面之后。")
      .addButton((button) => button.setButtonText("粘贴导入").onClick(() => {
        new ImportModal(this.app, async (text) => {
          try {
            const parsed = JSON.parse(text) as { pages?: unknown } | unknown[];
            const rawPages = Array.isArray(parsed) ? parsed : Array.isArray(parsed.pages) ? parsed.pages : [parsed];
            const deps = this.deps();
            const pages = rawPages
              .map((page, index) => sanitizePageWithDeps(page, `导入页面 ${index + 1}`, deps))
              .filter((page): page is HomePage => page !== null)
              .map((page) => ({
                ...page,
                id: createId("page"),
                widgets: page.widgets.map((widget) => ({ ...widget, id: createId(widget.kind) }))
              }));
            if (pages.length === 0) throw new Error("没有可导入的页面");
            settings.pages.push(...pages);
            await this.host.saveSettings();
            this.host.refreshViews({ layoutOnly: true });
            this.display();
            new Notice(`已导入 ${pages.length} 个页面`);
          } catch (error) {
            new Notice(`导入失败：${error instanceof Error ? error.message : String(error)}`);
          }
        }).open();
      }));
    new Setting(containerEl).setName("从旧版导入").setDesc("重新读取旧版 Home Pages 的 data.json，并替换当前布局。旧插件文件不会被修改。")
      .addButton((button) => button.setButtonText("导入旧版布局").onClick(() => {
        new ConfirmModal(
          this.app,
          { title: "从旧版导入", message: "这会用旧版插件的布局替换当前所有页面。确定继续？", confirmText: "导入", danger: true },
          async () => {
            const result = await this.host.repo.importLegacy();
            if (!result.imported) {
              new Notice(result.reason === "no-legacy-data" ? "未找到旧版 Home Pages 的布局数据" : "导入失败，已保留当前布局");
              return;
            }
            this.host.refreshViews();
            this.display();
            new Notice(`已从 ${result.source ?? "旧版"} 导入布局`);
          }
        ).open();
      }));
    new Setting(containerEl).setName("重置为默认布局").setDesc("删除所有页面并重新生成默认首页（习惯打卡等本地数据也会清除）。")
      .addButton((button) => button.setButtonText("重置").setWarning().onClick(() => {
        new ConfirmModal(
          this.app,
          { title: "重置布局", message: "确定删除所有页面并恢复默认首页？此操作不可撤销。", confirmText: "重置", danger: true },
          async () => {
            this.host.layout.resetToDefault();
            await this.host.saveSettings();
            this.host.refreshViews();
            this.display();
          }
        ).open();
      }));
  }
}

function clampNumber(value: unknown, min: number, max: number): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

class TextModal extends Modal {
  constructor(app: App, private readonly title: string, private readonly text: string) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(this.title);
    const area = this.contentEl.createEl("textarea", { cls: "hp-json-area" });
    area.value = this.text;
    area.readOnly = true;
    area.rows = 18;
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class ImportModal extends Modal {
  constructor(app: App, private readonly onSubmit: (text: string) => Promise<void>) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("导入布局 JSON");
    const area = this.contentEl.createEl("textarea", { cls: "hp-json-area", attr: { placeholder: "在此粘贴 JSON" } });
    area.rows = 16;
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText("取消").onClick(() => this.close()))
      .addButton((button) => button.setButtonText("导入").setCta().onClick(async () => {
        const text = area.value.trim();
        if (!text) return;
        await this.onSubmit(text);
        this.close();
      }));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

// 保留旧导出名的类型别名，避免外部脚本/测试立刻断裂。
export type { HomeDeckSettings, HomePage, WidgetInstance };
export { MAX_COLUMNS, MAX_ROWS };
