---
description: "面向运行托管工作区的部署方，以及调试水合或写穿的维护者的、由驱动器支撑的 ctx.fs 后端。"
kind: "package-reference"
---

# @deepseek-ai/dsh-fs-network-drive

[English](README.md) | 中文

## 概述

把网络驱动器投影到文件系统 seam 的 `ctx.fs` 后端。它维护一个真实的本地物化根，使 `processPath()` 返回 ripgrep、shell 与语言服务器能够打开的路径；读取按需水合并按驱动器版本重新校验，写入则先发布到驱动器再报告成功。

## 目录

- [使用本包](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用本包

把[网络驱动器](../network-drive/README.zh.md)投影到文件系统 seam 的 `ctx.fs` 后端，使托管会话的工作区位于远端存储，同时所有本地工具照常工作。

## 为什么要物化

`FileSystem.processPath()` 必须返回真实操作系统进程能够打开的路径。`tool-fs-search` 会启动 ripgrep；`bash-local`、`terminal-bash` 与 `lsp-stdio` 会启动进程；`sandbox-local` 按真实路径设围栏。以 URI 作答的后端会让它们全部失效。

因此该 provider 维护一个**物化根**：一个真实的本地目录，驱动器的子树按需镜像其中。`processPath()` 返回该目录内的路径，于是 ripgrep、shell 与语言服务器看到的是一个普通工作区。

路径解析只分配身份，不传输内容。读取按需水合，并按驱动器的 `DriveVersion` 而非时间戳重新校验。写入先提交到驱动器，再替换本地副本。远端拒绝提交时保留原有修订；若远端提交成功而本地发布失败，操作会报告错误，后续读取可重新水合已提交的字节。

本地操作根据规范化物化根校验已有路径祖先。离开工作区的链接会被拒绝，包括重定向私有暂存目录或缓存记录的链接；工作区内部链接仍可使用。`lstat` 仍能报告最终链接本身。流式读取在开始消费时重新检查路径归属。

## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `materializationRoot` | 必填 | 驱动器镜像进入的本地绝对目录 |
| `remoteRoot` | 驱动器根 | 以斜杠分隔的驱动器路径，其子树被镜像 |
| `maxFileBytes` | 见[配置目录](../../../docs/config-catalog.zh.md) | 单个文件在任一方向上的上限 |

`materializationRoot` 必须与沙箱策略设围栏的目录相同。这正是每个被替换的后端都遵循的单一执行世界规则：文件系统、shell 与限制机制必须指向同一个工作区，否则命令可能写到围栏够不到的地方。

## Model Experience

间接地，通过 `read`、`write`、`edit`、`glob` 与 `grep` 工具体现，它们渲染每条路径与每个字节。模型看到的是物化根下普通的本地路径，无法分辨该工作区位于远端——而这正是目的所在。

#### KV Cache effect

无：该后端不贡献任何提示词文本，也不重排任何请求。

## Known Limitations and Deferred Work

- **路径检查与本地 I/O 不是原子操作。** 原生路径解析能识别已有的符号链接越界，但其他进程仍可能在检查与后续文件操作之间重命名目录。恶意并发写入方需要操作系统级限制；本 provider 不实现基于目录描述符的原子遍历。

- **每个驱动器子树只应有一个写入方。** 指向同一远端根的第二个 harness 可能在本实例的版本检查与写入之间完成发布。每个驱动器都会提供版本——当 collection 不提供 ETag 时，WebDAV provider 会退回到修改时间与大小——因此比较并设置的检查始终会执行；缺少 ETag 所损失的是*原子的*远端守卫（`If-Match`），留下检查与 `PUT` 之间的一个窗口，而不是取消该检查。
- **工作区中的 shell `rm` 或 `mv` 不会到达驱动器。** `ctx.fs` seam 没有 unlink 与 rename，因此删除与重命名是通过 shell 对物化根执行的。驱动器仍然持有该文件，下一次水合会把它带回来。要弥合这一点需要驱动器 seam 的 `remove` 与 `move`，它们正是为此而存在，目前尚无消费方。
- **物化根不做垃圾回收。** 已水合的文件会一直保留到该根被删除，因此长会话在大驱动器上会增长到它触碰过的规模。淘汰需要一套策略——按年龄、大小或固定标记——目前尚无消费方提出。
- **驱动器侧的编辑在重新 stat 之前不可见。** Definition 中没有 watch，因此水合之后在驱动器上被更改的文件，会一直由本地副本作答，直到某个操作重新校验它。
- **驱动器尚未持有的工作文件，其身份要按自身大小来计算，且超过 `maxFileBytes` 时不可读。** 尚无任何一方发布过它，因此它的版本就是其内容摘要：`stat`、`read` 与 `write` 都会流式读取整个文件来求得版本，而超过上限的文件会被拒绝而不是被送出。驱动器上的文件则由驱动器已报告的修订标识，完全不需要读取。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文 —— 点击展开</summary>

无。

</details>
