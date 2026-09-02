# Agent Note：LiteRT-LM 路由与 Railway 推理服务

Status: implemented

[English](2026-09-03-litert-lm-route-and-railway-server.md) | 中文

## Problem

LiteRT-LM 提供一个 Python CLI，其 `serve` 子命令暴露兼容 OpenAI 的 HTTP API，因此与它*通话*不需要任何新东西——[`@deepseek-ai/dsh-llm-pi-ai`](../../../../packages/llm/llm-pi-ai/README.zh.md) 早已能对任意 base URL 服务手写声明的 `openai-completions` 网关。现有包都不拥有的是围绕这条线路的一切：把数 GB 的 `.litertlm` 模型导入 CLI 的注册表、以受管子进程方式启动 `litert-lm serve`、在把任何请求路由过去之前等它应答、并在 dispose 时停掉它。想用本地 LiteRT 模型的组合此前只能手工启动服务，并指望 harness 不会比它先退出。

## Decision

[`@deepseek-ai/dsh-llm-litert`](../../../../packages/llm/llm-litert) 拥有 LiteRT-LM 的模型与进程生命周期，并把每个请求委派给 pi-ai。`apply` 解析自身配置，在本组合拥有该服务时先把端点拉起来，然后基于一份 profile 构造 `PiAiAdapter`：其 `api` 为 `openai-completions`，`baseURL` 为解析出的端点，`models[]` 为已配置的模型目录——与部署为任何其他兼容 OpenAI 的网关手写的声明完全相同。`ctx.llm.registerAdapter([provider], adapter)` 将其发布。本包内没有任何 HTTP 客户端、流式解码器或消息转换。

两种姿态都是一等的，并且在结构上可区分。schemastery 会把缺失的嵌套对象物化为填满默认值的对象，因此无法把 `server?:` 键与未设置的情形区分开；于是由 `server.cwd`——唯一没有正当默认值的受管字段——来选定本地受管姿态。只给出 `baseURL` 即远程：不启动进程、不执行导入，与之并列的 `huggingFaceRepo` 会被拒绝，因为那等于承诺一次该路由永不执行的导入。同时给出两者、或两者都不给，都会在加载时失败。

`LitertServer` 就是完整的就绪路径。它通过 `ctx.subprocess.resolveExecutable` 解析可执行文件，用 `litert-lm list` 读取注册表，对注册表中尚不存在的每个已配置模型运行 `litert-lm import [--from-huggingface-repo REPO] FILE ID`，启动 `litert-lm serve --host --port`，并轮询 `GET /v1/models` 直到服务应答。判定"是否已存在"的权威是注册表而非文件路径：`import` 写入 `$HOME/.litert-lm` 而非调用方指定的路径，因此路径探测永远观察不到一次成功导入的产物。每个预算都是经校验的配置字段——`importTimeoutMs`、`startupTimeoutMs`、`healthIntervalMs`、`shutdownGraceMs`、`maxStderrBytes`——并且每条失败都会引用子进程保留的输出。以超时、调用方取消或提前退出收场的等待都会在抛出之前终止进程，因此失败的 `apply` 不留残留；成功路径把拆解注册为 `ctx.effect()` 的 disposer，在路由撤销之后运行。

关于 pi-ai 有两个承重的事实，之所以记录在此，是因为两者都与其源码的直观读法相反。

**把 `llm-pi-ai` 作为子插件挂载并不安全。** 那本会是最小的委派——`ctx.plugin(PiAiPlugin, { providers })` 可白拿设置分区、凭据解析与可配置 provider 目录。但 `llm-pi-ai` 会安装 `llm-pi-ai` 设置命名空间，而 [`SettingsProvider.register`](../../../../packages/settings/settings/src/index.ts) 在重复注册时抛出 `settings namespace "…" is already registered`。同时挂载两个插件的组合——也就是常规情形，因为 LiteRT 只服务一条路由，其余由 pi-ai 服务——将无法启动。直接构造 `PiAiAdapter` 才使两者得以共存。

**pi-ai 的 `openai-completions` 请求路径要求非空密钥。** 它的 `getClientApiKey` 返回请求携带的密钥，或在已存在 `Authorization` 头时返回字面量 `"unused"`，否则抛出 `No API key for provider`。省略 `apiKeyEnv` 的路由在*配置*时以及端点探询中都是受支持的，但来自这种路由的流式调用永远到不了网络。LiteRT-LM 的服务不做任何认证，因此本包的 `resolveApiKey` 无条件返回 pi-ai 自己的 `'unused'` 占位符。它是该客户端的常量而非部署选择，这也正是本包不提供凭据选项的原因：一个真的会校验凭据的 LiteRT 端点就不会是这条路由。

`llm-pi-ai` 发布 `./auth` 与 `./config` 子路径导出，各自由包内 `tsdown.config.ts` 构建为独立产物并列入 `files`，使 `llm-litert` 在真正拥有这些符号的模块中取得 `resolveProfiles`、`credentialStoreFrom` 与 `authContextFrom`。最初落地的另一种做法——在 `llm-pi-ai` 入口模块上加再导出行——用一个模块拓宽了另一个模块的触及范围，已被禁止。

## Railway deployment

[`deploy/litert/`](../../../../deploy/litert/README.zh.md) 定义一个运行同一服务的 Railway 服务，供以 `baseURL` 指向它的组合使用，而本地姿态受管的正是同一个服务。镜像是 `python:3.12-slim` 加 `pip install litert-lm`，不携带模型层：一个 `.litertlm` 文件有数 GB，而镜像层会在每次部署时被重新拉取，卷里其实已经有它了。`entrypoint.sh` 在首次启动时导入所配置的模型，然后绑定 Railway 注入的 `$PORT`，绝不绑定 CLI 默认的 `9379`——那会让服务无法访问并使其自身健康检查失败。`HOME` 指向卷挂载点，因为 CLI 把注册表解析为 `$HOME/.litert-lm`，正是这层间接使已导入的模型能挺过重新部署。Railway 的配置 schema 没有 `volumes` 键，因此 `railway.json` 以 `deploy.requiredMountPath` 声明该需求，卷本身在服务上创建；`numReplicas` 为 `1`，因为一个卷只能挂到一个副本。

## Alternatives considered

**再写一个 OpenAI-completions HTTP 客户端。** 直接否决：`llm-pi-ai` 已经实现了该协议、它的流式处理与消息转换，一份 LiteRT 专用的副本将是对本包唯一不拥有之物的第二次实现。

**把 `llm-pi-ai` 作为子插件挂载。** 因上文所述的设置命名空间冲突而否决。它还会使 LiteRT 路由可通过 `llm-pi-ai` 用户设置分区编辑，而一次人工编辑就能把 `baseURL` 指离本插件所受管的进程。

**通过写入 `llm-pi-ai` 设置分区来声明该路由。** 否决，因为那个分区是用户的文档。由组合拥有的路由会以用户覆盖的形式出现、在插件 dispose 后继续存在，并比它所指的服务活得更久。

**探测配置的 `.litertlm` 路径以决定是否导入。** 否决，因为 `litert-lm import` 复制进注册表而非调用方指定的路径，于是成功导入之后该配置路径依然不存在，每次启动都会重新下载。`litert-lm list` 是查看注册表内容的既定方式，它打印的表头行与已配置 id 的任何碰撞都无关紧要：一次误匹配只会跳过一次导入，而服务随后会响亮地失败。

**经由 `./src/*` 导出取用 `llm-pi-ai` 的内部模块。** 否决，因为该说明符会原样进入发布产物——`tsdown` 会将其外部化——留下一个构建产物去导入纯 Node 无法加载的 `.ts` 文件。真正的子路径导出解析到 `lib/*.js`，[`web-fetch-http`](../../../../packages/web/web-fetch-http/package.json) 对 `./policy` 与 `./network` 已经这样做。

**为置于认证代理之后的部署提供 `apiKeyEnv`。** 因缺少使用方而否决：LiteRT-LM 没有凭据，而一个可配置的凭据会诱使部署相信本包认证了某些它并未认证的东西。

## Consequences

组合只需给出 `server.cwd` 与其模型即可获得本地 LiteRT 模型，只需给出 `baseURL` 即可获得托管的那一个；harness 中别无改动，DeepSeek 与 pi-ai 路由不受影响。代价是 `llm-litert` 耦合到了 `llm-pi-ai` 的适配器构造而非某个更窄的接缝：`PiAiAdapterOptions` 是同仓库内的契约，因此对它的改动在编译期而非运行期到达本包，但它现在是两个包共同持有的契约，而不再是一个。

启动更慢，并且会在此前不会失败的地方失败。本地姿态会阻塞 `apply` 直到服务应答，因此需要下载模型的首次启动会耗时与下载相当，而永远不健康的服务会让整个组合失败而不是降级。这是有意的取舍：注册在死端点上的路由会让每个请求都失败于一个什么都没指明的网络错误。

`llm-pi-ai` 现在多发布两个入口并携带包内构建配置，因此其 `files` 数组需要每个带额外产物的包都携带的那条[约束白名单条目](../../../../scripts/check-workspace-constraints.ts)。

## Testing

[`packages/llm/llm-litert/tests/litert.spec.ts`](../../../../packages/llm/llm-litert/tests/litert.spec.ts) 注入子进程 spawner、可执行文件解析器与健康探针，驱动真实的 `LitertServer` 与真实插件。它固定了跳过导入与执行导入的判定、每次 `litert-lm` 调用的 argv、一次失败的导入与一次失败的 `list`、一次超出自身超时的导入、一次永不健康的启动（在配置预算内终止进程）、一个在启动期间退出的 serve 进程、调用方取消，以及每一条配置拒绝。远程姿态的固定方式是：断言路由已注册到 `ctx.llm`，而记录型 subprocess 服务完全没有见到任何 spawn。
