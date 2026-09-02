# LiteRT-LM inference server on Railway

[English](README.md) | 中文

本目录定义了一个 Railway 服务，用于运行 [LiteRT-LM](https://developers.google.com/edge/litert-lm/cli) 的 OpenAI 兼容 HTTP 服务器。harness 通过 `@deepseek-ai/dsh-llm-litert` 的远程姿态访问它：该插件把路由的 `baseURL` 与模型目录注册到 `ctx.llm`，不监管任何本地进程。

## 文件

| 文件 | 职责 |
| --- | --- |
| `Dockerfile` | `python:3.12-slim` 加上 `pip install litert-lm`；不包含模型层。 |
| `entrypoint.sh` | 首次启动时导入所配置的模型，然后运行 `litert-lm serve --host 0.0.0.0 --port $PORT`。 |
| `railway.json` | 构建、启动命令、`/v1/models` 健康检查，以及必需的卷挂载路径。 |

## 部署步骤

1. 从本仓库创建一个 Railway 服务。
2. 把服务的 **Root Directory** 设为 `deploy/litert`。Railway 随后读取 `railway.json`，并以该目录为构建上下文构建 `Dockerfile`；仓库中的其他内容都不需要。
3. 在服务上创建一个卷，并把挂载路径设为 `/data`。`railway.json` 把 `deploy.requiredMountPath` 声明为 `/data`，镜像把 `HOME` 设为 `/data`，因此 CLI（命令行界面）的注册表目录（`$HOME/.litert-lm`）位于该卷上。没有这个卷，每次部署都会重新下载模型。
4. 如果默认模型不是你想要的，请设置下面的模型变量。
5. 部署。首次启动会下载并导入模型，因此耗时远超后续启动；`railway.json` 中的健康检查预算就是按此设定的。
6. 为该服务生成一个公开域名。harness 路由的 `baseURL` 就是该域名加上 `/v1`，例如 `https://litert-production.up.railway.app/v1`。

不要修改启动命令中的绑定地址与端口。Railway 注入 `PORT` 并把公网流量路由到它，因此绑定 CLI 默认的 `9379` 会让服务无法访问并使健康检查失败。

## 环境变量

| 变量 | 设置方 | 用途 |
| --- | --- | --- |
| `PORT` | Railway | `litert-lm serve --port` 绑定的端口。缺失时 entrypoint 会明确失败。 |
| `RAILWAY_VOLUME_MOUNT_PATH` | Railway | 所挂载卷的位置；保持为 `/data`，以便与 `HOME` 一致。 |
| `HOME` | 镜像（`/data`） | 选择 `litert-lm` 的注册表目录。只有在同时修改卷挂载路径时才覆盖它。 |
| `LITERT_MODEL_REPO` | 镜像／服务 | `litert-lm import --from-huggingface-repo` 读取的 Hugging Face 仓库。 |
| `LITERT_MODEL_FILE` | 镜像／服务 | 该仓库中 `.litertlm` 文件的文件名。 |
| `LITERT_MODEL_ID` | 镜像／服务 | 注册表 id，它同时是服务器在 `POST /v1/chat/completions` 上响应的 `model` 名称，以及 harness 路由所配置的 `models[].id`。 |

服务器不做任何身份验证：LiteRT-LM 的 HTTP API 自身没有凭据。因此，公开的 Railway 域名会暴露一个开放的推理（inference）端点。如果这不可接受，请把服务保持为私有（仅内部网络），或在其前面放置一个执行身份验证的代理。

## 模型选择、内存与卷容量

镜像默认使用 `litert-community/gemma-4-E2B-it-litert-lm`（`gemma-4-E2B-it.litertlm`，注册表 id 为 `gemma4-e2b`），也就是 Google CLI 文档在自身示例中使用的模型。把三个 `LITERT_MODEL_*` 变量指向另一个 `litert-community` 仓库即可提供其他模型；`litert-community/gemma-4-12B-it-litert-lm`（`gemma-4-12B-it.litertlm`）是同一系列中最大的一个。

所选模型带来两项容量后果，而 Google 的 CLI 文档并未公布逐模型的数据——请在选择实例前，从 Hugging Face 仓库的文件列表中读取文件大小：

- **卷。** 卷必须容纳 `.litertlm` 文件加上 CLI 的磁盘缓存。容量至少设为文件大小的两倍。Railway 的卷上限在 Free 与 Trial 计划为 0.5 GB，Hobby 为 5 GB，Pro 为 50 GB，因此数 GB 级的模型至少需要 Hobby 计划，12B 级模型需要 Pro。
- **内存。** 服务器在 CPU 后端上把模型权重载入 RAM，因此实例所需内存约为文件大小加上所服务上下文的 KV Cache。小于模型文件的实例会在启动过程中被杀死，部署会因健康检查失败而失败，而不是变慢。

只有一个副本可以挂载卷，因此 `deploy.numReplicas` 为 `1`。扩展该服务意味着运行更多服务，每个都带自己的卷，并由上游路由分发。

## 检查部署

```sh
curl https://<your-domain>/v1/models

curl https://<your-domain>/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gemma4-e2b","messages":[{"role":"user","content":"Hello!"}]}'
```

`GET /v1/models` 同时也是健康检查路径，因此能响应第一条命令的服务，就是 Railway 认为健康、并且 `@deepseek-ai/dsh-llm-litert` 可以指向的服务。

## 把 harness 接到它

```yaml
- id: llm
  name: '@deepseek-ai/dsh-llm-litert'
  config:
    provider: litert
    displayName: LiteRT on Railway
    baseURL: https://<your-domain>/v1
    models:
      - id: gemma4-e2b
        file: gemma-4-E2B-it.litertlm
        contextWindow: 32768
        maxTokens: 4096
```

`file` 记录该路由所服务的产物；远程姿态不导入任何东西，因此并列的 `huggingFaceRepo` 会在加载时被拒绝。请把 `contextWindow` 与 `maxTokens` 设为模型的真实容量——harness 依据它们进行上下文管理，而且没有任何端点会报告这些值。
