# Agent Note: Classify pi-ai failures on the leading HTTP status

Status: implemented

[English](2026-08-31-pi-ai-status-prefixed-failure-classification.md) | 中文

## Problem

pi-ai 会把 provider 故障压平成一个字符串，因此 `dsh-llm-pi-ai` 通过扫描该文本恢复稳定 code。扫描先对整个字符串执行 `/\b(?:401|403)\b/`，而该字符串是状态码后面跟着 provider 的完整响应体。某网关以 `502` 返回一个 HTML 等待页面，其 logo 以内联 SVG 嵌入，这些路径坐标中含有 `403`（`… 121.52 403.66 117.89 …`），于是该页面被判定为 `AUTH`。`AUTH` 不在默认可重试集合内，因此一次瞬时上游故障立刻结束该轮次，并报告一个运维人员无从处理的认证失败：密钥本身没有问题。

## Decision

文本以 provider HTTP 状态码开头的故障——无论是裸写（`502 <body>`）还是带标签（`HTTP 401: …`）——仅依据该状态码分类。`401` 与 `403` 为 `AUTH`；`5xx` 为 `SERVER`，完全不读取响应体；限流拒绝是唯一仍需查看响应体的状态码，因为 `429` 既可能表示配额耗尽也可能表示普通限流；`400` 与 `413` 为 `INVALID_REQUEST`；其他状态码为 `PI_AI_ERROR`。不带前导状态码的文本继续走既有词法规则，那是传输截断、socket 断开与超时的唯一信号，而这些都不会带状态码。

上下文窗口溢出不受影响：`mapStopReason` 在分类之前就已从 pi-ai 的 usage 与消息中识别它。

## Alternatives considered

**调整词法规则顺序，让 `5xx` 优先于 `401|403`。** 已否决，因为那只修好观察到的这一个页面。任何响应体数字仍可能被读成状态码：同一段 HTML 的 CSS 长度也匹配 `\b400\b` 与 `\b413\b`，于是 502 会变成 `INVALID_REQUEST`。

**扫描前剥离 HTML。** 已否决，因为响应体并不总是 HTML——JSON 载荷中的 id 与 token 数会以同样方式被扫描到——而且这会给一条本就已知状态码的路径再加一个解析器。

**只匹配字符串开头的裸状态码，不支持 `HTTP` 标签形式。** 已否决，因为 pi-ai 的各 provider 两种写法都会产生，而带标签的形式正是既有测试所固定的。

**把所有未识别状态码都当作 `SERVER` 以便重试。** 已否决，因为重试 `404` 模型名或 `402` 计费拒绝只是在重复一个不可能成功的请求；`PI_AI_ERROR` 让它们保持终止。

## Consequences

网关或上游 5xx 现在会按默认策略重试并报告为服务器故障，等待上游的页面不再读作凭据被拒。由前导状态码得出的 code 不再依赖响应体内容，这消除了一整类意外匹配。仅在 JSON 响应体内报告状态码、没有前导状态码的 provider 仍会走词法规则，分类与此前一致。
