# Agent Note: Playwright fetch 让 WebSocket 也经由目的地策略路由

Status: implemented

[English](2026-09-03-playwright-websocket-policy-and-coverage.md) | 中文

## Problem

`dsh-web-fetch-playwright` 只安装了一个拦截器 `context.route('**/*')`，而有四处地方据此宣称渲染页面发出的每一个请求都经过地址策略：`src/provider.ts` 与 `src/policy.ts` 的模块文档，以及两段 README 文字。Playwright 通过另一套独立 API 路由 WebSocket。它的 `browserContext._onWebSocketRoute` 在没有处理器匹配时会调用 `connectToServer()`，因此渲染页面可以打开 `ws://127.0.0.1:*/` 或 `ws://169.254.169.254/`，并在完全没有检查的情况下经由 `onmessage` 读取应答。一次反向对照确认了这一暴露：装上请求路由、不装 WebSocket 路由时，页面向 `ws://127.0.0.1:9/` 发起的套接字以代码 `1006` 关闭，也就是网络拒绝了一次真实的连接尝试，而不是根本没有离开浏览器。

随之而来还有四个缺陷。README 描述的姿态比代码实际交付的更严格，而 `packages/bundle/base/cordis.patch.yml` 中的组合注释早已如实写明 Chromium 会在连接时重新解析。该包在 `verify-package-readme-limitations` 中持有一条允许清单条目，其理由说的是某个撰写 agent（智能体）写入过滤器的性质，而不是这个包的性质。四个源文件未达到逐文件 100% 的覆盖率门禁。apply 时的探针在每次启动时都会拉起并关闭一整个 headless Chromium，而它在失败时打印的安装命令无法从仓库根目录运行，因为工作区安装不会把 `playwright` 放进根 `node_modules`。

## Decision

**WebSocket 目的地与请求经过同一套策略。** `RenderContext` 新增了 `routeWebSocket`，`renderAdmitted` 在上下文尚未持有页面之前就把它与 `context.route` 一并安装，因为 Playwright 只路由处理器存在之后才打开的连接。`DestinationPolicy.admitSocket` 校验 `ws:`/`wss:` URL 的方式是把协议改写为对应的 HTTP 形式，再运行共享的 `validateFetchUrl`（长度有界、不含内嵌凭据），然后复用 fetch 针对每个主机名的判定，因此在 `https://host` 判定之后，`wss://host` 不再有额外开销。`guardSocket` 把被放行的套接字接到其服务器，并以 RFC 6455 代码 `1008` 关闭被拒绝的套接字；与请求处理器一样，它把判定与拒绝都结算掉，因为抛出异常的处理器会让连接永远挂起。匹配器是一个谓词而非 glob，因此在“每一个连接”与浏览器实际路由的内容之间不夹任何东西。

**每个上下文都屏蔽 service worker。** Playwright 的请求拦截器永远看不到 service worker 发出的请求，因此 `newContext` 传入 `serviceWorkers: 'block'`。这在 HTTP 一侧封堵了同一类绕过，代价是依赖 service worker 的站点会按首次访问的样子渲染。

**安装探针检查可执行文件，而不是拉起一个。** `probeChromium` 现在确认 `chromium.executablePath()` 存在。在热机主机上每次以全新进程测量：文件系统探测耗时 103 毫秒，其中几乎全部花在导入 `playwright` 上，而拉起再关闭耗时 179 毫秒；更重要的改动理由是，这样不再有浏览器进程、不再有临时 profile，也不再可能因为一次卡住的拉起而让 `apply()` 一直挂着。`available()` 保持原义：一个在注册之前就解析完毕的答案，每次选择都不产生 I/O。

**安装命令是解析出来的，不是猜出来的。** `chromiumInstallCommand()` 通过本包自己的模块解析定位 `playwright/package.json`，并打印 `node "<pkg>/cli.js" install chromium`，该命令可在任意目录下运行。README 新增了一节“Install the browser”，因为仓库中没有任何东西会下载浏览器，而在未下载的情况下钉住 `fetchProvider: playwright` 会让每一次 fetch 都以 `WEB_PROVIDER_CONFIGURED_UNAVAILABLE` 失败。

**两处不可达状态被删除，而不是被覆盖。** `browserOrRelaunch` 开头是 `if (this.disposed) throw`，`dispose()` 结尾是 `if (opened?.ok)`。这两个分支都不可达：`dispose()` 会在任何东西抵达拉起之前中止生命周期 signal，而进入 `browserOrRelaunch` 的每一条路径都会经过 `RenderPermits.acquire`，后者在 signal 已中止时 reject；拉起失败会自行清除 memo，因此 `dispose()` 永远观察不到一个被 reject 的 memo。那个 disposed 检查所指的泄漏由 `dispose()` 自身的顺序防止：它先等待每一次进行中的渲染，再读取 memo，因此在这段等待期间打开的进程正是它随后关闭的进程；这一顺序现在有了直接的测试。由此 `dispose()` 是全函数，于是插件的 disposer 去掉了 `.then(undefined, warnCloseFailure)`，与每个同类包所用的 `yield () => x.dispose()` 写法一致。

**README 陈述代码实际交付的姿态。** 放行不等于钉住，残留的传输通道被逐一点名，规范的 `## Known Limitations and Deferred Work` 一节取代了那条允许清单条目。

## Verification

`tests/chromium.spec.ts` 针对真实的 `playwright` 包与一个活动 Chromium 演练启动器、探针、可执行文件定位器与安装命令，并通过真实的路由 API 证明这次修复：页面的 `new WebSocket('ws://127.0.0.1:9/')` 由本策略以 `1008` 关闭，而同一页面在没有该路由时由网络以 `1006` 关闭。没有安装浏览器时，它只跳过依赖浏览器的用例；启动器断言在那种环境下仍然运行，并断言一次 reject。该套件是 `*.spec.ts` 文件，覆盖率车道会收集它；`.e2e.ts` 文件在 `testIncludes` 之外，会让门禁无法满足。

端口假件携带了新成员，因此单元测试套件证明了调用顺序（`route`、`routeWebSocket`、`newPage`）、对回环、链路本地、私有、带凭据、非 `ws:` 与格式错误套接字 URL 的拒绝、对被放行套接字的连接、对页面主机名判定的复用，以及关闭本身失败时处理器仍被结算。该包中每个文件都满足逐文件 100% 门禁（语句、分支、函数、行），没有任何排除条目、没有 `v8 ignore`，也没有改动阈值。

## Alternatives considered

**一律拒绝所有 WebSocket。** 已否决：该提供方在 `domcontentloaded` 时序列化 DOM，因此全面拒绝确实更简单也更严格，但它会破坏那些脚本在缺少套接字时明确报错的页面，而地址规则对公网目的地本就有确切的答案。

**用请求所使用的 `'**/*'` glob 匹配 WebSocket。** 已否决：该 glob 对 `ws:` URL 的行为属于 Playwright 自己的事，而一项安全控制不应当依赖从 HTTP 推断出来的匹配器语义。返回 true 的谓词直接陈述意图。

**保留拉起并关闭的探针，改为让可用性判断变成惰性的。** 已否决：惰性只是把同一次浏览器拉起挪到第一次 fetch，并让 `available()` 要么不诚实、要么产生 I/O。文件系统检查在启动时回答同一个问题，而它更弱的保证（可执行文件存在，但不保证能启动）已记录在 README 中。

**用调度技巧覆盖不可达的 `disposed` 与 `opened.ok` 分支。** 已否决：抵达它们需要一个把 `dispose()` 落在特定微任务窗口里的测试，那钉住的是 V8 调度而非行为。删除不可达代码正是逐文件门禁的用途。

**屏蔽 dedicated worker，或注入 `Content-Security-Policy`，来封堵 worker 套接字这个缺口。** 目前已否决：从每个 realm 中移除 `Worker`，或改写每一个响应以添加响应头，都会牺牲这个包存在的意义所在的渲染保真度。该缺口已被记录、被测试钉住，并且比看上去更窄（见下文）。

## Consequences

- 渲染页面只能经由地址策略抵达 `ws:`/`wss:` 目的地，被拒绝的连接向页面报告 `1008`，而不是一个网络错误。
- 依赖 service worker 的站点会按首次访问的样子渲染；这现在是一条明确的行为边界。
- 启动时不再拉起浏览器进程来回答“是否装了浏览器”，而且每一条被打印的安装命令都能在打印它的地方运行。
- **dedicated worker 的 WebSocket 仍未被路由。** 针对活动 Chromium 实测：`browserContext.routeWebSocket` 与 `page.routeWebSocket` 都看不到 `new Worker(...)` 脚本打开的套接字，处理器列表始终为空，页面观察到 `1006`。同一个 worker 发出的 HTTP 请求*确实*被拦截，这一点也经过实测，因此残留路径只能抵达私有地址上的 WebSocket 服务器；非 WebSocket 的服务永远完不成握手，也不会把任何数据返回给页面。`tests/chromium.spec.ts` 钉住了这个缺口，因此上游一旦修复，该断言就会转红，这条限制也会从 README 中移除。
- **放行仍然只是放行。** Chromium 在连接时会重新解析主机名，因此一个在放行时解析到公网、在连接时解析到私有地址的名字仍能抵达该私有地址。`fetchProvider: http` 才是做钉住的后端；要在此处封堵它，需要浏览器层面的解析代理或一个上游钩子。
- WebRTC 数据通道与 WebTransport 在 Playwright 中不被任何东西路由；在启动时禁用它们属于推迟的工作。
