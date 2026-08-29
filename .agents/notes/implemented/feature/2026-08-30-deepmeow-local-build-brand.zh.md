# Agent Note: DeepMeow 本地构建品牌

Status: implemented

[English](2026-08-30-deepmeow-local-build-brand.md) | 中文

## 问题

从源码树启动的 `dsh web` 会话用本地化的 `common.brand.localBuild` 字符串、未填充的品牌标记 slot 回退，以及 `apps/web/public/favicon.svg` 标识自己。那套 chrome 是非 official 客户端构建的产品身份，必须与 `ui-brand-official` 仅在 `DSH_CLIENT_BUILD_PROFILE` 为 `official` 时注册的官方 DeepSeek Harness wordmark 保持区分。

## 决策

`common.brand.localBuild` 字典值在两种 locale 中均为 `DeepMeow`。`apps/web/index.html` 的 title 占位与 Vite `DEFAULT_CLIENT_TITLE` 与该名称一致，因此在未设置 `DSH_CLIENT_TITLE` 时，首份文档标题与 hydration 后的 locale 字符串相符。

未填充的 `sidebar.brand.mark` 与 `conversation.hero.brand.mark` slot 渲染 `CatLogo`，这是 `@deepseek-ai/dsh-client-ui-primitives` 中的方形 currentColor 猫脸标记。`FishLogo` 仍是官方鲸鱼填充。`apps/web/public/favicon.svg` 使用同一猫脸 path，并仍在浅色 scheme 下绘制 `#000`，在 `prefers-color-scheme: dark` 下绘制 `#fff`。Chromium 可安装性 PNG（`icon-192.png`、`icon-512.png`、带 80% 安全区的 maskable 配对，以及 `apple-touch-icon.png`）由该标记栅格化。安装 manifest 的 `theme_color` 与 `background_color` 为 `#ffffff`，与浅色 `--dsw-alias-bg-base`（`--dsw-static-neutral-bluish-00`）一致。运行时 `theme-color` 元数据仍由 presenter 持有的计算后 body 背景决定。

`@deepseek-ai/dsh-client-ui-brand-official` 仍在构建 profile 不是 `official` 时 no-op，因此 official 产物保留鲸鱼标记、DeepSeek Harness wordmark 以及 `DSH_CLIENT_TITLE`。

## 曾考虑的替代方案

**把 `FishLogo` 本身换成猫。** 不予采纳，因为官方品牌填充渲染 `FishLogo`；改那条 path 会改写官方鲸鱼标记。

**按 profile 分别发布 favicon。** 不予采纳，因为 `apps/web/public/` 不按 `DSH_CLIENT_BUILD_PROFILE` 拆分。Web 应用只随包发布一份 favicon。

**在 zh 字典中翻译 `DeepMeow`。** 不予采纳，因为它是自造产品名，两种 locale 均保留拉丁字母拼写（[术语](../../../../docs/i18n/terminology.md)）。

## 后果

本地 `dsh web` chrome 在侧栏、空白会话 hero、标签页图标、安装 manifest 和默认文档标题中显示 DeepMeow 与猫脸标记。official 构建仍用鲸鱼 wordmark 填充品牌 slot 并设置 `DSH_CLIENT_TITLE`，Vite closeBundle 会把该标题写入 `manifest.webmanifest`（`DeepSeek Harness` / `DSH`）。在 public 资源按 profile 拆分之前，它们共用这份猫 favicon 与栅格安装图标。本地版本芯片使用主题的 code-block-small 字体，不追加 dirty。locale、primitive、sidebar、layout、assembled-boot 与 PWA 测试固定该名称、标记几何、回退占用、favicon 的 color-scheme 切换、启动画面画布色以及 192/512 安装图标。
