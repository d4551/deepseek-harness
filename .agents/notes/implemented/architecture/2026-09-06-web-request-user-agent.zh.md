# Agent Note: Web 请求发送单一的、由清单推导的 `User-Agent`

Status: implemented

[English](2026-09-06-web-request-user-agent.md) | 中文

## Problem

[强制的 `User-Agent` 归属标识](2026-06-21-mandatory-app-attribution-headers.zh.md)管辖 LLM 适配器边界，而 LLM 一侧从自身清单读取版本，因此该请求头不会与已发布的内容漂移。Web 能力两半都没有采纳。

有五个包各自重述了该请求头。`web-search-exa`、`web-search-perplexity` 与 `web-search-deepseek` 声明了 `const USER_AGENT = 'deepseek-harness/0.0.1'`，其中一个还带着"随包版本一起提升"的注释；`web-fetch-http` 导出的 `DEFAULT_USER_AGENT` 使用同一版本再加一个联系 URL，`web-fetch-playwright` 则导入了它。仓库交付的是 `0.1.2-alpha.1`，因此每一次对外的搜索与抓取请求都在告诉 Exa、Perplexity、DeepSeek 以及抓取提供方读取的每个站点：自己是一个很久以前发布的版本。没有任何东西能察觉：该字符串是五个文件中的字面量，也没有任何门禁把它与任何东西比较。

## Decision

`@deepseek-ai/dsh-web` 拥有该标识，因为它正是上述每个提供方都已依赖的能力包。`WEB_USER_AGENT` 是 `deepseek-harness/` 加上通过 `createRequire` 从该包自身清单读取的版本——与 [`dsh-llm` 的归属模块](../../../../packages/llm/llm/src/attribution.ts)相同的机制，理由也相同。`WEB_FETCH_USER_AGENT` 追加了爬取策略期望自动化客户端公布的联系 URL，也是两个抓取提供方为其可配置 `userAgent` 设定的默认值。

`DEFAULT_USER_AGENT` 被删除而非做成别名：发布前立场要求直接改名并更新每一处引用，而同一个值有第二个导出名，正是当初让两个抓取提供方与三个搜索提供方发生漂移的原因。

一个测试断言 `WEB_USER_AGENT` 等于清单中的版本且不是那个陈旧字面量，因此恢复硬编码字符串会失败。

## Alternatives considered

**保留各包各自的常量，另加一道比较它们的门禁。** 否决：五个字面量加一道门禁比一个常量更难维护，而且该门禁只会报告共享常量本就不可能发生的漂移。

**读取根清单的版本。** 否决：已发布的包陈述自己的版本，而根清单是私有的。LLM 一侧早已用同样方式解决了这一点。

**把该常量放进某个 `packages/util/*` 包。** 否决：该值是 Web 能力的线上标识，且每个消费方都已依赖 `dsh-web`，新增包只会多出一条依赖边而不减少任何一条。

## Consequences

新的 Web 提供方只要导入就能发送正确的 agent；发布版本变动时没有需要提升的版本号。该请求头现在写明的是真实的已发布版本，这会改变第三方服务日志中看到的内容。需要不同 agent 的提供方仍有其可配置的 `userAgent` 字段——该常量是默认值，而不是围栏。
