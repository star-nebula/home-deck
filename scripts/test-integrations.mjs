// 把测试与 obsidian 桩一起打包后在 Node 里运行（不需要启动 Obsidian）。
//   HOME_PAGES_TEST_VAULT=<含测试数据的库路径> node scripts/test-integrations.mjs
import esbuild from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

mkdirSync("tests/.out", { recursive: true });
const entries = ["tests/integrations.test.ts", "tests/core.test.ts"];

for (const entry of entries) {
  const name = entry.split("/").pop().replace(/\.ts$/, ".mjs");
  const outfile = `tests/.out/${name}`;
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "es2022",
    outfile,
    alias: { obsidian: resolve("tests/obsidian-stub.ts") },
    logLevel: "warning"
  });
  const result = spawnSync(process.execPath, [outfile], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
