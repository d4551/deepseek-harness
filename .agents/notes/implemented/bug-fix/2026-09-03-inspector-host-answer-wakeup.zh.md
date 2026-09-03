# Agent Note: 停泊的 Inspector Worker 错过了 Host inspector 的应答

Status: implemented

[English](2026-09-03-inspector-host-answer-wakeup.md) | 中文

## 问题

Inspector Worker 服务的每一次 Host realm CDP 请求都终止于 `HostInspectorSession.request`，它把 method post 到一个以 `connectToMainThread()` 绑定的 `node:inspector` `Session` 上。Host V8 inspector 位于进程主线程，因此应答要经由运行时自身的跨线程投递回到 Worker。

在主机负载下该应答仍会到达，但不在它产生的时刻。`Runtime.evaluate`、`Runtime.getProperties`、`Runtime.globalLexicalScopeNames` 与 `Runtime.releaseObjectGroup` 都曾被观测到 post 之后八到三十秒无人应答，随后回调送来一个普通结果——包括 `Invalid remote object id` 这类在空闲主机上 V8 不到一毫秒即可作答的结果。Worker 与该请求本身都解释不了这段间隔：停顿期间主线程上一个一百毫秒的心跳一次都没有漏拍，在停顿五秒处发出的第二次 CDP 调用一毫秒即被应答，而参数、method 以及 DevTools 连接数量都不改变结果。

真正起作用的是 Worker 自己的事件循环是否在转。等待应答的 Worker 没有其他工作，于是其循环停泊，本应投递该应答的唤醒随之丢失；而一个在转的循环会把它排空。Worker 内一个未 ref 的一百毫秒定时器消除了全部停顿：在同一主机负载下各九次运行，不带它时六次停顿 28.7 至 29.6 秒，带它时零次停顿，最差时延降至 85 毫秒。

`tests/integration.host.spec.ts` 是报告者。自[测试 CDP 客户端的终止条件](../testing/2026-09-03-cdp-test-client-terminal-conditions.zh.md)让它得以点名未完成的请求起，它在负载下的失败读作 `Inspector CDP requests never answered: <method>`，并在四个用例中点出了上述四个 method。

## 决策

`HostInspectorSession` 对已 post 的请求计数，并在计数大于零期间持有一个未 ref 的 `HOST_ANSWER_WAKEUP_MS` 间隔定时器。该定时器不承载任何工作：让 Worker 循环转起来就是它的全部作用。它随第一个未完成请求启动、随最后一个停止，因此空闲的 Worker 仍会停泊，而 `unref` 使它不会撑住 Worker 不退出。

该间隔限定了一次丢失唤醒能够附加的时延。它不是期限：间隔耗尽不会让任何请求失败，lane 的 `testTimeout` 与调用方仍是应答耗时的唯一限制。

## Alternatives considered

**像 Client 请求那样给 Host 请求一个期限。** `ClientRuntimeRouter` 用 `clientRuntimeTimeoutMs` 限定每一次 Worker 到 Client 的命令，因为 Client 是可能消失的独立进程。Host V8 inspector 就在本进程内且总会作答；给它加期限会把一次投递停顿转成捏造的协议故障，而这正是[测试 CDP 客户端那篇 Agent Note](../testing/2026-09-03-cdp-test-client-terminal-conditions.zh.md) 从测试侧消除的缺陷。

**延迟后重发请求。** V8 已经接收该消息并会作答；第二份副本会执行两次，而两个应答会关联到不同的 id。

**改为持有一个已 ref 的句柄而非定时器。** 已 ref 的句柄让循环保持存活，却不会让它转，而应答是在一次转动中被投递的。

**在有未完成请求期间串接 `setImmediate`。** 那会让循环持续转动并为此占满一个核，效果与定时器每间隔转一次相同。

**把 Host inspector `Session`移到主线程，经既有控制端口代理。** 那是彻底移除跨线程 inspector 路径而非加以约束，并把按连接的 V8 会话所有权从持有其余全部 realm 会话的 Worker 中挪走。若该运行时行为被证实长期存在，这是正确形态；就本缺陷而言，它今天的改动面过大。

## 影响

运行时未能及时投递的 Host realm CDP 应答，如今最多延迟一个间隔而非数秒，对 DevTools 用户与测试同样成立。

Worker 在等待 Host 期间持有一个定时器、空闲时不持有，因此运行中的 Inspector 只在它本就阻塞的工作期间增加唤醒。

成因位于本仓库之下。若 Node 修复了它，或受影响版本被确定，本约束仅需删除一个字段与一个间隔。

`src/worker/realms/**` 不在逐文件覆盖率门禁之内，因为 Worker 线程无法归属到父进程，故新增路径由行为测试而非该门禁覆盖。

## Testing

该停顿无需 Vitest、Client fixture 或该测试文件即可复现：一个启动单个 Inspector、开启单条 CDP 连接、对 Host realm 发出六十轮 `Runtime.evaluate`、`Runtime.getProperties` 与 `Runtime.releaseObjectGroup` 的脚本，在负载下即会停顿。对 `HEAD` 处的源码同样复现，因此它早于同日落地的 Inspector 改动。

该约束以其自身做 A/B：在所交付源码的副本中用一个开关跳过 `retainWakeup`。跳过时九次运行有六次停顿，最差时延为 29595、29552、29428、29428、29343 与 28713 毫秒；启用时九次运行在更高负载下零次停顿，最差时延 85 毫秒。

在不超过核数两倍的负载下，`tests/integration.host.spec.ts` 连续十四次运行、每次十个测试全部通过，整个 `packages/experimental/inspector` 套件的二十一个文件、一百四十一个测试也全部通过。在大约三倍核数以上的负载下该文件仍会失败，但只发生在 `cancels Client Runtime work when the Worker deadline expires`，且源于该用例自身的 `clientRuntimeTimeoutMs: 20`，已记录于测试 CDP 客户端那篇 Agent Note。
