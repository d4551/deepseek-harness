# Agent Note: axe over every exported client primitive

Status: implemented

[English](2026-08-29-client-accessibility-lane.md) | 中文

## Problem

没有任何东西度量本仓库交付的 UI 在没有视力或没有鼠标的情况下是否可用。client 通道会渲染组件并断言其标记，因此一个只包含 chevron（折叠箭头）的按钮，或一个让应用变为 inert（惰性）却不说明自身是什么的浮层，都能通过仓库当时的每一项检查。这类无障碍缺陷对快照测试与行为测试不可见：DOM 正是组件想要产出的样子。

## Decision

[`dsh-client-a11y`](../../../../packages/test-support/client-a11y/README.zh.md) 对套件已渲染出的 DOM 运行 axe-core，而 `packages/client/ui-primitives/tests/accessibility.client.spec.tsx` 用它检验 primitives 包的每一个导出组件。该通道在 `bun run test` 内运行，因此存在于每一个运行单元层级的聚合中。

- **规则集固定在 harness 内**，而非按调用传入：WCAG 2.0 与 2.1 的 A、AA 级加 axe 的最佳实践标签。套件无法收窄衡量自身的标准，并且有一个单元测试钉住该清单。
- **受审集合由包的导出推导得出**，套件断言受审名称等于导出名称。新组件或新图标在交付的那一刻即被审计，而不是等到有人想起把它加进清单。React `memo` 包装也算组件，否则被 memo 包裹的导出会从名称检查中溜走。
- **各 surface（受审面）在 `main` landmark 内渲染。** 页面结构类规则无法由漂浮在空 `body` 中的组件满足；没有该 landmark，审计会把脚手架缺少页面框架报告成每个组件的缺陷。
- **下限等于已记录分数。** 每一项已判定检查都通过，因此下限为 100，任何一项检查失败都会让运行失败。低于记录值的下限会恰好允许那么多回归落地，却仍读起来像一条下限。
- **未判定检查被排除在分数之外，且哪些规则未判定会被断言。** jsdom 不计算布局，因此 `color-contrast` 什么也判定不了；套件断言未判定集合恰好只有该规则，否则某条新变为不可判定的规则会让数字保持不变而不是失败。
- **每个 surface（受审面）必须至少判定一项检查。** 什么也没判定的 surface 会白得 100 分，没有这条断言，聚合分数就不携带任何「确实检查过」的证据。

## Why a separate package

axe-core 在加载时会触碰 jsdom 的全局对象。经由 [`dsh-client-test-runtime`](../../../../packages/test-support/client-runtime/README.zh.md) 引入它，会让它出现在每个 client spec 之前并改变无关测试的布局测量——两个 `ui-chat` 的滚动锚定测试在其被测对象毫无改动的情况下开始失败。因此该 harness 独立成包，只有无障碍套件依赖它。

## What the audit found

两个真实缺陷，都被修复而非将就：

- `DisclosureRow` 的切换按钮只包含一个 chevron，辅助技术因此播报出一个无名控件。现在由该行自身的标题为它命名。
- `OnboardingSurface` 覆盖整个应用并把根节点设为 `inert`，却以装饰性元素的身份呈现。它现在是带 `aria-modal` 与必填 `label` 的 `dialog`；该 prop 是破坏性 API 变更，而该组件目前没有产品调用方。

## Alternatives considered

**在既有 client spec 中加入 axe 断言。** 每个功能套件本就以正确的上下文渲染其被测对象，因此用更少的新代码即可获得更广的覆盖。但这会把 axe-core 放到每个 client spec 之前——正是迫使拆包的那个故障——并且会让受审集合退化为「每个套件恰好渲染了什么」，也就是推导式集合所要避免的清单过期问题。

**改在浏览器通道中审计，而非 jsdom。** Chromium 能判定 jsdom 无法判定的颜色对比度，因此该通道将完全没有未判定桶。但它每次运行都需要已构建的前端，并把变动最频繁的断言放进最慢的通道。jsdom 通道以低成本拿到结构类规则；对比度仍由浏览器通道负责证明。

**只统计违规、不做聚合分数。** 真正起门禁作用的是零违规断言，因此分数并未给套件增加必须满足的条件。保留它是因为它是读者会索要的数字，而把它钉在已记录值上，正是防止它沦为装饰的办法。

## Consequences

每一个导出的 primitive 在每次单元运行中都接受 WCAG A 与 AA 检验：97 个 surface（受审面）、1138 项已判定检查、零失败，且 `color-contrast` 是 jsdom 唯一无法判定的规则。新 primitive 无法在未受审的情况下交付，回归会让运行失败，而不是拉低一个平均值。

该通道覆盖 `ui-primitives`、`ui-attachment`、`ui-user-questions`、`ui-goal`、`ui-workspace`、`ui-tool`、`ui-chat`、`ui-trajectory`、`ui-settings-general` 与 `ui-conversation`。前者审计包所导出的内容；后者无法如此，因为它导出的是插件、其组件在内部组合，因此其 surface 以用户实际遇到的状态挂载——持有待发送图片的 rail、拖放浮层、灯箱，以及一张消息图片。第三个是用户在时间压力下作答的表单，它在已经渲染该 surface 的套件内部受审，而非另起一个文件——因为正是那套 setup 让该 surface 成其为真实形态。它们遵守同一条下限。

**每个 surface 都在 ARIA 要求于它的结构内部受审。** 会话行是 `treeitem`，必须位于 `tree` 之内；产品的 browser 提供了该容器，因此单独审计该行会针对一个并不存在的缺陷报出 `aria-required-parent`。审计挂载的正是产品所挂载的容器。改为压制该规则，则会把「该容器确实缺失」的情形一并藏起来。

**未判定集合按 surface 分别记录，而非假定。** primitives 通道因 jsdom 不计算布局而留下 `color-contrast` 未判定；但一个没有给 axe 任何「文字压背景」组合的 surface，则不会留下任何未判定项——context meter 断言的是空集合。每条通道都断言自己实测到的内容，从而让新出现的不可判定规则在某处失败，而不是悄悄退出分数。

**审计读取的是整个文档，因此它只审计自己挂载的内容。** 未设置 `afterEach` 清理的套件会把先前的树留在 body 中，而那些不在 landmark 内的残留并非该 surface 的缺陷。approval-command 的审计在挂载前先清理它们，而不是为它们触发的 `region` 规则开脱。

其余组合而成的界面——chat、settings、workspace——仍未受审。每一个都需要其功能套件的上下文才能渲染，这正是本记录留待完成的工作，而它占了 client 的大部分：`packages/client/` 下的 37 个包中，今天受审的是十个。
