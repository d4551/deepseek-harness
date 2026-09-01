# Agent Note: An unused lint suppression fails, and the TypeScript 7 scans carry no path carve-outs

Status: implemented

[English](2026-09-01-no-tolerated-lint-suppressions-or-gate-carveouts.md) | 中文

## Problem

TypeScript 7 转换遗留了两处容忍，每一处都让工作从通过的 gate 中隐身。`.oxlintrc.json` 将未使用的 `oxlint-disable` 指令按 warning 报告，因此一条已不再抑制任何诊断的指令能挺过每一次通过的 lint 运行和每一个 CI 作业。`scripts/typescript7-unstable-api.spec.ts` 用 pathspec 排除收窄了它的两次全树扫描 —— compiler-API 扫描排除 `patches/*`，兼容包扫描排除 `goal/` —— 而 `goal/` 排除项上的注释断言那些 plan 记录陈述了相反的验收标准。

## Decision

`.oxlintrc.json` 中不再有任何设为 `"off"` 的规则。按文件类别划分的豁免全部移除：共享源码块不再静默 `no-empty-object-type`、`no-invalid-void-type`、`no-namespace` 或 `no-void`；`examples/**` 与 webworker Node 桩块不再静默 `require-await` 或 `no-extraneous-class`；TypeGraph fixture 块不再静默 `no-explicit-any` 或 `@stylistic/quotes`；测试块不再静默 `no-non-null-assertion`、`no-unnecessary-condition`、`only-throw-error`、`require-await` 或 `restrict-template-expressions`。改动的是代码，用以满足规则。

未使用的 disable 指令同样会让 gate 失败：`reportUnusedDisableDirectives` 为 `error`，`scripts/oxlint-contract.spec.ts` 中的可执行约定锁定失败的退出状态。

在不使用抑制指令的前提下满足 `require-await` 与 `use-unknown-in-catch-callback-variable`，改动了三处异步接缝。webworker 运行时的 `node:fs`、`node:fs/promises` 与模块接缝面通过 `settled`（`packages/experimental/webworker-runtime/src/settled.ts`）执行其同步工作，使同步 throw 仍以 rejection 抵达；其目录迭代器改为显式异步迭代器，而非从不 await 的 `async *` 生成器。`dsh-atomic-write` 改用回调式 `node:fs` 读写，其完成回调携带带类型的 `NodeJS.ErrnoException`，因此不再出现 rejection 回调与 `catch` 变量；其写者锁通过 `rmSync` 同步释放。

两次 TypeScript 7 扫描都读取整棵受版本控制的树。唯一保留的 pathspec 排除是 gate 文件自身，它把被禁的 import 形式与被禁的包名作为测试数据携带。被移除的两项排除都不承载任何作用：`patches/` 只存放 `.patch` 文件，compiler-API 扫描的源码 glob 均不匹配；且没有任何 `goal/` 记录匹配兼容包的 specifier 模式。被移除注释中的说法是假的，它所辩护的排除项隐藏的是扫描覆盖面，而不是换来了什么。

## Alternatives considered

**让未使用的指令保持 `warn`。** 已否决：没有任何 gate 读取的 warning 是缺陷记录，不是检查。今天树中没有未使用的指令，因此正是这一级别在维持这一状态；warning 只会告诉后来的读者曾经容忍过一条。

**保留按文件类别的规则豁免，只修复 gate 排除项。** 已否决：以路径 glob 为键的豁免，会为无人读过的代码静默规则。这十四条最终全部可以满足 —— 它们所隐藏的 `scripts/**` 中的二十二处违规，加上 webworker 运行时的六十三处与 `dsh-atomic-write` 的五处，都已在代码中修复。

**手工删除陈旧指令并把级别留在 `warn`。** 出于同样理由否决：眼下没有可删的，而手工审计撑不过下一条比其规则活得更久的抑制指令。

**让 staged 配置也继承 `error`。** 依据实测否决：不加载项目的配置随后会在全树报告 117 条未使用指令，每一条都指向该配置并未加载的类型感知规则。那是配置在误判自己无法评估的指令，而不是发现。

**保留 `goal/` 与 `patches/*` 排除，只更正注释。** 已否决：这些排除并未排除任何东西，因此纯粹是扫描收窄。禁令 gate 中的 pathspec 排除，正是下一次真实违规得以不被发现的机制。

## Consequences

`bun run lint` 对每一个自有文件运行每一条规则，不存在按路径的豁免，并且会因一条不抑制任何东西的指令而失败，因此规则豁免与陈旧抑制指令都无法越过评审存活。随代码改变的行为有两处：`dsh-atomic-write` 将非 Error 的 rejection 捕获为 `Error`，而不再原样重新抛出；其锁释放不再等待异步删除。pre-commit 钩子不受影响：staged 配置扫描全树零发现。两次 TypeScript 7 扫描分别覆盖每一个受版本控制的源文件与每一个受版本控制的文件，因此根 manifest、`bun.lock` 与 `goal/` plan 记录都处于兼容包禁令之内。[Oxlint 决策](2026-07-29-oxlint-linter.zh.md)记录了本 note 所推翻的 warning 级别；[TypeScript 7 编译固定版本](2026-08-29-typescript-7-compiler.zh.md)拥有该禁令本身。
