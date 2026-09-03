# Agent Note: 多根与渲染式 fetch 改动之后的快照车道修复

Status: implemented

[English](2026-09-03-snapshot-lane-repair.md) | 中文

## Problem

有三次改动在缺少[测试政策](../../../../docs/testing.zh.md)所要求的录制会话证据的情况下合入，`bun run test:snapshot` 在四个场景上转红。

`packages/acp/acp/src/index.ts` 获得了多文件夹支持：`session/new` 与 `session/resume` 现在会校验 `additionalDirectories`，并通过 `setAdditionalWorkspaceRoots` 记录被接受的根目录。`snapshots/acp/reject-extra-dirs` 场景仍在断言那条已被移除的拒绝信息 `Invalid params: additionalDirectories is not supported`，而快照 harness 仍把 `additionalDirectories` 与 `mcpServers` 描述为未实现——`mcpServers` 在同一时期已经变成受支持的 stdio 与 HTTP 传输清单。

`packages/context/agent-instructions/src/config.ts` 往 `workspaceBaselineIdentity` 里加入了 `additionalRoots`。该字符串经由基线指令消息抵达模型并随之持久化，因此 `agent-instructions` 与 `ptc-workspace-context` 与各自已提交的会话日志出现分歧。

base 组合包为已发布的渲染式路由写入了 `fetchProvider: playwright`。`snapshots/session/web-fetch` 此前依赖自己是唯一注册的 fetch 提供方，于是它的回环 fixture（测试前置数据）不再被选中，渲染式路由对 `public.test` 走了真实 DNS 解析，并把 `getaddrinfo ENOTFOUND public.test` 记录为工具结果。这是仓库中唯一一份会话级的 `web_fetch` 覆盖。

## Decision

**ACP（Agent Client Protocol）场景断言的是接受。** `snapshots/acp/reject-extra-dirs` 现在是 `snapshots/acp/additional-directories`。它先初始化，发送一次 `session/new`，其 `additionalDirectories` 条目是相对路径并以 `additionalDirectories entries must be absolute paths` 被拒绝，随后再发送一次，其条目是绝对路径并被接受。该场景设置 `comparesLog: true`，于是携带 `{{cwd}}/extra-root` 的持久 `workspace/roots` 事件就是被接受的根目录确实生效的证据；单看 `session/new` 的结果帧只能说明这次调用返回了。场景本地的 `workspace/extra-root/` 种子目录让所声明的根目录成为客户端确实拥有的目录。

**已提交的输入脚本用 `{{cwd}}` 命名生成的工作区。** `newSession` 与 `newSessionExpectError` 都接受 `additionalDirectories`，并在把 `{{cwd}}` 替换为本次运行生成的根目录之后逐字发送每个条目。一条规则覆盖两个步骤，因此单个脚本既能命名桥接器会接受的绝对根目录，也能命名它会拒绝的相对写法，而这个 token 与规范化器写回预期输出的那个一致。

**两份基线身份 fixture 只携带新字段，别无其他。** 每个 `baselineIdentity` 字符串新增了 `"additionalRoots":[]`。该改动先以无密钥回放测量，确认没有其他值发生差异之后才应用。

**web-fetch 覆盖层写明自己的路由。** `snapshots/session/web-fetch/cordis.yml` 及其回放同级文件写入 `fetchProvider: http`，并在 fixture 所替换的 `web-fetch-http` 行之外一并禁用 `web-fetch-playwright`。该 fixture 以注入的解析器把真实的 `HttpFetchProvider` 注册在 seam 的 `http` id 之下，因此写明那个 id 正是选中它的方式；把渲染式那一行继续挂载还会在挂载时探测浏览器安装情况，使整套组合依赖宿主环境。该场景已录制的会话日志、提示词钉住与工具 schema 钉住均未改变。

## Alternatives considered

**删除该 ACP 场景。** 已否决。为了让车道转绿而删掉工作区范围决策唯一的协议级覆盖，是在移除证据而不是更新证据，违背“测试描述行为，而非正确性”。

**让该场景仅作为拒绝探针保留。** 已否决。多文件夹这项交付物的重点是接受；一个只展示相对路径被拒绝的用例，会让已发布的行为在协议层面无人断言。

**用一个无效的 `mcpServers` 条目、而不是相对根目录来覆盖剩下的拒绝分支。** 就本场景而言已否决。相对的 `additionalDirectories` 条目是被接受写法的直接同类，且在同一个校验步骤中失败，因此两种结果可以从同一个脚本读出。

**把每个声明的根目录都相对本次运行的 cwd 解析。** 已否决。那样一来相对写法的拒绝就完全无法表达，而 `newSession` 与 `newSessionExpectError` 会对同一字段承载不同含义。

**用 `test:snapshot:refresh` 重新录制这两个 headless 场景。** 作为已提交产物已否决。刷新还会把 `sourceEventSeqs` 从扁平列表重新规范化为 `encodeSeqRanges` 现在写出的区间形式。那次重写在语义上是中性的——`normalizeSessionLog` 在比较前会解码两侧——但它是一次独立的、涉及整个语料的存储迁移，不属于本次改动。

**把 fixture 提供方注册在 `playwright` id 之下。** 已否决。那样该场景会声称覆盖了渲染式路由，实际运行的却是地址钉住的 HTTP 传输。

**让渲染式路由跑在一个本地服务器上。** 已否决。这需要一份无密钥车道无法假定存在的 Chromium 安装，而且渲染式路由的目的地策略只放行公网单播地址，回环地址不属于其中。

## Testing

`bun run test:snapshot` 覆盖全部四个场景。ACP 用例已被证明确实起守卫作用：从 `session/new` 中移除 `setAdditionalWorkspaceRoots` 调用后，它以差异中点名的缺失 `workspace/roots` 事件失败。

`packages/test-support/session-snapshot/tests/harness.spec.ts` 断言 `{{cwd}}` 替换抵达了协议层，所用的假 agent（智能体）会在拒绝信息中引用它收到的根目录。

## Consequences

ACP 语料现在通过其持久记录断言多文件夹被接受，而不再断言一条已被移除的拒绝信息，并且单个输入脚本就能演练被放行与被拒绝两种工作区范围。

已发布的渲染式 fetch 路由没有会话级快照。`snapshots/session/web-fetch` 钉住的是地址钉住的 HTTP 路由，那是一种受支持的部署选择，也是无密钥、无浏览器的车道唯一能确定性驱动的选择。渲染式路由的证据留在 `packages/web/web-fetch-playwright`，直到有一条拥有浏览器的车道能够承载它。

已提交的会话 fixture 仍以区间化之前的形式存储 `sourceEventSeqs`。下一次对任何场景执行 `test:snapshot:refresh` 都会重写该场景的编码；无论哪种形式，比较结果都不受影响。
