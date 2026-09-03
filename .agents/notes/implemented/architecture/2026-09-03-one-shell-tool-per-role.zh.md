# Agent Note: 每个角色一个 shell 工具包，shell 由配置指定

Status: implemented

[English](2026-09-03-one-shell-tool-per-role.md) | 中文

## 问题

四个包把两个面向模型的 shell 工具各发布了两遍：`ctx.shell` seam 之上的 `dsh-tool-bash`/`dsh-tool-pwsh`，以及 `ctx.terminals` seam 之上的 `dsh-tool-bash-persistent`/`dsh-tool-pwsh-persistent`。每个 pwsh 包都带着一条注释，声称自己是其 bash 孪生包有意为之的镜像，而这些注释同时充当 `jscpd:ignore` 标记；标记在全树移除之后，克隆门禁在这两对上报告了 20 处克隆：一次性那一对 7 处，持久那一对 13 处、约 316 行。

[两套接口共用一份实现 Agent Note](../simplification/2026-09-03-bash-pwsh-parallel-surfaces.zh.md)已经把*提供方*层共享的一切移进了 `@deepseek-ai/dsh-shell`，并把这 20 处上报而没有继续做下去：把 Consumer 代码提升进该 seam，会迫使 `@deepseek-ai/dsh-shell`——以及每个依赖它的执行器提供方——需要 `dsh-tools`、`dsh-jobs`、`dsh-agent`、`dsh-terminal` 和 `dsh-user-approval`。那次上报记下了决定性的事实：提供方抽取之后，pwsh 孪生包不再携带任何其 bash 对应包没有的行为。

## 决策

每一对都合并成一个以方言参数化的包。`@deepseek-ai/dsh-tool-bash` 与 `@deepseek-ai/dsh-tool-pwsh` 合并为 `@deepseek-ai/dsh-tool-shell`；`@deepseek-ai/dsh-tool-bash-persistent` 与 `@deepseek-ai/dsh-tool-pwsh-persistent` 合并为 `@deepseek-ai/dsh-tool-shell-persistent`。按[命名规则](../../../../docs/cookbook/adding-a-package.zh.md#name-the-role-that-exists)，这两个名称陈述的是实际存在的角色——一个面向模型的 shell 工具——而不是各自最先实现的那种 shell。

shell 是一个经过校验的 `Config` 字段 `dialect: 'bash' | 'pwsh'`，用 `.required()` 声明，因此**没有默认值**。给了默认值，一个挂载了 PowerShell 执行器却忘记写该字段的组合，就会在一个解析不了 bash 的 shell 之上悄悄对外宣告一个 `bash` 工具——正是 `Misconfiguration fails loud` 所禁止的那种静默误配置。写出这个字段的代价，是在那一行本来就必须做出选择的执行器配置项旁边多写一行。

### 方言选择了什么

一次性工具的 [`src/dialect.ts`](../../../../packages/shell/tool-shell/src/dialect.ts) 持有一个 `Record<ShellDialectName, ShellToolDialect>`；其中每个字段要么是一段模型可见的文本，要么是这类文本的标识符：

| 字段 | `bash` | `pwsh` |
|---|---|---|
| `toolName` | `bash` | `pwsh` |
| `jobKind` | `bash`（来自 `dsh-jobs`） | `pwsh`（在此声明合并） |
| `sectionName` / `sectionOrder` | `tool:bash` / 1000 | `tool:pwsh` / 1010 |
| `sectionText` | 退出标记提醒 | 退出标记提醒，外加 Windows 上 exit 1 的读法 |
| `intro` | `` Execute a bash command (`bash -c`) … `` | `` Execute a PowerShell command (`pwsh -Command`) … `` |
| `freshProcess` | 全新 shell，传入 `workdir` | 全新 pwsh 进程，外加原生 `C:\…` 路径和 `$env:NAME` |
| `managedEnv` | `` `$DSH_*` `` | `` `$env:DSH_*` `` |
| `platformNote` | 空 | 被强制终止的进程结算为 exit 1 的那句话 |
| `escalationPrefix` | 空 | ConstrainedLanguage 与命名管道那两段 |
| `commandDescription` / `descriptionExample` | bash 措辞 | PowerShell 措辞 |

该工具发布的其余一切——退出标记那句、沙箱拒绝那句、截断那句、后台运行那几句、参数集合、输出 schema、展示、workdir 解析、升权审批、请求组装——都只有一份定义。两个 `managedEnv` 字符串中的 `DSH_*` 前缀现在从该 seam 插值 `DSH_ENV_PREFIX`，而不再写两遍。

持久工具的 [`src/dialect.ts`](../../../../packages/shell/tool-shell-persistent/src/dialect.ts) 持有 PTY 驱动规则，那才是真正的平台差异：

- **命令包装与引号处理。** bash 在 `eval -- $'…'` 外围发出 `printf` 标记并报告 `$?`；pwsh 在 `Invoke-Expression "…"` 外围发出 `Write-Output` 标记，使用反引号转义，并结合 `$?` 解析 `$LASTEXITCODE`。两者都保持在一行物理输入上，理由各不相同：bash 遇到内嵌换行会打印 PS2，pwsh 则会把提取步骤要剥掉的 PSReadLine 回显切成两截。
- **初始化与提示符。** bash 提交 `stty -echo` 并保留后端自身的提示符，因此后端基于提示符的就绪检测仍然有效。pwsh 没有回显开关，于是它在运行时用 `[char]27`／`[char]7` 构造并安装一个私有提示符（`__DSH_PERSISTENT_PWSH_PROMPT__ `），因为在 PSReadLine 之下，提交输入中的裸 ESC 并不可靠。`prompt` 是唯一的方言字段：它是否存在还决定了 `trimTail` 中的尾部提示符剥离，以及无锚点回退路径上的内部提示符清除。
- **无标记时的结算。** bash 读取后端的 `stdin_read` 等待原因；pwsh 则在视口末尾等自己的提示符出现。
- **标记中缀与超时代码。** `__DSH_PERSISTENT_{BASH,PWSH}_{START,END}_<uuid>` 与 `PERSISTENT_{BASH,PWSH}_TIMEOUT` 都由同一个 `markerInfix` 派生。
- **面向模型的文本。** 工具名称、`command` 参数描述、默认描述、重置消息，以及输出被裁剪说明中点名的搜索命令（`` `grep -n` `` 对 `Select-String`）。

包装层剥离过去只有 pwsh 需要，如今在 `commandOutput` 和回退路径上都无条件执行：包装层内嵌了本次调用自己的 UUID nonce，因此捕获文本中任何一处出现它的地方，都是这次调用被回显的输入。对于 `stty -echo` 之下的 bash，这一步是空操作。

### 模型可见文本未变，只有一处例外

`gen-tool-catalog` 把每个包启动两次，每种方言一次，因此目录在同一个分区下记录两个名称。`docs/tool-catalog.md` 中的每一个 `json` schema 块都与合并前的目录逐字节相同：合并前 65 块，合并后 65 块，作为多重集完全一致。两个提示词分区都保持各自的名称、顺序和文本。唯一记录在案的模型可见改动与这些工具无关：随产品发布的 `editing-cordis-compositions` skill（技能）把 `tool-bash` 举为「必须位于 realm 之外的消费方配置项」的例子，这个名字不得不改成 `tool-shell`。`snapshots/session/skill-load/session.jsonl` 与 `snapshots/web/skill-tool-row/ui.expected.md` 为这一个词重新录制。

### 一处行为改动：pwsh 的 workdir 身份

`dsh-tool-pwsh` 把相对 `workdir` 解析到原始会话头部的 cwd 之上；`dsh-tool-bash` 在沙箱策略存在规范工作区根目录时解析到该根目录，否则解析到 `canonicalPath(headerCwd)`，使一条受约束的命令与它的启动目录共用同一个身份。pwsh 的 README 把这一点记为一项已知差距，「推迟到共享 shell 工具基类抽取时处理」。这次就是那次抽取：合并后的工具对两种方言都使用 bash 的解析方式，该差距就此闭合。`canonicalPath` 对不存在的路径原样返回，因此既有的那些针对合成路径的 pwsh workdir 断言不受影响。

### 组合

基础组合包里两行按平台门控的工具配置项，变成一行从不被禁用、并把同一条平台事实读进自身配置的配置项：

```yaml
- id: tool-shell
  name: '@deepseek-ai/dsh-tool-shell'
  config:
    dialect: !!js "process.platform === 'win32' ? 'pwsh' : 'bash'"
```

该表达式必须加引号。不加引号的 `!!js a ? b : c` 不是一个普通 YAML 标量——解析器把 `?` 读作显式键指示符、把 ` : ` 读作值分隔符，加载随即以 `object-based map does not support complex keys` 失败。基础补丁的 `approval` 配置项本来就为它的三元表达式用了加引号的写法。

`standard`、`ptc` 与 `cordis` preset 采用同样的单行形式。持久工具在 `minimal` preset 和 `sdk-minimal` 组合包中保留两行按平台门控的配置项，因为这两行的差异不是方言所能覆盖的：它们各自携带一段不同的、由部署方撰写并抵达模型的 `description`。

## 考虑过的替代方案

**给 `dialect` 一个 `bash` 默认值。** 不予采用：每个需要 `pwsh` 的调用点仍然得把它写出来，而一个挂载了 pwsh 执行器却忘记该字段的组合，会在 PowerShell 之上注册一个 `bash` 工具，直到模型发出第一条命令才失败。这个默认值省下四个字符，代价是一次静默误配置。

**保留四个包，通过第五个 Consumer 层包共享代码。** 不予采用：新包需要与这些工具相同的对等依赖（peer dependency）集合（`dsh-tools`、`dsh-jobs`、`dsh-agent`、`dsh-user-approval`，持久那一对还要加 `dsh-terminal`），因此它就是删掉工具注册之后的合并包——付出合并的代价，却拿不到合并的好处，还多一个发布名称。

**因为 pwsh 的 PTY 处理确有不同，就让持久 pwsh 工具单独存在。** 按实测不予采用：不同的部分是 6 个字段和 2 个方法，而重复的是大约 316 行会话注册表、回滚缓冲组装、轮询循环、捕获渲染与重置约定。方言记录恰好只持有这些差异，别无其他。

**每个组合照旧写两行配置项，每种方言一行，按平台门控。** 对一次性工具不予采用：平台决定的只有工具名称，一个配置表达式就把这件事直说了，而两行互斥的配置项要求读者去核对两个门控是否恰好互补。持久工具的配置项保留了这种写法，因为在那里平台还决定了一段不同的、面向模型的 `description`。

**保持 pwsh 的 workdir 解析原样，不改变任何行为。** 不予采用：这个差异是一项记录在案的差距，不是平台事实；保留它意味着合并后的工具携带一条按方言分叉的分支，而这条分支唯一的理由就是它过去存在。

**像 `tool-bash` 那样，把整个合并包排除在 Windows lane 之外。** 不予采用：win32 排除之所以存在，是因为 bash 测试集驱动真正的 `bash -c`，而 Windows 没有对应的解释器——pwsh 测试集恰恰是那条 lane 存在的意义。`scripts/vitest-inventory.ts` 现在按文件名排除两个 bash 方言测试集文件，而不是排除整个包，该包留在 Windows 覆盖率 lane 中。

## 测试

每一对的两套测试集都迁入合并后的包，现在在写明的方言之下驱动同一份实现：每个包里的 `tests/bash-dialect.spec.ts` 与 `tests/pwsh-dialect.spec.ts`，加上 `dsh-tool-shell` 中的 `tests/bash-integration.spec.ts`、`tests/pwsh-integration.spec.ts` 与 `tests/pwsh-loader.spec.ts`，以及 `dsh-tool-shell-persistent` 中的两套 loader 组合测试集。没有丢掉任何断言：四个包的每个用例都留了下来，改为经由写明方言的合并插件执行。六个合并后源文件的逐文件覆盖率在语句、分支和函数上均为 100%。

`packages/bundle/base/tests/base.spec.ts` 保留了它的平台门控用例，现在断言两行执行器配置项仍携带互补的 `!!js disabled` 表达式、唯一的 `tool-shell` 配置项从不被门控、它的 `dialect` 表达式在 win32 上求值为 `pwsh` 而在 linux 上求值为 `bash`，以及没有第二行挂载同一个包。`apps/cli/tests/windows-shell.spec.ts` 针对组合后的发布 bundle 各层与三个 preset 做出同样的断言。

## 后果

两个发布包名消失，两个出现；每一份 manifest（元数据清单）、tsconfig 引用、组合、preset、快照组合、目录、图和 README 都随之迁移，而预发布阶段的立场允许这次重命名不带兼容垫片。`dsh-agent-spine-demo` 的 `toolBash` 配置字段变为 `toolShell`，现在转发一个 `dialect`，默认值为 `bash`——也就是每个省略该字段的组合一直挂载的那种 shell。

`packages/shell` 上的克隆门禁报告零处克隆。仓库范围内，27 处克隆减为 4 处，其中没有一处属于这一族。

`gen-tool-catalog` 第一次把同一个包挂载两次。这样做是成立的，因为 schema 只取决于方言以及被挂载的执行器是否施加约束，从不取决于哪个执行器支撑该 seam，所以一个不施加约束的本地执行器就能满足两次挂载。包内说明写明：一次部署只挂载该包一次。

`docs/capability-seams.md` 与 `apps/cli/composition.md` 是为这次重命名手工编辑的，而不是重新生成：`bun run gen-doc-graphs` 目前会在一个无关的在途服务上失败（`missing service role classification: networkDrive`），生成器跑不起来。等那条分类落地，这两个文件重新生成后的内容与现在相同。
