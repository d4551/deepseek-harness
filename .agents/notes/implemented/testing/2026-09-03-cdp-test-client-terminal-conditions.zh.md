# Agent Note: 测试 CDP 客户端的单次调用超时把主机负载报成了协议故障

Status: implemented

[English](2026-09-03-cdp-test-client-terminal-conditions.md) | 中文

## 问题

CDP 客户端辅助类为每一次 CDP 请求装上一个 `setTimeout`，超时即以 `CDP call timed out: <method>` reject：`tests/cordis-tree.host.spec.ts` 中为五秒，`tests/integration.host.spec.ts` 中为三十秒，而后者上方的注释仍在描述被替换掉的五秒。

这个期限是第二份预算，与该 lane 已经拥有的那份赛跑。`vitest.config.ts` 的两个单元 project 都设置了 `testTimeout: 30_000`，因此五秒的定时器总是先触发，Vitest 自己的预算永远无法报告该用例；而三十秒的那个与 lane 预算相等，两者赛跑且胜负未定义。这两个数字都不来自协议、产品配置或实测往返，皆由测试文件凭空给出。

被它掐断的正是该文件最慢的那些请求。针对 `tree-host-*` group 的 `Runtime.releaseObjectGroup` 要抵达 Host inspector `Session`，而后者运行在测试进程的主线程上；针对 `tree-client-*` group 时还要经 `InspectorQueryConnection` 多一次 Worker 到 Client 的往返。两条路径都不带产品侧期限，因此在争用的主机上，主机让它们花多久就是多久。于是用例 `projects Host and Client trees and resolves both node kinds to RemoteObjects` 在峰值负载下约每十次失败一次，而失败文本点名了一个 CDP method——把机器状态呈现为 Inspector 缺陷。

与 lane 预算绑定的期限则相反，它把请求藏了起来。负载下 `tests/integration.host.spec.ts` 只报告 `Test timed out in 30000ms`，别无其他，于是该文件的失败被读作对 `waitForWorker` 的等待；点名未完成的请求后才看出它们是 Host V8 inspector 从未应答的 CDP 调用，即[Worker 丢失的应答唤醒](../bug-fix/2026-09-03-inspector-host-answer-wakeup.zh.md)。

## 决策

一次请求只在其连接的事件上结束：携带其 id 的响应、socket 关闭、socket 出错。流逝的时间不是其中之一。

`CdpClient` 把每个未完成请求保存为 `PendingCall`，其中持有 method 名与两个结束函数。`abandon` 以终止条件和所等待的 method 名 reject 每个未完成请求，socket 的 `close` 与 `error` 都调用它。`error` 监听器同时消除了一个潜在隐患：`connect` resolve 之后，socket 原本完全没有 `error` 监听器，而 `EventEmitter` 的 error 事件在无监听器时会抛出。

`inFlight` 给出被 socket 熬过的那些请求的名字。各文件的 `afterEach` 在拆解前读取它，并在全部资源释放之后抛出 `Inspector CDP requests never answered: <methods>`。因此，一个在调用中耗尽 lane `testTimeout` 的用例会报告两次：Vitest 如实说明该测试超出时间，拆解则点名 Vitest 的消息无法给出的 method。

`tests/cordis-tree.host.spec.ts` 与 `tests/integration.host.spec.ts` 都持有该辅助类。

## Alternatives considered

**把五秒调大。** `tests/integration.host.spec.ts` 曾经这么做过，调到了三十秒；该值与它本应先于其触发的 lane 预算相等，于是两者赛跑，落败一方的消息随之丢失。搬动一个数字并不能消除它，而任何大到足以熬过负载主机的数字，本来就会由 Vitest 先行报告。

**从 Vitest 的 `TestContext.signal` 推导期限。** 该 signal 恰好在 lane 预算耗尽时 abort，因此它是诚实来源而非凭空数字。但它无法留存到报告中：Vitest 让测试函数与其超时赛跑，此时已记录 `Test timed out`，并丢弃落败的 rejection。从 `afterEach` 报告未决集合能给出同样的 method 名，且无需把 signal 穿过每一个用例。

**保留一个随观测负载自适应的定时器。** 由机器算出的期限度量的是机器，这正是缺陷本身的另一种说法。

**为这个辅助类的四份副本抽取统一的 CDP 客户端。** `tests/debugger.e2e.ts` 与 `tests/client-browser.e2e.ts` 另带 `waitForEvent`，且运行在本次改动无法执行的 e2e lane 中；跨 lane 共享辅助类是另一次改动，需要它自己的证据。两份单元 lane 副本如今持有相同设计，因此那次抽取是搬移而非重写。

## 影响

慢但已被应答的调用如今只消耗墙钟时间而不再失败，`vitest.config.ts` 中的 `testTimeout` 是覆盖该用例的唯一期限。

被 socket 熬过的调用在毫秒级失败，而不是等满五秒，并在 await 所在行点名其 method。

超出 lane 预算的真实挂起产生两条错误，而不是一条捏造的错误，且两条都不宣称发生过并不存在的 CDP 故障。

`tests/` 不承担覆盖率义务，因此针对 `packages/*/*/src` 的逐文件门禁不受影响。

## Testing

该失败可由本地诊断按需复现，而非提交的 fixture：一个预加载模块包裹 `WebSocket.prototype.send`，在首次写出 `Runtime.releaseObjectGroup` 请求时把测试进程的主线程阻塞七秒。Host inspector `Session` 正运行在该线程上，因此阻塞期间确实无法产生响应——按需制造的饥饿主机。

在该 harness 与不超过核数两倍的负载下，旧辅助类使该文件十二次运行全部失败，每次失败均为 `CDP call timed out`；新辅助类则十二次运行全部通过。同样负载下不加 harness 的十二次运行同样全部通过，整个 `packages/experimental/inspector` 套件的二十个文件、一百三十八个测试也全部通过。

把阻塞时长提高到超过 lane 预算可验证诊断路径：Vitest 报告 `Test timed out in 30000ms`，拆解报告 `Inspector CDP requests never answered: Runtime.releaseObjectGroup`。在请求途中终止 socket 可验证另一条路径：该调用在两百毫秒内以 `Inspector CDP socket closed with Runtime.releaseObjectGroup in flight` reject。

`tests/integration.host.spec.ts` 对其自有副本以同样方式验证。在一次 await 无人结束的 promise 的 Host `Runtime.evaluate` 开始后五十毫秒关闭 socket，该调用在五十二毫秒时以 `Inspector CDP socket closed with Runtime.evaluate in flight` reject；旧辅助类则把同一调用扣到它三十秒的期限，然后报告 `CDP call timed out: Runtime.evaluate`——一个并未发生的 CDP 故障，且恰在 lane 预算同时耗尽的时刻。负载下它被卡住的调用如今会自报家门——`Inspector CDP requests never answered: Runtime.getProperties`、`Runtime.globalLexicalScopeNames`、`Runtime.evaluate`、`Runtime.releaseObjectGroup`——而旧辅助类只报告 `Test timed out in 30000ms`。

## Deferred

`tests/integration.host.spec.ts` :: `cancels Client Runtime work when the Worker deadline expires` 以 `clientRuntimeTimeoutMs: 20` 启动 Inspector，随后需要两次它并不测试的往返在同样的二十毫秒内完成：其执行上下文通告所等待的 `client-console/enable` 握手，以及证明 Runtime 会话在取消后仍然存活的那次求值。在大约三倍核数以上的负载下，该用例会因其中之一而失败——`no execution context named Client — Timeout Client` 与 `expected undefined to match object { type: 'number', value: 42 }`，在负载九十时十四次中有四次。这与辅助类定时器属于同一缺陷类别，只是经由产品配置表达；该值无法在“把取消等满那么久”与“接受这场赛跑”之外择一，因此该选择归该用例的所有者。
