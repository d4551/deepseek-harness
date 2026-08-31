# Agent Note: Cap the unit-lane vitest fork pool

Status: implemented

[English](2026-08-31-unit-lane-fork-pool-cap.md) | 中文

## Problem

单元测试 lane 使用不设上限的 fork 池。每个 worker 都是一个加载整个工作区图的完整 Node 进程，而在多核主机上 vitest 生成的 worker 超出了机器的承载能力：一台 18 核主机同时运行 23 个 worker 进程。那些自身还要生成进程的测试套件——持久 Bash 会话、经 stdio 通信的语言服务器、Lefthook 安装器的真实 git 调用、Claude Code hook 子进程——在争用中落败，因此它们会超时或被杀，而单独运行时全部通过。其他每条 lane 都已限制自己的 worker 数量。

## Decision

`vitest.config.ts` 在根 lane 与两个 project 上，通过 `maxWorkers` 将（Vitest 4 已移除 `poolOptions`，其键会被忽略） fork 池限制为 `Math.max(2, Math.min(availableParallelism(), 8))`。小型主机与 CI runner 实际上不受限制，只有大型主机才会绑定。这与同级 lane 已有的做法一致：预期输出 lane 限制为五个 worker，覆盖率分区以单 worker 运行，`run-gates.ts` 自行计算上限。

## Alternatives considered

**为每个失败的套件提高单测超时。** 作为本问题的处理方式已否决：这些超时是主机被饿死的症状，因此换一台机器后上限还得再提，而且套件会失去真正的挂起检测能力。若某个测试自身的工作确实超过 lane 预算，它仍然应当拥有自己的超时。

**只限制 process-bound project。** 已否决，因为压力来自两条 lane 的总和；正是普通 lane 的 worker 让 process-bound 的那些拿不到 CPU。

**交给 CI 判定。** 已否决，因为本地套件是贡献者推送前运行的 gate，而一个因机器规模而失败的套件不构成任何人可据以行动的信号。

## Consequences

单元 lane 最多运行八个 worker，因此大型主机不会比八核主机更快完成；这是让结果不依赖机器所付出的代价。生成进程的套件重新获得争用余量。只要另一个进程仍在改动同一个工作树，本地运行依然不可靠——并发的 `git checkout` 会使断言分支与远端关系的套件失效，而这一点无法靠调整池大小解决。
