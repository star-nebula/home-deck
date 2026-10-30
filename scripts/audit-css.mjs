// 开发辅助：列出 styles.css 中未在 src/ 出现的 class 选择器。
// 动态类（hp-card-${kind}、is-range-*、tone-N 等）会被误报，请人工复核后再删。
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

async function collectSources(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  let text = "";
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) text += await collectSources(path);
    else if (entry.name.endsWith(".ts")) text += await readFile(path, "utf8");
  }
  return text;
}

const css = await readFile("styles.css", "utf8");
const sources = await collectSources("src");
const classes = new Set();
for (const match of css.matchAll(/\.([a-zA-Z_][\w-]*)/g)) classes.add(match[1]);

const missing = [...classes].filter((name) => !sources.includes(name)).sort();
console.log(`styles.css classes: ${classes.size}`);
console.log(`not found in src/: ${missing.length}`);
for (const name of missing) console.log(`  .${name}`);
