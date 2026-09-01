# Agent Note: 构建先打包自己配置要加载的工具

Status: implemented

[English](2026-09-02-build-tooling-dependency-closure.md) | 中文

## 问题

`tsdown.config.ts` 从 `packages/typert/generator/lib/types/tsdown-plugin.js` 导入 Typert 插件，而 tsdown 加载配置时 Node 会解析该模块的整个导入图——此刻它所配置的那次构建还没写出任何东西。每个 dsh 包都解析到 `lib/index.js`，也就是同一次 tsdown 运行才产出的 bundle。于是当生成器开始导入 `@deepseek-ai/dsh-diagnostic-text`，配置就开始解析一个要等它自己把关的构建跑完才存在的说明符，`bun run build` 以 `Cannot find module .../dsh-diagnostic-text/lib/index.js` 中止。工作树里若还留着上一次构建的 bundle，构建照样通过，因此这处破坏进入 master 时看起来像一棵脏树；它先是被以手工把 tsc 产出拷成 `lib/index.js` 的方式绕开，随后又在另一台机器的干净检出上复现。

## 决策

`build:lib:host` 在 `tsc -b` 与带插件的 Host 趟之间插入一趟引导式 tsdown，使 Host 配置加载时它要解析的包已经带着各自的 bundle：

```sh
tsc -b tsconfig.host.json
tsdown --config tsdown.bootstrap.config.ts
tsdown --env.DSH_BUILD_FACE host
```

`tsdown.bootstrap.config.ts` 自身不加载任何插件。它的包集合是推导出来的，而非列出来的：[`scripts/build-tooling-closure.ts`](../../../../scripts/build-tooling-closure.ts) 读取 Host 配置，取出它导入过文件的每个 workspace 包，再顺着这些 manifest 的 `workspace:` 运行时依赖，通过已安装的链接做传递遍历。工具包自身也包含在内，这样只要配置还导入着一个包，集合就不会为空；而一个完全不导入 workspace 包的配置会明确报错，告诉维护者删掉这一趟。两趟都使用 [`scripts/tsdown-workspace-options.ts`](../../../../scripts/tsdown-workspace-options.ts) 中的 `WORKSPACE_BUNDLE_OPTIONS` 打包，因此一个包的产出不取决于是哪一趟写的。

[`scripts/check-workspace-constraints.ts`](../../../../scripts/check-workspace-constraints.ts) 中的 `checkBuildToolingBootstrap` 守住顺序：`constraints` 门禁会拒绝缺少任一趟、或把引导趟排在后面的 `build:lib:host`。生成器保留对共享的 `@deepseek-ai/dsh-diagnostic-text` 的导入——这套安排存在的意义正是让它成立。

## 备选方案

**禁止构建工具声明 workspace 运行时依赖。** 一条拒绝"配置所导入的包出现 `dependencies`"的 manifest 规则可以让构建保持单趟，也不需要新配置。但它会把共享包刚刚吸收掉的 flatten 重新复制一份，并且为守住一条顺序规则而让一整类正当的共享变成非法。引导趟约 0.4 秒，直接取消了这条规则。

**用支持 TypeScript 的加载器从源码加载配置。** 把 `--config-loader tsx` 指向 `packages/typert/generator/src/tsdown-plugin.ts` 可以彻底断掉对产物的依赖，同类打包器配置解析插件时正是这么做的。这条路在此跑不通：tsdown 的 tsx 加载器在 Node 26 上经其 CJS 钩子以 `ENOENT ... node:fs?tsx-namespace=<uuid>` 失败，`unrun` 未安装，而默认的原生加载器在 strip-only 模式下拒绝生成器的参数属性。等到某个加载器能覆盖整个 engines 范围时值得重新考虑，届时这一趟即可移除。

**发布工具的依赖并按版本消费。** 从 registry 解析到的已发布 `dsh-diagnostic-text` 永远不依赖这次构建。本仓库处于预发布阶段且各包同步演进，这么做只是把构建顺序问题换成发布顺序问题。

**让 `@deepseek-ai/dsh-diagnostic-text` 指向自己的 tsc 产出。** 把 `main` 与 `exports["."].default` 设为 `lib/types/index.js` 便无需 bundle，`tsc -b` 之后即可解析。这会让一个包拥有其他 dsh 包都没有的入口布局，而把每个已发布包钉在 `lib/index.js` 的 `constraints` 规则也要为它开一处例外。

**手工列出引导包清单。** 在引导配置里写一个字面数组比推导更短。但构建工具第一次新增依赖时它就会悄悄漂移，而这正是本次要修的故障。

## 后果

`bun run build` 在没有任何既有产物的树上通过，并已从失败状态验证：证明它的那次运行先删掉了 `packages/util/diagnostic-text/lib/index.js`，在引导趟里打包了它，又在 Host 趟里重建了它。构建工具从此可以声明 workspace 依赖，新增一个也无需改动引导配置。

构建因此多了一次 tsdown 调用，以及一份在加载时计算包集合的配置。声明了却未安装的 workspace 依赖，如今会在该计算处点名报错，而不是拖到 Host 趟里。门禁只检查脚本顺序：另一个在 `build:lib:host` 之外加载 `tsdown.config.ts` 的工具需要自己的引导趟，而今天没有任何检查覆盖这一点。
