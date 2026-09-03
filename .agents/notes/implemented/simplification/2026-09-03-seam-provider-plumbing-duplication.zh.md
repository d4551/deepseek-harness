# Agent Note: seam 提供方的管道有所有者，没有理由

Status: implemented

[English](2026-09-03-seam-provider-plumbing-duplication.md) | 中文

## 问题

四对包携带着 12 处克隆，[标记 Agent Note](2026-09-03-duplication-suppression-that-suppressed-nothing.zh.md)把它们揭了出来，而每一处都配有一段说明文字，解释这次重复为何是有意的：

| 克隆数 | 行数 | 配对 | 现场的说法 |
|---|---|---|---|
| 4 | 74 | `credentials-local` ↔ `settings-file` | 「与 settings-file 采用同样的 watcher 纪律，是设计如此」；「有意镜像……抽取一个共享 helper 会把它们的 teardown 语义跨包耦合起来」 |
| 4 | 45 | `subagent-claude-code` ↔ `subagent-codex` | 「同级产品提供方有意暴露互相重叠、由部署方拥有的字段，而不新增一个共享的配置所有者」；「同级提供方有意各自保留产品私有的运行输入与错误归一化」 |
| 2 | 38 | `code-runtime-worker-thread` ↔ 自身 | 「源 worker 镜像 session 的 JSON helper，但不引入 workspace 运行时导入」 |
| 2 | 23 | `time-context` ↔ `llm-retry` | 「领域专属的延迟校验与 llm 的 retry-policy 平行；不可抽取」 |

这些说法里只有一条经受住了与代码的对照，而且它说中的并不是它当初所辩护的那件事。

## 这些说法实际是什么

**「把它们的 teardown 语义跨包耦合起来」是一句托词。** credentials 与 settings 两个提供方存储的是不同的文档，有不同的解析规则、不同的权限检查和不同的发布事件——以及完全相同的*管道*：同一套 Schemastery 配置字段、同一组由 `debounceMs` 派生的 chokidar 选项、同一批 `all`／`ready`／`error` 处理器、同一条只保留一个已结算尾部的操作链、同一条「`INVARIANT` 上抛、其余告警」的重载策略、同一种把 ENOENT 读作文件不存在的读取，以及同一次 dispose（资源释放）时的完全停稳。teardown 语义不是两份有耦合风险的约定；它们是同一份约定写了两遍。

**「不可抽取」把自己的对象说错了。** `time-context` ↔ `llm-retry` 这处克隆根本不是延迟校验——它是[会话暂存 Agent Note](2026-09-03-session-staging-plumbing-owner.zh.md)当天早些时候已经指定了所有者的不变式配套模块管道。两个配套模块都手写了 `ctx.sessions.list()` 播种、`session/created` 监听器和 `internal/dispatch` 拦截，而 `stageSessionEvents` 早已为另外六个包安装了这些。这两个文件是掉队者，不是例外。

**「不引入 workspace 运行时导入」是真的，但与这次重复无关。** `worker-json.ts` 与 `output-json.ts` 确实不能导入 workspace 包：`source-worker.compat.spec.ts` 把该 worker 的文件集合复制到 workspace 之外再启动它，所以任何包导入在那里都会失败。这条约束禁止的是导入 `@deepseek-ai/dsh-session` 的 JSON helper。它对这两个文件互相导入只字未提，而它们现在正是这么做的。

**「产品私有的运行输入与错误归一化」只对了一半。** 两份运行 spec 描述的是不同的产品，但 `thrown()` 是一个 `@deepseek-ai/dsh-subagent` 本来就有的函数的第四份副本，而两份 spec 中由配置派生的那四个字段是同一条记录。

## 决策

### `@deepseek-ai/dsh-document-queue` 拥有单个文档的操作链

这两个提供方实现的是不同的 seam（`ctx.credentials`、`ctx.settings`），因此谁都不能导入对方，两个 Service Definition 也都不能持有共享代码。共享代码去了一个新的 `packages/util/` 包，现在两者都依赖它：`DocumentQueue`（已结算尾部的操作链、`watch()`、`close()`、`isClosed()` 和重载策略）、`resolveDocumentSpec`（`path`／`dshHome`／`watch`／`debounceMs` 这一步统一的默认值填充）、`readDocumentText` 与 `isENOENT`。`credentials-local` 从 954 行降到 857 行，`settings-file` 从 370 行降到 292 行，而取代那 175 行的这个队列连同它的文档共 245 行。

行为没有变化，这次划分是有意的：队列从不为读取内容而打开文档，因此权限检查、格式识别、解析、保留注释的渲染、`dsh-atomic-write` 的写入方锁以及 seam 发布，全都留在各自的提供方。`settings-file` 的 `ResolvedSpec` 现在在共享的 `DocumentSpec` 之上扩展出它的格式字段。

`lock-race.spec.ts` 曾伸进提供方私有的 `closed` 字段，以观察 teardown 在一次在途创建结算之前就拒绝新工作。它现在读 `queue.isClosed()`，那才是这个标志所在的地方。

### `@deepseek-ai/dsh-subagent` 拥有一次性提供方的配置解析

两个提供方本来就依赖该 seam，而 `src/out-of-process.ts` 本来就是为此存在的：面向进程外后端的提供方侧词汇。它新增了 `resolveOneShotProviderConfig` 及 `OneShotRunConfig`／`OneShotProviderConfig`／`OneShotProviderDefaults`、`assertTimerBound`（两个提供方都逐字写出过的正有限值检查加 `MAX_TIMER_DELAY_MS` 上限，两条诊断信息都逐字保留），以及原先模块私有的 `toError`。`ClaudeCodeRunSpec` 与 `CodexRunSpec` 现在扩展 `OneShotRunConfig<TMode>`，只添加 `cwd`、`spawn` 和 `onError`，因此每个 `start()` 都把自己的 spec 构造成 `{ ...this.config, cwd, spawn, onError }`，不再手工复制四个字段。

`env` 与 `disposeGraceMs` 保留各自的 `as` 断言，而不是补上 `??` 默认值：一个省略 `disposeGraceMs` 的编程式调用方仍然必须在 `assertTimerBound` 中大声失败，而在那里编造一个默认值既会改变这一行为，又会在逐文件 100% 门禁下留下一条无法覆盖的分支。

该 seam 为了 `MAX_TIMER_DELAY_MS` 新增了 `@deepseek-ai/dsh-timeout`（对等依赖（peer dependency）、dev 依赖与项目引用）。它没有新增 `@deepseek-ai/dsh-subprocess`：运行 spec 的 `spawn` 字段把 `SubprocessSpawnSpec`／`SubprocessHandle` 类型留在各个提供方包里，因此该 seam 仍然不表述任何进程机制。`subagent-acp` 与 `subagent-dsh-sdk` 仍然手写自己的 `assertPositiveFinite` 与定时器上限；它们不在本次改动范围内，是 `assertTimerBound` 的下一批调用方。

### worker 闭包多了第五个成员

`src/intrinsics.ts` 持有 `IntrinsicCallable`、`intrinsicReflectApply`、`dataDescriptor`、`defineEnumerableDataProperty`、`append` 与 `takeLast`——两个 JSON 模块用来构造值的那些原型安全原语。它不导入任何东西，因此复制出去的源闭包仍能启动；`source-worker.compat.spec.ts` 把它连同另外四个文件一起复制，而这正是证明旧注释所点名那条约束的测试。

### `time-context` 与 `llm-retry` 采用 `stageSessionEvents`

两个配套模块现在都经由 `@deepseek-ai/dsh-session/invariant-staging` 安装。它们的状态就是会话本身，因为每次检查读的都是已提交前缀——`time-context` 需要开放的轮次和步骤，加上当前轮次已进入的消息；`llm-retry` 需要开放的步骤、被路由到的提供方以及同一条链上更早的记录——而在 `internal/dispatch` 时，会话中恰好就是候选事件之前的那些事件。`seed` 执行既有的整会话校验，`stage` 执行既有的逐事件校验，`claims` 点名本包自己的事件类型，`commit` 原样返回状态。没有任何校验规则和失败消息发生变化；这两个配套模块获得了共享所有者的保证：一个被宣告的事件如果未经 dispatch 就发布，会失败而不是静默提交。

这同时消除了这一对与 `goal-round-driver` 共有的第三处克隆。

## 配置目录遍历器如何接纳一组共享字段

[`scripts/gen-config-catalog.ts`](../../../../scripts/gen-config-catalog.ts) 静态遍历每个插件入口的 schema，并沿 `z.object(...)` 的参数只跟随一跳具名引用：可以是入口文件自己声明的标识符，也可以是它所导入的某个 workspace 包的入口文件声明的标识符。展开够不着，具名导出的对象则够得着：`z.object({ ...documentQueueConfigFields() })` 会报出 `@deepseek-ai/dsh-credentials-local (packages/credentials/credentials-local/src/index.ts): schema object property '...documentQueueConfigFields()' is not a plain key`，此后目录会声称该插件不接受任何字段。

两对包都通过这一跳完成校验：

- `credentials-local` 与 `settings-file` 写作 `static Config: z<Config> = z.object(DocumentQueueConfigFields)`。`@deepseek-ai/dsh-document-queue` 把那四个校验器声明在 `resolveDocumentSpec` 旁边，因此 Loader 的 schema 与默认值填充这一步读到的是同一个 `DEFAULT_WATCH` 和同一个 `DEFAULT_DEBOUNCE_MS`。
- `subagent-claude-code` 与 `subagent-codex` 写作 `z.intersect([z.object(OneShotProviderConfigFields), z.object({ … })])`，遍历器会逐一跟随其中的两个成员。`@deepseek-ai/dsh-subagent` 拥有 `model` 与 `env`；`providerName`、`permissionMode` 与 `disposeGraceMs` 留在各提供方自己的那一半里，因为它们点名的分别是该产品自己的默认值或模式词汇。

`OneShotProviderConfigFields` 声明在 `@deepseek-ai/dsh-subagent` 的 `src/index.ts` 中，而不是在 `src/out-of-process.ts` 里挨着 `OneShotProviderConfig`：这一跳落在所属包入口文件自身的声明上，不会再跟随入口文件的重新导出，因此声明只要往里深一个模块，该插件接受的键就不会进入目录。

接口声明留在本地：目录把每个插件的 `Config` 逐字粘贴，作为它面向部署方的配置接口，而每一份粘贴记录的要么是不同的默认文档路径，要么是不同产品的权限模式。把一个共享字段改名、使它不再存在于某个插件已声明的 `Config` 上，会让生成器以 `schema validates key '<name>' but config type 'Config' declares no such member` 失败，而这正是让这一跳保持诚实的检查。

## 后果

- 一个模块拥有这条文档操作链，因此对 watcher 结算、重载策略或排空顺序的改动只发生一次，两个以文件为后端的提供方都会继承。两个提供方谁也不导入谁，两个 seam 保持独立。
- `credentials-local` 与 `settings-file` 不再依赖 `@deepseek-ai/dsh-home-paths`；`settings-file` 在运行时不再依赖 `chokidar`（它伪造 watcher 的测试集把它保留为 devDependency，`credentials-local` 也是如此）。
- `@deepseek-ai/dsh-subagent` 现在依赖 `@deepseek-ai/dsh-timeout`。每个把 subagent seam 列为对等依赖的包都会多出这条边；`dsh-timeout` 是一个叶子工具包，自身没有任何 dsh 依赖。
- `dsh-document-queue` 是一个新的发布成员，带 `exports`、`files`、一个 `./invariant` 配套模块和一份双语 README。它没有 `tsdown.config.ts`：它的两个入口是 `index` 与 `invariant`，默认的 workspace 入口清单已经打包它们。
- 如果 `time-context` 与 `llm-retry` 自己的某个事件未经 dispatch 就到达发布，它们现在会大声失败；这是共享暂存所有者的约定，不是新增的包内专属行为。
- `@deepseek-ai/dsh-document-queue` 与 `@deepseek-ai/dsh-subagent` 拥有各自提供方共享的那组 Loader 字段校验器，因此往任一组里新增一个字段都会同时到达两个插件。`dsh-document-queue` 为发布它们新增了 `@deepseek-ai/schemastery`（依赖与项目引用）。
- `subagent-acp` 与 `subagent-dsh-sdk` 仍然携带各自的「正有限值加上限」检查。现在它们有 `assertTimerBound` 可以采用。

## 考虑过的替代方案

**把文档管道放进 `@deepseek-ai/dsh-atomic-write`。** 两个提供方本来就依赖它，而它也已经拥有写入方协调中跨进程的那一半。不予采用，因为这会把 `chokidar` 放进 `attachment-local`、`app-boot`、`llm-deepseek`、`agent-presets`、`session-persistence-jsonl` 与 `storage-json` 的依赖闭包，而它们谁也不监视任何东西。

**把不变式管道放进 `@deepseek-ai/dsh-invariants`。** 有两重理由不予采用：[不变式服务 Agent Note](../architecture/2026-07-19-package-invariant-runtime-contracts.zh.md)规定该注册表不导入任何产品包，而 `dsh-session` 已经依赖这个注册表，因此这次导入会在项目引用中形成环。由 `dsh-session` 拥有它——也就是 `invariant-staging` 的做法——这两个问题都不存在。

**把 `llm-retry` 与 `time-context` 改成增量游标，而不是持有整个会话。** 因超出范围不予采用。两个校验器都是针对一段历史切片写的，把它们的关系重新推导成折叠会改变这些不变式所观察的内容，那属于这些约定的所有者，而不属于一次去重工作。

## JSON 结构化相等有一个平台所有者

`credentials-local` 用 `node:util` 的 `isDeepStrictEqual` 比较两条已解析的凭据记录。每条记录在进入比较之前都会通过 `assertJsonValue`，因此这个平台谓词与它所取代的手写遍历在每个被接纳的值上判断一致，而平台谓词还额外区分了手写遍历忽略的原型与 symbol 键。

`experimental/webworker-runtime` 中已实现的 `util` 内建保留自己那份结构遍历，因为在 worker 内部，该模块*就是* `node:util`：[`src/module-proxies.ts`](../../../../packages/experimental/webworker-runtime/src/module-proxies.ts) 把 `node:util` 解析到它身上，而 `context/agent-instructions`、`mcp/mcp-client` 与 `goal/goal-round-driver` 都经由这个说明符拿到 `isDeepStrictEqual`。那里并不禁止 workspace 导入：`builtin_modules/implemented/crypto.ts` 就从 `@deepseek-ai/dsh-util-crypto` 取用 `randomUUID`，而 worker 的 bundle 会内联每一个依赖；因此这棵树上的约束其实是浏览器安全性与 bundle 体积。真正让这份遍历留在本地的是：一个 Node API 自身的实现不得取自调用它的 harness 代码。

`@deepseek-ai/dsh-settings` 导出的 `deepEqualJson` 与 `core/session/src/surface.ts` 中的 `isDeepEqualJson` 是同一条规则的第二种和第三种写法。它们彼此之间、以及与 worker 那份之间都不构成 jscpd 克隆；而 settings 的那份是一个 Service Definition 公开的变更检测谓词，由它的不变式配套模块直接检查。合并这两份属于一次 seam 决策，而不是一次去重工作。

## 证据

`bun run duplication` 对 `packages` 与 `scripts` 只报告一处克隆：`client/ui-slots/src/index.ts` 内部的一处自我克隆，本次改动没有碰它。本 Agent Note 范围内的 12 处克隆全部消除，其中最后三处靠的是上文的共享字段集合与平台谓词。

`bun run gen-config-catalog` 接受这两组共享字段集合各自的那一跳，其输出只有四个 `Source:` 行号发生变化：`credentials-local:65`、`subagent/subagent:190`、`subagent-claude-code:38`、`subagent-codex:38`，它们指出的是各条声明当前所在的位置。每一份被粘贴的配置声明都逐字节相同，也没有任何插件分节丢失字段。把 `DocumentQueueConfigFields` 里的 `debounceMs` 改名，或把 `OneShotProviderConfigFields` 里的 `env` 改名，都会让生成器针对两个依赖它的插件以 `schema validates key '<name>' but config type 'Config' declares no such member` 失败，这正是证明遍历器跨过了包这一跳的验收路径。

限定范围的 `bun x vitest run` 全部通过：`util/document-queue`（15）、`settings/settings-file`（48）、`credentials/credentials-local`（104 通过 + 2 跳过）、`code-runtime/code-runtime-worker-thread`（104）、`context/time-context`（51）、`llm/llm-retry`（66），以及整个 `packages/subagent`（1052 条通过）。`subagent-codex/tests/real-product.spec.ts` 在改动前后都有同样 3 条断言失败，原因是一处 fixture（测试前置数据）／产品版本漂移，正在另行排查。每个被改动文件的覆盖率在四项逐文件阈值上都是 100%。`bun x tsc -b`、`no-barrels`、`verify-export-jsdoc`、`run-oxlint`、`verify-package-invariants`、`check-workspace-constraints`、`verify-module-graph` 与 `verify-doc-budgets` 全部通过。
