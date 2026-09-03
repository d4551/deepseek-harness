# Agent Note: Client realm 在具备转发 Console 调用的能力之前就被公布

Status: implemented

[English](2026-09-03-inspector-realm-console-forwarding.md) | 中文

## 问题

Client realm 只有在 Worker 的 `client-console/enable` 帧抵达时才安装自己的 Console observer。`ClientRuntimeRouter.subscribeConsole` 把该帧写入 source socket 后，在同一个事件循环轮次内就返回 disposer，于是 Worker 把一次刚派发出去的 enable 当成了已建立的订阅。`RuntimeDomainSession` 随即应答 `Runtime.enable` 并发出 `Runtime.executionContextCreated`，而此时那一帧仍在途中。

任何从这两个信号得知该 realm、随后让该 realm 输出日志的一方，都在与这一帧赛跑。`ClientConsoleObserver.captureConsole` 只向捕获时刻已启用的 session 扇出，且不保留历史，因此落在这段空窗内的调用会被丢弃一次且不再重试——在首次 enable 时，observer 对 `console.log` 的替换甚至尚未安装。这种丢失在两个方向上都是静默的：Client 什么都不发，Worker 则在等一个永远不会存在的 event。

`tests/integration.host.spec.ts` :: `forwards Client Console objects through isolated realm sessions` 大约有一半几率命中此问题，并且是耗尽 15 秒预算而非快速失败。一次失败运行的 stderr 追踪显示，fixture（测试前置数据）的 `console.log` 比两条连接的 enable 帧都早 1 毫秒：

```
DIAGF 1788421304621 log-value
DIAGC 1788421304622 enable a63093bf-… closed=false active=false
DIAGC 1788421304623 enable 5ee1a073-… closed=false active=true
```

两条连接都丢失了该 event，这与「缺失对称性」这条证据的预测一致：两次 enable 按序走同一条 socket，因此这段窗口要么同时套住两者，要么两者都套不住。

## 决策

`ConsoleBackend.subscribe` 返回 `Promise<() => void>`，且只在 realm 确实把 event 转发给 listener 之后才 resolve。`HostConsoleBackend` 立即 resolve——原生 session 本来就直接投递进它的通知通道。`ClientConsoleBackend` 则在新增的 `client-console/enabled` 帧上 resolve，该帧由 Client 在 `ClientConsoleObserver.enable` 安装好 observer 之后发出，按 source generation 与 Runtime session 关联，并受 router 既有的 `clientRuntimeTimeoutMs` 约束。一条 `ConsoleSubscription` 记录拥有整个 session：listener、确认 resolver 与截止时间在确认、dispose（资源释放）、session 关闭、source 关闭或 router 关闭时一并结算并丢弃。

`RuntimeDomainSession` 保存的是这个订阅 promise 而不是 disposer，因此 `attachConsole` 是幂等的，而每一个调用方——`Runtime.enable` 循环与 realm-opened 路径——都在 `announce` 执行前等待同一次建立完成。Console 或 Runtime 无法准备就绪的 realm 会被关闭而不是被公布，这正是 realm-opened 路径对失败的 Runtime enable 早已采取的做法。

把公布排在一次往返之后，会使重连 Client 的 Elements 更新跑到它的 execution context 前面，而这一点由 `tests/cordis-tree.host.spec.ts` :: `restores a disconnected Client tree from a new transport generation` 钉住。有两条顺序事实保证它不被破坏：

- `InspectorSourceRegistry.open` 在应答 `source/accepted` 之前发出 `opened`。source 一读到该应答就会发布（`ClientBridgePublisher.accept` 同步发送替换），因此消费方为该 generation 发出的能力帧必然先于它上线。
- `openRealm` 在等待 Runtime enable 之前就启动 Console 订阅。`attachConsole` 抵达 `sources.send` 的路径上没有任何 `await`，因此 enable 帧是在 `opened` 的发出过程之内写出的，而不是晚一个微任务。先订阅再启用对 Host 也是更安全的顺序：两者之间不会有原生通知插进来。

于是 Client 会在处理 `source/accepted` 之前安装好 observer 并作出确认，而这份确认早于第一条记录帧抵达 Worker。

## 考虑过的替代方案

**只对 `Runtime.enable` 的应答做门控。** 对于在 Client 已就位之后才启用的连接，这满足 CDP 约定，但它对已观察到的故障毫无作用：本例中 realm 是在 `Runtime.enable` 之后才打开的，因此公布是唯一的信号，而它依旧先于订阅。

**拿一次既有的 Runtime 往返当屏障。** `release-object-group` 或 `global-lexical-scope-names` 能证明 enable 帧已被处理，因为 Client 按序处理 socket 帧。但这个证明只存在于注释里而不在协议里，读者还得从一次无关的操作中把它重建出来。

**在 Client 侧缓冲 Console 调用并在 enable 时回放。** V8 对 `Runtime.enable` 就是这么做的，而且它还能覆盖任何 DevTools 连接存在之前发生的调用——这才是「页面加载期间打日志」所暴露的真实产品风险。但它需要有上限的消息存储、建立在其上的 `discardConsoleEntries` 语义，以及把页面实时对象保留到某个 session 将其序列化为止。那是一项功能，不是这个缺陷的修复。

**让测试等待更长或可重试的信号。** 没有任何可观察量能证明 Console 已就绪，因此任何等待都只是对着一个早已被永久丢弃的 event 空睡。

**改掉重连顺序断言。** 在 DevTools 知晓某个 Client 的 execution context 之前，绝不会更新该 Client 的 Elements 树；而指向未公布 context 的 RemoteObject，正是该断言存在的意义所在。

## 后果

`Runtime.enable` 以及每一个 synthetic `Runtime.executionContextCreated`，都表示本连接对已公布 realm 的 Console 转发是活的。`Runtime.enable` 对每个已连接的 Client realm 要付出一次 Worker 到 Client 的往返；受影响用例由约 165ms 变为约 215ms。始终不作确认的 Client 会在 `clientRuntimeTimeoutMs` 之后以 `Client Console enable timed out after <n>ms` 让 enable 失败，这与 enable 对「attach 中途断连的 Client」早已采用的全有或全无回滚是同一套。

协议格式（wire format）新增一条 source 到 Worker 的帧 `client-console/enabled`，携带它所确认的 source、generation 与 session。两端在同一个 `INSPECTOR_PROTOCOL_VERSION` 下一起发布，因此不存在仍发送旧帧集的一端。

Client 在任何 DevTools 连接完成订阅之前所做的 Console 调用仍会丢失。realm 公布的保证并不延伸到它们，而堵上这道缺口需要上文被否决的那套消息存储。

## 测试

`tests/protocol.host.spec.ts` 解码 `client-console/enabled`，并拒绝多余字段、缺失的 `sessionId`，以及出现在 source 载体上的 Worker 到 Client 的 `client-console/enable` 标签。行为本身由此前那个不稳定的集成用例钉住，它现在确定性地通过：`tests/integration.host.spec.ts` 连续十二次运行全绿、约 215ms；而把源码回退后，六次运行中有四次失败。
