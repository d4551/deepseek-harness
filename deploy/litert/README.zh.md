# LiteRT-LM inference server on Railway

[English](README.md) | 中文

本目录定义了一个 Railway 服务，用于运行 [LiteRT-LM](https://developers.google.com/edge/litert-lm/cli) 的 OpenAI 兼容 HTTP 服务器。harness 通过 `@deepseek-ai/dsh-llm-litert` 的远程姿态访问它：该插件把路由的 `baseURL` 与模型目录注册到 `ctx.llm`，不监管任何本地进程。

## 文件

| 文件 | 职责 |
| --- | --- |
| `Dockerfile` | `python:3.12-slim` 加上 `pip install litert-lm`；不包含模型层，也不包含模型身份。 |
| `entrypoint.sh` | 首次启动时导入所配置的模型，然后运行 `litert-lm serve --host 0.0.0.0 --port $PORT`。 |
| `.railway/railway.ts` | Infrastructure as Code：卷及其挂载路径、模型变量、`/v1/models` 健康检查，以及单个副本。 |

Railway 的 `railway.json` Config as Code 已弃用——新服务无法再选用它，已有文件也将在 2026-12-01 停止被读取——因此本服务改用 [Infrastructure as Code](https://docs.railway.com/infrastructure-as-code) 描述。差别在于文件何时被读取：`railway.json` 由每次部署从仓库中读取，而 `.railway/railway.ts` 由 Railway CLI（命令行界面）在你自己的机器上求值，并按需应用。

## 部署步骤

1. 把你 fork 的本仓库连接为一个 Railway 服务。
2. 把服务的 **Root Directory** 设为 `deploy/litert`。正是它让 Railway 的构建器以该目录为构建上下文去构建 `Dockerfile`；仓库中的其他内容都不需要。`.railway/railway.ts` 不声明 `source`，因此它管理各项设置，却不接管仓库连接。
3. 在 `deploy/litert` 的检出目录中应用该配置：

   ```sh
   npm install railway
   railway login
   railway link
   railway config plan
   railway config apply
   ```

   `plan` 会打印它将设置的卷、变量、健康检查与副本数；`apply` 在确认后执行这些改动。CLI 会在当前目录及其各级父目录中查找 `.railway/railway.ts`，因此请在 `deploy/litert` 下运行，或传入 `--file`。请把文件中的项目名改成你所链接的项目，否则 `apply` 会把项目改名成与文件一致。

   否则 Railway IaC 会把缺席的资源视为已删除的资源：一份描述整个项目的文件被应用到还有其他内容的环境时，会把那些内容删除。本文件导出 `partial = 'litert-lm'`，把这一行为限制在它自己声明的服务与卷上，链接环境中的其余部分不受影响。应用之后请勿重命名该导出——旧名字仍然持有它所拥有的资源。
4. 如果默认模型不是你想要的，请修改 `.railway/railway.ts` 中的 `LITERT_MODEL_*` 值并重新应用。
5. 部署。首次启动会下载并导入模型，因此耗时远超后续启动；`.railway/railway.ts` 中的 `healthcheckTimeout` 就是按此设定的，远高于 Railway 的 300 秒默认值。
6. 为该服务生成一个公开域名。harness 路由的 `baseURL` 就是该域名加上 `/v1`，例如 `https://litert-production.up.railway.app/v1`。

不要修改 `entrypoint.sh` 中的绑定地址与端口。Railway 注入 `PORT` 并把公网流量路由到它，因此绑定 CLI 自带的默认端口会让服务无法访问并使健康检查失败。

## 环境变量

| 变量 | 设置方 | 用途 |
| --- | --- | --- |
| `PORT` | Railway | `litert-lm serve --port` 绑定的端口。缺失时 entrypoint 会明确失败。 |
| `HOME` | 镜像与 `.railway/railway.ts`（`/data`） | 选择 `litert-lm` 的注册表目录（`$HOME/.litert-lm`）。`.railway/railway.ts` 中的单个 `MOUNT_PATH` 常量同时设定它与卷挂载点，因此二者不会漂移；镜像也烘焙同一路径，供直接 `docker run` 使用。 |
| `LITERT_MODEL_REPO` | `.railway/railway.ts` | `litert-lm import --from-huggingface-repo` 读取的 Hugging Face 仓库。缺失时 entrypoint 会明确失败。 |
| `LITERT_MODEL_FILE` | `.railway/railway.ts` | 该仓库中 `.litertlm` 文件的文件名。缺失时 entrypoint 会明确失败。 |
| `LITERT_MODEL_ID` | `.railway/railway.ts` | 注册表 id，它同时是服务器在 `POST /v1/chat/completions` 上响应的 `model` 名称，以及 harness 路由所配置的 `models[].id`。缺失时 entrypoint 会明确失败。 |

镜像不烘焙任何模型身份，这正是那三个守卫能够真正触发的原因：由本 `Dockerfile` 构建的镜像在服务提供这些变量之前拒绝启动。`HOME` 没有守卫，因为镜像已设定它，而容器运行时总会提供一个，守卫永远不会触发；这一致性改由 `packages/llm/llm-litert/tests/deploy.spec.ts` 检查，健康检查路径与所绑定端口同样由它检查。

服务器不做任何身份验证：LiteRT-LM 的 HTTP API 自身没有凭据。因此，公开的 Railway 域名会暴露一个开放的推理（inference）端点。如果这不可接受，请把服务保持为私有（仅内部网络），或在其前面放置一个执行身份验证的代理。

## 模型选择、内存与卷容量

该配置默认使用 `litert-community/gemma-4-E2B-it-litert-lm`（`gemma-4-E2B-it.litertlm`，注册表 id 为 `gemma4-e2b`），也就是 Google CLI 文档在自身示例中使用的模型。把三个 `LITERT_MODEL_*` 变量指向另一个 `litert-community` 仓库即可提供其他模型；`litert-community/gemma-4-12B-it-litert-lm`（`gemma-4-12B-it.litertlm`）是同一系列中最大的一个。

所选模型带来两项容量后果，而 Google 的 CLI 文档并未公布逐模型的数据——请在选择实例前，从 Hugging Face 仓库的文件列表中读取文件大小：

- **卷。** 卷必须容纳 `.litertlm` 文件加上 CLI 的磁盘缓存。请把 `sizeMB` 至少设为文件大小的两倍；随附的 `4096` 按该规则足以覆盖默认模型。Railway 的卷上限在 Free 与 Trial 计划为 0.5 GB，Hobby 为 5 GB，Pro 为 50 GB，因此数 GB 级的模型至少需要 Hobby 计划，12B 级模型需要 Pro。`volume()` 还接受 `region`；请把它设为服务所在的区域，或像随附文件那样省略它，交由 Railway 放置。
- **内存。** 服务器在 CPU 后端上把模型权重载入 RAM，因此实例所需内存约为文件大小加上所服务上下文的 KV Cache。小于模型文件的实例会在启动过程中被杀死，部署会因健康检查失败而失败，而不是变慢。

只有一个副本可以挂载卷，因此 `replicas` 为 `1`。扩展该服务意味着运行更多服务，每个都带自己的卷，并由上游路由分发。

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
        contextWindow: 32768
        maxTokens: 4096
```

远程姿态不导入任何东西，因此两条导入指令——`file` 与 `huggingFaceRepo`——都会在加载时被拒绝；模型进入注册表的地方正是上面这套部署。请把 `contextWindow` 与 `maxTokens` 设为模型的真实容量，因为 harness 依据它们进行上下文管理，而且没有任何端点会报告这些值。
