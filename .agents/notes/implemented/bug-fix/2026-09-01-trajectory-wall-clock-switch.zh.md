# Agent Note: 用户够不到的轨迹计时开关

Status: implemented

[English](2026-09-01-trajectory-wall-clock-switch.md) | 中文

## 问题

`TrajectoryToolbar` 的实际时间开关自引入它的那次提交起就带着 `hidden` 属性，且没有任何地方记录原因。`onActualTimeChange` 是 `setActualTime` 的唯一调用方，而该开关又是唯一触发它的东西，因此 `actualTime` 在每个会话中都恒为 `false`。`TrajectoryView` 由 `actualDuration` × `actualTime` 这一对值推导 `timelineMode`，于是四种模式中的两种——`'actual'` 与 `'time'`——在产品里无法抵达。它们的实现一直是活的：`deriveTrajectoryTimeline` 处理 `'actual'`，`TrajectoryTimeline` 依据 `'time'` 为 `[data-equal-duration]` 设样式，还有一个单元测试直接执行 `'actual'`。工具栏也为一个用户看不见的控件保留着完整的 `.control`、`.controlTrack`、`.controlThumb` 样式，`toolbar.actualTime` 文案则在两份词典里都已翻译好。

## 决策

该开关正常渲染。移除 `hidden` 就是全部改动：控件、处理器、样式、文案以及两种时间轴模式本来就都存在，且未作改动。一个视图层测试渲染 `TrajectoryView`，按 role 找到该开关，并断言点击会翻转 `aria-checked`，于是从控件到 `timelineMode` 所读状态的这条路径是被覆盖的，而不是被假定的。

## 考虑过的替代方案

**删除该开关以及它选择的两种模式。** 死控件确实是债务，当一个半成品功能没有任何消费者时，删除才是正确答案。这一个并非半成品：模式推导、时间轴样式与双语文案都已完整，删掉它们等于为了收拾一个属性而放弃可用的行为。

**保持隐藏并记录原因。** 没有原因可记录。该属性早于任何 Agent Note，没有测试覆盖该控件，而它所驱动的 props 被文档描述为一项面向用户的选择：完整的墙钟计时还是压缩空闲后的计时。

## 后果

`snapshots/web/navigation-panes/trajectory.expected.md` 会新增该开关，因为 `hidden` 此前把它挡在了 golden 所捕获的无障碍树之外。该文件通过 `bun run test:web:refresh` 重新录制，这需要真实服务器；`bun run test` 与 `bun run test:gui` 不受影响。
