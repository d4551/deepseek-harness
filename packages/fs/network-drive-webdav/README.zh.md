---
description: "面向把托管工作区指向既有 WebDAV collection 的部署方的 ctx.networkDrive WebDAV 后端。"
kind: "package-reference"
---

# @deepseek-ai/dsh-network-drive-webdav

[English](README.md) | 中文

## 概述

随包发布的 `ctx.networkDrive` provider，通过持续维护的 `webdav` 客户端访问 WebDAV collection。WebDAV 是普通托管环境已经支持的唯一开放标准，因此已有 collection 的部署无需运行任何新组件即可获得托管工作区。凭据以名称引用而非内联，且每个操作都遵守调用方的取消。

## 目录

- [使用本包](#use-this-package)
- [范围读取](#ranged-reads)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用本包

随包发布的 [`ctx.networkDrive`](../network-drive/README.zh.md) provider：一个 WebDAV collection，通过持续维护的 [`webdav`](https://www.npmjs.com/package/webdav) 客户端访问，而不是手写的 PROPFIND 解析器。

## 为什么选 WebDAV

它是普通托管环境已经支持的、唯一面向远程文件系统的开放标准：Nextcloud、SharePoint、Box 以及 macOS 与 Windows 都能把一个 WebDAV collection 挂载为网络驱动器。已经拥有它的部署无需再运行任何新组件即可获得托管工作区。

## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `url` | 必填 | 支撑驱动器根的 collection 的绝对 `http(s)` URL |
| `authType` | `password` | `none`、`password`、`digest`、`token` 或 `auto` |
| `usernameEnv` / `passwordEnv` | — | 用于 `password`、`digest` 与 `auto` 的凭据引用 |
| `tokenEnv` | — | 用于 `token` 的凭据引用 |
| `requestTimeoutMs` | 见[配置目录](../../../docs/config-catalog.zh.md) | 单次驱动器操作的截止时间 |

凭据以名称引用，从不内联：配置携带的是[凭据 seam](../../credentials/credentials/README.zh.md) 解析的凭据名称，因此已挂载驱动器的密钥不会出现在组合文件中。若某种认证方式完全没有指明凭据引用，会在挂载时失败。已指明但存储无法解析的引用，会在第一次操作时以 `DRIVE_UNAUTHENTICATED` 失败，因为凭据是按操作读取的——轮换后的密钥无需重新挂载即可在下一次请求生效。

每个操作都把调用方的 `AbortSignal` 传入客户端自身的 `signal` 选项，因此被取消的工具调用会取消该 HTTP 请求，而不是让它成为孤儿。

## 错误翻译

provider 把传输层故障映射到 Definition 的封闭 `DriveErrorCode` 联合。该联合命名的状态——401、403、404、409、412、507——各自翻译为对应的码；其余任何状态（含 500）都成为 `DRIVE_IO_ERROR`，并把原始错误作为其 cause 携带。该联合是封闭的，因此在其上分支的消费方以 `assertNever` 收尾，新增一个码就必须让每个消费方都处理它。

<a id="ranged-reads"></a>
## 范围读取

带字节窗口的读取会发送 `Range`，随后依据状态码给答复定位。206 的响应体是服务端选定的窗口，其 `Content-Range` 说明该窗口从哪里开始；200 的响应体是整个实体，由 provider 自己从请求的偏移处切出。响应体长度无法区分二者——忽略 `Range` 的服务端可能返回比请求长度更短的实体——因此对于 provider 无法定位的答复，它以 `DRIVE_IO_ERROR` 失败，而不是返回来自未知区域的字节：任何其他状态码、缺少可解析 `Content-Range` 的 206，以及起点越过请求偏移的窗口都属此列。起点越过文件末尾的窗口不算错误；此时读取返回零字节，这正是 Definition 在文件先结束时所承诺的行为。

## Model Experience

间接地，通过 [`dsh-fs-network-drive`](../fs-network-drive/README.zh.md) 体现：它把该驱动器投影到 `ctx.fs`，并拥有模型看到的每条路径与每个字节。

#### KV Cache effect

无：该 provider 不贡献任何提示词文本，也不重排任何请求。

## Known Limitations and Deferred Work

- **没有加锁。** 未使用 WebDAV 的 `LOCK`/`UNLOCK`，因此指向同一 collection 的两个 harness 可能交错写入同一文件。带守卫的写入意图把窗口收窄到版本检查与其 `PUT` 之间的间隙；要彻底关闭它，需要这些锁动词以及随之而来的锁令牌生命周期。
- **版本取决于服务端返回什么。** 不提供 ETag 的 collection 会使每次带守卫的写入实际失去守卫，因为 provider 没有可比较的对象。这是服务端的属性，provider 如实报告，而不是改用需要读取整个文件才能计算的摘要来替代。
- **没有范围写入。** Definition 本身没有，且 WebDAV 的 `PATCH` 字节范围扩展并未被广泛支持，因此一个字节的编辑也会重新上传整个文件。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文 —— 点击展开</summary>

无。

</details>
