import { App, Modal, Setting, setIcon } from "obsidian";
import type { HomeDeckHost, WidgetSettingsContext } from "../core/ports";
import { MAX_COLUMNS, MAX_ROWS, type WidgetInstance, type WidgetKind } from "../core/types";
import { renderEmpty } from "./dom";

export { MAX_COLUMNS, MAX_ROWS };

/** 单个组件的配置弹窗：通用项（标题 / 尺寸）+ 组件自定义项，点“保存”才写回。 */
export class WidgetSettingsModal extends Modal {
  private draft: WidgetInstance;
  private draftConfig: Record<string, unknown>;
  private bodyEl!: HTMLElement;

  constructor(
    app: App,
    private readonly host: HomeDeckHost,
    widget: WidgetInstance,
    private readonly onSave: (updated: WidgetInstance) => void | Promise<void>
  ) {
    super(app);
    this.draft = { ...widget, config: { ...widget.config } };
    this.draftConfig = host.registry.normalizeConfig(widget);
  }

  onOpen(): void {
    const definition = this.host.registry.get(this.draft.kind);
    this.modalEl.addClass("hp-modal");
    this.titleEl.setText(`配置组件 · ${definition?.name ?? this.draft.kind}`);
    this.bodyEl = this.contentEl.createDiv({ cls: "hp-modal-body" });
    this.renderBody();

    const footer = this.contentEl.createDiv({ cls: "hp-modal-footer" });
    new Setting(footer)
      .addButton((button) => button.setButtonText("取消").onClick(() => this.close()))
      .addButton((button) => button.setButtonText("保存").setCta().onClick(async () => {
        const definition = this.host.registry.get(this.draft.kind);
        const normalized = definition?.normalizeConfig ? definition.normalizeConfig(this.draftConfig) : this.draftConfig;
        await this.onSave({ ...this.draft, config: { ...normalized } });
        this.close();
      }));
  }

  private renderBody(): void {
    const container = this.bodyEl;
    container.empty();
    const definition = this.host.registry.get(this.draft.kind);
    if (!definition) {
      renderEmpty(container, {
        icon: "plug",
        text: `组件类型「${this.draft.kind}」由第三方插件提供，插件尚未加载；配置已保留。`
      });
      return;
    }

    new Setting(container).setName("标题").setDesc("留空使用默认标题。")
      .addText((text) => text.setPlaceholder(definition.name).setValue(this.draft.title ?? "").onChange((value) => {
        this.draft.title = value.trim() || undefined;
      }));
    new Setting(container).setName("宽度（列）").setDesc(`网格共 ${MAX_COLUMNS} 列。`)
      .addSlider((slider) => slider.setLimits(1, MAX_COLUMNS, 1).setValue(this.draft.w).setDynamicTooltip().onChange((value) => {
        this.draft.w = value;
      }));
    new Setting(container).setName("高度（行）").setDesc("行高可在插件设置中调整。")
      .addSlider((slider) => slider.setLimits(1, MAX_ROWS, 1).setValue(this.draft.h).setDynamicTooltip().onChange((value) => {
        this.draft.h = value;
      }));

    container.createEl("h3", { cls: "hp-modal-section", text: "组件设置" });
    const ctx: WidgetSettingsContext<Record<string, unknown>> = {
      app: this.app,
      plugin: this.host,
      config: this.draftConfig,
      update: (patch) => {
        Object.assign(this.draftConfig, patch);
      },
      refresh: () => this.renderBody()
    };
    definition.renderSettings(container, ctx);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** 选择要添加的组件类型。existingKinds 里已有的类型会在卡片上标注「已添加」（仍可重复添加）。 */
export class AddWidgetModal extends Modal {
  constructor(
    app: App,
    private readonly host: HomeDeckHost,
    private readonly onPick: (kind: WidgetKind) => void,
    private readonly existingKinds?: ReadonlySet<string>
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("hp-modal");
    this.titleEl.setText("添加组件");
    const grid = this.contentEl.createDiv({ cls: "hp-add-grid" });

    for (const definition of this.host.registry.list()) {
      const isThirdParty = !this.host.registry.isBuiltinKind(definition.kind);
      const card = grid.createDiv({ cls: `hp-add-card${isThirdParty ? " hp-add-card-user" : ""}` });
      card.style.setProperty("--hp-accent", definition.accent);
      const added = this.existingKinds?.has(definition.kind) ?? false;
      const iconCol = card.createDiv({ cls: "hp-add-icon-col" });
      setIcon(iconCol.createDiv({ cls: "hp-add-icon" }), definition.icon);
      if (added) iconCol.createSpan({ cls: "hp-add-card-added-tag", text: "已添加" });
      const text = card.createDiv({ cls: "hp-add-text" });
      const nameRow = text.createDiv({ cls: "hp-add-name-row" });
      nameRow.createDiv({ cls: "hp-add-name", text: definition.name });
      if (isThirdParty) nameRow.createSpan({ cls: "hp-add-card-custom-tag", text: "第三方" });
      text.createDiv({ cls: "hp-add-desc", text: definition.description });

      card.addEventListener("click", () => {
        this.close();
        this.onPick(definition.kind);
      });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export class ConfirmModal extends Modal {
  constructor(
    app: App,
    private readonly options: { title: string; message: string; confirmText?: string; danger?: boolean },
    private readonly onConfirm: () => void | Promise<void>
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(this.options.title);
    this.contentEl.createEl("p", { text: this.options.message });
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText("取消").onClick(() => this.close()))
      .addButton((button) => {
        button.setButtonText(this.options.confirmText ?? "确定").onClick(async () => {
          await this.onConfirm();
          this.close();
        });
        if (this.options.danger) button.setWarning();
        else button.setCta();
      });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export class PromptModal extends Modal {
  private value: string;

  constructor(
    app: App,
    private readonly options: { title: string; placeholder?: string; value?: string; confirmText?: string },
    private readonly onSubmit: (value: string) => void | Promise<void>
  ) {
    super(app);
    this.value = options.value ?? "";
  }

  onOpen(): void {
    this.titleEl.setText(this.options.title);
    let inputEl: HTMLInputElement | null = null;
    new Setting(this.contentEl).addText((text) => {
      inputEl = text.inputEl;
      text.setPlaceholder(this.options.placeholder ?? "").setValue(this.value).onChange((value) => {
        this.value = value;
      });
      text.inputEl.addClass("hp-setting-input-wide");
      text.inputEl.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          void this.submit();
        }
      });
    });
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText("取消").onClick(() => this.close()))
      .addButton((button) => button.setButtonText(this.options.confirmText ?? "确定").setCta().onClick(() => void this.submit()));
    window.setTimeout(() => inputEl?.focus(), 0);
  }

  private async submit(): Promise<void> {
    const value = this.value.trim();
    if (!value) return;
    await this.onSubmit(value);
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
