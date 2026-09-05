---
description: "强制审批审计：拒绝缺少理由或带有规避工作的理由，并将模型重定向到用户指令。"
kind: "package-reference"
---

# @deepseek-ai/dsh-approval-assessor

[English](README.md) | 中文

## 概述

每个工具审批请求都必须通过审计。缺少理由，或理由要求跳过、推迟、弱化用户已授权的工作时，请求会在任何应答者作出决定前被拒绝。拒绝会追加一条引用最近人类指令的简短重定向。只有非规避且非空的理由通过审计后，才会进入正常审批流。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

每个 `dsh-base` profile 都在产品审批应答者之前挂载本插件。组合值会为用户持有的 Host 设置章节提供初始值，因此无需替换插件行即可修改策略。启用策略后，每个请求都必须携带通过审计的非空理由，之后下游应答者才能作出决定。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | 拒绝缺失及命中规避工作模式的理由；`false` 会原样委托所有请求。 |
| `extraPhrases` | `[]` | 最多添加 64 条不区分大小写的字面短语，每条最多 256 个字符。正则表达式语法没有特殊含义。 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-approval-assessor)是组合字段的完整来源。Host 设置章节在 `approval-assessor` 命名空间使用相同字段，并将持久化或外部发布的变更应用于后续请求。

### 效果

理由缺失或命中规避工作模式的请求会被拒绝，模型收到一条插件署名、引用用户最近指令的消息。只有人类消息才算作该指令：user 角色的日志同样承载运行时上下文提示等插件快照，引用其中之一会把模型指向插件文本。`bash`、`pwsh`、`write`、`edit` 与其他工具使用相同的强制审计。

-----

<a id="understand-the-implementation"></a>
## 理解实现

插件在面向用户的应答者之前监听 `approval/request` 瀑布；`dsh-base` 在添加那些应答者的层之前挂载它。插件读取当前 Host 设置；理由缺失或匹配内置或配置的规避工作模式时，插件注入来源为 `plugin: approval-assessor` 的重定向，不调用 `next()` 而直接判定 `rejected`。策略被禁用或理由不规避工作时，插件在审计后委托。重定向经由智能体收件箱作为稍后的 `user/message` 进入日志。`./invariant` 伴生件确保会话中已提交的重定向条数永不超过被拒审批决定的条数。

启用的审计适用于每个审批请求。缺少理由以及内置或配置的规避工作模式都会拒绝。没有人类消息的会话仍会收到拒绝，只是不附带指令引用。

<a id="model-experience"></a>
## 模型体验

### 拒绝重定向消息

#### What the model sees

规避工作模式命中时，模型收到下述消息，作为一条署名 `plugin: approval-assessor` 的 `user/message`，其后引用用户最近的指令。工具模式与正常调用文本不变。

##### 拒绝重定向

```markdown
Mandatory approval audit denied "<toolName>": the justification is missing or indicates work-avoidance. Do not ask for permission to skip, defer, or soften work the user already instructed you to do. Refer to the user's original instructions and proceed.

User instruction: <excerpt of the user's last instruction, capped at 500 chars>
```

#### Token effect

拒绝前 token 为零。每次拒绝追加一条保留历史的消息，其数据相关部分以 500 字符的指令摘录为上限。

#### KV Cache effect

仅追加；重定向在历史中位于被拒审批请求之后，不使既有 KV-cache 条目失效。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定了审计何时不是合适的选择。它们是当前包的约束，不是任务积压。

- **仅使用规则匹配** — 同时未命中内置规则与 `extraPhrases` 条目的改述式规避会通过审计。学习式或模型辅助检测在出现需求证据前被拒绝。
- **内置规则仅覆盖英文** — 其他语言需要在 `extraPhrases` 中添加部署特定条目。
- **每位用户一份策略** — Host 设置命名空间对每个审批请求应用同一启用状态与短语列表；策略不能按工具或会话选择。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
