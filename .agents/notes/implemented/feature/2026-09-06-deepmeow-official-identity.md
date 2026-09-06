# Agent Note: DeepMeow is the official client identity

Status: implemented

English | [中文](2026-09-06-deepmeow-official-identity.zh.md)

## Problem

[DeepMeow local-build brand](2026-08-30-deepmeow-local-build-brand.md) gave source builds the DeepMeow identity and left official artifacts carrying the DeepSeek Harness wordmark and whale mark: `ui-brand-official` registered upstream's occupants, and `officialClientBuildEnvironment` in [scripts/client-build-environment.ts](../../../../scripts/client-build-environment.ts) fixed `DSH_CLIENT_TITLE` to `DeepSeek Harness`. The `dsh` release family packs only official artifacts, so every packed release, and every installation made from one, shipped DeepSeek's brand. This repository is no longer a fork of deepseek-ai/deepseek-harness, and [BRAND_GUIDELINES.md](../../../../BRAND_GUIDELINES.md) asks projects not to present DeepSeek's trademark as their own.

## Decision

The `official` client build profile carries the DeepMeow identity. `OFFICIAL_CLIENT_BUILD_ENVIRONMENT` sets `DSH_CLIENT_TITLE` to `DeepMeow`, so the document title and every install-manifest member read the committed placeholder name, and `projectManifestTitle` in [scripts/client-document-title.ts](../../../../scripts/client-document-title.ts) writes the selected title into `name`, `short_name`, and `description` alike; no launcher label is abbreviated. `@deepseek-ai/dsh-client-ui-brand-official` still registers only under the `official` profile, and its occupants render `CatLogo` and the text `DeepMeow` from a package stylesheet sized like the sidebar's fallback name. `DeepMeow` joins the brand tokens that `verify-client-ui-i18n` exempts from the dictionaries. `FishLogo` and `BrandWordmark` stay exported from `ui-primitives` as artwork nothing shipped renders.

## Alternatives considered

**Add a `deepmeow` artifact profile beside `official`.** Rejected because the release family accepts exactly one artifact profile, and nothing in this repository ships DeepSeek's identity any more; a second profile would keep dead branding alive.

**Compose a separate brand package into the slots.** Rejected because `ui-brand-official` already owns the official occupants and the profile gate; replacing its artwork is the smaller change.

**Remove `FishLogo` and `BrandWordmark`.** Rejected here because the primitives library exports them as artwork, and their removal is a separate decision with its own tests and README coverage.

## Consequences

Official artifacts, source builds, and every installation made from a packed release show DeepMeow and the cat-face mark in the sidebar, the blank-session hero, the tab icon, the install manifest, and the document title. What separates a source build from an official artifact is the build record: `DSH_CLIENT_BUILD_PROFILE`, `DSH_CLIENT_COMMIT_HASH`, and `DSH_CLIENT_VERSION`. `scripts/client-build-environment.client.spec.ts`, `scripts/client-document-title.spec.ts`, the `ui-brand-official` tests, and the built web boot expectation pin the identity for both profiles. The [Web UI guide](../../../../docs/user/guide/index.md#build-identity) is the user-facing home for the identity.
