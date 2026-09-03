---
description: "面向 ctx.llm 的 LiteRT-LM 路由：部署如何提供本地 .litertlm 模型——既可以监管 litert-lm serve，也可以指向已在运行的服务器——而线路协议由 pi-ai 负责。"
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-litert

[English](README.md) | 中文

## 概述

有了 `dsh-llm-litert`，组合可以通过 LLM（大语言模型）服务（`ctx.llm`）提供 LiteRT-LM 模型。本包只负责 OpenAI 兼容客户端无法替 LiteRT-LM 完成的两件事：把 `.litertlm` 文件导入 `litert-lm` 注册表，以及监管 `litert-lm serve` 进程。请求本身被委派出去——插件把解析后的端点与模型目录注册为 pi-ai 的 `openai-completions` 提供方档案，因此这里没有 HTTP 客户端、流解码器或消息转换。当部署要在自有硬件上运行模型时选择它，无论模型跑在 harness 的进程树内，还是跑在别人启动的服务器后面。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [模型体验](#model-experience)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在已加载 LLM 服务的组合中挂载本插件；它会用你指定的 `provider` 在 `ctx.llm` 上注册一个路由键。一个路由要么是远程的，要么是本地监管的，二者互斥。

### 选择姿态

设置 `baseURL` 指向已在运行的 LiteRT-LM 服务器——容器、Railway 服务，或在 harness 之外启动的服务器。此时不会启动任何进程，也不会导入任何模型，因此 `server.cwd` 必须缺省，任何模型也不得指定两条导入指令 `file` 与 `huggingFaceRepo` 中的任何一条。

改为设置 `server.cwd` 则监管本地服务器。插件会导入所有已配置的模型，启动 `litert-lm serve`，等待 `GET /v1/models` 作出响应，并在插件销毁时终止该进程。两者都设置或都不设置，都会在加载时以点名这两个键的消息失败。

### 最小配置

```yaml
- id: llm
  name: '@deepseek-ai/dsh-llm-litert'
  config:
    provider: litert
    models:
      - id: gemma4-e2b
        file: gemma-4-E2B-it.litertlm
        huggingFaceRepo: litert-community/gemma-4-E2B-it-litert-lm
        contextWindow: 32768
        maxTokens: 4096
    server:
      cwd: /var/lib/litert
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `provider` | 必填 | 在 `ctx.llm` 上注册的路由键 |
| `displayName` | `provider` | 配置界面为该路由显示的名称 |
| `models` | 必填 | 该路由提供的模型，按配置顺序排列 |
| `baseURL` | — | 已在运行的服务器端点，含其 `/v1` 前缀 |
| `server.cwd` | — | `litert-lm` 子进程的工作目录；设置它即选择本地监管 |
| `server.command` | `litert-lm` | 通过 subprocess 服务的执行世界解析的可执行文件 |
| `server.host` | `127.0.0.1` | 传给 `--host` 并被连接的地址 |
| `server.port` | `9379` | 传给 `--port` 的端口 |
| `server.startupTimeoutMs` | `120,000` | 服务器被启动后回应 `GET /v1/models` 的预算 |
| `server.importTimeoutMs` | `1,800,000` | 一次 `litert-lm import` 的预算，按数 GB 下载设定 |
| `server.maxStdoutBytes` | `1,048,576` | 每个子进程保留的 stdout 尾部；`litert-lm list` 由它解析，因此小于一次注册表列表的界限会丢失 id 并重新导入数 GB |
| `server.maxStderrBytes` | `65,536` | 每个子进程保留、并在失败信息中被引用的 stderr 尾部；纯诊断用途 |

每个模型都要指明其 `litert-lm` 注册表 id，以及 harness 据以进行上下文管理的容量。被监管的模型还要指明其导入所读取的 `.litertlm` `file`，并可选地指明从中拉取它的 `huggingFaceRepo`；远程模型两者都不指明。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-llm-litert)是每个受支持字段及其 JSDoc 的穷尽式真源。

### 单独部署服务器

[deploy/litert](../../../deploy/litert/README.zh.md) 定义了一个在容器中运行同一 `litert-lm serve` 的 Railway 服务。指向该服务公开域名加 `/v1` 的路由使用远程姿态。

### 加载期失败

配置解析先于任何导入运行，因此无法提供的模型列表会直接失败，不必先付出数 GB 的下载代价。重复的模型 id、空的 id、远程路由上的导入指令、缺少 `file` 的被监管模型、非 `http`／`https` 的 `baseURL`，以及大于启动预算的健康检查间隔，都会以点名该键的消息失败。被监管的路由还会在以下情况失败：可执行文件无法解析、导入未在 `importTimeoutMs` 内完成，或服务器未在 `startupTimeoutMs` 内作出响应；失败信息中会引用保留的 stderr 尾部。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

本节说明该路由背后的设计决策；可观察行为已在[使用本包](#use-this-package)中完整覆盖。

### 设计哲学

- **生命周期在此，协议在别处。** LiteRT-LM 说的是 `dsh-llm-pi-ai` 已经实现的 OpenAI completions 线路协议。因此本包只贡献进程与模型文件，并把携带端点和目录的提供方档案交给 pi-ai。线路协议的变更由 pi-ai 负责。
- **唯一的显式解析步骤。** `resolveConfig()` 是本包唯一的默认值处理点。它决定姿态、校验每个键，并返回下游只读而不再作任何决定的 `ResolvedLitertConfig`。
- **由 `server.cwd` 选择姿态。** schemastery 会把缺省的 `server` 对象物化为填满所有默认值的对象，因此唯一没有合理默认值的字段，正是区分「已配置监管块」与「未设置」的依据。
- **占位凭据是协议常量。** LiteRT-LM 不做任何身份验证，但 pi-ai 的 OpenAI-completions 客户端在没有密钥时拒绝构造请求，因此一个固定的非机密占位值随 header 发出，服务器会忽略它。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：姿态分支、pi-ai 档案构造、适配器注册 |
| [`src/config.ts`](src/config.ts) | 配置 schema 与 `resolveConfig()`，唯一的显式解析步骤 |
| [`src/server.ts`](src/server.ts) | `LitertServer`：模型导入、`litert-lm serve` 与启动期健康等待 |
| [`src/invariant.ts`](src/invariant.ts) | 不变式伴生插件（无运行时不变式；持久的请求关系属于 LLM 服务） |

### 启动与销毁

被监管的路由会导入其模型，经 `ctx.subprocess` 启动服务器，并每隔 `healthIntervalMs` 轮询一次 `GET /v1/models`，直到它作出响应或 `startupTimeoutMs` 耗尽。启动工作会观察插件自身的销毁，因为异步插件回调必须先中止自己，Cordis 才能运行 effect 清理。启动失败会处置它可能已经启动的进程，因为此时 teardown effect 尚未注册。适配器注册绑定到调用方 fiber，因此销毁会先移除路由，再停止进程。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [LLM 包地图](../README.zh.md)——本组及各包的职责。
- [dsh-llm](../llm/README.zh.md)——本路由注册进入的服务。
- [dsh-llm-pi-ai](../llm-pi-ai/README.zh.md)——为本路由承担线路协议的适配器。
- [dsh-subprocess](../../subprocess/subprocess/README.zh.md)——服务器进程所在的执行世界。
- [deploy/litert](../../../deploy/litert/README.zh.md)——同一服务器的容器部署，供远程姿态使用。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-llm-litert)——每个受支持配置字段及其源声明。

-----

## 模型体验

间接影响，通过 `dsh-llm-pi-ai` 体现，该适配器拥有使用本路由档案发出的每个请求。

#### KV Cache 影响

不会直接导致失效；被委派的适配器与请求组装负责任何前缀变更。


## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制定义本路由不尝试的事情；它们是当前的包契约。

- **每个插件实例一个路由**——要提供多个 LiteRT-LM 端点的组合需按路由多次挂载本插件，因为 `provider`、`models` 与端点是一起解析的。
- **被监管的服务器不会重启**——插件只启动进程一次，并在销毁时停止它；此后退出的服务器会让路由仍处于注册状态，其请求经 pi-ai 失败，直到 fiber 被重新加载。
- **导入只发生在加载期**——模型在插件 apply 期间导入，因此新增模型意味着修改配置并重新加载，而不是调用运行中的服务器。
- **端点不做身份验证**——LiteRT-LM 的 HTTP API 自身没有凭据，因此远程路由必须连到私有的、或由执行身份验证的代理挡在前面的服务器。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

-----

<a id="model-experience"></a>
