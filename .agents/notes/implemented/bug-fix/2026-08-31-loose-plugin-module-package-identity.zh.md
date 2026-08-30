# Agent Note: Loose plugin modules carry no package identity

Status: implemented

[English](2026-08-31-loose-plugin-module-package-identity.md) | 中文

## Problem

`dsh_plugin_packages` 会在每个官方 DeepSeek 请求派发前完成准备，准备阶段的拒绝会以 `REQUEST_EXTENSION` 使整个轮次失败。相对与绝对插件模块通过向上查找最近的所属 `package.json` 解析身份。从 profile patch 层挂载的插件（`name: './model-fallback.js'`）会走到 `initProfile` 写入的 manifest：`{ name: "dsh-profile-<dir>", private: true, dependencies, dsh }`，其中没有 `version`，因为 npm 只在发布时才要求它。解析器把缺失的 `name` 视为松散模块标记，却要求每个具名 manifest 提供 `version`，因此只要 profile 挂载了任一相对模块，每个官方 DeepSeek 请求都会在 HTTP 之前失败，且每一轮都失败，直到有人手工编辑该 manifest。

## Decision

`plugin-package-inventory-deepseek` 只为同时声明非空 `name` 与非空 `version` 的 manifest 报告身份。由相对或绝对模块向上查找得到的 manifest，只要缺少其中任一字段就标记为松散模块：profile 脚手架、workspace 根目录以及其他私有 manifest 拥有目录却并不指明可发布的包，因此该模块不贡献身份，请求继续进行。由裸包名解析出的 manifest 仍必须同时具备两个字段，因为 Node 是从已安装的包树中解析到它的；那里缺少字段仍然使请求准备失败。这正是该包 README 已经写明的松散模块限制。

覆盖随规则移动：格式错误元数据的拒绝改由 `node_modules` 中的裸包固定，而具名却无版本的 profile 形态 manifest 被固定为省略，并与仍然上报的带版本同级模块并列。

## Alternatives considered

**给生成的 profile manifest 写入 `version`。** 已否决，因为它修复不了任何已存在的 profile 目录，并且会让每个 profile 以活跃插件包的身份上报自身（`dsh-profile-web@0.0.0`），而该目录只是本地脚手架而非包。

**只把 `private: true` 的 manifest 视为松散。** 已否决，因为发布意图并不决定 manifest 是否标识一个包：本仓库的每个 workspace 包都是私有且带版本的，那样还需要第二条例外。

**只要有配置项解析失败就省略整个字段。** 已否决，因为通过包树解析到的裸包名在安装时就带有两个字段；那里的缺失属于配置错误，应当保持明确失败。

**让 adapter 丢弃失败的扩展字段并照常派发。** 已否决，因为准备是与 `dsh_session_log` 共享的单个 fail-closed 事务，而对于 provider 从未收到的请求，其接受水位不得推进。

## Consequences

紧邻无版本 manifest 的插件模块对清单不可见，而不再让会话致命，清单也只上报所属包确实可识别的配置项。明确拒绝收窄到裸包 specifier，那里的 manifest 属于已安装包自身。已存在的 profile 无需改动 `~/.dsh` 即可恢复。仍会发生的准备失败现在会在 `REQUEST_EXTENSION` 消息中写明原因，因此会话日志携带了运维人员可据以行动的信息。
