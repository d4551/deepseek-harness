# Agent Note: 一个 Worker 到 Client 的截止时间终结了它并不限定的工作

Status: implemented

[English](2026-09-03-inspector-client-deadline-scope.md) | 中文

## Problem

`clientRuntimeTimeoutMs` 限定的是一次 Worker 到 Client 的往返。在两处，它的到期终结了那次往返并不拥有的工作。

`RuntimeDomainSession.enable()` 在全部 realm 上 `await Promise.all`，于是只要有一个 Client 的 `client-console/enable` 始终未被确认，整个 DevTools 连接的 `Runtime.enable` 就被拒绝：catch 清除 `enabled`、摘除每一个 Console 订阅、清空已公布的 context，并对每个 realm（含 Host）调用 `Runtime.disable`。而接纳 enable 之后到达的 realm 的 `announceRealm`，把同一种失败限制在产生它的那个 realm 内——只丢弃那一个 realm，不影响其它。于是同一个 Client 以同样方式失败，会不会让整条连接失明，取决于它是在 `Runtime.enable` 之前还是之后连上的。一位同时检视 Host 与两个 Client 的 DevTools 用户，会因为第三者的沉默而失去 Host 和那个健康的 Client。

`tests/integration.host.spec.ts` :: `cancels Client Runtime work when the Worker deadline expires` 以 `clientRuntimeTimeoutMs: 20` 启动 Inspector，随后需要两次它并不测试的往返在同样的二十毫秒内完成：其 execution context 公布所等待的 Console enable 握手，以及证明 Runtime session 在取消后仍存活的那次求值。在大约三倍核数以上的负载下，该用例会因其中之一而失败——`no execution context named Client — Timeout Client`，或 `expected undefined to match object { type: 'number', value: 42 }`——在负载九十时十四次中有四次。必须跑赢被测截止时间的 setup，会把用例变成对宿主机速度的断言，这正是[测试 CDP 客户端自带定时器所携带的缺陷](../testing/2026-09-03-cdp-test-client-terminal-conditions.zh.md)经由产品配置的重述。

## Decision

一个 `admitRealm` 服务两条接纳路径。它为一个 realm 订阅 Console 并 enable Runtime，两者都成功时返回该 realm，否则摘除订阅、关闭该 realm session 并不返回任何东西。`enable()` 把它映射到 registry 的各 realm 上，并按 registry 顺序（而非完成顺序）公布它返回的那些；`announceRealm` 为单个 realm await 它，realm 存活则公布。`Runtime.enable` 不再因某个 realm 而失败，任何 realm 的失败也不再波及同侪。

这种限制在各类 realm 上是统一的，与 `RuntimeDomainSession` 其余部分一致。无法接纳的 Host realm 以同样方式被丢弃，该连接的下一次 Host 请求会在已关闭的 native session 上失败，而不是被报告成一次早已返回的 enable。

配置该截止时间的用例驱动一个什么都不作答、且只声明 `client-runtime` 能力的 Client peer。Console 对 Client source 是可选的，因此 `attachConsole` 读到该 realm 自身的 `console: unsupported`，而 Client Runtime 的 enable 是 Worker 本地的：连接接纳并公布该 realm，不产生任何 Worker 到 Client 的往返。该用例随后发出的两次求值都是 peer 永远无法作答的，因此各自只能以截止时间收场，宿主机越慢这一点越确定。第二次求值即是存活断言：若 realm 已被取消所拆除，回答会是 `Client execution context is no longer available`，而 `DSHInspector.getSources` 仍列出 Worker 保留的那个 source。

该用例放弃的两项事实，被断言在它们确定的地方。`tests/protocol.host.spec.ts` 以 source registry 替身驱动 `ClientRuntimeRouter`：到期的请求发出一条携带自身 request id 的 `client-runtime/cancel`，该 session 上的下一个请求被作答并被确认。`tests/plugin.client.spec.ts` :: `cancels an outstanding Client Runtime operation without sending a late response` 已经持有 Client 那一半——取消之后发出的请求仍被服务。

## Alternatives considered

**在用例里调高 `clientRuntimeTimeoutMs`。** 数值搬了家，赛跑还在。任何大到足以在负载宿主机上存活的值，都会被取消路径在每一次运行中花掉，而用例依然断言两次未被测试的往返能跑赢它。

**保留真实 Client fixture，改用 unique context id 寻址其 realm。** `Runtime.evaluate` 无需 `Runtime.enable` 即接受 `uniqueContextId`，握手确实可以跳过——但测试将不得不自行拼出 `dsh-client:<sourceId>:<generation>`，为一个由 Worker 拥有的格式再开第三处住所，而证明存活的那次求值仍会与截止时间赛跑。

**把用例移出真实 Worker，放进 `tests/announcement-barrier.host.spec.ts` 所用的进程内装配。** 一切都会变得确定，包括一次成功的后续调用，但那样就没有任何东西证明交给 `startInspector` 的 `clientRuntimeTimeoutMs` 到达了 Worker 里的 router。router 层的用例承载需要替身的部分；真实 Worker 的用例保住配置路径。

**给 Console enable 单独的可配置截止时间**，好让用例把它留在默认值。它与其它一样是一次 Worker 到 Client 的往返，也没有任何 consumer 要求单独限定它；第二个字段的存在将只是为了让一个测试挑两个数。

**暴露一个供用例等待取消的 Worker 信号。** 今天除截止时间外没有任何东西观察它，而一个只有一个测试调用者的新公共面，是披着配置名字的测试钩子。

**保留 `enable()` 在 Host realm 无法接纳时失败。** 那会把不对称重新塞进新助手，且服务于一条不可达的失败路径：Host 的 Console 订阅在返回时即已就绪，Host V8 session 也在本进程内作答 `Runtime.enable`。一个 Host 特例将不得不在没有任何用例触达的情况下被维护。

## Consequences

`Runtime.enable` 返回 `{}`，并公布本连接已接纳的那些 realm。一个连着 Host 与若干 Client 的 DevTools 前端保住每个可用 realm，一个无响应的 Client 只让它失去该 Client 的 context。[realm Console 转发那篇 Agent Note](2026-09-03-inspector-realm-console-forwarding.zh.md) 记录的全有或全无回滚已经消失；该 Client realm 只对无法接纳它的那条连接关闭，对其它连接仍与 Worker 保持连接。

在 `Runtime.enable` 处被丢弃的 Client realm 不会在该连接上重试。Worker 保留该 source，因此 DevTools 重新加载会开出一条新连接并再次接纳它。

该截止时间用例不再走真实 Client executor 的取消路径；`tests/plugin.client.spec.ts` 与 `tests/client-runtime.client.spec.ts` 拥有那一半，而 Worker 那一半现在有了它此前从未有过的断言。

## Testing

两种失败无需负载即可复现，靠的是本地诊断而非提交进仓库的 fixture：Client fixture 包裹 `WebSocket.prototype.send`，延迟 Worker 所等待的帧。把 `client-console/enabled` 延迟六十毫秒，会让此前的用例以 `no execution context named Client — Timeout Client` 失败；延迟 `client-runtime/response`，则以 `expected undefined to match object { type: 'number', value: 42 }` 失败。二者正是上文所述的负载失败，且随叫随到。当前用例在每一种延迟下以及两者同时开启时都通过。

在十八核上以三十六个 shell worker 施压、负载均值峰值达六十四（高于此前用例开始失败的三倍核数阈值）时，`tests/integration.host.spec.ts` 连续十二次运行通过，整个 `packages/experimental/inspector` 套件也连续十二次通过，为二十一个文件、一百四十三个测试。

realm 限制以回退来证明：用此前的 `enable()`，`keeps the Host realm on a connection whose Client realm never confirms its Console` 会失败，`Runtime.enable` 的应答是 `Client Console enable timed out after 20ms`。有了这项限制，该 enable 成功，其后创建的 `node:vm` context 仍被公布给该连接——这是此前回滚对 Host realm 调用 `Runtime.disable` 所阻止的——在其中求值也仍有应答。

`tests/announcement-barrier.host.spec.ts` 钉住公布计数器所拥有的次序，且原样通过：`admitRealm` 在两条路径上都保持每次接纳一次自增、一次结算。
