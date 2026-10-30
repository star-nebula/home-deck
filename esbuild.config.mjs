import esbuild from "esbuild";
import process from "process";
import { builtinModules } from "node:module";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const prod = process.argv[2] === "production";
const watch = process.argv.includes("--watch");

// watch 模式下每次重建后自动同步产物到开发库（目标见 scripts/dev-target.mjs）
async function deployToDevTarget() {
  try {
    const { resolveDevTarget } = await import("./scripts/dev-target.mjs");
    const target = resolveDevTarget();
    mkdirSync(target, { recursive: true });
    for (const fileName of ["main.js", "styles.css", "manifest.json"]) {
      const source = resolve(root, fileName);
      if (existsSync(source)) copyFileSync(source, resolve(target, fileName));
    }
    console.log(`[deploy] synced to ${target} — reload the plugin in Obsidian to see changes`);
  } catch (error) {
    console.warn(`[deploy] skipped: ${error instanceof Error ? error.message : error}`);
  }
}

const context = await esbuild.context({
  banner: { js: "/* Home Deck — Obsidian homepage dashboard plugin */" },
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", ...builtinModules],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  minify: prod,
  outfile: "main.js"
});

if (watch) {
  // esbuild 的 watch 回调只在增量重建时触发，首次构建手动同步
  await context.rebuild();
  await deployToDevTarget();
  await context.watch(() => {
    void deployToDevTarget();
  });
} else {
  await context.rebuild();
  process.exit(0);
}
