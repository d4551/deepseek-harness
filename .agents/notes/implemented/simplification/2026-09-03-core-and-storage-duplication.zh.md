# Agent Note: core 与 storage 的 codec 各有一个所有者，却各写了两遍

Status: implemented

[English](2026-09-03-core-and-storage-duplication.md) | 中文

## 问题

[标记 Agent Note](2026-09-03-duplication-suppression-that-suppressed-nothing.zh.md)移除 `jscpd:ignore` 标记之后，session、tool、storage 与 SQLite 各包之间的 14 处克隆显露出来。每一处现场都带着一段声称这次重复是有意为之的说明文字：

| 克隆数 | 行数 | 配对 | 现场的说法 |
|---|---|---|---|
| 6 | 87 | `core/session` ↔ `session-persistence-sqlite` | 「schema 19 有意拥有一个冻结的物理 codec；导入或共享 JSONL 的 codec 会让那个格式改变这个数据库解释器」 |
| 2 | 31 | `core/session` ↔ `core/tools` | 「这道 realm 边界镜像了 session 所拥有的无损 JSON intrinsic 测试」 |
| 1 | 13 | `core/tools` ↔ 自身 | 「显式栈遍历骨架有意与 ts-types.ts 的 renderSupportedSchema 平行；两个同级渲染器保持对称形态」 |
| 1 | 23 | `storage-json` ↔ 自身 | 「这两个 unit 类各自独立；drain/guard 生命周期镜像了共享的 KvUnit 约定」 |
| 1 | 9 | `subprocess-local` ↔ 自身 | 「Windows 检查器有意镜像 process-inspector.ts：决策逻辑是同一份约定在 Win32 原语之上的表达」 |
| 1 | 16 | `session-query-sqlite` ↔ `storage-sqlite` | 「下面这段仅所有者可用的路径准备与 session-query-sqlite 的派生索引 open 逐字节相同，本次改动不碰它」 |
| 1 | 23 | `session-title-all-prompts-llm` ↔ `session-title-first-prompt-llm` | 「Loader 要求每个插件导出自己可静态遍历的 schema；字段校验器仍然共享」 |
| 1 | 10 | `llm/llm` ↔ `mcp-client` | 「领域专属的延迟校验与 llm 的 retry-policy 平行；不可抽取」 |

## 这些说法实际是什么

**「schema 19 有意拥有一个冻结的物理 codec」说中了一个真实风险，却给错了对策。** 这两个 codec 不只是彼此相似：它们发出的是*相同的字节*。`classify`、`continues`、`buildRow`、`expandRow`、连续段扫描以及整套信封／成员／缺口校验都完全相同，而 sqlite 的 `id` 强制转换（`Extract<StreamChunk, { type: 'tool-call-delta' }>['id']`）解析到的正是 JSONL codec 所打标的同一个 `ToolCallId`。任一写入方存下的 `text-chunks` 行，都能被另一方正确解码。schema 19 真正拥有的是 JSONL 日志没有的三条事实——至多 1,024 个成员、至多 1 MiB 序列化数据，以及同时尊重这两条上限的二分查找连续段切分——外加一次 Client 面无法执行的 `Buffer` 字节计量。为了守住这三条事实而复制整套编码，结果是把这个冻结格式定义在了两个地方，而这恰恰是那条注释所害怕的失效方式，不是对它的防御。

**「这道 realm 边界镜像了 session 所拥有的无损 JSON intrinsic 测试」是一句托词，而且它自己点出了所有者。** `hasIntrinsicConstructor`、`isIntrinsicObjectPrototype` 与 `hasPlainArrayPrototype` 在 `core/session/src/json.ts` 和 `core/tools/src/json-schema.ts` 中逐字节相同，而后者本来就为了 `isJsonValue` 导入了 `@deepseek-ai/dsh-session`。

**「两个同级渲染器保持对称形态」不过是在描述复制粘贴。** TypeScript 与 Python SDK 的渲染器差别在于发出什么，而不在于怎么遍历：同一个显式帧栈、同一次待处理子节点分发、同一个弹栈并交付给父节点的 `finish`，以及压在同样两个不可达 guard 之上的同样两条 `v8 ignore` 注释。

**「这两个 unit 类各自独立」对布局成立，对生命周期不成立。** `single` 持有权威内存并重新发布整个文件；`per-record` 不持有内存，只写一个文档。两者有同一个 `closed` 标志、同一个在途写入集合、同一个先排空再释放的幂等 `close`、同一个 `assertOpen`、同一个已声明全局量的 guard，以及同一个只带一条注释的写入追踪器。

**「Windows 检查器有意镜像 process-inspector.ts」对约定成立，对代码不成立。** 两次树遍历只差一步：POSIX 表行自带启动身份，而 Windows 行按 pid 解析身份，并丢弃身份不可读的成员。这是一个参数，不是一份副本。

**「与 session-query-sqlite 的派生索引 open 逐字节相同」是一次准确的观察，却没有下文。** `createDatabaseFile` 有三份副本而不是两份——第三份在 `session-persistence-sqlite/src/store.ts`——而 `@deepseek-ai/dsh-sqlite-connection` 早就作为 open 阶段各步骤的所有者存在。

**「不可抽取」把自己的对象说错了。** 这重复的十行既不是 MCP 专属的，也不是 LLM（大语言模型）专属的：它们用 Node 的定时器上限约束一对有序的重试延迟，所用的消息文本正是 `@deepseek-ai/dsh-timeout` 已经从它私有的 `assertTimerDelay` 中产生的那一段。

**「Loader 要求每个插件导出自己可静态遍历的 schema」只说对了一半，而且点错了执行者。** Cordis Loader 接受任何 Schemastery 值。真正要求字面量的是 `scripts/gen-config-catalog-schema.ts`：`findInject` 拒绝不是数组字面量的 `inject`，而 `walkSchemaExpr` 拒绝了 `z.object(SessionTitleLlmConfigFields)`，因为那个参数是标识符而不是对象字面量。定义包本来就同时导出了字段校验器和一个无人使用的 `SessionTitleLlmConfigSchema`；每个提供方要把这七个字段重写一遍，原因在生成器，不在 Loader。

## 决策

### `@deepseek-ai/dsh-session/chunk-run-codec` 拥有打包分片连续段的编码

这个新模块持有行的词汇（`ChunkRow`、`StorageRecord` 以及两种连续段数据载荷）、打包白名单、连续段延续判定、行构造、行展开、连续段扫描和 `validateChunkRowShape`——一个存储行所表示的全部含义。它不导入任何 Node 内建模块，因此 Client 面仍能解码传输过来的行。

每种持久格式各自保留属于自己的部分。`chunk-rows.ts` 保留 `MIN_RUN = 3` 和无上限的行。`session-persistence-sqlite/src/codec.ts` 保留 `MIN_PACKED_ROW_MEMBERS`、`MAX_PACKED_ROW_MEMBERS`、`MAX_PACKED_DATA_BYTES`、`Buffer` 字节计量、二分查找切分和 `decodeSerializedChunkRow`。两者各自把自己的 emitter 传给 `scanChunkRuns`，把自己的校验器传给 `decodeChunkStorageRecord`。

存储的字节一个都没变。编码器对相同的事件产出相同的行，两个解码器拒绝相同的值；变的是损坏行的诊断文本现在只有一套词汇而不是两套，因为产出两种写法的那些检查本来就是同一份实现。schema 19 在要紧的意义上仍然冻结：sqlite 包依旧拒绝别的 schema 版本，而对共享编码的改动对两种格式都是一次 schema 变更——这件事现在在一个文件里就看得见，不再需要靠两处编辑来保持一致。

### session 包拥有 realm intrinsic 的原型检测

`hasPlainObjectPrototype` 与 `hasPlainArrayPrototype` 从 `core/session/src/json.ts` 经由那个本来就发布 `isJsonValue` 的包入口导出。`core/tools/src/json-schema.ts` 导入它们，并保留自己的 `try/catch`，因为 Proxy 可能在读取原型时抛出，而一条会抛出的 JSON-Schema 记录本来就不是普通记录。

### 三处同包克隆的本地所有者

- `core/tools/src/schema-render-stack.ts` 为两个 SDK 渲染器驱动同一次后序遍历；各自提供 `frame`、`start` 与 `combine`，`v8 ignore` guard 只存在一处。
- `storage-json/src/unit-lifecycle.ts` 是两种 unit 布局共同继承的抽象基类，提供关闭态 guard、写入排空、已声明全局量检查和写入追踪器。
- `subprocess-local/src/process-tree-walk.ts` 以子节点优先的顺序遍历该表，并从调用方取得身份解析这一步，而那正是两个平台唯一分歧的地方。

### `@deepseek-ai/dsh-sqlite-connection` 拥有 open 阶段的路径步骤

`createDatabaseFile` 与 `prepareDatabasePath` 在那里与连接设置汇合；三个 SQLite 包都调用它们。`session-persistence-sqlite` 保留自己的 `preparePath`，因为它要在创建目录与创建文件之间校验父目录和已存在的文件，所以它在自己的检查之后才调用 `createDatabaseFile`。`session-query-sqlite` 补上了它本该早就有的依赖。

### `assertBackoffDelays` 归入 `@deepseek-ai/dsh-timeout`

它把该模块已有的 `assertTimerDelay` 组合调用两次并加上顺序检查，因此 `llm/retry-policy.ts` 与 `mcp-client/connection.ts` 保持各自一字不差的消息，而那条上限则与 `MAX_TIMER_DELAY_MS` 住在一起。

### 配置目录遍历一份由别的包拥有的字段集合

`walkSchemaExpr` 现在会把命名了某个 `const` 的 `z.object(...)` 参数——该 `const` 声明在同一文件中，或由该入口导入的某个 workspace 包导出——解析到那个对象字面量，并在所有者的文件里遍历它的属性。只走一跳，依然完全静态，依然与插件声明的配置类型交叉核对。两个 session-title 提供方现在都写 `z.object(SessionTitleLlmConfigFields)`，无人使用的 `SessionTitleLlmConfigSchema` 已经删除。生成器改动前后的 `docs/config-catalog.md` 逐字节相同，两个新增的 fixture（测试前置数据）测试证明这次遍历既能收集一份由别处拥有的字段集合，也仍会拒绝配置类型未包含的键。

`core/tools/src/invariant.ts` 也改用[暂存 Agent Note](2026-09-03-session-staging-plumbing-owner.zh.md)提供的 `stageSessionEvents` 与 `advanceOpenTurn`，替换掉它手写的播种、`session/created` 监听器、发布折叠和开放轮次映射。它的 dispatch 根与轮次包含关系没有变化；一条跳过校验就发布的 code-dispatch 记录现在会失败，而不是在发布时被再校验一遍。

## 考虑过的替代方案

**给 SQLite 的 codec 一个 `ChunkRowLimits` 参数，共享整个校验器。** 不予采用，因为字节上限使用 `Buffer.byteLength`，而 `chunk-rows.ts` 被 Client 包导入。传 `Infinity` 仍会在 JSONL 路径上对每个解码行执行一次 `JSON.stringify`，并把 `Buffer` 拖进浏览器 bundle。

**把 realm intrinsic 的判定函数放进一个新的 `packages/util/*` 包。** 不予采用，因为新包需要一份经过评审的双语 README，而翻译不是这次改动的工作。`dsh-session` 本来就是 `core/tools` 的依赖，工具包里的注释也早已点名它是所有者。

**用一个配置判别字段把两个 session-title 提供方包合并。** 不予采用，这属于一次去重之外的架构决策：这些插件名称出现在已发布的组合里，而这两个提供方是两个已注册的 seam 身份。

**因为有门禁要求字面量，就让 session-title 的 schema 继续重复。** 在查明那道门禁是仓库的生成器而不是 Loader 之后不予采用。一个逼着每个插件把七个字段校验器重写一遍的生成器，那是生成器的局限；教会它走一跳静态解析，代价小于它强加的那些副本。

## 后果

`@deepseek-ai/dsh-session` 发布 `./chunk-run-codec`；`packages/core/session/package.json`、`tsconfig.base.json`（经由 `gen-tsconfig-paths`）与 `scripts/gen-tsconfig-paths.spec.ts` 记录了它。生成的别名区域同时收进了其他在途工作已经在各自 manifest（元数据清单）里声明的子路径。

`docs/config-catalog.md` 早已因并行工作而陈旧，本次不动它：生成器在同一棵工作树上跑了两次，一次带遍历改动，一次不带，两次输出完全相同。

`packages/util/sqlite-connection` 不再声称文件与目录的创建属于后端；它的 README 配对、它的 Known Limitations 条目和包描述现在写的是它实际做的事。路径*校验*——所有权与符号链接父目录——仍然属于各个后端。

针对 `core/session/src/json.ts` 还剩两处克隆。`packages/extensions/cordis-host-runner/src/guard.ts` 在同一句「镜像了 session 所拥有的 realm 安全 intrinsic 测试」注释之下持有这些 intrinsic 判定函数的第三份副本；jscpd 先报告了 tools 那份副本，把它掩了过去。那个包本来就导入 `@deepseek-ai/dsh-session`，所以修法就是 tools 包现在用的那个导入，只是它不在本次改动的范围内。

给下一位写重复检测 Agent Note 的人留一条实测结论：在 `.jscpd.json` 的 `mode: "mild"` 之下，jscpd 5 **不**比较注释文本。两个文件如果唯一相同的内容是一段一模一样的 JSDoc 块，它们不构成克隆；而一处跨越不同 JSDoc 报告出来的克隆区域——session-title 那一对正是如此——匹配的是 JSDoc 两侧的代码。因此，重复现场的说明文字从来不是触发门禁的东西，改写一条注释也从来清不掉一处克隆。
