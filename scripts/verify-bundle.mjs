import { readFile } from "node:fs/promises";

const bundlePath = new URL("../main.js", import.meta.url);
const manifestPath = new URL("../manifest.json", import.meta.url);
const bundle = await readFile(bundlePath, "utf8");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

const forbiddenPatterns = [
  {
    name: "dynamic script element creation",
    pattern: /\.(?:createElement|createEl)\(\s*["']script["']\s*\)/g
  },
  {
    name: "eval()",
    pattern: /(?:^|[^\w$.])eval\s*\(/g
  }
];

const failures = forbiddenPatterns
  .map(({ name, pattern }) => ({ name, count: bundle.match(pattern)?.length ?? 0 }))
  .filter(({ count }) => count > 0);

if (manifest.id !== "home-deck" || manifest.name !== "Home Deck" || manifest.author !== "star-nebula") {
  failures.push({ name: `manifest identity (got ${manifest.id} / ${manifest.name} / ${manifest.author})`, count: 1 });
}
if (!bundle.includes("Home Deck — Obsidian homepage dashboard plugin")) {
  failures.push({ name: "bundle banner", count: 1 });
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`${failure.name}: ${failure.count} occurrence(s)`);
  }
  process.exit(1);
}

console.log("Bundle security check passed: no dynamic script elements or eval(); custom widget scripts are loaded by design.");
