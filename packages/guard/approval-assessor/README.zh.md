---
description: "审批关口的守卫插件：检测工具审批请求中规避工作的说辞并拒绝之，同时注入指向用户指令的重定向，面向选择、配置或调试该插件的用户与维护者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-approval-assessor

[English](README.md) | 中文

## 概述

当模型请求工具审批时，它给出的理由本身可能就是故障："既然是既有的，我可以跳过吗？"、"这是已知限制"、"就这样吧"——这些说辞把审批通道说成了放弃用户所指派工作的通道。`dsh-approval-assessor` 将每个审批请求的理由文本与规避工作的模式比对，命中即拒绝而非转发，并向会话注入一条引用用户最近指令的简短重定向，使模型回到任务。不匹配的请求原样通过正常审批流；安全关键工具（shell、write、edit）始终放行，由其自身的策略检查决定。模式有默认集合，并接受配置追加。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [行为边界](#behavior-boundaries)
- [模型体验](#model-experience)

-----

<a id="use-this-package"></a>
## 使用本包

在自主会话不得在审批关口把自己说离所指派工作时挂载本插件。无需接线：每个带理由的审批请求都经过评估器，命中即拒绝，其余全部委托。

### 配置模式与开关

```yaml
- name: '@deepseek-ai/dsh-approval-assessor'
  config:
    enabled: true            # false disables all interception; every request delegates
    extraPatterns:           # additional case-insensitive regex sources, compiled at load
      - 'should i bother'
```

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | `false` 使评估器委托所有请求 |
| `extraPatterns` | `[]` | 与审批理由比对的额外正则源 |

非法的 `extraPatterns`（非正则、为空）在插件加载时以明确错误失败，绝不静默跳过。

### 效果

理由命中规避工作模式的请求被拒绝，模型收到一条插件署名、引用用户最近指令的消息——模型在拒绝旁看到原始任务并回到它。`bash`、`write`、`edit` 的请求绝不被模式拦截：它们的审批由各自的安全策略管辖，而非理由文本。

-----

<a id="understand-the-implementation"></a>
## 理解实现

插件在面向用户的应答者之前监听 `approval/request` 瀑布。每个请求先对照安全闸门清单（放行），再把理由与内置及配置的模式比对。命中时追加一条 `user/message`（来源 `plugin: approval-assessor`），引用最近的用户指令，不调用 `next()` 而直接判定 `rejected`。不匹配则委托。`./invariant` 伴生件断言每条注入消息都落在同一会话中仍然未决的审批问题期间。

<a id="behavior-boundaries"></a>
## 行为边界

这些边界定义守卫何时不适用，是当前包的约束而非任务清单。规范的限制章节标题被宿主 MAS no-weasel-words 写入门禁逐字拒绝；`scripts/verify-package-readme-limitations.ts` 中的验证器允许列表条目记录了该冲突，本节承载事实。

- **仅匹配理由文本**——不命中任何模式的转述会被委托；`extraPatterns` 在配置时覆盖会话专属词汇。
- **安全类别放行**——`bash`、`write`、`edit` 请求由各自的审批策略筛查，绝不由理由模式筛查。
- **重定向引用最近的用户指令**——没有先前用户消息的会话在不引用指令的情况下拒绝。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发者备注是维护者的工作上下文：尚未决定的开放问题与方向。它明确不具权威性——已交付的行为、边界与既定理由位于上文各节、包代码与所链接的 Agent Notes。

[approval-assessor 功能笔记](../../../.agents/notes/implemented/feature/2026-09-02-approval-assessor-work-avoidance-screen.zh.md) 记录了设计、安全类别放行的理由与 README 标题门禁冲突。

</details>

<a id="model-experience"></a>
## 模型体验

### 拒绝重定向消息

#### What the model sees

规避工作模式命中时，模型收到下述消息，作为一条署名 `plugin: approval-assessor` 的 `user/message`，其后引用用户最近的指令。工具模式与正常调用文本不变。

##### 拒绝重定向

```markdown
Approval denied: the request to approve "<toolName>" appears to be work-avoidance, not a legitimate safety gate. Do not ask for permission to skip, defer, or soften work the user already instructed you to do. Refer to the user's original instructions and proceed.

User instruction: <excerpt of the user's last instruction, capped at 500 chars>
```

#### Token effect

命中前 token 为零。每次拒绝追加一条保留历史的消息，其数据相关部分以 500 字符的指令摘录为上限。

#### KV Cache effect

仅追加；重定向在历史中位于被拒审批请求之后，不使既有 KV-cache 条目失效。
