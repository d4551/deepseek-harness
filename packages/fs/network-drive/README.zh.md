---
description: "面向以远端存储支撑会话工作区的部署方，以及实现驱动器的开发者的 ctx.networkDrive 能力契约。"
kind: "package-reference"
---

# @deepseek-ai/dsh-network-drive

[English](README.md) | 中文

## 概述

网络驱动器的 Service Definition：对远端树的七个操作，由托管部署实现，使会话工作区可以位于非本地磁盘的存储上。它承载的正是 `ctx.fs` 所缺少的部分——创建目录、删除与重命名——因为本地后端从 shell 获得这些能力，而驱动器没有 shell。

## 目录

- [使用本包](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用本包

网络驱动器能力的 Service Definition：`ctx.networkDrive`，即托管部署为会话工作区提供非本地磁盘存储时所实现的 seam。

## 服务

`NetworkDrive` 声明了对远端树的七个操作，每个都接受 provider 必须遵守的 `AbortSignal`：

| 操作 | 回答 |
|---|---|
| `stat(path, signal?)` | 条目的类型、大小与不透明的 `DriveVersion`；不存在时为 `undefined` |
| `list(path, signal?)` | 一层目录 |
| `read(path, range, signal?)` | 文件字节，可为整体或按 `DriveByteRange` |
| `write(path, content, intent, signal?)` | 在 `DriveWriteIntent` 之下产生的新 `DriveVersion` |
| `remove(path, signal?)` | 移除一个条目 |
| `move(from, to, signal?)` | 驱动器内的重命名 |
| `makeDirectory(path, signal?)` | 创建目录 |

这些正是 `ctx.fs` 所没有的操作。文件系统 seam 负责读取、写入和编辑它已解析的目标；它没有 mkdir、unlink、rename 或 watch，因为本地后端从 shell 获得这些能力。驱动器没有 shell，因此代替 shell 的这个 seam 承载了它们。

## 词汇

`DrivePath` 与 `DriveVersion` 是[带牌](../../util/brand/README.zh.md)的不透明字符串。路径以斜杠分隔且相对于驱动器；版本则是 provider 能够按相等性比较的任意值——ETag、修订号或内容摘要。消费方从不解析二者。

`DriveWriteIntent` 区分无条件写入与带守卫的写入，使 provider 能在预期版本不再匹配时拒绝写入，而不是静默覆盖一次并发更改。`DriveErrorCode` 是封闭联合；provider 把其传输层的失败翻译为它，而在其上分支的消费方以 `assertNever` 收尾。

## 组合

Definition 本身不注册 provider。请挂载恰好一个——随包发布的是 [`dsh-network-drive-webdav`](../network-drive-webdav/README.zh.md)——以及一个消费方 [`dsh-fs-network-drive`](../fs-network-drive/README.zh.md)，由它把驱动器投影到 `ctx.fs`。

## Model Experience

间接地，通过投影该驱动器的文件系统 provider 体现，模型看到的每条路径、每个字节与每个错误都由它拥有。

#### KV Cache effect

无：Definition 不贡献任何提示词文本，也不重排任何请求。

## Known Limitations and Deferred Work

- **没有 watch，也没有变更通知。** 需要察觉驱动器侧编辑的消费方应轮询 `stat`。该 seam 不承载订阅，因为随包发布的消费方按需物化并按版本重新校验；而没有任何 provider 能统一实现的订阅，将是该 seam 无法兑现的承诺。
- **没有部分写入。** `write` 整体替换一个文件；不存在追加或字节范围写入，因此编辑大文件的消费方会在两个方向上整体传输它。`read` 接受范围，所以这一不对称是刻意的：范围读取在 HTTP 上普遍可用，范围写入则不然。
- **没有跨路径的原子操作。** `move` 是唯一的双路径操作，各 provider 按其传输层允许的方式实现；不存在跨多条路径的事务，因此需要事务的消费方应基于带守卫的写入与自身的恢复逻辑来构建。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文 —— 点击展开</summary>

无。

</details>
