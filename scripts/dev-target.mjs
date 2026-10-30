// 解析开发部署目标：<vault>/.obsidian/plugins/home-deck
// 优先级：环境变量 HOME_DECK_DEV_PLUGIN_DIR > 兼容 HOME_PAGES_DEV_PLUGIN_DIR > 仓库根的 .dev-target 文件
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

function readTargetFile() {
  const file = resolve(root, ".dev-target");
  if (!existsSync(file)) return null;
  const content = readFileSync(file, "utf8").trim();
  return content || null;
}

export function resolveDevTarget() {
  const raw =
    process.env.HOME_DECK_DEV_PLUGIN_DIR?.trim() ||
    process.env.HOME_PAGES_DEV_PLUGIN_DIR?.trim() ||
    readTargetFile();
  if (!raw) {
    throw new Error(
      "未配置开发部署目标：设置环境变量 HOME_DECK_DEV_PLUGIN_DIR，" +
      "或在仓库根创建 .dev-target 文件（一行，内容为 <vault>/.obsidian/plugins/home-deck 的绝对路径）"
    );
  }
  const target = resolve(raw);
  if (!isAbsolute(target) || target === parse(target).root || target === root) {
    throw new Error(`Refusing unsafe plugin deployment target: ${target}`);
  }
  return target;
}
