# Agent Note: 重定向跳转在报告它们的通道上通过 fetch 目的地策略

Status: implemented

[English](2026-09-03-playwright-install-path-and-permits.md) | 中文

## 问题

渲染式 fetch 路由在五处宣称它会校验「每一次重定向跳转」：`packages/bundle/base/cordis.patch.yml` 中的组合注释、`src/policy.ts` 的模块文档与类文档、`src/provider.ts` 的模块文档，以及两段 README 文字。唯一的证据是一个名为 `redirectHop` 的单元测试替身，它被喂入一个环回地址 URL，这只能证明处理器拒绝环回地址，对重定向则什么也证明不了。

以运行中的 Chromium 1.62.1 实测，这个说法是错的。导航到一个应答 `302` 的 URL 的页面会抵达目标，而 `context.route` 只对第一跳被调用——浏览器在它自己的网络栈内部跟随重定向。以 `3xx` 状态调用 `route.fulfill` 同样不会产生被跟随的重定向，导航会挂起。暴露面是具体的：一个在公网主机上被准入的页面，被重定向到 `http://127.0.0.1:<port>/internal`，加载该源的内容，而本提供方会把它序列化并返回。这正是 `web_fetch` 上的 SSRF 所呈现的样子。

另有两个缺陷与之同行。`chromiumInstallCommand()` 无保护地解析 `playwright/package.json`，而插件正是在缺失 `playwright` 所产生的那条分支里调用它：`resolveAvailability()` 吞掉了 `await import('playwright')` 抛出的 `ERR_MODULE_NOT_FOUND`，随后警告又同步地重新触发同一个失败并让 `apply` 拒绝，把整个 profile 拖垮。`playwright` 是一项对等依赖（peer dependency）且不附带 postinstall——它的 manifest（元数据清单）根本没有 `scripts` 字段——因此没有任何东西会安装这条路由所需的浏览器，而走到那条路径上的部署恰恰就是那份指引所面向的部署。另外，`src/provider.ts` 中的 `RenderPermits` 是一个手写的有界 FIFO 准入控制器，写于 `@deepseek-ai/dsh-capacity-gate` 作为同一件东西发布的三天之后；克隆检测器基于文本，看不出这一点。

## 决策

**重定向跳转通过同一套策略，并在 Chromium 报告它的那条通道上作出判定。** 发现缺口的那次实测同时给出了修复方式：跳转以 context 上的 `request` 事件抵达，携带 `redirectedFrom()`，而一条导航链的每一跳都在 `goto` 解决**之前**被报告。`RenderContext` 新增了 `on('request', listener)`，`guardContext` 现在安装三项检查而非两项——请求观察器排在最前，因为它是同步的，也是跳转唯一能抵达的通道。`auditRedirects(policy)` 为每个 `redirectedFrom()` 非 null 的被报告请求发起一次 `policy.admit`，其余一律跳过，因为页面自己发起的请求已经抵达过拦截器。这些跳转共用本次 fetch 的按主机名备忘表，因此重定向回主框架已判定过的主机不产生任何开销。

**被拒绝的跳转会让整次 fetch 失败，时点在导航之后、序列化之前。** `render` 在 `goto` 之后、`page.evaluate` 之前结算这次审计，因此一次拒绝返回的是策略自己的 `WEB_BLOCKED_URL`，且文档的任何一个字节都不会被读取。改为中止那一个请求则是做戏：等到 Chromium 报告该跳转时，页面已经持有那一跳的响应，字节仍会留在本提供方即将序列化的 DOM 里。这样做没有做到的是阻止请求——判定落在浏览器发出请求之后，因此对被拒绝地址的一次盲请求仍然会发生。要阻止它，需要通过 `route.fetch` 手动跟随重定向，而那会把渲染页面发出的每一个请求都移出 Chromium 的网络栈，并改变 `page.url()` 的报告结果；此事暂缓，并连同它本可关闭的残余缺口一起记录在 README 中。

**`fetchProvider: playwright` 仍是交付路由，而浏览器这一步写在部署者会遇到它的地方。** 跳转被检查之后，倾向 `http` 的目的地论据不复存在：两条路由现在都校验每一个目的地，剩下的只有固定版本上的差异。没有任何东西会安装 Chromium，而由 postinstall 下载浏览器并不是本仓库有证据支持的默认做法——因此，与其把这项要求藏起来，不如由 `packages/bundle/base` 的 README 在它自己的 `### Install the browser the fetch tool needs` 一节中、并再次在它的已知限制中，以两种语言写明：命令是什么，以及在运行它之前每一次 `web_fetch` 都会以 `WEB_PROVIDER_CONFIGURED_UNAVAILABLE` 失败。组合注释在固定该路由的那条配置行上携带同样的警告。

**缺失 `playwright` 时给出指引，而不是崩溃。** `playwrightInstallCommand(resolve)` 接收模块解析器，并在 `playwright` 无法解析时答以 `npm install playwright && npx playwright install chromium`；`chromiumInstallCommand()` 把它绑定到本包自己的解析。这个回退同时指名包和浏览器，因为抵达它的失败是那次失败的 import——只给浏览器无济于事。注入解析器的写法与它旁边的 `probeExecutable(locate)` / `probeChromium()` 一致，因此部署会走到的那条分支，也是测试能走到的分支。

**`RenderPermits` 已删除，改用 `CapacityGate`。** 提供方持有一个 `CapacityGate(limits.maxConcurrentRenders)`，并通过 `admitRender(signal)` 取得它的名额，该方法在 `acquire(signal)` 之前调用 `signal.throwIfAborted()`。这项前置检查正是闸门刻意留给持有者的那一项行为：`acquire` 在有空闲名额时不读取信号就予以准入，而本提供方对于预算已经耗尽的 fetch 绝不能打开浏览器 context。返回的 `CapacityRelease` 是幂等的，取代了原先单独的 `release()` 调用。`assertPositiveInteger` 现在检测 `Number.isSafeInteger`，因此超出闸门取值范围的上限仍然以插件自己的消息失败，而不是以闸门的 `RangeError` 失败。

## 验证

`bun x vitest run packages/web packages/bundle/base`——26 个文件、417 个测试，全部通过；仅 playwright 包就跑 62 个，其中十个针对真实 Chromium。

重定向修复以真实浏览器端到端得到证明。`fails the whole fetch when a rendered page is redirected to a private address` 以 `--host-resolver-rules=MAP fixture.test 127.0.0.1` 启动 Chromium，提供一份环回 fixture（测试前置数据），其 `/start` 以 `302` 应答指向 `http://127.0.0.1:<port>/internal`，并驱动真实的 `PlaywrightFetchProvider`：该次 fetch 以指名 `127.0.0.1` 的 `WEB_BLOCKED_URL` 拒绝。启动期的主机名映射正是让一次离线渲染成为合法操作的前提——策略拒绝环回地址，因此 fixture 页面需要一个它会准入的名字——而重定向目标是一个 IP 字面量，判定直接依据该字面量作出，不牵涉解析器。`reports a redirect hop to the request observer and to no interceptor` 在下面保留了那条平台事实：两跳都以请求形式抵达，只有第一跳被路由，因此某个开始路由重定向跳转的 Playwright 版本会让它变红。

两者都被确认为真阳性：把 `render` 中那两行审计检查移除后，三个重定向测试全部失败，而真实 Chromium 的那个是以*解决成功*的方式失败的——也就是把环回源的内容返回给了调用方，这正是缺陷本身。

`names the package as well as the browser when playwright itself is missing` 用一个抛出 Node `MODULE_NOT_FOUND` 的解析器驱动 `playwrightInstallCommand`，并断言 `chromiumInstallCommand()` 从不抛错，这正是让 `apply` 保持全域可用的东西。`policy.spec.ts` 中原先名为 `redirectHop` 的那个 fixture 现在叫 `loopback`，因为那才是它所证明的东西。

`packages/web/web-fetch-playwright/src` 上的逐文件覆盖率在全部五个文件上语句、分支、函数与行均为 100%，没有 `v8 ignore` 注释，也没有 `vitest.config.ts` 排除项。`bun run test:snapshot` 通过（107 通过，2 跳过）。`scripts/no-barrels.ts`、`scripts/verify-export-jsdoc.ts`、`scripts/no-duplication-overrides.ts`、`run-oxlint.ts packages/web`，以及覆盖五个受影响包的一次限定范围 `tsc -b` 全部通过。

## 考虑过的替代方案

**不检查跳转，改把基础组合包路由到 `http`。** 否决。这曾是这里的第一个答案，而它是错的：支持它的唯一持久论据是 `http` 校验每一次重定向跳转而渲染式路由不校验，可这是一条应当修复提供方的论据，不是放弃该能力的论据。交付要求的正是一条渲染式路由，而策略所需的信息本来就在一条没人读取的通道上被报告着。

**中止被拒绝跳转的请求，而不是让整次 fetch 失败。** 否决：该跳转是在浏览器发出它、并且页面收到响应之后才被报告的，因此中止一个请求会把它的字节留在提供方即将序列化的 DOM 里。失败关闭是唯一能让内容不流向调用方的结果。

**在提供方内部通过 `route.fetch` 跟随重定向并 fulfil 最终响应。** 暂缓，并作为关闭剩余缺口的方式记录在 README 中。它是唯一能阻止请求本身而非只阻止信息泄露的设计，但它会把渲染页面发出的每一个请求都移出 Chromium 自己的网络栈——包括缓存、流式传输与二进制响应体——而且 `page.url()` 将不再报告最终 URL，那是一个模型可见的结果字段。

**校验每一个被报告的请求，而不只是校验跳转。** 否决：路由拦截器已经在判定页面自己发起的请求，并且会中止被拒绝的请求而不让整次 fetch 失败。把这些请求也送进审计，会让任何嵌入了私有地址子资源的页面变成整次 fetch 失败，而且会在一个严格更差的时点上重复同一项判定。

**用 postinstall 安装 Chromium，让组合安装它所固定的东西。** 否决：这会把一次浏览器体量的网络下载塞进 `dsh-base` 的每一次安装，破坏离线与气隙安装，并让每一个部署都承担只有这条路由才需要的成本。一个写在组合包自己的 README、写在组合注释、写在挂载警告以及每一次启动失败中的必需手动步骤是诚实的；一个悄无声息的步骤则不是。

**把 `does not route the hop a redirect names` 用例保留为重定向的全部证据。** 在缺口关闭后否决：它记录的是一条平台事实，不是本提供方的行为。它被保留为端到端用例之下的负对照，这样两套机制不会悄悄各说各话。

**保留 `RenderPermits`，因为闸门的中止语义不同。** 在核对了唯一真实的差异后否决：`CapacityGate.acquire` 在有空闲名额时不读取信号就予以准入，而 `RenderPermits.acquire` 会拒绝一个已被中止的调用方。那是一条闸门文档中写明由持有者自己承担的持有者层规则，而 `admitRender` 用三行代码把它写了出来。被拒绝时的错误文本也不同——是 `signal.reason` 而不是一个固定字符串——但 `renderFailure` 依据信号的中止状态翻译，从不读取那条消息，因此没有任何模型可见的东西发生变化。

**为渲染式路由建一条录制会话通道。** 否决：它可能抓取的 fixture 页面需要 Chromium 启动期的 `--host-resolver-rules` 映射，而交付的 profile 无处声明这一点；仅仅让该配置行保持挂载，又会让任何场景依赖宿主——插件恰恰在宿主没有 Chromium 时于挂载处告警，而 headless 测试框架会逐字节比对进程 stderr。`snapshots/session/web-fetch/cordis.yml` 中的组合头部与 README 都记录了这一点，读者若想知道那条配置行为何被禁用，会在那里读到答案。

## 后果

- 被重定向到环回、链路本地或私有地址的渲染页面会以 `WEB_BLOCKED_URL` 让 fetch 失败，且它读到的任何内容都不会返回。对该地址的请求仍然会发出；这项残余在 README 中被指名，而不是被粉饰过去。
- 提供方现在依赖三条 Playwright 通道，而不是两条。未来某个改变哪条通道报告重定向的版本会打断这次审计，而真实 Chromium 的负对照正是给出这一信号的东西。
- 在没有运行过 `playwright install chromium` 的宿主上，`web_fetch` 仍会失败——但这一步以两种语言写在基础组合包 README 自己的章节与限制中、写在组合注释中、写在挂载警告中，也写在每一次启动失败中。
- 在没有 `playwright` 的情况下挂载本插件的部署现在可以启动，而它的警告指名了一条会把包和它的浏览器一并安装的命令。
- `dsh-web-fetch-playwright` 新增 `@deepseek-ai/dsh-capacity-gate` 作为对等依赖和开发依赖并新增一条 tsconfig 引用，同时丢掉了 42 行自己拥有并自己测试的准入控制代码。
- 对[WebSocket 策略那篇 Agent Note](2026-09-03-playwright-websocket-policy-and-coverage.zh.md)的取代性细节：它关于 `RenderPermits.acquire` 使 `browserOrRelaunch` 在中止后不可达的说法，现在落在执行同样拒绝动作的 `admitRender` 上；而它关于渲染页面发出的每一个请求都经过拦截器的表述，只对页面自己发起的请求成立。
