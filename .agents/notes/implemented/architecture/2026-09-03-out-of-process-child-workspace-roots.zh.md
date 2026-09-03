# Agent Note: 把父级的工作区根目录传递给每一个进程外子 agent

Status: implemented

[English](2026-09-03-out-of-process-child-workspace-roots.md) | 中文

## 问题

进程内子 agent（智能体）会继承父级的完整工作区：`childSessionMeta` 复制 `cwd`，`appendDelegatedSessionState` 把父级的附加根目录写到子 agent 自己的日志上（[让 swarm 模式可达、强制 write scope 互斥，并把每一个根目录交给子会话](2026-09-03-swarm-reachability-and-child-roots.zh.md)）。四个进程外提供方只把 `cwd` 交给子 agent，除此之外别无他物，因此跨多个文件夹工作的父级会悄悄把每个外部子 agent 收窄到其中一个：它的沙箱写入围栏、搜索覆盖范围与逐根目录指令加载会在一项父级已按更大范围界定的任务中途一起坍缩。

四份 README 中有两份用一个关于子产品的说法来为这次收窄辩护，而该说法是错的。Claude Code 的 Agent SDK 接受 `Options.additionalDirectories`，Codex 的 `thread/start` 接受按线程的配置覆盖，其中包括 `sandbox_workspace_write.writable_roots`；两个产品都不是只从自身配置获取工作区。ACP 的 `NewSessionRequest` 早在所锁定的 SDK 版本之前就已经在 `cwd` 旁携带 `additionalDirectories`，因此「只携带单个 `cwd`」的说法同样是错的。`subagent-dsh-sdk` 驱动的是本仓库自己的 SDK，那里唯一的障碍只是 `InitializeParams` 没有承载这些根目录的字段。

## 决策

**seam 中一个解析步骤，每个产品一种传递机制。** `resolveChildWorkspaceRoots(parent, childCwd)` 与 `resolveChildCwd` 一同放在 `dsh-subagent/out-of-process`：它返回 `sessionWorkspaceRoots(parent.session)` 去掉子 agent 自身解析出的 `cwd`。每个提供方在 `start()` 中调用它并把结果存到自己的运行 spec 上，因此默认值处理始终是拥有方实现中的显式解析步骤，而不是驱动内部隐藏的 `??`。

结果中刻意不包含父级自己的 `cwd`。没有 `cwd` 覆盖时子 agent 本就在那里运行；存在覆盖时，部署已经声明了子 agent 的工作位置——把父级目录再加回去，会让一个被刻意固定的子 agent 的写入围栏越过其配置。因此 `childCwd` 过滤只会移除恰好落在父级某个附加根目录上的覆盖值，那是该子 agent 的主根目录而非附加根目录。根目录按精确拼写比较，也就是 `setAdditionalWorkspaceRoots` 记录它们所用的同一身份；规范化归子 agent 自己的强制层负责。

**传递出去的根目录集合要经过确认，而不是假定。** 三个外部接口中有两个可能静默丢弃该字段，而子 agent 在比父级记录更窄的工作区中运行，正是这项工作要消除的失败，因此两者都不靠「发出去就算」。

ACP 走协商：`SessionCapabilities.additionalDirectories` 为 `{}` 表示支持，键缺省与显式 `null` 都表示不支持。当父级存在附加根目录、而子 agent 的 `initialize` 响应未声明该能力时，委派会在该响应处——也就是该声明存在的最早时点——以 `stage: new-session; category: configuration` 被拒绝。cause 中写明配置的 agent 命令以及它无法接收的根目录，便于运维处置；模型可见文本仍保持本包固定的安全事实。

Codex 不协商，但会给出确认。`thread/start` 的 `config` 映射中无法识别的键会被忽略且不报错——这与 CLI 的 `--strict-config` 会大声拒绝不同——因此未来版本重命名该键会在毫无信号的情况下收窄子 agent。`ThreadStartResponse.sandbox` 会报告合并后的策略，因此这个确认是可校验的：当声明了根目录且返回策略为 `workspaceWrite` 时，每个声明的根目录都必须出现在它的 `writableRoots` 中。`dangerFullAccess` 下子 agent 本就可以写任何位置，而只读或外部策略下该列表并非部署所选的机制，因此两者都不视为传递失败。

Claude Code 与 DSH SDK 两者都不需要。`Options.additionalDirectories` 是精确锁定的直接依赖上的普通启动选项，它一旦消失便是编译错误而非静默丢弃；其附近记载的「仅限收紧」过滤只作用于 `managedSettings`，而本提供方从不传入该项。DSH SDK 服务器是我们自己的，它会如实记录收到的内容。

空根目录列表不发送任何内容。这对 Codex 并非只是外观问题：`thread/start` 的 `config` 映射是一个覆盖，因此携带空列表的 `writable_roots` 条目会把部署自身已配置的根目录替换成零。为保持对称，同一规则适用于所有位置，而每个提供方既有的精确载荷测试都会钉住单根目录请求保持不变。

**每个产品都通过它本来就有的列表接收这些根目录。**

- `subagent-claude-code` 设置 `Options.additionalDirectories`，即官方 Agent SDK 中与 CLI `--add-dir` 对应的字段。
- `subagent-codex` 在 `thread/start` 上加入 `config: { 'sandbox_workspace_write.writable_roots': [...] }`。这里使用线程级配置覆盖而非结构化的 `sandboxPolicy`：后者会迫使本提供方为了改一个字段，而把部署的网络、tmpdir 与 `/tmp` 设置重新写成硬编码值。
- `subagent-acp` 在 `session/new` 上加入 `additionalDirectories`。
- `subagent-dsh-sdk` 新增一个协议字段，因为子 agent 就是本仓库自己的运行时。`InitializeParams.additionalDirectories` 是可选且仅接受绝对路径的；`HarnessSdkJsonRpcServer` 在握手时校验它——在任何会话存在之前，与 `session.create` 拒绝非法根目录的位置相同——并通过 `setAdditionalWorkspaceRoots` 把它记录到 SDK 创建的每个会话上。`DeepSeekHarnessOptions.additionalDirectories` 会针对调用进程解析每个条目，原因与 `cwd` 相同：子 agent 不再做二次解析。

在 SDK 子 agent 上，这些根目录与别处一样仍是日志事实：header 只携带 `cwd`，子 agent 自己的 `workspace/roots` 事件携带该集合，冷恢复会重放它。

## 测试

每个提供方都在子 agent 调用处得到验证，而不是在某个调用边界。`subagent-codex` 通过 `ctx.subagents.start` 搭配多根目录父级，断言伪 app-server 实际收到的 `thread/start` 帧，并在 wire 层另有一处断言。`subagent-claude-code` 从官方 `query` 被调用时的 options 上读取 `additionalDirectories`。`subagent-acp` 驱动真实的 mock agent 进程，它在 `MOCK_ECHO_ROOTS` 下把收到的 `additionalDirectories` 回显出来；第三个用例通过断言父级自身工作区作为附加根目录抵达，钉住 `cwd` 覆盖时的行为。`subagent-dsh-sdk` 读取伪运行时从 wire 上记录下来的 `initialize` 参数。SDK 服务器断言所创建会话的日志折叠为握手根目录、省略列表时完全不追加事件、以及相对路径条目会被拒绝且消息中带上该路径。SDK 客户端断言解析为绝对路径的握手载荷，以及空列表时的省略。

两道确认防线以同样方式得到验证。ACP 套件驱动真实 mock agent 走过三种协议合法的回答——能力键缺省、显式 `null`、以及完全没有 `agentCapabilities`——每一种都会拒绝多根目录启动，而单根目录用例仍可对未声明能力的 agent 正常运行；关闭该门槛会让它们全部由拒绝变为兑现，而把 `null` 读作支持则只让 null 用例失败。Codex 套件用真实 app-server 返回的策略回应 `thread/start`，会拒绝被忽略的覆盖、没有携带可写根目录列表的 `workspaceWrite` 策略以及无法读取的策略，同时接受 `dangerFullAccess`；移除该校验会让三处拒绝全部失败，而跳过 `workspaceWrite` 验证则会让其中关键的两处失败。

回退每一处传递代码，都会让它自己的测试失败并指名缺失字段：Claude Code 为 `expected undefined to deeply equal [ '/second-root', '/third-root' ]`，Codex 为缺失的 `config` 键，ACP 子 agent 的回显为 `expected null to deeply equal [...]`，SDK 握手为缺失的 `additionalDirectories`，服务器记录的根目录为 `expected [] to deeply equal [...]`。

四个提供方套件中的伪父级 Agent，以及 SDK 服务器套件中的伪 Agent，都补上了解析与记录步骤要读取的 `session` 成员；它们此前是某个类型的不完整桩，而该类型的真实值总是携带这些成员。

## Alternatives considered

**传递父级的完整根目录列表（`sessionWorkspaceRoots`），让被 `cwd` 覆盖的子 agent 把父级自身工作区保留为附加根目录。** 最初正是这样实现的，随后被拒绝。它会放宽一个被部署刻意固定到别处的子 agent，把其配置从未指名的目录的写入权限交给它；并且会把每一个单根目录的 `cwd` 覆盖部署都变成多根目录委派——继而卡在 ACP 的协商门槛上。`effectiveWorkspaceRoots` 既是更窄的答案，也是进程内捕获本就采用的那一个，因此两条委派路径不会彼此分歧。

**把根目录发出去，交由子 agent 自行处理。** 对 ACP 与 Codex 拒绝：忽略该字段的 agent 会让父级以为自己授予了一个子 agent 从未拥有的工作区，而这正是本工作要消除的静默收窄。拒绝的代价是一次本可降级运行的委派；接受的代价则是毫无信号的正确性损失。

**在 `turn/start` 上给 Codex 发送结构化的 `sandboxPolicy`。** 拒绝：`SandboxPolicy.workspaceWrite` 是一条完整记录，提供它意味着本提供方要替部署自身的 Codex 配置去选择 `networkAccess`、`excludeTmpdirEnvVar` 与 `excludeSlashTmp`——为了改一个配置覆盖本就能直接命中的字段，在插件里塞入硬编码可调项。

**为统一起见无条件发送空根目录列表。** 在 Codex 上被拒绝：config 映射是一个覆盖，空的 `writable_roots` 会抹掉部署已配置的根目录。因此对四者统一采用「为空即省略」，而不是按产品拆分规则。

**在 `session/prompt` 而非 `initialize` 中携带 SDK 协议上的根目录。** 拒绝：`cwd` 是进程级握手事实，会记录到 SDK 创建的每个会话上，而这些根目录是关于同一工作区的同一事实。按提示词携带的字段会让同一运行时中的两个会话，对客户端只描述过一次的工作区产生分歧。

**给每个提供方增加 `workspaceRoots` 配置字段。** 拒绝：这些根目录是发起委派的会话的属性，而非部署选择，配置出来的列表会让提供方行与父级自己的日志相矛盾。`cwd` 覆盖之所以存在，是因为部署确实可能需要固定子 agent 的运行位置；没有任何类似理由支持第二套彼此冲突的根目录集合。

## Consequences

外部子 agent 现在能触及父级工作的每一个文件夹，因此无论子 agent 是进程内的，还是 Claude Code、Codex、ACP 或嵌套运行时进程，多根目录委派的行为都一致。代价是四处产品专属耦合，其中两处现在还各带一道校验。重命名了点分配置路径的 Codex 版本会在确认校验处大声失败，而不是静默收窄——这是更好的失败方式，但仍是失败：该部署在更新该键之前将停止委派。尚未采纳 `SessionCapabilities.additionalDirectories` 的 ACP agent 完全无法接收多根目录委派，但它仍能服务每一次单根目录委派。精确载荷测试钉住了当前的键，而该包既有的「协议按版本锁定」限制本就要求升级时重新跑一遍协议证据。

`InitializeParams` 增加了一个可选字段。省略它的既有客户端不受影响——服务器不会记录任何内容——因此 Python SDK 无需改动即可继续工作，只有在它选择发送该字段时才获得这项能力。
