---
description: "ctx.web 的 Playwright Chromium 渲染页抓取后端：部署方如何挂载 DOM 渲染式 URL 抓取，含匿名隐身上下文、单一共享浏览器进程与有界输出。"
kind: "package-reference"
---

# @deepseek-ai/dsh-web-fetch-playwright

[English](README.md) | 中文

## 概述

有了 `dsh-web-fetch-playwright`，harness 可以通过 web 服务（`ctx.web`）抓取 JavaScript 渲染的页面：它在无头 Chromium 浏览器中加载每个 URL，等待 DOM，并返回序列化文档。当组合需要纯 HTTP 抓取无法产出的内容时选择它——单页应用的客户端渲染 DOM、用脚本构建内容的页面，或任何只有在执行后才存在有效标记的文档。它像 HTTP 后端一样保持匿名：不携带凭据，抓取之间不共享 Cookie，每次渲染都隔离在全新的隐身上下文中。页面抵达的每个目标——主框架、子资源、重定向指向的每一跳，以及其页面与框架打开的每个 WebSocket——都要通过共享的抓取 URL 策略，并且只有目标是公网单播地址时才被放行；与 HTTP 后端不同，浏览器在连接时会再次解析主机名，因此这项检查放行的是目标，而不是把连接钉死到某个地址。面向模型的 `web_fetch` 工具位于 `dsh-tool-web`，由它渲染本提供方的正文。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [行为边界](#behavior-boundaries)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在已加载 web 服务的组合中挂载本提供方；它以 `playwright` 抓取提供方身份注册。它是随发行版交付的抓取路线：`dsh` 基础组合包固定了 `fetchProvider: playwright`，因此基于该核心构建的每个 profile 都进行渲染。想改用纯 HTTP 后端的组合——因为无法安装浏览器，或因为需要地址钉死——应在 `web` 行上声明 `fetchProvider: http`。

### 何时选择

当部署必须抓取内容由客户端脚本构建、而纯 HTTP 后端只会返回空壳的页面时选择此后端：单页应用、脚本拼装的文档，或需要真实 DOM 才能产出标记的页面。它要求主机上装有 Chromium（`playwright` 的浏览器二进制）。

### 安装浏览器

本仓库中没有任何步骤会替你下载这个 Chromium：`playwright` 不带 postinstall 步骤，因此全新克隆只有包而没有浏览器。在这样的主机上固定 `fetchProvider: playwright` 的组合，挂载出的提供方会被 seam 判定为不可用，之后每次 `web_fetch` 都以 `WEB_PROVIDER_CONFIGURED_UNAVAILABLE` 失败。由于随发行版交付的 profile 固定了这条路线，该安装是一个必需的部署步骤，基础组合包的 README 与此处都作了说明。在仓库根目录执行一次安装：

```sh
node packages/web/web-fetch-playwright/node_modules/playwright/cli.js install chromium
```

之所以写出显式路径，是因为 `playwright` 是本包的工作区依赖，而不是仓库根目录的依赖：在根目录执行裸的 `playwright install chromium` 找不到该命令，而 `npx playwright install chromium` 会另行下载一份无关的包副本来运行。在本仓库之外，`playwright` 是消费方自己的依赖，`npx playwright install chromium` 就是同一操作。插件的 apply 期警告与启动失败都会打印它所解析到的那份安装对应的命令，因此消息在任何阅读处都点名一条可运行的命令。当 `playwright` 本身缺失时——它是 peer 依赖，部署可以在没有它的情况下挂载本插件——该命令会一并安装这个包及其浏览器，因为只装浏览器会让提供方仍然无法启动它。

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
| `maxConcurrentRenders` | `2` | 同时持有浏览器上下文的渲染数；其余按到达顺序排队 |
| `userAgent` | `deepseek-harness/0.0.1 (+https://github.com/deepseek-ai)` | 每个渲染请求携带的 `User-Agent` |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web-fetch-playwright)是每个受支持字段及其 JSDoc 的穷尽式真源。

### 抓取返回什么

成功调用产生 `WebFetchResult`：导航（含重定向）之后页面的最终 URL、主导航的 HTTP 状态码（合成导航报告 `200`）、以 `html` 正文分类的序列化 DOM，以及文档超过 `maxBodyChars` 时的 `truncated` 标志。非 2xx 状态是结果而非错误——`WebError` 只用于启动、导航或序列化失败。

### 渲染行为

本提供方在共享的抓取 URL 策略下只接受不带嵌入凭据的 `http:` 与 `https:` URL。随后它在目标可能抵达的全部三条通道上把守该上下文——请求拦截器、WebSocket 拦截器，以及上下文自己的请求观察器（重定向的那一跳在此出现）——并且只有目标是公网单播地址时才放行。被拒绝的请求以 `blockedbyclient` 中止；被拒绝的 WebSocket 在抵达任何服务器之前以关闭码 `1008` 关闭；被拒绝的导航目标在任何浏览器工作开始前报告 `WEB_BLOCKED_URL`；而被拒绝的重定向跳转会让整次抓取以 `WEB_BLOCKED_URL` 失败，判定发生在导航之后、读取文档之前。`ws:` 与 `wss:` 沿用 `http:` 与 `https:` 的规则，并且每个主机名的判定在一次抓取的生命周期内被记忆，因此一次页面加载对每个主机只判定一次，`wss://host` 复用 `https://host` 的判定结果。

三者都在上下文尚未拥有页面时安装，因为 Playwright 只路由处理器存在之后打开的 WebSocket；每个上下文都禁止 Service Worker，因为 Service Worker 发出的请求不会经过请求拦截器。重定向的那一跳会让整次抓取失败，而不是只失败一个请求：Chromium 报告它时页面已经拿到了该跳的响应，只中止单个请求会把它的字节留在本提供方即将序列化的文档里。请求拦截器覆盖专用 Worker 发出的请求；WebSocket 拦截器不覆盖专用 Worker 打开的连接，此点记录于下文。

这项检查放行的是目标，而不是把连接钉死。`dsh-web-fetch-http` 只解析一次主机名，并把连接钉死到它校验过的地址上。Chromium 在连接时会自行再次解析主机名，因此某个名字若在策略判定时返回公网地址、在浏览器连接时返回私有地址，就会抵达那个私有地址——参见[已知限制与延期工作](#known-limitations-and-deferred-work)。

每次抓取在单一共享浏览器进程中打开全新隐身上下文，以 `domcontentloaded` 导航，序列化 DOM，并关闭页面与上下文；任何 Cookie、存储或身份验证都不会跨越一次抓取存活。同时最多有 `maxConcurrentRenders` 次抓取持有上下文；其余按到达顺序等待，并在自身期限中止时放弃。

插件在 apply 期间探测一次 Chromium 安装——只对启动时会运行的可执行文件做一次文件系统检查，而不是启动一个浏览器进程——并在该可执行文件缺失时记录一条点名安装命令的警告，因此服务读到可用性，既不必在每次选择时探测，也不必在每次启动时拉起浏览器。浏览器进程本身在首次抓取时惰性启动并被复用；启动失败或进程死亡会清除记忆值，使下一次抓取重试。销毁是终态：它取消进行中的渲染、关闭进程——包括某次并发渲染在销毁等待期间打开的那个进程——并让之后的每次抓取都以 `WEB_PROVIDER_ERROR` 失败。

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
- **在浏览器边缘执行地址策略。** 公网目标规则由拦截而非仅靠 URL 校验来把守：渲染中的页面会抵达调用方从未指名的目标，因此同一策略要裁决主框架、每个子资源、重定向指向的每一跳以及每个 WebSocket。每类目标都从各自的 Playwright 通道抵达——请求拦截器、WebSocket 拦截器，以及上下文的请求观察器，后者是浏览器自行跟随的那一跳唯一出现的通道。只接在一条通道上的策略也就只覆盖那一条通道。
- **两层超时。** 提供方的 `timeoutMs` 是资源兜底，同时限定 Playwright 自身的导航超时；面向模型的工具调用预算属于 `dsh-tool-call-timeout-policy`，由它武装 `exec.signal`。当外层期限先到时，提供方报告 `WEB_ABORTED`，该策略将其替换为 `TOOL_TIMEOUT`；因此 `WEB_FETCH_TIMEOUT` 标识的是提供方预算耗尽的服务调用方。

### 源码地图

| 文件 | 角色 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置模式、上限验证、提供方注册、销毁时关闭浏览器 |
| [`src/provider.ts`](src/provider.ts) | `PlaywrightFetchProvider`：共享浏览器生命周期、隐身渲染、DOM 序列化 |
| [`src/policy.ts`](src/policy.ts) | 目标策略：逐请求、逐重定向跳转与逐 WebSocket 的放行判定、每主机名一次判定，以及两个拦截器处理器 |
| [`src/browser.ts`](src/browser.ts) | 提供方依赖的浏览器端口、Chromium 启动与安装探测、解析出的安装命令，以及页面内 DOM 序列化函数 |
| [`src/invariant.ts`](src/invariant.ts) | 不变量伴随文件（无运行时不变量；上限在提供方中强制执行） |

### 读取路径

一次抓取校验并放行导航目标，取得一个渲染名额，然后复用或启动共享浏览器并打开全新隐身上下文。它在打开页面之前把请求观察器、请求拦截器与 WebSocket 拦截器安装到该上下文上，在提供方超时下以 `domcontentloaded` 导航，结清该次导航报告的每一跳重定向，序列化 DOM，并在返回前关闭页面与上下文——因此即使序列化失败清理也会执行，而被拒跳转背后的文档不会被读取。死亡或启动失败的浏览器会清除被记忆的句柄，使下一次抓取重试而不是钉死一个坏进程。销毁会先等待进行中的渲染，然后才读取该记忆值，因此某次渲染在销毁等待期间打开的进程，正是销毁关闭的那个进程。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级契约不够用时阅读这些页面。它们从共享词汇表走向服务、面向模型的工具与设计依据。

- [Web 子系统](../../../docs/subsystems/web.zh.md)——穷尽的抓取请求/结果词汇表与错误代码。
- [Web 包地图](../README.zh.md)——七个包的家族与各自角色。
- [dsh-web](../web/README.zh.md)——本提供方注册进入的 web 服务。
- [dsh-web-fetch-http](../web-fetch-http/README.zh.md)——面向服务端渲染页面的匿名 HTTP 后端；两个抓取后端覆盖互补的页面类别。
- [dsh-tool-web](../tool-web/README.zh.md)——渲染本提供方正文的面向模型 `web_fetch` 工具。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web-fetch-playwright)——每个受支持配置字段及其源声明。
- [Web 能力缝决策](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.zh.md)——为什么搜索与抓取共享一个提供方选择服务。

-----

<a id="behavior-boundaries"></a>
## 行为边界

这些边界定义本提供方不尝试的事情；它们是当前的包契约。

- **不做 DOM 后等待**——导航在 `domcontentloaded` 处 settle；仅在网络后续活动、懒加载或水合之后才出现的内容不会出现在序列化 DOM 中。显式的 network-idle 等待是这里下一个要添加的能力。
- **每次抓取都是匿名的**——没有 Cookie 或会话持久化；要求登录的页面返回其未登录标记，本家族中没有抓取后端执行身份验证检索。
- **不启用 Service Worker**——每个上下文都禁止注册，因为 Playwright 的请求拦截器看不到 Service Worker 发出的请求；内容依赖 Service Worker 的站点会按首次访问的样子渲染。
- **宿主浏览器依赖**——Chromium 必须通过 `playwright` 的浏览器二进制安装；插件把缺少安装报告为 apply 期的、点名安装命令的警告，seam 随后以 `WEB_PROVIDER_CONFIGURED_UNAVAILABLE` 拒绝该提供方，而抵达坏安装的抓取以 `WEB_PROVIDER_ERROR` 失败。
- **销毁不可逆**——被销毁的提供方不再接受抓取，因此卸载后再重新挂载插件得到的是新的提供方，而不是复活的浏览器。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文——点击展开</summary>

无。

</details>

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过 `dsh-tool-web`：该工具把本提供方经 `maxBodyChars` 限制的序列化 DOM 转换为 markdown 置于抓取结果内。

#### KV Cache 影响

不会直接导致 KV Cache 失效；请求前缀变更由上述消费方负责。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

以下是部署会继承的目标策略缺口，以及其背后的维护者约束。它们是当前的包限制，而不是可以绕开的缺陷。

- **放行不等于地址钉死**——策略判定的是主机名，而 Chromium 在连接时会再次解析它，因此某个名字若在放行时返回公网地址、在连接时返回私有地址，就会抵达那个私有地址。Playwright 没有暴露可用于钉死地址的连接级钩子，因此堵上它需要一个替 Chromium 解析并钉死地址的浏览器级代理，或上游提供钉死 API；今天需要钉死的部署应声明 `fetchProvider: http`。
- **被拒绝的重定向跳转是在请求发出之后被拒绝的，而不是之前**——Chromium 在自己的网络栈内部跟随重定向，不会为那一跳再次进入 `context.route`；它把该跳报告给上下文的 `request` 观察器，本提供方就在那里作出判定。因此判定发生在浏览器已经发出该请求之后：被拒绝的跳转会阻止内容抵达调用方——抓取在读取文档之前以 `WEB_BLOCKED_URL` 失败——但不会阻止请求本身，从而留下一次指向被拒地址的盲请求。要连请求也阻止，就得通过 `route.fetch` 手工跟随重定向并回填最终响应，这会把页面发出的每个请求都移出 Chromium 自己的网络栈，并改变 `page.url()` 的报告内容；`fetchProvider: http` 今天通过在连接前解析并钉死每一跳做到了这一点。
- **专用 Worker 的 WebSocket 不被路由**——Playwright 路由的是页面或框架打开的 WebSocket，`browserContext.routeWebSocket` 与 `page.routeWebSocket` 都看不到 `new Worker(...)` 脚本打开的连接；`tests/chromium.spec.ts` 对真实 Chromium 钉住了这一点，因此 Playwright 若在某个版本堵上它，该测试会变红。同一 Worker 发出的 HTTP 请求会被拦截，所以这条路径只能抵达私有地址上的 WebSocket 服务器——非 WebSocket 服务不会完成握手，也不会把数据交回页面。要堵上它需要上游修复路由，或注入 `Content-Security-Policy`，而本提供方并不为此改写响应。
- **只有 Playwright 会路由的传输受检**——HTTP(S) 请求与 `ws:`/`wss:` 连接会通过地址策略。WebRTC 数据通道与 WebTransport 不被 Playwright 路由，因此页面脚本可能经由它们抵达某个目标；在启动时关闭这些传输属于延期工作，二者目前都不可能经由请求或 WebSocket 拦截器触及。
- **安装探测是文件系统检查**——它确认启动时会运行的可执行文件存在，而不是确认它能启动。残缺或损坏的安装仍会把提供方报告为可用，随后首次抓取以启动错误加安装命令的形式失败。
- **随发行版交付的这条路线没有录制会话道次**——重定向拒绝、WebSocket 拒绝、启动器、探测与安装命令都在 `tests/chromium.spec.ts` 中对真实 Chromium 运行，其中包含一次端到端抓取：它把固定主机名映射到回环地址，从而让完整渲染可以离线运行。`snapshots/session/` 下的场景做不到同样的事：策略拒绝回环地址，因此它可以抓取的固定页面需要那条启动期主机映射，而随发行版交付的 profile 没有地方声明它；并且仅仅让该行保持挂载就会让场景依赖主机，因为插件恰好在主机没有浏览器时于挂载期告警，而该测试装置逐字节比对进程 stderr。因此录制会话道次跑的是 `http` 路线，本路线的证据是真实 Chromium 套件。
