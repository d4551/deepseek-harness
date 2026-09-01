# Agent Note：`dsh init` 生成 profile 的配置文件

Status: implemented

[English](2026-09-02-dsh-init-profile-generator.md) | 中文

## Problem

一个 profile 就是 `$DSH_HOME/profiles/<name>` 下的三个文件——承载组合包配置层列表与 reload 生命周期的 manifest（元数据清单）、用户 patch 层，以及树外插件借以解析 peer 依赖的 bun 安装设置。此前只有五个随附名称会生成它们：`loadProfile` 匹配 `PROFILE_TEMPLATES`，并在首次启动时调用 `initProfile`。其他名称一律失败，而诊断信息给出的唯一补救办法是 `dsh plugin --profile <name> add <package>`——它是在向 profile 安装某个包的副作用中顺带创建该 profile 的。想要一个只含 base、以便自行 patch 的 profile 的用户没有命令可用，必须指定一个自己并不想要的包，还需要 `PATH` 上有 bun，才能写出这三个小文件。没有任何机制会在运行真正需要配置时生成它。

## Decision

`dsh init --profile <name>`（[`apps/cli/src/init.ts`](../../../../apps/cli/src/init.ts)）写出这些文件后退出，不启动 profile。随附名称会精确复现其首次启动本会创建的内容；其他名称从 `@deepseek-ai/dsh-base` 与 `patchReload: live` 起步。可重复的 `--bundle <package>` 按 argv 顺序替换配置层列表，`assertBundlesUsable` 会在写出任何文件之前拒绝无法解析或未声明 `dsh.bundle` 的配置层，因此生成器不可能写出一份下次启动就会卡在自身配置层上的 manifest。生成复用 `initProfile`，它只在文件缺失时写入：重复运行会报告已存在的 profile，保留其中的改动，补回缺失的 `bunfig.toml`，并说明 `--bundle` 已被忽略，而不是改写用户可能手工编辑过的配置层列表。

启动路径仍然拒绝生成。`missingProfileMessage`（[`packages/boot/app-boot/src/profile.ts`](../../../../packages/boot/app-boot/src/profile.ts)）把原先的一行提示替换为：随附名称、`listProfileNames` 在 `$DSH_HOME/profiles` 下找到的已初始化 profile，以及创建缺失 profile 的 `dsh init --profile <name>` 命令。正是"列出该 home 能启动什么"让拼写错误显形；若改为直接创建，拼错的随附名称就会变成一棵照常启动却什么都不做的空配置树。

## Alternatives considered

**在启动过程中直接生成任何缺失的 profile。**已否决：这恰恰是唯一会破坏用户已经知道的名称的方案。`dsh --profile healdess` 会悄悄造出一个只含 base 的 profile，并启动一个不含 headless 任何配置行的 agent，故障表现为行为缺失而不是一个有名有姓的错误。本仓库"配置错误必须显式失败、绝不静默跳过缺失引用对象"的规则正是为这种情形而设。

**在启动过程中先询问再生成。**已否决：`headless`、`sdk`、`sdk-minimal` 与 `acp` 都没有交互界面，因此该询问需要一个非交互的答案，而唯一可用的答案就是上面那种静默生成。有一半场景根本问不出口的确认，不算确认。

**继续把 `dsh plugin --profile <name> add <package>` 作为唯一路径。**已否决：它把创建 profile 与向其安装内容耦合在一起，并要求 `PATH` 上有 bun。`dsh plugin` 首次使用时仍会初始化，因此没有任何能力被拿走；生成器只是那条不强迫用户挑选一个毫无理由的包的路径。

**用编辑距离推荐相近名称，而不是列出清单。**已否决：为了一个猜测而引入一个距离函数及其专属测试并不划算。真实清单是确定性的，把拼写错误与正确写法并排呈现同样清楚，并且额外回答了"这个 home 能启动什么"——这是推荐做不到的。

## Consequences

创建 profile 变成一条无需指定任何包的命令，而发现该缺口的启动会打印出弥补它的命令，因此生成器在运行失败的那一刻就触手可及。启动路径保留其显式失败：除了一条错误信息的文本之外，运行行为没有任何变化。代价是多出第四种需要与其他三种一同维护文档的 CLI 模式，以及第二处解析组合包名称的位置（`assertBundlesUsable` 调用 `resolveBundleDir`，即启动所用的同一个双锚点解析器）——这项 `--bundle` 检查原本要推迟到用户尚未执行的那次启动。显式配置层会被校验，模板与默认配置层则不会：无法解析它们的启动说明的是安装损坏而非参数有误，在此重复检查只会把该诊断从真正负责它的启动那里挪走。七个行为测试固定了生成、模板复现、配置层顺序、幂等重复运行、被拒绝的配置层与非法 profile 名称；诊断信息在 app-boot 的 profile 测试套件中另有专属测试。
