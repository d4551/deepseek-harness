# Agent Note: 点击目标下限识别单位、合并选择器与靠内边距撑起的盒子

Status: implemented

[English](2026-09-06-hit-target-units-merge-and-padding.md) | 中文

## Problem

[`scanUiSsot`](../../../../scripts/client-ui-ssot.ts) 中的 WCAG 2.5.8 检查报告语料为空，而实际上有十七个作者编写的指针目标以小于 24 CSS 像素的尺寸交付。三种不同的读法让它们通过了。

尺寸按 `(\d+)px` 匹配，因此 `rem` 不可见。`model-selection-card.module.css` 在同一条规则中用 `width: 2.25rem; height: 1.25rem` 加 `cursor: pointer` 定义其开关——一个 36×20 的控件，正是该检查为之编写的情形，却凭单位通过了。

该检查一次只读一条规则，因此跨规则拆分的控件两半都不满足条件。`SubagentHeaderLineage.module.css` 在一条规则中把 `.disclosure, .disclosureSpace` 定为 14×18，在下一条规则中才给 `.disclosure` 加上 `cursor: pointer`；单独看任一条都不是问题。

该检查要求声明 `width`/`height`，而常见的按钮形态两者都不声明。有十四个控件完全由内边距、边框和行盒撑起——`.retry` 为 16px，`.button` 为 22px，`.pill` 为 22px——它们没有产生任何可比较的尺寸。

## Decision

尺寸解析 `px` 与 `rem`（含小数），`rem` 按 16px 的初始根字号计算——因为 `packages/client` 与 `apps/web` 下没有任何样式表设置根字号。`em` 不做换算：它相对元素自身继承的字号解析，而样式表扫描无从得知。

在检查运行前，各条声明先合并到它们所命中的复合选择器上，这样一条规则中的几何尺寸就能与另一条规则中的 `cursor: pointer` 在它们共同的元素上相遇。结尾的伪类会被剥离，因为 `:hover` 修饰的是同一个盒子。命名了用户代理伪元素的规则在合并前被丢弃，因此 `::-webkit-search-cancel-button` 的几何尺寸绝不会算到它所装饰的控件头上。

样式表从不设定尺寸的目标改为被界定下界而非跳过：`paddedHeightFloorPx` 把垂直内边距与边框宽度加到单个行盒上，其中行盒取声明的 `line-height`（绝对值或无单位倍数），否则取声明的 `font-size`。该下界只报告确实无法达到 24px 的盒子；任何它无法解析的部分——`var()`、百分比、`em`、缺失的 `font-size`——都会让它放弃界定，而不是把缺失部分当作零。

十七个控件全部提升到该下限：在布局模式可以自由更改处使用 `min-height: 24px` 配合 inline-flex 居中；在 `text-overflow: ellipsis` 需要保留原有布局处改用垂直内边距；对已声明几何尺寸的两条规则则直接改写尺寸。开关的轨道改为 36×24，滑块 20px，位移随之调整。

## Alternatives considered

**把 `em` 也按 16px 换算。** 否决：该值取决于继承的字号，算出的数字将不是页面实际使用的数字——既产生无人能据以行动的报告，也会在继承字号更大时漏报。

**报告每一个未声明显式尺寸的目标。** 否决：多数控件由其内边距正确撑起，一个对它们全都触发的检查什么也没说明。下界回答的是这一个能否达到 24px。

**实现 WCAG 2.5.8 的间距例外。** 否决，理由与当初替换按名字的选择器白名单时相同：该下限针对目标上声明的几何尺寸，而间距会让两个相邻的过小目标互相放行。

**跨文件合并。** 否决：CSS Module 的类名是文件局部的，跨文件合并会把在 DOM 中从不相遇的选择器连到一起。

## Consequences

以 `rem` 定义尺寸、跨兄弟规则定义尺寸，或仅由内边距撑起的控件，现在都会被测量。扫描无法界定的规则会被静默接受，因此内边距来自自定义属性的控件仍需声明 `min-height` 才能被覆盖——该检查陈述的是它能证明的下限，而非所有下限。调高或调低 24 这个数字，仍然是同时修改 `HIT_TARGET_MIN_PX` 与 [web-styling](../../../../docs/web-styling.zh.md) 中那句话。
