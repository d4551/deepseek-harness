# Agent Note: bash 与 pwsh 两套接口共用一份实现

Status: implemented

[English](2026-09-03-bash-pwsh-parallel-surfaces.md) | 中文

## 问题

八个包把 `ctx.shell` seam 及其两个面向模型的工具实现成了两族——`bash-local`/`pwsh-local`、`bash-sandbox`/`pwsh-sandbox`、`tool-bash`/`tool-pwsh`、`tool-bash-persistent`/`tool-pwsh-persistent`。每个 pwsh 包都带着一条注释，声称自己是其 bash 孪生包「有意为之的逐调用镜像」，而这些注释同时充当 `jscpd:ignore` 标记，因此克隆门禁从未报告过这四对。移除标记后，这四对在大约 918 行上报告了 35 处克隆：仓库中最大的一簇。

镜像说法不是证据。对这些区域做 diff 显示，几乎没有一处重复源于平台差异。真正的平台差异很小，而且可以逐条列举：`bash -c <command>` 与 `pwsh -NoLogo -NoProfile -NonInteractive -Command <preamble><command>` 的区别、`TERM=dumb`（一个 pwsh 用不上的 POSIX 概念）、pwsh 可执行文件解析及其 UTF-8 输出前导、每个提供方盖在自身错误上的诊断前缀，以及持久 PTY 工具特有的命令包装、引号处理、提示符处理和面向模型的 shell 名称。其余部分全是复制。

## 决策

`@deepseek-ai/dsh-shell` 是两族本就依赖的 Service Definition 包，它拥有每种方言表述相同的那部分。方言包只保留真正不同的部分。

**提供方。**`SubprocessShellExecutor`（`@deepseek-ai/dsh-shell/subprocess-executor`）实现了整个 `ctx.shell` 提供方：设置分区的安装、`resolve` 的默认值填充与上限收敛、spawn 规格、collect reader 投影、融合后的截止期限与首因分类、带消费式读取合并和一次性投递 spawn 失败提示的后台句柄，以及可选的 `ctx.sandbox` 约束层。提供方只提供一个 `ShellDialect`（`label`、`envOverrides`）和一个 `argv(spec)` 方法。`dsh-bash-local` 从 328 行降到 70 行，`dsh-pwsh-local` 从 360 行降到 125 行；`pwsh-local` 额外覆盖 `onConfigChange`，因为它解析出的可执行文件是它唯一从配置派生的事实。

**约束。**`ShellConfinement` 持有一次受约束运行据以结算的每进程事实，把 runner 启动的正面证据转换为 `SANDBOX_UNAVAILABLE`，并盖上 `mode`/`denied`/`enforcement`/`runnerFailed`。它通过本地的 `ShellSandboxPolicy` 接口从部署的策略服务读取两个成员，而 `ctx.sandboxPolicy` 在结构上满足该接口，因此该 seam 不新增对 `@deepseek-ai/dsh-sandbox-policy` 的依赖。`dsh-bash-sandbox` 与 `dsh-pwsh-sandbox` 现在只剩一个类声明、一个 `inject` 列表和一次 `confineThrough({ sandbox, policy })` 调用：182 行和 189 行变成了 46 行和 53 行。

**工具。**该 seam 拥有两个工具共同发布的面向模型文本与调用约定：`renderShellResult` 和 `renderShellProcessRead`（连同本就在此、作为其逆操作的 `parseExitStatus`）、`processOutcome`、`validateShellToolArgs`、`canonicalShellResult`，`timeoutMs`/`workdir`/`run_in_background`/`sandbox_permissions`/`justification` 参数，`SHELL_TOOL_OUTPUT_SCHEMA` 以及 `SHELL_ESCALATION_GUIDANCE`。模型可见的字节一个都没有变：`gen-tool-catalog --check` 报告已提交的目录——它固定了两个工具的描述、参数和输出 schema——仍然是最新的。每个工具包只表述自己的方言：工具名称、命令词汇、pwsh 额外给出的关于被强制终止进程的平台说明、它的提示词分区，以及它的 workdir 解析。

有两条 pwsh 注释是真的，并作为行为保留下来：`TERM` 不进入 pwsh 环境，因为它是 POSIX 概念；pwsh 的 argv 保留 `ENCODING_PREAMBLE`，因为 Windows PowerShell 5.1 默认按控制台代码页写出。镜像注释所辩护的其余一切，现在都只有一份定义。

## 生成器约束了什么

[`scripts/gen-config-catalog.ts`](../../../../scripts/gen-config-catalog.ts) 静态遍历每个插件入口的 `static Config` 字面量，因此每个提供方仍要逐一写出自己接受的键：展开共享字段会让这次遍历报告 `schema object property '...subprocessShellConfigFields()' is not a plain key`，随后目录会声称该插件不接受任何字段。写出键名、而把 schema 取自别处则没有问题——遍历器只记录键名，忽略值表达式——因此 `subprocessShellConfigFields()` 提供每个共享字段（包括其默认值），每个提供方的字面量只是一份两行长的键名清单。配置中没有任何内容被写了两遍。

## 两个 Consumer 孪生包

工具 Consumer 层有同样的问题，而且没有包可以拥有它：`tool-bash` ↔ `tool-pwsh` 共享 `presentCall`、`presentResult`、升权审批包装层、`apply()` 前导以及 `execute` 主体，持久那一对则共享整套会话注册表、轮询循环与捕获渲染。把这些移进 `@deepseek-ai/dsh-shell`，会让该 seam——以及每个依赖它的执行器提供方——需要 `@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-jobs`、`@deepseek-ai/dsh-agent`、`@deepseek-ai/dsh-terminal` 和 `@deepseek-ai/dsh-user-approval`。改为合并孪生包，见[每个角色一个 shell 工具 Agent Note](../architecture/2026-09-03-one-shell-tool-per-role.zh.md)：`@deepseek-ai/dsh-tool-shell` 与 `@deepseek-ai/dsh-tool-shell-persistent` 用一份实现注册任一方言，而 `dsh-tool-shell` 消费本 Agent Note 迁入该 seam 的渲染、参数、输出 schema、参数校验与升权指引。

## 考虑过的替代方案

**把共享的 Consumer 代码放进 `dsh-tool-bash`，再由 `dsh-tool-pwsh` 导入。**不予采用，理由是 [pwsh UI 对等 Agent Note](../feature/2026-08-05-pwsh-ui-bash-parity.zh.md) 已经记录过的那一条：一个工具依赖它的孪生工具会颠倒包之间的关系，并把 `tool-bash` 塞进每一个刻意只挂载 pwsh 工具的组合。

**把工具层依赖给 `dsh-shell`，把一切都移过去。**不予采用：`packages/AGENTS.md` 规定工具 schema 与展示留在 Consumer，而一个对等依赖集合中含有工具注册表、任务运行时和 agent 主干的 seam，会让一个叶子执行器提供方拖进整条产品主干。

**使用 mixin（`confining(Base)`），让每个沙箱执行器继续继承自己的本地执行器。**不予采用：在抽象基类之上使用 TypeScript mixin 需要 `any[]` 构造函数参数，并在声明生成时产生无法命名的返回类型。改为把约束层装在共享基类上，既保住两条继承链，也只保留一份实现。

**让沙箱执行器直接继承 `SubprocessShellExecutor`，而不是继承各自的本地孪生类。**不予采用：`SandboxPwshExecutor` 将不得不重复 `pwsh-local` 的可执行文件解析，等于用一处克隆换另一处克隆。

**让配置 schema 字面量保持共享，重新生成目录。**不予采用：生成器会拒绝该文件，而不是发出一条不完整的条目；教会它一种新的 schema 写法属于 `scripts/` 的改动，超出本次变更的范围。

## 测试

`renderResult`/`renderPwshResult`、`renderProcessRead`/`renderPwshProcessRead` 以及两套 `processOutcome` 测试集从两个工具包移入 `packages/shell/shell/tests/render.spec.ts` 和 `packages/shell/shell/tests/background.spec.ts`，合并时保住了两侧的每一条断言——bash 用例，加上 pwsh 测试集对精确字符串的拒绝、升权提示和 runner 失败的预期，以及一条与 POSIX 路径并列的 Windows spill 路径。每个工具的 `presentResult` 往返测试留在各自的包里，现在驱动共享的渲染器，因为它把该工具的展示转换器钉在标记约定上。

`bash-sandbox` 的三条事实泄漏断言读的是 `confinement.processFacts` 而不是 `processFacts`：同一个 map、同一条断言，只是所有方深了一层。

## 后果

`@deepseek-ai/dsh-shell` 新增 `@deepseek-ai/dsh-timeout` 作为对等依赖（peer dependency）、`@deepseek-ai/schemastery` 作为依赖，并发布带独立 `tsdown` 入口的 `./subprocess-executor` 子路径。该 bundle 会导入包根，因此它携带 Service Definition 的第二份副本；该 seam 不持有可变状态，并按名称注册服务，所以这份副本不改变任何调用方可观察到的东西。

配置目录现在把 `dsh-bash-local` 的配置显示为 `export type Config = SubprocessShellConfig` 并附上指向该 seam 的链接，与 `dsh-bash-sandbox` 本来的形式相同。

`packages/shell` 的克隆门禁结果：35 处克隆、883 行重复代码变成零。
