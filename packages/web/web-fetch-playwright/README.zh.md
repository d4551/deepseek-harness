---
description: "ctx.web 的 Playwright Chromium 渲染页抓取后端：部署方如何挂载 DOM 渲染式 URL 抓取，含匿名隐身上下文、单一共享浏览器进程与有界输出。"
kind: "package-reference"
---

# @deepseek-ai/dsh-web-fetch-playwright

[English](README.md) | 中文

## 概述

有了 `dsh-web-fetch-playwright`，harness 可以通过 web 服务（`ctx.web`）抓取 JavaScript 渲染的页面：它在无头 Chromium 浏览器中加载每个 URL，等待 DOM，并返回序列化文档。当组合需要纯 HTTP 抓取无法产出的内容时选择它——单页应用的客户端渲染 DOM、用脚本构建内容的页面，或任何只有在执行后才存在有效标记的文档。它像 HTTP 后端一样保持匿名：不携带凭据，抓取之间不共享 Cookie，每次渲染都隔离在全新的隐身上下文中。面向模型的 `web_fetch` 工具位于 `dsh-tool-web`，由它渲染本提供方的正文。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [行为边界](#behavior-boundaries)
- [模型体验](#model-experience)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在已加载 web 服务的组合中挂载本提供方；它以 `playwright` 抓取提供方身份注册。因为它耗费一个浏览器进程，所以它是显式选择项——用 `fetchProvider: playwright` 固定它，让服务只在被请求时选中它；页面在服务端渲染时优先使用 `dsh-web-fetch-http`。

### 何时选择

当部署必须抓取内容由客户端脚本构建、而纯 HTTP 后端只会返回空壳的页面时选择此后端：单页应用、脚本拼装的文档，或需要真实 DOM 才能产出标记的页面。它要求主机上装有 Chromium（`playwright` 的浏览器二进制）。

### 最小配置

加载 web 服务、为抓取选中本提供方，再挂载本提供方；可配置上限都有安全默认值，并在插件构造时验证，因此无效值会响亮地失败，而不是构造出上限荒谬的提供方。

```yaml
- name: '@deepseek-ai/dsh-web'
  with:
    fetchProvider: playwright
- name: '@deepseek-ai/dsh-web-fetch-playwright'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxBodyChars` | `100,000` | 序列化 DOM 最大字符数 |
| `timeoutMs` | `30,000` | 每次抓取预算——资源兜底，不是面向模型的工具预算 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web-fetch-playwright)是每个受支持字段及其 JSDoc 的穷尽式真源。

### 抓取返回什么

成功调用产生 `WebFetchResult`：导航（含重定向）之后页面的最终 URL、主导航的 HTTP 状态码（合成导航报告 `200`）、以 `html` 正文分类的序列化 DOM，以及文档超过 `maxBodyChars` 时的 `truncated` 标志。非 2xx 状态是结果而非错误——`WebError` 只用于启动、导航或序列化失败。

### 渲染行为

本提供方在共享的抓取 URL 策略下只接受不带嵌入凭据的 `http:` 与 `https:` URL。每次抓取在单一共享浏览器进程中打开全新隐身上下文，以 `domcontentloaded` 导航，序列化 DOM，并关闭页面与上下文；任何 Cookie、存储或身份验证都不会跨越一次抓取存活。浏览器进程在首次使用时惰性启动，跨抓取复用，在插件销毁时关闭，并在死亡后重新全新启动。缺少 Chromium 安装会在首次使用时以 `WEB_PROVIDER_ERROR` 暴露。

### 失败与恢复

失败抛出带可机读路由代码的 `WebError`：`WEB_INVALID_URL`、`WEB_BLOCKED_URL`、`WEB_FETCH_TIMEOUT`、`WEB_ABORTED` 或 `WEB_PROVIDER_ERROR`。使用 `ctx.web.fetch` 的调用方按代码路由；面向模型的 `web_fetch` 工具在其自身的错误信封中向模型呈现失败文本。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

本节解释提供方背后的设计决策；可观测行为已完整覆盖于[使用本包](#use-this-package)。

### 设计哲学

本包建立在一处分离与一个分层超时之上：

- **渲染抓取与呈现分离。** 本提供方拥有 URL 校验、浏览器生命周期、导航、DOM 序列化与字符上限；`dsh-tool-web` 拥有 HTML→markdown 与截断格式化。非 2xx 导航是数据而非失败。
- **两层超时。** 提供方的 `timeoutMs` 是资源兜底，同时限定 Playwright 自身的导航超时；面向模型的工具调用预算属于 `dsh-tool-call-timeout-policy`，由它武装 `exec.signal`。当外层期限先到时，提供方报告 `WEB_ABORTED`，该策略将其替换为 `TOOL_TIMEOUT`；因此 `WEB_FETCH_TIMEOUT` 标识的是提供方预算耗尽的服务调用方。

### 源码地图

| 文件 | 角色 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置模式、上限验证、提供方注册、销毁时关闭浏览器 |
| [`src/provider.ts`](src/provider.ts) | `PlaywrightFetchProvider`：共享浏览器生命周期、隐身渲染、DOM 序列化 |
| [`src/invariant.ts`](src/invariant.ts) | 不变量伴随文件（无运行时不变量；上限在提供方中强制执行） |

### 读取路径

一次抓取校验 URL，复用或启动共享浏览器，并打开全新隐身上下文与页面。它在提供方超时下以 `domcontentloaded` 导航，序列化 DOM，并在返回前关闭页面与上下文——因此即使序列化失败，清理也会执行。死亡或启动失败的浏览器会清除被记忆的句柄，使下一次抓取重试而不是钉死一个坏进程。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级契约不够用时阅读这些页面。它们从共享词汇表走向服务、面向模型的工具与设计依据。

- [Web 子系统](../../../docs/subsystems/web.md)——穷尽的抓取请求/结果词汇表与错误代码。
- [Web 包地图](../README.md)——七个包的家族与各自角色。
- [dsh-web](../web/README.md)——本提供方注册进入的 web 服务。
- [dsh-web-fetch-http](../web-fetch-http/README.zh.md)——面向服务端渲染页面的匿名 HTTP 后端；两个抓取后端覆盖互补的页面类别。
- [dsh-tool-web](../tool-web/README.zh.md)——渲染本提供方正文的面向模型 `web_fetch` 工具。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web-fetch-playwright)——每个受支持配置字段及其源声明。
- [Web 能力缝决策](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md)——为什么搜索与抓取共享一个提供方选择服务。

-----

<a id="behavior-boundaries"></a>
## 行为边界

这些边界定义本提供方不尝试的事情；它们是当前的包契约。

- **不做 DOM 后等待**——导航在 `domcontentloaded` 处 settle；仅在网络后续活动、懒加载或水合之后才出现的内容不会出现在序列化 DOM 中。显式的 network-idle 等待是这里下一个要添加的能力。
- **每次抓取都是匿名的**——没有 Cookie 或会话持久化；要求登录的页面返回其未登录标记，本家族中没有抓取后端执行身份验证检索。
- **宿主浏览器依赖**——Chromium 必须通过 `playwright` 的浏览器二进制安装；缺少安装会使首次抓取以 `WEB_PROVIDER_ERROR` 失败。

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过 `dsh-tool-web`：该工具把本提供方经 `maxBodyChars` 限制的序列化 DOM 转换为 markdown 置于抓取结果内。

#### KV Cache 影响

不会直接导致 KV Cache 失效；请求前缀变更由上述消费方负责。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

无。

</details>
