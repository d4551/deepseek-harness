# Agent Note: LiteRT 的 Railway Infrastructure as Code，以及由解析拥有的 stdout 上限

Status: implemented

[English](2026-09-03-litert-railway-iac-and-stdout-bound.md) | 中文

## Problem

`deploy/litert/` 与 `packages/llm/llm-litert/` 在[最初的 LiteRT 路由](../feature/2026-09-03-litert-lm-route-and-railway-server.zh.md)中一并发布，而对两者的对抗式审读找出了六个缺陷，它们既通不过 schema 校验的检查，也通不过绿色单元测试套件的检查。

该部署用 `railway.json` 描述自身，也就是 Railway 的 Config as Code。这一机制已废弃：新服务完全无法启用它，既有文件在 2026-12-01 之后不再被读取。schema 是否合法无关紧要：从这个目录发起的全新部署根本用不上该文件。`deploy/litert/` 还完全没有任何测试或门禁，因此没有任何东西检查入口脚本绑定的是 Railway 注入的 `$PORT` 而不是 CLI（命令行界面）默认端口、卷挂载路径是否与镜像的 `HOME` 一致，或健康检查路径是否是服务器真的会应答的路径。当时唯一存在的跨文件不变量是 Dockerfile 里的一条注释，请求人工让 `ENV HOME` "in step with `deploy.requiredMountPath`"。`entrypoint.sh` 中五个 `:?` 守卫里有四个永远不可能触发，因为镜像烘焙了 `HOME` 与全部三个 `LITERT_MODEL_*` 变量，而 README 却宣称每一个都会大声失败。

在包内部，`server.maxStderrBytes` 被同时当作 stdout 与 stderr 的字节上限，但 stdout 并非诊断输出：`registryIds()` 从中解析 `litert-lm list` 的结果，用来决定要导入哪些模型。为削减日志量而调低该字段，会悄悄截短注册表列表、让 id 掉出被保留的尾部，并重新导入注册表本已持有的数 GB 数据。`registryIds()` 的注释只描述了一行表头，而该命令还会打印一段 `Listing models in: <dir>` 前言。此外，`file` 在 schema 中对每一个模型都是 `required()`，包括远程路由，而远程路由什么都不导入，并且正是出于这个原因本就拒绝 `huggingFaceRepo`。

取代 `railway.json` 的那份 Infrastructure as Code 文件随即以新的形式重演了原来的缺陷：它在本仓库里无从验证。`railway` 不在任何 manifest（元数据清单）中，因此 `import { … } from 'railway/iac'` 什么都解析不到；没有任何 `tsconfig*.json` 点到 `deploy/`，因此该文件不属于任何 TypeScript program；`.oxlintrc.json` 的类型感知覆盖项只列出 `packages`、`apps`、`examples`、`scripts` 与 `website`，因此它只受基础规则 lint；而新增的那道门禁用正则表达式匹配它的源码文本。一个拼错的选项（`sizeMb`、`healthcheckTimeoutSeconds`）能原样通过上述每一项，只会被 `railway config apply` 拒绝，而那要等到有人先关联了一个项目之后。

## Decision

**部署由 Infrastructure as Code 描述。** `deploy/litert/.railway/railway.ts` 取代 `railway.json`，使用已正式可用的 TypeScript 编写 API（来自 `railway/iac` 的 `defineRailway`、`project`、`service`、`volume`，通过先 `npm install railway` 再 `railway config plan` / `railway config apply` 应用）。没有 IaC 对应物的 Config as Code 键不做伪造：`builder`、`dockerfilePath`、`requiredMountPath` 与重启策略被移除，`numReplicas` 改为 `replicas`，卷则成为一个声明出来的 `volume()` 资源，通过 `volumeMounts` 挂接，而不再是一条挂载路径断言。`source` 被刻意省略，使该文件只拥有服务设置而不主张仓库连接；把 Railway 的构建器指向同级 `Dockerfile` 的是服务的 Root Directory 设置。这也改变了文件被读取的时机：`railway.json` 在每次部署时从仓库读取，而 `.railway/railway.ts` 由 CLI 求值并按需应用。

**一个常量承载挂载路径不变量。** IaC 文件中的 `MOUNT_PATH` 既是 `volumeMounts` 的键，也是服务的 `HOME`，因此在该文件内部，卷与 `litert-lm` 注册表目录（`$HOME/.litert-lm`）不可能漂移。Dockerfile 仍然为普通 `docker run` 烘焙同一路径，而两个文件的相等关系是一条测试断言，不再是一条注释。

**镜像与模型无关。** `LITERT_MODEL_REPO`、`LITERT_MODEL_FILE` 与 `LITERT_MODEL_ID` 是 IaC 文件中的服务变量，而不是 `ENV` 行，这正是它们的守卫能够触发的原因：由这份 Dockerfile 构建出的镜像在服务提供这些变量之前拒绝启动。那个失效的 `HOME` 守卫被删除，而不是为了对称而保留——镜像会设置 `HOME`，容器运行时也总会提供一个，因此针对它的守卫永远无法触发。README 现在正是这样写的。

**`deploy/litert` 有一道已执行的门禁。** `packages/llm/llm-litert/tests/deploy.spec.ts` 读取那三个真实文件，并断言跨越它们的不变量：不再残留任何 Config as Code 文件；IaC 挂载路径等于镜像的 `ENV HOME` 且两处使用都读取 `MOUNT_PATH`；健康检查路径等于 `LitertServer` 的就绪探测针对本包自己解析出的端点所请求的路径；serve 那一行绑定 `"${PORT}"` 而绝不绑定解析出的默认端口；入口脚本读取的每一个模型变量都有守卫、都不在镜像中、且都在 IaC 环境变量中；`PORT` 有守卫且不在 IaC 环境变量中钉死；`HOME` 被烘焙且没有守卫；以及声明了一个副本。它落在包的 `tests/` 目录里，因为仓库的 Vitest include glob 只运行那里；`deploy/` 不匹配其中任何一条。

**stdout 携带自己的、经过校验的上限。** `server.maxStdoutBytes`（默认 `1,048,576`）决定 `litert-lm list` 解析所读取的 stdout 保留尾部的大小；`server.maxStderrBytes`（默认 `65,536`）仍是诊断旋钮。两者都是带同一条正整数规则的、经过校验的 `Config` 字段，两者的差别写在各自的声明处。

**IaC 文件针对 Railway 求值它时所用的那个包编译。** `railway` 是仓库根的开发依赖，因为 `bunfig.toml` 设置了 `linker = "isolated"`，而 `deploy/` 本身不构成任何 workspace：根 manifest 是 `deploy/litert/.railway/railway.ts` 唯一够得着其 `node_modules` 的 manifest，也正是部署者自己执行 `npm install railway` 时的落点。`packages/llm/llm-litert` 为导入这些类型的测试套件声明同一范围。`deploy/litert/tsconfig.json` 是只装着这一个文件的 leaf 项目；两个 aggregate 都不引用它，因为部署描述既不是 Host 也不是 Client 产品代码，而被引用的 project 不得禁用 emit，于是由 `packages/llm/llm-litert/tests/deploy.spec.ts` 对它运行 `tsc --build --force`，该检查随 `bun run test` 执行。`.oxlintrc.json` 中点名 `scripts/` 的那四条覆盖项现在也点名 `deploy/*/.railway/*.{ts,tsx}`，这正是把该文件纳入类型感知规则的原因；`knip.json` 把同一个 glob 列为根 entry，因为只有 Railway CLI 会导入它。

**这道门禁读的是图，而不是文件的文本。** `deploy.spec.ts` 导入默认导出，像 `railway config plan` 那样用 `createRailwayContext()` 与 `project` 调用它，并对返回的 `ServiceNode` 与 `VolumeNode` 断言：`volumeAttachments[…].mountPath`、`variables` 中的 `HOME` 字面量、`deploy.healthcheckPath`、`deploy.numReplicas` 与 `config.region`。Railway 会忽略的选项根本不出现在那张图里，重新排版该文件也不会挪动任何一条断言。Dockerfile 与 `entrypoint.sh` 这两半仍按文本比对，因为 Dockerfile 和 shell 脚本没有这套测试能够抵达的求值形态。

**卷依然不钉死任何 region，并且有一条测试写明了原因。** 在 `railway/iac` 中 `region` 是可选的：`volume(name, config?)` 搭配 `region?: string | null`，运行时默认为 `{}`，`validateGraph` 从不读取它；而 Railway 会在挂载该卷的服务所在的 region 制备卷。只在卷上钉死 region 就构成 Railway 需要停机迁移的跨 region 挂接，因此该文件两边都不钉死，只在调用点写出那四个 region 标识符，供想要指定位置的部署者取用；测试套件则断言卷不会钉死一个服务并未钉死的 region。

**`file` 感知路由姿态，并与 `huggingFaceRepo` 对称。** 两者都是导入指令。受管路由要求 `file` 并接受 `huggingFaceRepo`；远程路由两者都拒绝，理由与本包本就为 `huggingFaceRepo` 给出的一致：该路由指向的服务器有自己的注册表，本包从不触及，因此这两个键都会读作它无法兑现的承诺。解析现在在本地端点上携带 `imports: readonly LitertImport[]`，因此 `LitertServer` 收到的条目按构造就带有 `file`，无需再次检查一个可选字段。

**该文件导出了具名 `partial`，否则一次 apply 会删除它没有点名的资源。** Railway IaC 把描述整个项目的编写文件视为完整的期望状态：缺席即删除。本文件只描述一个服务，而被应用的环境属于部署者、并且可能已在使用中，因此没有 partial 时 `railway config apply` 会移除他们不相关的资源。`export const partial = 'litert-lm'` 把「缺席即删除」限制在此处声明的服务与卷上。这也正是 Railway 自己的 `railway config migrate --service <name>` 会写出的形态，因为本文件所替代的 `railway.json` 是按服务划分的；这次手工迁移产出了该工具会产出的一切，唯独漏了这一项。该名字属于已应用状态——在 apply 之后重命名会让旧名字持有的资源变成孤儿——因此 `deploy.spec.ts` 把它锚定到服务自身的名字，而不是一个字面量。

## Verification

`bun x vitest run packages/llm/llm-litert`——行为测试套件与新的部署门禁合计 35 个测试。行为套件新增了一个假的子进程句柄，它会真正把 spawn spec 的 `maxBytes` 作为尾部长度应用，因此有三个新用例断言的是行为而非参数：一次注册表列表在 `maxStderrBytes: 8` 下仍然存活且不重新导入任何内容；一个过小的 `maxStdoutBytes` 会丢掉 id 并迫使重新导入；第一个生命周期用例把两个上限钉为 spawn spec 上的两个独立值。配置用例覆盖两种远程拒绝、受管路由的 `file` 要求、解析出的导入列表，以及 `maxStdoutBytes` 的校验。

每一条部署门禁断言都通过破坏它所守卫的文件而被证明会失败：恢复一个 `railway.json`；把 `MOUNT_PATH` 改成与镜像 `HOME` 不同的值；用字面量替换 `HOME: MOUNT_PATH`；把 `healthcheck` 改到 `/health`；在 serve 那一行硬编码 CLI 默认端口；绑定 `127.0.0.1`；把 `ENV LITERT_MODEL_ID` 加回镜像；从 IaC 环境变量中删掉一个模型变量；删掉一个入口脚本仍在读取的守卫；在 IaC 环境变量中钉死 `PORT`；移除 `ENV HOME`；以及把 `replicas` 提到 3。每一次改动都恰好让拥有它的那条断言失败，恢复文件后套件重新转绿。

`bun x tsx scripts/run-oxlint.ts packages/llm/llm-litert deploy/litert/.railway/railway.ts`——7 个文件，0 条警告，0 个错误。

把 IaC 文件纳入一个 program 之后：`bun x vitest run packages/llm/llm-litert`——两个文件共 37 个测试；`bun x tsc -b deploy/litert --force`——干净通过；`bun x tsx scripts/run-oxlint.ts deploy/litert packages/llm/llm-litert`——7 个文件，0 条警告，0 个错误；`bun x vitest run scripts/live-stack-floors.spec.ts`——31 个测试，覆盖新增的 `railway` 根依赖版本下限。

另有六次改动证明了两条新断言与四条重新落到图上的断言。把 `sizeMB` 改名为 `sizeMb`、把 `healthcheckTimeout` 改名为 `healthcheckTimeoutSeconds`，各自只让编译断言失败，TS2561 直接点出正确拼写；这两处在此前的正则门禁下都能原样通过。在服务未钉死 region 的情况下给卷加上 `region: 'us-west2'`，只让 region 断言失败。把 `HOME: MOUNT_PATH` 换成字面量 `'/elsewhere'`，只让挂载断言失败；该断言不再依赖那个常量是否写在那一处。把 `healthcheck: '/v1/models'` 换成合法别名 `healthcheckPath: '/health'`，能通过编译，只让健康检查断言失败。`replicas: 3` 只让副本断言失败。把 `volumeMounts` 重排为三行（此前的单行正则会拒绝这种写法），套件仍然全绿。

上面关于 Railway API 的说法都在源头重新核对过，而不是沿用先前那次阅读。`region` 记在 `## Volumes` 之下一张双列 `Field | Description` 表里，该表不把任何字段标为必填；已发布的 `railway@3.11.0` 声明与之一致：`declare function volume(name: string, config?: VolumeConfig)` 搭配 `type VolumeConfig = { sizeMB?: number | null; region?: string | null; … }`。Railway 自己的 Public API 参考文档确实带有 Required/Optional 列，其中 `VolumeCreateInput.region` 标为 Optional。两个有记录的 `volume(…)` 示例都传了 `region`，这很可能就是把它读成必填的来源。

Railway API 是从线上文档而非记忆中读取的：Infrastructure as Code 参考文档提供编写文件的路径、`service` 与 `volume` 的字段表，以及省略 `source` 的做法；IaC 概览提供 `npm install railway`、`plan`/`apply` 命令、父目录文件查找，以及 Config as Code 的废弃措辞与 2026-12-01 截止日期；健康检查指南提供超时单位及其 300 秒默认值。

那次阅读漏掉了同一概览页的 `## One file per project` 一节，而「缺席即删除」与具名 partial 这条出口正写在那里。partial 是在重读后补上的，并由两次变异证明：删掉该导出会让新断言以 `expected undefined to be 'litert-lm'` 失败，把它写成 `'litert'` 会以 `expected 'litert' to be 'litert-lm'` 失败。`bun x vitest run packages/llm/llm-litert/tests/deploy.spec.ts`——9 个测试，恢复后为绿。

## Alternatives considered

**保留 `railway.json`，因为它能通过校验。** 已否决：合法不等于可用。新服务无法启用该机制，因此第一个照着文档部署路径操作的人就会失败。

**把挂载路径的一致性继续留作注释。** 已否决：那条注释本就存在，也本就在请求人工维护它。一个常量加一个测试，把这条不变量从散文变成会失败的东西。

**把模型身份留在镜像中，转而放软 README 的说法。** 已否决：服务提供哪个模型属于部署配置，把它烘焙进镜像相当于容器版的硬编码可调参数。移除那些 `ENV` 行一举修好了失效守卫与模型无关镜像两件事，之后只需丢掉那个真正无法触发的 `HOME` 守卫。

**把部署门禁放在 `deploy/litert/tests/`。** 已否决：仓库的 Vitest include glob 是 `packages/*/*/tests`、`apps/*/tests` 与 `scripts`，因此放在那里的套件永远不会运行。一道不执行的门禁正是它本要修复的那个缺陷。

**从解析出的注册表 id 中过滤掉 `Listing` 与 `ID`。** 已否决：匹配 CLI 的散文比容忍两个不会造成危害的词更脆弱。配置成这两个 id 之一的模型只会跳过一次导入，随后服务器会大声失败。注释现在描述的是解析实际看到的输出。

**把 `deploy/litert` 登记进 `tsconfig.host.json`。** 已否决，而且它根本编译不过：`oxlint-tsgolint` 报出 `Referenced project '…/deploy/litert' may not disable emit`，而另一条路（给一个部署目录设 `outDir`）会把构建产物写进 `deploy/`。一个不被引用、由拥有该目录的测试套件运行的 leaf，检查的是同一个文件，也在同一条命令下执行。

**因为每个有记录的示例都这么写，所以钉死 `region: 'us-west2'`。** 已否决：类型、运行时与文档表格都表明它是可选的，而 Railway 会把卷放在其服务所在的 region。写进仓库交付文件的 region 会对每一个部署者生效，而服务运行在别处的部署者就会撞上那种需要停机迁移的跨 region 挂接。

**允许远程路由把 `file` 当作文档保留。** 作为这一切的起点的不对称已否决。插件无法针对一个它并不管理的服务器验证该声明，而这正是它本就拒绝 `huggingFaceRepo` 的原因。

## Consequences

- 部署这个目录现在是一次本机 CLI 操作（`railway config plan`、`railway config apply`），而不再是平台在部署过程中拾取的一个文件。README 记录了 CLI 的父目录查找与项目名匹配。
- 卷声明为 `sizeMB: 4096` 且不带 `region`。该大小遵循 README 自己针对默认模型的“文件大小两倍”规则，并保持在 Railway 的 5 GB Hobby 上限之下；region 交给 Railway，而不是替全球用户猜一个，README 也写明设置它时要与服务所在 region 一致。
- 在此改动之前配置的远程路由会在加载时失败，并点名 `file`。这是有意为之的发布前破坏；两份 README 的远程示例不再携带该键。
- `LitertServerSpec.models` 变成了 `imports`，`ResolvedLitertEndpoint` 的本地变体新增了 `imports`。两者都是导出类型，因此直接构造 `LitertServer` 的消费方会随之更新。
- `docs/config-catalog.md` 由这些配置类型生成，需要重新运行 `bun run gen-config-catalog`。这里没有改动它，因为工作树中同时存在对其他包配置的并行改动，而生成器会重写整个文件。
- `deploy/litert/.railway/railway.ts` 现在让部署套件每次运行多付一个 `tsc` 进程，约 60 ms。这是检查一个没有其他 program 会编译的文件所付的代价。
- 一次不固定版本的 `npm install railway` 会让 `railway` 前移，因此仓库的 `^3.11.0` 与对应的 `ROOT_DEPENDENCY_FLOORS` 条目，才是让这项编译检查始终衡量部署者 CLI 将要求值的那套 API 的依据。提升其中一处就要一并提升另一处。
- `deploy/litert/README.md` 早已记录 `npm install railway` 与省略的 `region`；这次新增了一段，说明 apply 会删除未被点名的资源，以及 `partial` 导出把这一行为限制在何处。
- `partial` 的名字如今是与每一个应用过本文件的环境共享的已应用状态。重命名它不是一次重构：旧名字仍持有它拥有的资源，而那些资源会以不受管理的形式重新出现。
