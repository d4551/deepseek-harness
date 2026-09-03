---
description: "dsh 的托管工作区补丁层：会话工作区由 WebDAV 网络驱动器而非宿主磁盘支撑，使服务器上运行的 harness 拥有比机器更长寿的工作区。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-hosted-drive

[English](README.md) | 中文

## 概述

`dsh-hosted-drive` 把会话工作区从宿主磁盘移到 WebDAV 网络驱动器上。在 `dsh-base` 与 `dsh-web-app` 之后应用它，harness 的运行方式一如既往——同样的工具、同样的沙箱、同样的 shell——区别只在于每个工具看到的目录是远端存储的镜像，并随模型工作写穿回去。它为托管部署而存在：运行在服务器上、不得把用户文件留在该服务器磁盘上、且工作区必须比所在机器更长寿的 harness。主要边界：每个部署一个驱动器，由环境变量配置，并且并发写入的唯一仲裁者是驱动器本身。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## 使用本包

<a id="use-this-package"></a>

### 配置驱动器

该层由环境变量驱动：

| 变量 | 默认值 | 含义 |
|---|---|---|
| `DSH_DRIVE_URL` | 必填 | WebDAV collection 的绝对 `http(s)` URL |
| `DSH_DRIVE_USERNAME` / `DSH_DRIVE_PASSWORD` | 必填 | 该 collection 的凭据 |
| `DSH_DRIVE_WORKSPACE` | 必填 | 驱动器物化进入的本地绝对目录 |
| `DSH_DRIVE_REMOTE_ROOT` | 驱动器根 | 要镜像的驱动器子树 |
| `DSH_DRIVE_MAX_FILE_BYTES` | `10485760` | 该层在任一方向传输单个文件的字节上限 |
| `DSH_DRIVE_REQUEST_TIMEOUT_MS` | `30000` | 单次驱动器请求的期限 |
| `DSH_PERMISSION_MODE` | `workspace-write` | 该层重述的沙箱模式 |

`DSH_DRIVE_WORKSPACE` 同时也是 `sandbox-policy` 设围栏所用的目录。只改其一会割裂执行世界，因此该补丁用同一个变量设置两者，使它们无法漂移。

这两个上限属于该层本身，而非驱动器后端文件系统的默认值：10 MiB 只有 `fs-network-drive` 在本地磁盘上所允许值的十分之一，因为这里的每个字节都要两次穿越网络；链路更快或套餐限额不同的部署无需改动 bundle 即可上调或下调这两个值。

## 理解实现

<a id="understand-the-implementation"></a>

### 覆盖 base 的补丁面

该层做的是替换而非叠加。`dsh-base` 插入的宿主本地 provider `fs-sandbox` 被停用，因为同一棵树中的两个 `ctx.fs` provider 会让模型拥有两个工作区。补丁在其位置插入 [`network-drive-webdav`](../../fs/network-drive-webdav/README.zh.md) 作为驱动器，并插入 [`fs-network-drive`](../../fs/fs-network-drive/README.zh.md) 作为其上的文件系统后端，同时重述 `sandbox-policy`，使围栏指向物化根。

### 单一执行世界

Bash、持久终端、ripgrep、语言服务器与文件工具都通过 `processPath()` 解析路径，而它返回物化根内的真实目录。它们都不知道工作区位于远端，也都不需要知道。

这一性质在 harness 运行期间被检查，而非从补丁中假定。该层自己的行用同一个变量设置围栏与物化根，但 profile 的 `cordis.patch.yml` 或 `dsh --patch` 覆盖层可以只重述其中一行；随之而来的割裂世界会让命令写入围栏够不到的位置，而驱动器永远看不到。因此该补丁还插入了[不变量注册表](../../runtime-diagnostics/invariants/README.zh.md)以及本包的伴生插件：它在每次 `fs/observed` 时比较实时的 `fs.materializationRoot` 与实时的 `sandboxPolicy.resolve().workspaceRoot`（两者都经规范化），并在它们指向不同目录时让该次运行失败。

在其他所有已发布配置树中运行时不变量都是关闭的（[决策](../../../.agents/notes/implemented/simplification/2026-08-03-omit-invariants-from-shipped-config.zh.md)），因此注册表行携带只列出 `@deepseek-ai/dsh-hosted-drive` 的 `package_allowlist`：hosted 运行获得的是该层的这项检查，而不是其他任何包的诊断。需要更多检查的部署可以像修改任何其他配置一样放宽该行。

## 延伸阅读

<a id="further-exploration"></a>

- [网络驱动器 Service Definition](../../fs/network-drive/README.zh.md) —— 另一种后备存储需要实现的 seam。
- [WebDAV provider](../../fs/network-drive-webdav/README.zh.md) —— 随包发布的驱动器。
- [驱动器支撑的文件系统](../../fs/fs-network-drive/README.zh.md) —— 水合、写穿与物化根。

<a id="model-experience"></a>
## 模型体验

间接地，通过该层重新指向的文件与 shell 工具体现，它们把模型看到的每条路径与每个字节渲染为物化根下普通的本地路径。

#### KV Cache 影响

无：该 bundle 不贡献任何提示词文本，也不重排任何请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **每个部署一个驱动器。** 该层从环境变量配置单一 collection；若某个部署以一个进程服务多名用户，则需要按会话选择驱动器，而补丁层没有表达它的位置。
- **并发由驱动器仲裁，且仅在它提供版本时有效。** 指向同一 collection 的两个 harness 会交错写入；当服务端提供 ETag 时带守卫的写入会报告冲突，不提供时则完全无法守卫。
- **此处仅接线密码认证。** WebDAV provider 同样支持摘要认证与 bearer 令牌，但该补丁接线的是密码形式，因此以令牌认证的 collection 需要自己的覆盖行。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文 —— 点击展开</summary>

无。

</details>
