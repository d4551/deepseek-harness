# Agent Note: DeepMeow local-build brand

Status: implemented

English | [中文](2026-08-30-deepmeow-local-build-brand.zh.md)

## Problem

A source-tree `dsh web` session identifies itself with the localized `common.brand.localBuild` string, the unfilled brand-mark slot fallback, and `apps/web/public/favicon.svg`. That chrome is the product identity of a non-official client build, and it must stay distinct from the official DeepSeek Harness wordmark that `ui-brand-official` registers only when `DSH_CLIENT_BUILD_PROFILE` is `official`.

## Decision

The `common.brand.localBuild` dictionary value is `DeepMeow` in both locales. The `apps/web/index.html` title placeholder, the `name`, `short_name`, and `description` members of `apps/web/public/manifest.webmanifest`, and `DEFAULT_CLIENT_TITLE` in [scripts/client-document-title.ts](../../../../scripts/client-document-title.ts) all carry that one name, so the first document title agrees with the hydrated locale string when `DSH_CLIENT_TITLE` is unset. That module owns the projection for both documents: it HTML-escapes the title for the index element, JSON-encodes it for each manifest member, and throws when a document has lost a placeholder, so a build that sets `DSH_CLIENT_TITLE` can neither leave a `DeepMeow` member behind nor ship HTML entities inside JSON. The index document also declares `color-scheme: light dark` so the tab icon and UA chrome can resolve before the theme presenter writes `html { color-scheme }`.

Unfilled `sidebar.brand.mark` and `conversation.hero.brand.mark` slots render `CatLogo`, a square currentColor cat-face mark in `@deepseek-ai/dsh-client-ui-primitives`. `FishLogo` remains the official whale occupant. `apps/web/public/favicon.svg` uses the same cat-face path and still paints `#000` in light color scheme and `#fff` under `prefers-color-scheme: dark`. Chromium installability PNGs (`icon-192.png`, `icon-512.png`, maskable pairs with an 80% safe zone, and `apple-touch-icon.png`) are rasterized from that mark. The install manifest `theme_color` and `background_color` are `#ffffff`, matching light `--dsw-alias-bg-base` (`--dsw-static-neutral-bluish-00`). Runtime `theme-color` metadata stays the presenter-owned computed body background.

`@deepseek-ai/dsh-client-ui-brand-official` still no-ops unless the build profile is `official`, so official artifacts keep the whale mark, the DeepSeek Harness wordmark, and `DSH_CLIENT_TITLE`.

## Alternatives considered

**Replace `FishLogo` itself with a cat.** Rejected because official brand occupants render `FishLogo`; changing that path would recast the official whale mark.

**Ship a profile-specific favicon.** Rejected because `apps/web/public/` is not split by `DSH_CLIENT_BUILD_PROFILE`. One favicon ships with the web app.

**Translate `DeepMeow` in the zh dictionary.** Rejected because it is a coined product name and stays in Latin letters in both locales ([terminology](../../../../docs/i18n/terminology.md)).

## Consequences

Local `dsh web` chrome shows DeepMeow and the cat-face mark in the sidebar, the blank-session hero, the tab icon, the install manifest, and the default document title. Official builds still fill brand slots with the whale wordmark and set `DSH_CLIENT_TITLE`, and the Vite closeBundle step copies that title into `manifest.webmanifest` (`name` and `description` `DeepSeek Harness`, `short_name` `DSH`). They share the cat favicon and raster install icons until public assets are profile-split. The local version chip uses the theme code-block-small font and does not append dirty. Locale, primitive, sidebar, layout, assembled-boot, and PWA tests pin the name, mark geometry, fallback occupancy, favicon color-scheme switch, splash canvas color, and 192/512 install icons; `scripts/client-document-title.spec.ts` pins the projection of the committed index document and install manifest for the local, official, and hostile-character titles. The [Web UI guide](../../../../docs/user/guide/index.md#local-build-identity) is the user-facing home for this identity, and the root README links it from the fork description.
