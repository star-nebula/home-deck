# Home Deck for Obsidian

A fast, customizable homepage dashboard for Obsidian. Home Deck gives you a 12-column adaptive grid, draggable and resizable cards, multiple pages, and 19 built-in widgets. Layouts and settings stay local in `data.json` — no analytics, telemetry, or hidden network tracking.

> **Project origin:** Home Deck is an independent fork of [jepicaju862-lab/home-pages](https://github.com/jepicaju862-lab/home-pages) (GPL-3.0), maintained by [star-nebula](https://github.com/star-nebula). All credit for the original work goes to its author. Plugin id: `home-deck`.
>
> **Migrating from Home Pages?** Install Home Deck, enable it once, and your layout is copied from `.obsidian/plugins/home-pages-star-nebula/data.json` automatically. The old plugin and its data are left untouched. A backup is written to `.obsidian/plugins/home-deck/data.pre-migration.json`.

## Features

| Area | Widgets |
| :--- | :--- |
| **Dashboard basics** | Welcome banner with clock/weather/vault stats, recent notes, quick access tiles, countdown & anniversaries, daily quote, note embed |
| **Focus & planning** | Pomodoro timer, task kanban, habit tracker, daily note diary, “on this day” review |
| **Vault insight** | All-notes index, knowledge map, vault statistics |
| **Optional integrations** | Duowei table digest, annotation inbox, WeChat inbox, integrated feed, mainstream media / RSS reader |

Highlights:

- **12-column adaptive grid** that reflows on desktop, tablet, and mobile.
- **WYSIWYG layout editing** — drag cards, resize with the corner handle, duplicate/delete, and reorder pages.
- **Multiple dashboards** (e.g. Work, Life, Projects) with draggable tabs.
- **JSON import/export** for backup and cross-vault migration.
- **Path-scoped refresh** — only cards affected by a file change re-render, and hidden cards stay idle. Large vaults stay responsive.

## Installation

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest release.
2. Create `<vault>/.obsidian/plugins/home-deck/`.
3. Copy the three files into that folder.
4. Enable **Home Deck** in **Settings → Community plugins**.

Minimum Obsidian version: **1.7.2**. Desktop and mobile are supported.

## Layout editing

Click **Edit layout** in the view header:

- Drag a card by its title/grip to reorder; drag the bottom-right handle to resize.
- Use the edit bar to move, resize, configure, duplicate, or delete a card.
- Drag page tabs to reorder; right-click a tab to rename, move, or delete it.
- Press `Esc` to cancel an in-progress drag or resize.

## Host API for plugin developers

Other plugins can register widgets without patching Home Deck:

```ts
const api = app.plugins.plugins["home-deck"]?.api;
// Or listen for the "home-deck:ready" workspace event.

const unregister = api.registerWidget(myWidgetDefinition, "my-plugin-id");

api.pinWidget("my-widget-kind", { ref: "note-path" }, {
  title: "My Pinned View",
  w: 6,
  h: 4,
  provider: "my-plugin-id"
});

api.refresh("my-widget-kind");
api.ui.renderKpi(containerEl, { label: "Completed", value: 12 });
api.ui.renderEmpty(containerEl, { message: "No data available" });
```

A widget definition is the same object described in `src/core/ports.ts`: `kind`, `name`, `description`, `icon`, `accent`, `defaultSize`, `defaultConfig`, `render`, `renderSettings`, and optional refresh flags / `refreshScope`.

### Custom widgets (unified loader)

Place `.js` widget scripts in `<plugin-dir>/widgets/` (the folder next to `main.js`). They are evaluated and registered into the same `WidgetRegistry` as built-in widgets, so they share rendering, refresh, configuration, and the Host API. On first upgrade, scripts from the legacy `.obsidian/home-pages-widgets` folder are copied into `<plugin-dir>/widgets/`; the old folder is left as a backup.

Auto-add is **off by default**: loading a script does not create a card. Add it from the **Add widget** panel when you want it. Scripts are loaded after the dashboard opens; unchanged files are skipped by mtime, and a 60-second fallback scan covers the plugin's hidden folder.

> **Security:** custom scripts execute arbitrary JavaScript with plugin privileges. Only load scripts you trust.

## Development

```bash
npm install
npm run dev        # esbuild watch; syncs main.js/manifest.json/styles.css to .dev-target
npm run lint
npm run build      # tsc + production bundle + security/identity check
npm test           # integration + core migration/index tests
npm run test:sorting  # Playwright layout tests (requires playwright)
npm run deploy     # copy build output to HOME_DECK_DEV_PLUGIN_DIR
```

Set the dev target with `HOME_DECK_DEV_PLUGIN_DIR` or a one-line `.dev-target` file containing the absolute plugin directory. See `docs/development.md`.

Source layout:

```text
src/core/        identity, persisted types, ports, registry, settings repository, layout store, migrations
src/services/    incremental VaultIndex, mtime cache
src/widgets/     the 19 built-in widgets + builtins.ts
src/ui/          shared DOM, modal, settings, and sorting helpers
src/view.ts      HomeView + per-card WidgetHost
src/main.ts      plugin lifecycle and service wiring
```

## Privacy

Home Deck reads only the local vault and local plugin data. Weather, media/RSS, and optional integrations make network requests only when their card is visible or refreshed; no usage data is collected.

## License

[GNU General Public License v3.0](LICENSE).
