# Agent Note: Product-first root README

Status: implemented

English | [中文](2026-07-22-product-first-root-readme.zh.md)

## Problem

The root README is the repository's product entry point. Its product-first structure and established voice remain useful, but concrete entry points and capability claims drift as the runtime grows. Rewriting sections whose facts remain correct increases the review surface and discards language that already works.

## Decision

The root README is a compact product and contributor entry point. It states the product identity and plugin architecture, links the documentation site, names this checkout as a fork of [the upstream repository](https://github.com/deepseek-ai/deepseek-harness) with its bun 1.4 / TypeScript 7 toolchain, marks the developer-preview and safety status, and then gives the supported npm and source launch paths. The npm path runs the published `@deepseek-ai/dsh` package; the source path clones and builds this fork. Toolchain rationale lives in [the bun package-manager Agent Note](2026-08-29-bun-package-manager.md) and [the TypeScript 7 Agent Note](2026-08-29-typescript-7-compiler.md); contributor setup lives in the [development guide](../../../../docs/development.md).

Both launch paths start the Web UI through the `dsh` profile entry point. The source path builds the checkout before it runs `bun dsh web`. Detailed ACP, TUI, SDK, capability, and package guidance stays in the user guide, architecture documentation, and package map instead of being repeated on the landing page.

The remaining sections link community support, contribution guidance, development documentation, agent instructions, the license, and third-party notices. The English and Chinese README sides keep the same technical structure while their community links serve their language audiences. The documentation website keeps a separate [quick-start entry route](../../../../docs/user/index.md).

## Alternatives considered

**Rewrite the README around a new product narrative.** A complete rewrite can make every current surface prominent, but it replaces accurate, reviewed copy and creates unnecessary churn. Current facts fit the established product-first structure.

**Present the repository as an SDK and package catalog.** This exposes implementation breadth immediately but makes a new reader reconstruct the product from package names. The package map and generated capability graph remain the authoritative inventories.

**Use a long marketing page with screenshots, badges, and duplicated tutorials.** Rich media can demonstrate a stable product journey, but it ages separately from commands and source contracts. The root stays compact and links to runnable examples and owned guides.

**Project the root README as the documentation website home page.** A single landing page avoids two narratives, but the website's user guide and the repository's product/developer entry point have different navigation and maintenance needs. The documentation root sends readers to quick start instead.

## Consequences

Reviewers can distinguish factual refreshes from editorial rewrites, and future updates retain established wording unless its meaning becomes false or incomplete. The README must still change with affected commands, entry points, release-stage claims, or high-level capability families, while exhaustive detail remains linked rather than copied.
