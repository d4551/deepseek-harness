---
description: "循环卫生 guard 家族的包映射：建议性重复工具提醒、单次工具调用超时策略、审批理由的回避工作筛查，以及可选启用的对抗式审批评审者，供选择或组合 guard 的用户与维护者阅读。"
kind: "package-group"
---

# guard/：循环卫生 guard 家族

[English](README.md) | 中文

## 概述

`guard/` 组通过监视工具调用与审批关口的常见失败模式来保持 agent loop（智能体循环）高效。`repeat-tool-reminder` 会在模型重复完全相同的工具调用时提醒它改变方法或结束任务，让卡住的循环不再浪费时间和 token。`timeout-policy` 为声明了限时的工具调用设置时间上限，让挂起的调用向模型返回清晰的超时错误，而不是拖住整个会话。`approval-assessor` 筛查审批请求的理由文本，拒绝那些主张放弃用户已指示工作的请求，并把用户最近一条指示回引给模型。`approval-adversary` 在用户开启后更进一步：由模型评审者代替人工提示决定其余每个审批请求，并假定智能体正在规避或越出指令。前三者随 `dsh` base 组合默认启用，评审者随组合挂载但默认关闭；组合可以调优或移除它们，两个审批 guard 都接受插件设置页的调整。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

四个小插件分别覆盖这些模式；下文每个 README 都说明何时保留、调优或移除它。

| 包 | 提供什么 |
|---|---|
| [`repeat-tool-reminder/`](repeat-tool-reminder/README.zh.md) | 在模型重复相同工具调用时提醒它，使其改变方法或结束任务 |
| [`timeout-policy/`](timeout-policy/README.zh.md) | 为声明了限时的工具调用设置超时，让模型得到清晰错误而不是无限等待 |
| [`approval-assessor/`](approval-assessor/README.zh.md) | 拒绝理由主张跳过已指示工作的审批请求，并把模型引回该指示 |
| [`approval-adversary/`](approval-adversary/README.zh.md) | 用户启用后，以对抗式模型评审代替人工提示决定审批请求 |

-----

<a id="related-documentation"></a>
## 相关文档

先从工具子系统参考了解工具调用流水线，再看重复提醒的配置、策略背后的超时库决策、两个审批 guard 所依附的审批子系统参考，以及对抗式评审者背后的决策。

- [工具子系统参考](../../docs/subsystems/tools.zh.md)——这些 guard 都依赖的工具调用流水线与决策。
- [生成配置目录](../../docs/config-catalog.zh.md#deepseek-aidsh-repeat-tool-reminder)——重复调用提醒的每个受支持字段。
- [超时截止时间库 Agent Note](../../.agents/notes/implemented/architecture/2026-07-06-timeout-deadline-library.zh.md)——`timeout-policy` 所执行的时序／终止拆分。
- [用户审批子系统参考](../../docs/subsystems/approval.zh.md)——两个审批 guard 所处的应答者 waterfall 与审计事件对。
- [对抗式审批评审者 Agent Note](../../.agents/notes/implemented/feature/2026-09-05-approval-adversary-model-reviewer.zh.md)——为何模型评审者仅作为可选项代替人工提示，以及它放弃了什么。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
