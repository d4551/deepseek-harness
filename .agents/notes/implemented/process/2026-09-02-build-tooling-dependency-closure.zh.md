# Agent Note: 构建自身的工具链只依赖已发布的依赖

Status: implemented

[English](2026-09-02-build-tooling-dependency-closure.md) | 中文

## 问题

`tsdown.config.ts` 从 `packages/typert/generator/lib/types/tsdown-plugin.js` 导入 `typertPlugin`，而 tsdown 加载配置时 Node 会解析该模块的整个导入图——此时它所配置的那次构建还什么都没写出。每个 dsh 包都解析到 `lib/index.js`，也就是同一次 tsdown 运行才产出的 bundle。当 `packages/typert/generator/src/ts7-session.ts` 开始导入 `@deepseek-ai/dsh-diagnostic-text`，配置就开始解析一个要等它自己把关的构建跑完才存在的说明符，于是 `bun run build` 以 `Cannot find module .../dsh-diagnostic-text/lib/index.js` 中止。工作树里若还留着上一次构建的 bundle，构建照样通过，因此这处破坏进入 master 时看起来像一棵脏树而非顺序死锁，并被以手工把 tsc 产出拷成 `lib/index.js` 的方式绕开。

## 决策

Typert 生成器只解析 npm 依赖与自身产出。`flattenDiagnosticMessageText` 位于 `packages/typert/generator/src/ts7-session.ts`；`ts7-project.ts` 与 `tests/type-model-shared.ts` 从那里导入它，manifest 不声明任何 workspace 运行时依赖。`packages/util/diagnostic-text` 保留 `flattenDiagnosticMessage` 供 `scripts/ts7-session.ts` 使用，后者由 tsx 经 `paths` 解析到源码，且没有任何构建配置加载它。

规则由 [scripts/check-workspace-constraints.ts](../../../../scripts/check-workspace-constraints.ts) 中的 `checkBuildToolingClosure` 承载：它读取根 `tsdown.config.ts`，把配置从中导入过文件的每个 workspace 包视为构建工具，并拒绝其 `dependencies` 或 `optionalDependencies` 中出现另一个 workspace 成员。`peerDependencies` 仍然合法——dsh 包为自己的 invariant 伴生插件声明 Cordis 与 invariant 服务，而构建配置从不加载它。该检查运行于 `constraints` 门禁，因此 `bun run hygiene` 与 CI 会在任何人走到干净树之前就拒绝引发本次问题的那处 manifest 修改。

## 备选方案

**在带插件的那趟之前加一趟引导式 tsdown。** 先跑一趟不带插件的构建即可产出工具链所需的 workspace bundle，从而只保留一份 flatten 实现。它给每次构建都塞进第二次 tsdown 调用与第二份配置，而那份配置的包清单必须跟住工具链的依赖图，否则会以同样的方式失败。为共享四行代码，这份代价落在每一次构建上。

**让 `@deepseek-ai/dsh-diagnostic-text` 指向自己的 tsc 产出。** 把 `main` 与 `exports["."].default` 设为 `lib/types/index.js` 便无需 bundle，`tsc -b` 之后即可解析。这会让一个包拥有其他 dsh 包都没有的入口布局，而把每个已发布包钉在 `lib/index.js` 的 `constraints` 规则也要为它开一处例外。

**用 tsx 加载配置并从 `src` 导入插件。** `--config-loader tsx` 加上 `paths` 解析能让一切都走到源码。这会在构建配置里让生成器走源码平面、而它所配置的构建走产物平面，并给每一次构建都套上一层 TypeScript 转换。

**删掉 `packages/util/diagnostic-text`，把那份副本还给 `scripts/ts7-session.ts`。** 这要移除一个已发布的包、它的双语 README、它的测试与目录条目，最终得到的仍是本决策保留的那两份函数副本。

## 后果

`bun run build` 在没有任何既有 bundle 的树上通过，并已从失败状态验证：证明它的那次运行先删掉了 `packages/util/diagnostic-text/lib/index.js`，最后又把它作为真正的 bundle 写了回去。

flatten 存在两份——生成器里的 `flattenDiagnosticMessageText` 与 `dsh-diagnostic-text` 里的 `flattenDiagnosticMessage`。两者的名称与接受的类型都不同，因此 `bun run duplication` 看不见它们；真正阻止下一位读者再把生成器那份换成导入的，是这道门禁与生成器副本处的注释。今后构建工具若要新增 workspace 依赖，必须连同让它可解析的引导趟一起到来，而不是只加一行 manifest。
