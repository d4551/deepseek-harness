# Agent Note: 让 swarm 模式可达、强制 write scope 互斥，并把每一个根目录交给子会话

Status: implemented

[English](2026-09-03-swarm-reachability-and-child-roots.md) | 中文

## 问题

三个缺陷，每一个都是代码没有兑现的一项宣称。

**swarm 模式哪里也没有交付。** `packages/preset/swarm-profile` 设了 `private: true`，处在 `scripts/check-workspace-constraints.ts` 的发布排除 allowlist 中，没有任何 `PROFILE_TEMPLATES` 条目指名它，也没有任何 `apps/cli` 依赖声明它。`packages/bundle/base/cordis.patch.yml` 携带 `subagent` seam 及其两个进程内提供方，却没有 `agent-team` 或 `tool-agent-team` 配置行，因此协作底座在每一份交付组合中都是缺席的。swarm 层里的 `maxConcurrentRuns: 8` 没有约束住任何用户跑得起来的东西；交付的上限仍是 seam 自己的默认值。交付要求的是一项可用的功能，而它唯一的入口是一份源码检出。

**write scope 互斥在一条路径上被强制，在它的同级路径上却是敞开的。** `TeamTaskBoard.claimNextReady` 会跳过 write scope 与某个 in-progress 任务重叠的候选任务，`team_task_claim_next` 的描述也告诉模型不会有两个成员写同一批路径。`TeamTaskBoard.update` 完全不做 scope 检查，而 `team_task_update` 在两种协作模式下都暴露 `claim`，因此同一个模型可以经由这条指名的路由拿下同一个任务。`reassign` 与一次扩大 scope 的 `edit` 也能抵达同一个状态转移。这一重叠只以一条提示性的 `writeScopeWarnings` 字符串浮现出来，某个测试在同时 claim `src` 与 `src/nested` 时断言了它。省略 schema 字段并不是一个可选的修法，而且那也算不上强制：作出判定的操作是那个服务方法。

**附加工作区根目录止步于委派边界。** `childSessionMeta` 从父级 header 复制了 `cwd`，关于工作区的其他信息一概没有复制。`setAdditionalWorkspaceRoots`、`workspace/roots` 与 `sessionWorkspaceRoots` 在 `packages/subagent/`、`packages/core/agent/` 与 `packages/core/agent-loop/` 之下均未出现。因此每一个 `subagent`、`subagent_fork` 与 Team teammate 都只在主根目录中运行：它的沙箱写入围栏、搜索覆盖、语言服务器路由与按根目录的指令加载全部塌缩，而且是在父级已经跨越数个文件夹划定范围的任务中途悄然塌缩的。

## 决策

**swarm 层就地发布，并由一个交付的 `swarm` profile 把它叠上去。** `@deepseek-ai/dsh-swarm-profile` 去掉 `private` 并声明 `publishConfig.access: public`；它的 allowlist 条目被移除，因为一个可发布的包不能留在发布排除表中。`PROFILE_TEMPLATES.swarm` 是 `['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless', '@deepseek-ai/dsh-swarm-profile']`，带 `patchReload: 'startup'`，并且 `apps/cli` 把该组合包声明为依赖，这样 `resolveBundleDir` 才能从安装锚点找到它。`dsh --profile swarm "<task>"` 就是入口：一个 headless 任务、多个 teammate、一块共享任务板、可配置的运行上限。

这一层仍是一份自足的补丁文档，而不是叠在 `agent-team-profile` 之上的增量，这是[既有的决定](../process/2026-09-03-swarm-layer-drift-and-atomicity-scope.zh.md)——组合包无法要求一个前置组合包，因此只应用增量的用户得到的会是一条 Loader 警告，而不是一次拒绝。两份文档仍然是一份经过校验的副本，而防止它们漂移的等价性测试与基础配置行 id 测试保持不变。

这一层仍留在 `packages/preset/` 之下。把它移到 `packages/bundle/` 会更贴合分组定义，但这次移动要改写生成的 tsconfig 路径别名、模块图与配置 catalog，而其他工作正在这些文件中进行，况且它并不能换来 profile 模板条目尚未提供的任何东西。

**write scope 互斥在那次让任务处于 in-progress 的提交上被强制。** `TeamTaskBoard.update` 在任务图检查之后、日志追加之前断言：没有别的 in-progress 任务持有重叠的前缀，否则以 `TEAM_TASK_WRITE_SCOPE_CONFLICT` 拒绝。判定条件是提交后快照的状态，而不是动作名，因此 `claim`、`reassign` 与一次扩大 scope 的 `edit` 全部受它约束，而且日后新增的动作无法落在它之外。`release`、`complete`、`reopen` 与 `delete` 从不会让任务停留在 in-progress，因此不受影响。

`claimNextReady` 仍然选择推迟而不是拒绝，这份不对称正是重点所在：它的调用方要的是任何一份空闲的工作，因此一次碰撞是它以 `write-scope-conflict` 连同被推迟的 id 一并报告的普通任务板状态。`update` 指名了一个任务，因此一次碰撞就是对所请求之物的拒绝。一个私有的 `busyOverlaps` 助手同时支撑推迟、拒绝以及待办任务视图所携带的 `writeScopeWarnings`，因此这三者不会对什么算重叠各执一词。

`writeScopeWarnings` 保留下来。在互斥之下，一个 in-progress 任务不可能再携带这样的警告，但待办任务的视图仍会指名正在阻塞它的 in-progress 工作，那正是成员在决定是否等待之前会读的东西。这些前缀仍然是任务板的互斥键，而不是文件系统锁：没有任何东西阻止成员写到自己 claim 的 scope 之外，而两份 README、子系统页面以及两份协作策略现在都这么写，不再把这些 scope 称作提示性的。

**子会话继承父级工作区的方式，与它继承父级策略的方式相同。** `DelegatedPolicyOverrides` 更名为 `DelegatedSessionState` 并新增 `workspaceRoots`；`captureDelegatedPolicyOverrides` 与 `appendDelegatedPolicyOverrides` 更名为 `captureDelegatedSessionState` 与 `appendDelegatedSessionState`。捕获动作在子会话启动的第一个 await 之前同步读取 `effectiveWorkspaceRoots(parent.session.events)`，就挨着沙箱覆写与审批固定值，因此此后再改动自己根目录的父级，改动的只是它自己的将来。追加动作在未发布的创建窗口内通过 `setAdditionalWorkspaceRoots` 写入它们，其中会丢弃与子会话主根目录相同的根目录，并在 fork 种子已经携带同一组根目录时不追加任何内容。

于是「模型可见即被记录」得以成立：子会话的根目录以一条 `workspace/roots` 事件存在于子会话自己的日志上，`sessionWorkspaceRoots` 折叠它们，冷恢复会回放它们，而不是从一个可能已经消失的父级重新推导。选择改名这一对函数而不是新增第二对，保住了[可续接策略那篇 Agent Note](../feature/2026-08-10-continuable-subagent-policy-inheritance.zh.md)所确立的单一捕获点：一次性驱动器与续接管理器都调用它，因此两条委派路径不会漂移，而 Team teammate——一个可续接的子会话——按构造即被覆盖。

本 Agent Note 交付时，四个进程外提供方（`subagent-codex`、`subagent-claude-code`、`subagent-acp`、`subagent-dsh-sdk`）只传递主根目录，因为把一组根目录跨每个产品各自的接口传递，是每个产品各自的改动，需要各自的协议证据。[进程外子 agent 工作区根目录 Agent Note](2026-09-03-out-of-process-child-workspace-roots.zh.md) 提供了这份证据，并通过每个产品自己的根目录列表把这些根目录传递下去，因此这些 README 不再携带该限制。

## 验证

`bun x vitest run packages/subagent packages/preset packages/bundle apps/cli`——1187 通过、3 失败，三个失败全部位于 `packages/subagent/subagent-codex/tests/real-product.spec.ts`。原因是这台宿主在 `/etc/codex/requirements.toml` 上的受管 Codex 策略（root 所有，`allow_managed_hooks_only = true`），而这一结论来自抓取到的协议帧，而不是我们自己的错误文本。

子进程给出了正确答案——`item/completed` 携带了脚本约定的哨兵值。随后该策略的四个 `[[hooks.Stop]]` 条目运行，`mas-stop-advisor.mjs` **拒绝了这次 stop**：`[NES strict] Stop denied: Judge certification has not completed.`（`hookRunId stop:27`）与 `[NES/PirateBao strict] Stop denied: trusted source evidence is not bound.`（`stop:30`）。被拒绝的 stop 会让 app-server 继续这一轮，于是第二次请求打到只脚本化了一种行为的 Responses fixture，得到 500；再经过五次 `responseStreamDisconnected` 重试后以 `internalServerError` 结束，而 `wire.ts:163` 将其映射为 `category: 'service'`——这是正确的。分类没有问题，这一轮确实失败了。

该拒绝读取的是一个共享的 MAS 生命周期账本，它会在审计周期运行期间变化，因此这**并不确定**：探针测得 3 次运行中 2 次被拒、1 次放行，某个单独用例先通过一次，随后连续失败五次。三种隔离尝试均被证伪——在测试 `CODEX_HOME` 中设置 `features.hooks = false`、清空 `hooks.managed_dir`、以及在 `thread/start` 中覆盖 config——因为 `/etc/codex/*.toml` 是编译进二进制的绝对路径，且生成的 `ClientRequest` schema 没有暴露任何关闭钩子的入口。

本段较早的一个修订只点名了 `PreToolUse` 的 `hardban-edit-guard` 拒绝。那个钩子在这台宿主上确实会触发，但它不是让这三个用例失败的原因，Stop 拒绝才是。「只有 PreToolUse」的措辞是对一句原本准确的话所做的错误更正，上面的协议帧把它恢复了回来。


`apps/cli/tests/profile-bundles.spec.ts` 通过：每个模板指名的每个组合包都是一项已声明的 `apps/cli` 依赖。`packages/boot/app-boot/tests/profile.spec.ts` 钉住新的模板元组，以及缺失 profile 诊断所打印的交付 profile 列表。`packages/preset/swarm-profile/tests/profile.spec.ts` 现在断言该 manifest（元数据清单）可发布，而它对交付配置行的 Loader 启动保持不变。

`apps/web/tests/swarm-web-composition.e2e.ts` 覆盖 `swarm-web` 元组本身。它从 `PROFILE_TEMPLATES` 读取组合包列表，把每个组合包解析到该包 manifest 自己声明的 patch 文件，在空根之上完成组合，并断言生效条目表带有 `maxConcurrentRuns: 8`、`maxMembers: 16` 与 `coordination: swarm`；随后启动脚手架尚未挂载的那些层，断言实时 Loader 配置行带有相同取值、`ctx.subagents.capacity()` 报出该上限、客户端名册提供 `dsh-client-ui-agent-team` 与 `dsh-client-ui-workspace-roots`，以及 Lead 装配出的提示词是 swarm 策略而非 delegated 策略。把模板中的 `dsh-swarm-profile` 换成 `dsh-agent-team-profile` 会让第一项上限失败，去掉浏览器组合包会让名册失败，让已挂载的工具忽略其配置的 coordination 会让提示词失败。不使用浏览器：面板与工作区标题的渲染各有自己的用例，而 swarm 的差异抵达的是模型而非 DOM。

write scope 这部分工作是通过执行器而不是工具 schema 来证明的。`refuses every named route that would start work on paths already being written` 先 claim `src`，随后拒绝一次改派给 teammate 的 `reassign`、teammate 自己的一次 `claim`，以及把一个已准入的 `docs` 任务扩大到 `src/deep` 的一次 `edit`，最后展示在持有的任务被释放之后每条路由都放行一次。原先演示该绕过路径的那个已作废用例，现在断言的是拒绝本身、没有任何内容被提交，以及被拒绝任务的视图指名了阻塞它的那个任务。

根目录这部分工作是通过后果来证明的。`gives a spawn child every workspace root its parent works in` 让子会话在 `workspace-write` 沙箱下 `write` 进第二个根目录并把文件读回；还原那行追加代码会让它以沙箱拒绝失败。`records no roots for a single-root parent` 守住空集情形。`seeds the parent workspace roots and reconstructs them on cold resume` 检查运行中的子会话、从父级移除该根目录、发起一次跟进，并断言持久化的子会话日志仍然折叠出委派时刻的那组根目录，且恰有一条 `workspace/roots` 事件。`gives a teammate every workspace root its Lead works in` 覆盖 Team 路径。

每个被改动的源文件在语句、分支、函数与行上的逐文件覆盖率均为 100%：`agent-team/src/{task-board,index,validation}.ts`、`tool-agent-team/src/index.ts`、`subagent/src/{child-agent,continuation,index}.ts`、`subagent-in-process-driver/src/index.ts` 与 `app-boot/src/profile.ts`。`bun run constraints`、`bun run verify-package-invariants`、`scripts/no-barrels.ts`、`scripts/verify-export-jsdoc.ts`、`scripts/run-oxlint.ts` 以及限定范围的 `tsc -b` 全部通过。`bun run test:snapshot` 回放不变：没有任何交付的默认组合挂载 Team 工具，也没有任何录制会话声明附加工作区根目录。`bun run gen-cordis-catalog` 重新生成了 `docs/subsystems/agent-team.md` 及其中文对侧文件中的两份 Team 服务约定。

## 考虑过的替代方案

**把 Team 底座放进 `packages/bundle/base`。** 否决：那会把 Team 工具面及其提示词策略交给每一个 profile，而按需选用的东西不进交付默认值。

**把 swarm 拆成叠在一个已发布 `agent-team` 组合包之上的增量。** 以那篇漂移 Agent Note 已经记录的理由否决——没有任何东西能强制用户把两者都叠上，而只应用增量得到的是警告而不是拒绝。

**让 `claim` 保持提示性，并把它与 `claim_next` 的差别记进文档。** 否决：claim-next 的工具描述向模型承诺两个成员绝不会写同一批路径，而在这项承诺上留一个有文档的洞，那个洞照样是洞。

**只拒绝 `claim`。** 否决：`reassign` 在 Lead 权限下执行同一个状态转移，因此互斥只会从一个动作挪到另一个动作，而不是被关上。

**把这些根目录放在 `childSessionMeta` 中、挨着 `cwd`。** 否决：附加根目录按设计就是一项日志事实，折叠是它唯一的读取方，而在 header 中再开一处存放位置，就需要它自己的恢复与回放方案。

**当父级带有额外根目录时，拒绝向进程外提供方委派。** 否决：能力缺口不是配置错误，而拒绝会为了一项 README 条目已经如实写明的收窄，打断本来可用的、只与单根相关的委派。

## 后果

`dsh --profile swarm` 是一个交付入口，它的组合包随发布载荷一同分发；缺失 profile 的诊断会列出它。一条重命名 `dsh-base` 中某个 subagent id 的补丁配置行，现在会打断一个交付的 profile，而不是一个按需选用的层，这由该层既有的基础配置行 id 测试捕获。

Team 任务板上没有任何路由能让两个所有者在重叠的 write scope 上开工，`TEAM_TASK_WRITE_SCOPE_CONFLICT` 是模型会看到的一个新的稳定错误码。两份协作策略各增加了一句话；把工作分解成重叠 scope 的 swarm Lead 现在得到的是一次必须解决的拒绝，而不是一条可以忽略的警告。

每个进程内子会话都携带父级完整的工作区，并且它的日志写明了这一点。一个录制的 swarm 会话以及针对 `--profile swarm` 的无密钥快照尚待补上；录制需要 API 密钥，因此这一层目前的覆盖是那次 Loader 真实组合测试，加上 headless 的 Team 端到端运行。

`swarm` 与 `hosted` 现已写入 `apps/cli/README.md` 与 `docs/architecture.md`，`apps/cli/tests/profile-bundles.spec.ts` 中的第五个用例会在任一随附模板缺席其中任一页面或其中文对照页时失败。此前「可达」被理解成一项解析属性，于是两个 profile 都能启动，却没有任何用户会读的页面提到过 `swarm`：`architecture.md` 只列出七个模板中的六个，而 CLI README 把五个说成会自动初始化，实际上七个都会。另有三句话不只是不完整，而是写错了——`dsh-base` 被说成是四个具名 profile 的第一层，实际上除 `sdk-minimal` 外每个随附 profile 都以它为底；patch 重载的划分漏掉了两个新 profile；Agent Teams 被描述为「直到 profile patch 启用它」之前一直禁用，而随附的 `swarm` profile 正是那层 patch。把 `architecture.md` 中带反引号的 `swarm` 去掉，新用例会以 `docs/architecture.md -> swarm` 失败。
