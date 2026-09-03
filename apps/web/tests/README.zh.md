# apps/web 浏览器 e2e

[English](README.md) | 中文

这些测试在进程内启动真实的 web 组合，并用真实 Chromium 通过真实 HTTP 驱动它。该 lane
的运行机制——模式、fixture、golden，以及与 `dsh web` 之间刻意保留的组合差异——记录在
[`scaffold.ts`](scaffold.ts) 和
[浏览器 e2e Agent Note](../../../.agents/notes/implemented/testing/2026-07-24-web-gui-browser-e2e-lane.zh.md)中。

## `.client.` 中缀指明所属程序

此处未标记的文件在根 `tsconfig.host.json` 中做类型检查，因为浏览器 e2e lane 直接读取
Host 服务：`ctx.connection`、Host 侧 `SessionStore` 与 `ctx.sessionProjectionCache`。运行时驱动
浏览器并不使一个文件成为 Client 程序的一部分——两个 face 在相同的键上以不同服务合并 cordis
`Context`，因此单个程序无法同时看见两者。把一个未标记的文件挪进 Client aggregate 会让每一处
Host 服务访问都无法编译。

在进程内挂载 Client shell 的文件带 `.client.` 中缀，改为在 `apps/web/tsconfig.json` 中做类型
检查，与 `packages/*/*/tests` 使用的是同一个标记。`tsconfig.host.json` 排除
`apps/web/tests/**/*.client.*` 并纳入本目录下的其余所有文件，因此归属由文件名决定，两份配置
都不再枚举文件。当 `apps/web` 下有文件既不属于任一程序、或同时属于两个程序时，
[`scripts/web-program-partition.ts`](../../../scripts/web-program-partition.ts)
会让 `bun run constraints` 失败。

## 不要在此 import `@deepseek-ai/dsh-client-*`

import 一个 Client 包——无论值还是类型——都会把它整个 TypeScript 工程、以及它引用的每个工程
拉进 **Host 构建图**。这已经坑过本 lane 一次：四个 Client 消费方包引用了 `api/remotes` 的
Client face，而该 face 必须等 Host tsdown 生成 `@deepseek-ai/dsh-goal/remote` 之后才能编译，
于是 Host 构建阶段变成在等一个由它自己产出的产物。

当某个场景需要 Client 持有的常量或纯函数时，改为在此处镜像一份，并紧挨着一条注释掉的
import 点明源模块。这样漂移会表现为选择器未命中或镜像值过期——是响亮的失败，绝不会是静默
通过。`scaffold.ts` 按此规则镜像欢迎声明的 namespace、确认字段、版本和被断言的中文文案。

有一类 Client import 是长期成立的，而许可它的正是这个中缀。`assembled-boot.client.ts`
驱动 shell 本身，因此它从 `@deepseek-ai/dsh-client-web` import `AppWebEntry`、从
`@deepseek-ai/dsh-client-modules/client` import boot manifest 类型；启动真实 shell 正是该
harness 的用途，而它与它的九个 `*.client.expected.e2e.ts` 消费方都位于 Client 程序中，
那些包本来就在其中。chat 场景则在 `support.ts` 中镜像 `conversationContextKey`，而不
import 其 Client owner。

没有任何机制强制这条镜像规则；靠 review 守住它。程序切分本身是被强制的：一个未标记的文件
若 import 了 Client 包，就会把该包的工程拉进 Host 图，Host 构建随即失败。
