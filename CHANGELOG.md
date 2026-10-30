# Changelog

## 1.0.0 — 2026-10-30

First release as **Home Deck** (`home-deck`), an independent fork of Home Pages.

### Added

- Unified custom-widget loader: built-ins and `.js` scripts in the configured folder register into the same `WidgetRegistry` and share rendering/refresh/config services.
- Automatic one-time migration from `home-pages-star-nebula` / `home-pages` `data.json`; the old plugin's data is never modified.
- Incremental `VaultIndex` with structural/content/metadata event handling and coalesced notifications.
- Path-scoped, visibility-aware card refresh (`refreshScope`, `IntersectionObserver`).
- `MtimeCache` for repeated plugin JSON / annotation / `.duowei` reads.
- Migration, path-scope, and repository tests (`tests/core.test.ts`).
- CSS dead-selector audit script (`npm run audit:css`).

### Changed

- Rebranded plugin id, name, view type, ready event, data paths, and docs to Home Deck.
- Instance-scoped `WidgetRegistry`, `SettingsRepository`, `LayoutStore`, and `VaultIndex`.
- All 19 widgets and their persisted kinds/configs are preserved.
- Media sync is gated on card visibility and no longer runs on unrelated vault edits.
- Card bodies are reused across renders; scroll positions are preserved.
- Module-level media/doc/MOC caches are disposed on plugin unload.

### Removed

- Paste/demo modals and the old bespoke script manager; custom scripts now load from a configurable folder through the unified registry.
- Dead exports (`getTagCount`, `earliestVaultDay`, `executeCommand`, `OpmlCategorySummary`, `loadMediaData`).
- Duplicate date/path/plugin-JSON/duowei helpers.
- Stale `RELEASE_NOTES*.md`, `docs/多维表格视图结合方案.md`, and `examples/vault-heatmap.js`.
- Unused insights config fields (`duoweiTitleField`, `duoweiStatusField`, `duoweiSummaryFields`).
