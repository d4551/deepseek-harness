# Agent Note: 覆盖率欠债不只计数，还要测量

Status: implemented

[English](2026-09-12-coverage-debt-measurement.md) | 中文

## Problem

[覆盖率排除项声明为结构性或带标记的欠债](2026-09-06-coverage-debt-markers.zh.md)让欠债变得可计数，而计数曾是唯一的仪器。没有任何东西说明哪些带标记的条目已经达到按文件门槛，因此一个已达到 100% 的文件会一直被排除，直到有人手动测量；而藏起整个包的条目与藏起单个文件的条目计数相同。有三项发现游离于计数之外：`packages/experimental/webworker-runtime/src/**/*.ts` 与 `src/**` 并列出现，把同一笔欠债算了两次，自身却什么也没排除；[`vitest.config.ts`](../../../../vitest.config.ts) 展开进去的平台条件清单（win32 包集合、无 pwsh 主机的源码、仅 Windows 的源码）从未被读回，因此那里的一次重命名会让某个条目恰好在它适用的平台上豁免一条已不存在的路径；而这些标记拼作 `TODO(...)`，正是仓库契约禁止出现在门禁中的那个词。

门禁所依赖的两个部件没有自己的 spec：在阈值失败下打印可点击 `path:line:col` 记录的 istanbul reporter，以及 [`vitest.client-browser.ts`](../../../../vitest.client-browser.ts) 中的浏览器通道发现逻辑，后者在每次加载配置时都用 Babel 解析每一个 client spec，无论该 spec 是否可能导入无障碍测试工具包。

## Decision

**标记改为 `DEBT(gui)`、`DEBT(inspector)` 与 `DEBT(webworker)`。** 通道相同、注释块解析器相同、门禁相同；拼写不再携带被禁用的词，[`docs/testing.md`](../../../../docs/testing.zh.md) 也已写明新拼写。

**`bun run verify-coverage-debt` 读回更多内容。** 在前一篇记录列出的四种条件之外，它还会在以下情况失败：某个条目已被另一单个条目整体覆盖——两个相等条目中靠后的那个被标出，因此每个被标出的 glob 都能单独删除；以及某个平台条件通道条目在代码树中匹配不到任何文件。这些条件清单在 [`vitest-inventory.ts`](../../../../scripts/vitest-inventory.ts) 中无条件声明，并在派生导出中按平台选取，因此该检查在每台主机上都会运行。清单按通道打印 glob 数与文件数。

**`bun run measure-coverage-debt` 测量欠债。** 它只保留结构性与平台条件排除项、把所有阈值置零、并使用制表符分隔的按文件总计 reporter [`coverage-file-totals.cjs`](../../../../scripts/coverage-file-totals.cjs) 来运行覆盖率通道，该 reporter 的数字来自 istanbul 自己的按文件汇总，而非对原始范围表的二次推导。随后它把每个欠债文件与按文件 100% 对照：文件已全部达标的条目、按差距排序仍未达标的文件，以及没有任何套件加载的文件。尾随参数可把运行范围缩小到某个包自己的测试套件，下文的条目正是在一台无法运行整条通道的主机上以此关闭的。

**十九个条目离开了清单。** 六个指名文件仅凭自己的套件就已达标；重复的 webworker 条目什么也没排除；十二个通过针对测得差距编写的测试关闭——命令生命周期 invariant、Cordis host 注册表与 wire values、Cordis client guard、popupSelect 外壳与命令目录、斜杠触发检测、client-runtime 的 translate 替身，以及 Cordis 面板的 status、run-card 索引与 inventory。其中三个是通过删除差距所指出的死代码关闭的：无人调用的 `disarmRequest`、`select` 与 `confirm` 已同步完成过的 settle 时二次检查，以及 `@` 路径永远到不了的触发字符分支。

**两个 istanbul reporter 都通过 istanbul 的 writer 打印，并且都有 spec。** 未覆盖位置 reporter 向报告上下文索取其控制台 writer 而非使用 `console.log`，其记录形态——隐式分支、整行语句、无声明位置的函数——都已钉住，总计 reporter 也以同样方式钉住。

**发现逻辑只解析拼出工具包说明符的 spec。** 从未提及 `@deepseek-ai/dsh-client-a11y` 的 spec 不可能导入它，因此只花费一次文件读取；解析仍负责区分值导入、类型导入与注释中的提及。每次 Vitest 配置加载都会运行发现逻辑，所以这份节省落在每一次运行上。

**转换后的模块在本地运行之间持久化。** `fsModuleCache` 在 CI 之外对根通道与两个 node 项目开启：Vitest 按文件内容与环境配置为条目建键，并在 v8 provider 下于 worker 内绕过缓存，因此门禁测量的仍是未缓存的源码。CI 从全新 checkout 开始，没有任何东西能留存复用。

## Alternatives considered

**在 `verify-coverage-debt` 内部测量。** 否决：测量要付出一次覆盖率通道运行的代价，而静态通道必须保持静态。两个命令共享排除项读取器，除此之外互不相干。

**从 istanbul 的 JSON reporter 读取总计。** 否决：总计文件是五列计数，用字符串切分与整数解析读回，遇到任何其他形态都会大声失败；改用 JSON reporter 则意味着为了同样的五个数字去校验一份嵌套文档。

**因为前一篇记录写的是 `TODO(...)` 就保留该拼写。** 否决：契约禁止该词出现在门禁中，而那篇记录是带日期的记录，不是当前现实；它现在指向这里。

**在 CI 中也开启转换缓存。** 否决：CI 作业之间没有任何东西持久化，缓存只会付出写入的代价。

## Consequences

棘轮现在有两种读数：`verify-coverage-debt` 打印每条通道藏起多少 glob 与文件，`measure-coverage-debt` 说明哪些条目可以删除。留在清单中的条目要么以明确的项目数落后于门槛，要么因为没有套件加载该文件而未被测量，两种读数都来自门禁所用的同一个排除项读取器。

`packages/interaction/commands/src/index.ts` 仍因一条容错路径留在清单中——`command/done` 追加本身失败时写出的警告——没有一个会拒绝追加的会话，任何套件都到不了它；`packages/session/session-projection/src/index.ts` 与其余 `DEBT(gui)` 条目一同保留。这里没有测量 client-browser 项目的贡献：测量只运行了 node 项目，因此每个被移除的条目仅凭这些项目就已达标，门禁的聚合只会在此之上增加。
