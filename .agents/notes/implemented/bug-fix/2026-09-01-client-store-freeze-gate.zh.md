# Agent Note: 被客户端打包器变得不可达的生产快路径

Status: implemented

[English](2026-09-01-client-store-freeze-gate.md) | 中文

## 问题

`createSnapshotStore` 的整体 `set()` 绕过了 immer 的冻结，因此 `devFreeze` 会深冻结替换值，以阻止调用方随后修改它而悄悄破坏 store。当 `process.env.NODE_ENV === 'production'` 时它会跳过这次遍历。

客户端打包器把 `process.env` 定义为 `{}`——`clientBuildEnvironmentDefines` 先产出该条目，然后为每个带 `DSH_CLIENT_` 前缀的名字各产出一个 define。因此在浏览器产物中，其他任何名字都读作 `undefined`，那个比较在那里不可能成立，跳过在任何已发布的客户端里都没有发生过。一个 store 测试把该行为命名为"生产环境下不深冻结整体状态"并且通过了，因为 vitest 运行在未打包环境中，`NODE_ENV` 在那里是真实字符串；它证明的是 Node 路径，对浏览器只字未言。

## 决策

该判断改为读取 `process.env.DSH_CLIENT_BUILD_PROFILE === 'official'`——这是客户端 define 集合确实携带的名字，于是官方产物能够走到跳过分支。测试、开发服务器与未打包的消费方仍保留该守卫，而那里正是值得捕获 `set` 之后误修改的地方。

该测试在同一个用例中断言两个方向：把 `NODE_ENV` 打桩为 `production` 时值仍被冻结——这正是浏览器的处境——只有打桩官方构建 profile 才会释放它。另外两个同样写着"outside production"的兄弟测试名，现在改为陈述它们实际检查的内容。

## 考虑过的替代方案

**把 `NODE_ENV` 加入客户端 define 集合。** 它不是 `DSH_CLIENT_` 名字，而该前缀是允许进入浏览器产物的值的既定保留区。为一个判断而放宽它，等于把一个未经审计的名字放进每一个已发布 bundle。

**无条件冻结并删除该分支。** 该冻结是针对 TypeScript 无法捕获的误修改的开发辅助，而非运行时不变式；因此在已发布产物中为每次整体 set 付出一次深度遍历，是拿用户可感知的代价换取终端用户毫无所得的东西。

**读取 `import.meta.env.DEV`。** Vite 会为 `apps/web` 定义它，但 `packages/client/*` 由 tsdown 打包，因此该名字恰恰会在这个判断所服务的产物中是 undefined。

## 后果

官方客户端产物不再在每次整体 `set()` 时深冻结整棵状态树。客户端源码中任何 `DSH_CLIENT_` 前缀之外的 `process.env` 读取在浏览器里都是 `undefined`；`packages/client` 中其余四处读取全部使用该前缀。
