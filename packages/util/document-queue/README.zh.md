---
description: "单个文件文档的独占操作链：串行化的进程内操作、由 watcher 驱动并「告警且保留最后可用值」的重载，以及静默收敛的释放。"
kind: "package-reference"
---

# @deepseek-ai/dsh-document-queue

[English](README.md) | 中文

## 概述

`dsh-document-queue` 承载每个在 harness home 下保存单个文档的提供方都需要的管道逻辑，与文档内容无关。写入与重载在同一条链上逐个执行，因此渲染绝不会从「另一次重载正在替换的文本」出发。文件系统 watcher 把外部编辑变成一次排队重载，并补上启动缺口：在持有者首次读取与 watcher 生效之间写入的变更不会触发任何事件。释放是静默收敛的：队列拒绝新工作、停止 watcher，并且只在所有已排队操作结算后才完成。读取、解析、校验、渲染与发布仍归持有者所有——队列只调用持有者的 `reconcile` 步骤，并对其失败施加一套策略。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)
- [开发者备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

先一次性解析文档位置，为它构造一个队列，然后让每个操作都经过该队列。

```ts
import { DocumentQueue, readDocumentText, resolveDocumentSpec } from '@deepseek-ai/dsh-document-queue'
import type { Context } from '@deepseek-ai/cordis'

declare const ctx: Context
declare const config: { path?: string; dshHome?: string; watch?: boolean; debounceMs?: number }
declare function publish(text: string | undefined): void

const spec = resolveDocumentSpec(config, 'settings.yaml')
let cached: string | undefined

const reconcile = async (): Promise<void> => {
  const text = await readDocumentText(spec.filename)
  if (text === cached || queue.isClosed()) return
  cached = text
  publish(text)
}

const queue = new DocumentQueue({
  label: 'settings-file',
  filename: spec.filename,
  debounceMs: spec.debounceMs,
  logger: ctx.logger,
  reconcile,
})
```

`resolveDocumentSpec(config, basename)` 是唯一的默认化步骤：显式 `path` 优先，否则文档位于 `<harness home>/<basename>`；watch 默认开启，写入稳定窗口默认 100 毫秒。config 带有额外字段的调用方直接传同一个对象，只有这四个字段会被读取。

插件入口以 `static Config: z<Config> = z.object(DocumentQueueConfigFields)` 校验同样这四个键，因此 Loader schema 与 `resolveDocumentSpec` 的默认值不会各自漂移。每个提供方仍声明自己的 `Config` 接口——[配置目录](../../../docs/config-catalog.zh.md)粘贴的正是该声明，作为插件的部署面；目录生成器沿字段引用向本包跳转一跳。

### 串行化一次写入

```ts
import { DocumentQueue } from '@deepseek-ai/dsh-document-queue'

declare const queue: DocumentQueue
declare function renderAndCommit(): Promise<void>

await queue.enqueue(async () => {
  if (queue.isClosed()) throw new Error('provider is disposed: cannot write')
  await renderAndCommit()
})
```

`enqueue` 按到达顺序执行操作，并始终结算队尾，因此被拒绝的操作既不会卡住下一个操作，也不会把拒绝泄漏给它；该拒绝仍原样传给它自己的调用方。入口检查两端都要做：提前拒绝，并在操作内部重新判定，因为操作排队等待期间状态可能已经改变。

### 监视与释放

```ts
import { DocumentQueue } from '@deepseek-ai/dsh-document-queue'

declare const queue: DocumentQueue
declare const watchConfigured: boolean

if (watchConfigured) await queue.watch()

await queue.close()
```

`close()` 调用属于持有者的释放路径。`watch()` 在规范化后的路径上安装 chokidar watcher，其 `awaitWriteFinish` 由 `debounceMs` 决定，为每次变更排入一次重载，并在 watcher 就绪时再排一次。`close()` 可重复调用、也可从多条 teardown 路径调用；每次调用等待的都是同一个队尾。

### 重载失败策略

`queueReload()`（也是 watcher 调用的入口）执行持有者的 `reconcile` 并对失败分流：携带 `code === 'INVARIANT'` 的错误会向上传播并经 `logger.error` 上报，因为被污染的提交不是重载问题；其余失败经 `logger.warn` 上报并保留持有者最后可用的快照，因为运行期热重载绝不能拖垮进程。需要相反行为（明确报错）的调用方自行在 `enqueue` 内调用 `reconcile`——读-改-写在渲染前正是这么做的。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内幕 — 点击展开</summary>

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `DocumentQueue`、`resolveDocumentSpec`、`readDocumentText`、`isENOENT` 及其类型 |
| [`src/invariant.ts`](src/invariant.ts) | 不变式伴生插件（无运行时不变式；每个队列都属于其持有者私有） |

### 为什么链尾总是被结算

`enqueue` 挂在一个吸收两种结果的队尾上，因此队列自身从不拒绝，下一个操作也不受上一个操作结果影响。`close()` 等待的正是同一个队尾——这就是正在释放的持有者可以确信没有排队写入还能发布的原因：队尾只在最后一个操作结算后才完成。

### 为什么「缺失」是一个值

`readDocumentText` 对缺失文件返回 `undefined`，其他错误一律重新抛出。把任何读取失败都当作缺失的持有者，会在文档变得不可读的瞬间发布空存储，而这与用户删除了全部条目无法区分。

### 哪些仍归持有者

队列从不为读取内容而打开文档。权限检查、格式判定、解析、保留注释的渲染、跨进程写锁与 seam 发布都属于持有它的提供方，因为每一项都取决于文档内容本身。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [文件设置提供方](../../settings/settings-file/README.zh.md) —— 基于本队列的单个 YAML/JSON namespace 分节文档。
- [文件凭据提供方](../../credentials/credentials-local/README.zh.md) —— 基于本队列的 harness home 凭据文档。
- [原子写入](../atomic-write/README.zh.md) —— 上述提供方在排队操作内部使用的持久化提交与跨进程写锁。

-----

<a id="model-experience"></a>
## 模型体验

无，因为本包不贡献任何模型可见文本、工具或提示词：它只串行化提供方自己的文件系统工作，模型看到的始终只是该提供方选择发布的内容。

#### KV 缓存影响

无：队列不贡献任何请求 token，也不重排任何模型请求。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

- **一个队列对应一个文档** —— 链对整个队列是全局的，因此保存多个文档的持有者需要构造多个队列，且不会获得跨文档的顺序保证。
- **不做跨进程串行化** —— 链只安排本进程的操作；需要排除其他进程的写入方仍要在排队操作内部使用 `dsh-atomic-write` 的文件锁。
- **漏掉的 watcher 事件保持不可见** —— 队列只在 watcher 事件与 watcher 就绪时对账，从不定时轮询，因此平台 watcher 漏报的变更只会被下一个事件、下一次排队操作或重启并入。
- **重载策略是固定的** —— `INVARIANT` 向上传播、其余告警；需要不同分流的持有者在 `enqueue` 内调用 `reconcile` 并施加自己的策略。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
