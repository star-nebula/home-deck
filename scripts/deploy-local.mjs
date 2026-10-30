// 把构建产物复制到本地库的插件目录：
//   HOME_DECK_DEV_PLUGIN_DIR="<vault>/.obsidian/plugins/home-deck" npm run deploy
// 目标路径也可以写在仓库根的 .dev-target 文件里（与 npm run dev 共用）。
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDevTarget } from "./dev-target.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const target = resolveDevTarget();
mkdirSync(target, { recursive: true });
const manifest = JSON.parse(readFileSync(resolve(root, "manifest.json"), "utf8"));
for (const fileName of ["main.js", "styles.css", "manifest.json"]) {
  const source = resolve(root, fileName);
  if (!existsSync(source)) throw new Error(`Build artifact missing: ${source}`);
  copyFileSync(source, resolve(target, fileName));
}
console.log(`Deployed Home Deck ${manifest.version} to ${target}`);
