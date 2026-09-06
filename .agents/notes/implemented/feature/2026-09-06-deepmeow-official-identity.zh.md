# Agent Note: DeepMeow 是官方客户端身份

Status: implemented

[English](2026-09-06-deepmeow-official-identity.md) | 中文

## 问题

[DeepMeow 本地构建品牌](2026-08-30-deepmeow-local-build-brand.zh.md)让源码构建拥有 DeepMeow 身份，却让 official 产物继续承载 DeepSeek Harness wordmark 与鲸鱼标记：`ui-brand-official` 注册的是上游的填充，[scripts/client-build-environment.ts](../../../../scripts/client-build-environment.ts) 中的 `officialClientBuildEnvironment` 把 `DSH_CLIENT_TITLE` 固定为 `DeepSeek Harness`。`dsh` 发布族只打包 official 产物，因此每一份打包发布以及由它安装出的每一个部署都带着 DeepSeek 的品牌。本仓库已不再是 deepseek-ai/deepseek-harness 的 fork，而 [BRAND_GUIDELINES.md](../../../../BRAND_GUIDELINES.zh.md) 要求各项目不要把 DeepSeek 的商标当作自己的呈现。

## 决策

`official` 客户端构建 profile 承载 DeepMeow 身份。`OFFICIAL_CLIENT_BUILD_ENVIRONMENT` 把 `DSH_CLIENT_TITLE` 设为 `DeepMeow`，因此文档标题与安装 manifest 的每个成员都读作已提交的占位名称；[scripts/client-document-title.ts](../../../../scripts/client-document-title.ts) 中的 `projectManifestTitle` 把所选标题同样写入 `name`、`short_name` 与 `description`，不再缩写任何启动器标签。`@deepseek-ai/dsh-client-ui-brand-official` 仍只在 `official` profile 下注册，其填充渲染 `CatLogo` 与文本 `DeepMeow`，样式来自包内样式表，尺寸与侧栏回退名称一致。`DeepMeow` 加入 `verify-client-ui-i18n` 豁免于字典之外的品牌 token。`FishLogo` 与 `BrandWordmark` 仍从 `ui-primitives` 导出，作为没有任何已发布内容渲染的美术资源保留。

## 曾考虑的替代方案

**在 `official` 之外增加 `deepmeow` 产物 profile。** 不予采纳，因为发布族只接受一个产物 profile，而本仓库已不再发布任何 DeepSeek 身份；第二个 profile 只会让已死的品牌继续存活。

**把另一个品牌包组合进这些槽位。** 不予采纳，因为 `ui-brand-official` 已经拥有官方填充与 profile 门控；替换其美术资源是更小的改动。

**移除 `FishLogo` 与 `BrandWordmark`。** 在此不予采纳，因为 primitives 库把它们作为美术资源导出，移除是另一项决策，需要各自的测试与 README 覆盖。

## 后果

official 产物、源码构建，以及由打包发布安装出的每一个部署都在侧栏、空白会话 hero、标签页图标、安装 manifest 与文档标题中显示 DeepMeow 与猫脸标记。区分源码构建与 official 产物的是构建记录：`DSH_CLIENT_BUILD_PROFILE`、`DSH_CLIENT_COMMIT_HASH` 与 `DSH_CLIENT_VERSION`。`scripts/client-build-environment.client.spec.ts`、`scripts/client-document-title.spec.ts`、`ui-brand-official` 的测试以及已构建 Web 启动期望为两种 profile 固定该身份。[Web UI 指南](../../../../docs/user/guide/index.zh.md#build-identity)是该身份面向用户的归属文档。
