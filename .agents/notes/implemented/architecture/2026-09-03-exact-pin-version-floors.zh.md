# Agent Note: 精确版本锁定没有下限，其中四项无人察觉地陈旧了

Status: implemented

[English](2026-09-03-exact-pin-version-floors.md) | 中文

## Problem

`scripts/live-stack-floors.ts` 按依赖逐项为根 manifest（元数据清单）设定下限，这套下限按构造即完备：manifest 声明了下限映射中没有的条目时，`unflooredRootDependencies` 失败，因此新增一个依赖就必须写出它永不得低于的版本。工作区各包的 manifest 没有对等机制。一个包锁定成什么版本，就一直停在什么版本。

其中四项已经陈旧，最严重的三项是 harness 以子进程方式驱动的第三方*产品*：它们在协议格式（wire format）上的行为会随发布版本变化，而它们的测试 fixture（测试前置数据）是对该行为的手写 mock：

| 包 | 锁定版本 | 当前发布版本 |
| --- | --- | --- |
| `@openai/codex` | 0.149.1 | 0.153.0 |
| `@anthropic-ai/claude-agent-sdk` | 0.3.241 | 0.3.259 |
| `@anthropic-ai/sdk` | 0.93.0 | 0.123.0 |
| `e2b` | 2.29.1 | 2.46.1 |

`@anthropic-ai/sdk` 落后了三十个次版本。仓库里没有任何东西能报出这一点，因为没有任何东西去看。

## Decision

门禁现在治理整个工作区的精确锁定。精确锁定是那种无法自行向上漂移的具体范围——caret 范围会跟随次版本，而 `"0.149.1"` 在有人改动之前一直停留在 0.149.1——因此精确锁定正是一整套技术栈会悄然陈旧的地方，也是本项检查唯一主张覆盖的范围形式。

`PINNED_PRODUCT_FLOORS` 逐项写出各自的下限，`PIN_FLOORS` 再把它与 `ROOT_DEPENDENCY_FLOORS` 组合起来，于是工作区 manifest 锁定某个根依赖族的成员时会被约束到同一个数字，无需重复书写。`unflooredPinnedDependencies` 像根映射本来那样保持映射完备：新锁定一项，门禁就要求写出它的下限。

`website/` 被排除在外。它是一份 VitePress 投影，依赖集合就是 VitePress 自己的依赖集合，其中包含 VitePress 锁定的 Vite 5，而仓库的 Vite 8 下限本会拒绝它。既有的 spec 已经为 Vite 携带了这条例外；这项排除把它写一次，而不是逐包重复。

## Alternatives considered

**治理所有范围，而不只是精确锁定。** caret 范围本就在其主版本内跟随上游，因此为它设下限只是在主版本到来之前复述该范围已经说明的内容——为了抓住少数被主版本甩在后面的依赖，却给每个依赖都加上噪声。陈旧的证据实际出现的位置就是精确锁定。

**把这些产品的锁定改成 caret 范围。** 那会让它们自行漂移，而漂移在这里恰恰是错的：这些产品各自由一份手写的协议格式 fixture 来 mock，因此版本在 fixture 底下移动，正是 `subagent-codex` 失败的成因。锁定是对的；没有下限的锁定不对。

**在门禁运行时从注册表读取当前发布版本。** 门禁将因此需要网络访问，会在坏日子与好日子给出不同的失败，并把每一次上游发布都变成一次红色构建。写明的下限是一项带日期的、经过评审的决定。

## Consequences

下限门禁在这四项陈旧锁定上失败，并逐一指出各自声明的范围。新增精确锁定时必须写出它永不得低于的版本，而 `website/` 那套由 VitePress 拥有的技术栈在一处被豁免，并附上理由。
