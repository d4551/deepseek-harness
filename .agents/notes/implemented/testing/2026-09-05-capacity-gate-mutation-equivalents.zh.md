# Agent Note: Capacity gate mutation equivalent

Status: implemented

[English](2026-09-05-capacity-gate-mutation-equivalents.md) | 中文

## Problem

变异测试可以改变容量等待者结算后的中止回调，而不改变真实 AbortSignal 可提供的行为。在闸门移除回调后直接调用捕获的回调，只会测量私有机制，而不是准入契约。

## Decision

capacity-gate 测试套件断言完全相同的关闭错误对象、授权与中止同时发生时只移交一次名额、取消中间等待者时不扰乱 FIFO 顺序，以及结算前后的中止监听器数量。真实 AbortController 与 Node getEventListeners 表明：等待者排队时有一个监听器，经发放或关闭后均为零。这些断言通过平台操作覆盖错误归属、单次名额结算、队列清理与监听器生命周期。

packages/util/capacity-gate/src/index.ts:174 的 ConditionalExpression 变异体 84 是唯一的等价存活项：它把中止回调中的 index < 0 守卫替换为 false。发放与关闭都会先同步移除回调，再结算等待者 promise。因此，结算前分派的中止会看到仍在队列中的等待者，而结算后分派的中止无法调用已移除的回调。发放名额后、调用方恢复前 signal 中止的另一种竞争由发放后的 signal 检查负责。

本记录细化仓库的[变异测试策略](2026-06-11-mutation-testing.zh.md)。测得的存活变异体继续显示在报告中；配置不排除操作符、代码行或文件。

## Alternatives considered

**直接调用已移除的回调。** 拒绝，因为该回调不是本包 API 的一部分，真实 AbortSignal 也无法在移除后分派它。

**排除等价变异体。** 拒绝，因为排除项可能隐藏相同行上后来出现的可观察缺陷；测量报告与本等价性证明保留这种区别。

## Consequences

聚焦的容量测试在 101 个变异体中记录 74 个被杀死、26 个超时、一个存活且没有未覆盖项。99.01% 的变异得分通过 99% 的中断阈值。该存活项保持可见以供审查，同时不排除其文件、代码行或变异器。
