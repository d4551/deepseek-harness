# Agent Note: Elements 更新与拥有它们的 execution context 发生竞态

Status: implemented

[English](2026-09-03-inspector-dom-delivery-behind-announcement.md) | 中文

## 问题

`RuntimeDomainSession` 在 `openRealm` resolve 之后才公布 Client realm 的 synthetic execution context，而这次 resolve 要等待 Client 的 `client-console/enabled` 应答。由于 Worker 在同一个事件循环轮次内写出 `client-console/enable` 与 `source/accepted`，重连的 Client 也会在同一个轮次内写出该应答与它的第一帧 `source/replace`。因此 Worker 的一次 socket 读取就可能同时携带两者，而 `ws` 会在这次读取内把两条 message 都发出：记录帧同步地装入新 generation 的树并写出 `DOM.childNodeRemoved` 与 `DOM.childNodeInserted`，此时公布仍是排在建立 promise 之后的一个 microtask 续体。

于是 DevTools 先得知了某个 generation 的 Elements 节点，却尚未被告知拥有它们的 context——而这正是让一个指向未公布 context 的 `RemoteObject` 变得不安全的情形。`tests/cordis-tree.host.spec.ts` :: `restores a disconnected Client tree from a new transport generation` 钉住了这个顺序，并在机器负载下以 `expected 1 to be greater than 3` 失败；实际投递顺序是 `Runtime.executionContextDestroyed`、`DOM.childNodeRemoved`、`DOM.childNodeInserted`、`Runtime.executionContextCreated`。单独运行时，两帧落在不同的读取中，microtask 在两者之间排空，用例通过——所以这个缺陷表现为套件负载下的 flake，而不是一次失败。

[realm Console 转发](2026-09-03-inspector-realm-console-forwarding.zh.md)记录的两条顺序事实约束的是帧在线路上的顺序，它们至今成立。但只要一次读取同时携带应答与记录帧，这两条事实都不约束 Worker 自身的投递顺序，因为记录摄入与读取同步，而公布不是。

## 决策

`RuntimeDomainSession` 记录自己欠下的公布次数。domain 已启用时的 realm 准入，以及每一次 `Runtime.enable` 调用，都会使计数加一；context 被公布或 realm 被丢弃时计数减一。`announcementPending()` 报告该状态，`onAnnouncementSettled()` 报告每一次结算。

`CordisDomSession` 在应用任何 backend 变更之前读取该状态。存在待公布时，它把变更追加到一个连接本地队列并返回；每次结算时，它把队列经同一个入口重新排空，因此仍处于待公布窗口内的变更会按序重新入队，而窗口之外的变更会被应用。顺序按整条流而非按 source 保持，因为前端是拿一串 mutation 序列回放到它已持有的树上。`DOM.getDocument` 会丢弃该队列：响应携带的就是当前 document，产生它的那些增量已经用尽。

这道屏障是连接本地的。准入 realm 较慢的 DevTools 连接只会扣住自己的 Elements 更新，Worker 仍为其他所有消费者持续摄入记录。

## Alternatives considered

**在等待 Console 订阅之前就公布。** 这样顺序在结构上得到恢复，但每个 synthetic `Runtime.executionContextCreated` 又退回到「enable 帧已派发」的含义——正是[realm Console 转发](2026-09-03-inspector-realm-console-forwarding.zh.md)所消除的那种损失：落在空窗内的 Console 调用被丢弃一次且不再重试。

**推迟 `source/accepted`，或扣住记录摄入，直到每条连接都已公布该 generation。** 两者都能把顺序变成协议属性，但也都把某一条 DevTools 连接的准入与其他所有消费者收到的数据耦合在一起。`InspectorSourceRegistry` 是刻意让消费者与准入相互隔离的，而一条卡住的连接将会停掉该 source 对 Worker 的发布。

**由完成订阅建立的那一帧同步发出公布。** 这是对公布本身最窄的修复，但它需要把一个建立回调贯穿 `ConsoleBackend.subscribe`、两个 backend 以及 Client Runtime router，并且对未声明 Console 能力的 Client 仍留有竞态——那类 realm 的公布挂在一个已 resolve 的 promise 之后。

**把 DOM 变更延后一个 macrotask 投递。** 今天待公布的链条会因此获胜，但顺序又一次取决于公布路径恰好经过多少个 microtask 跳转。此后在该路径上新增任何 `await` 都会静默地重新引入该缺陷。

**放宽断言、重试用例或延长等待。** 该断言陈述的正是这项保证；它观察到的顺序是错的，而不是慢的，任何额外等待都不会改变已经写入 transport 的顺序。

## Consequences

欠下公布的连接会扣住 Elements 更新一次 Worker 到 Client 的往返时长；当某个 Client 始终不确认它的 Console enable 时，则扣住 `clientRuntimeTimeoutMs`，随后按序投递被扣住的变更。没有任何变更被丢弃或合并，这条路径也依旧从不使用 `DOM.documentUpdated`。

`Runtime.enable` 现在在自身执行期间持有同一道屏障，因此首条连接不会收到它仍在准入的 realm 的节点。

`src/worker/cdp/**` 不受逐文件覆盖率闸门约束，因为 Worker 线程无法归因到父进程，所以新增路径由行为测试覆盖，而不是由该闸门覆盖。

## Testing

`tests/cordis-tree.host.spec.ts` :: `restores a disconnected Client tree from a new transport generation` 仍是钉子。把 Worker 的摄入读取合并成一次 50 毫秒批次——即负载中的事件循环所产生的读取形态——该用例在没有本次改动时每次运行都失败，有本次改动时每次运行都通过；在主机负载下连续十二次无辅助地运行该文件同样全部通过。`tests/announcement-barrier.host.spec.ts` 是提交进仓库的守卫：它在不使用任一 socket 的情况下装配 Worker 的来源注册表、路由器、realm 以及两个 CDP 域会话，并在同一轮中投递 Client 的 Console 确认帧与新一代的首批记录，从而让合并读取成为被测用例本身。移除 `updateDocument` 中的屏障后它每次运行都失败；移除 `DOM.getDocument` 的队列丢弃后它的对应用例失败。基于真实 socket 的合并读取工具仍是本地诊断手段：套件依然无法强制一次 socket 读取同时携带两帧。
