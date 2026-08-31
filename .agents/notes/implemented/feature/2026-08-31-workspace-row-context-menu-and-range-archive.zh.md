# Agent Note: Workspace row context menu and range archive

Status: implemented

[English](2026-08-31-workspace-row-context-menu-and-range-archive.md) | 中文

## 问题

侧边栏浏览区里每一个操作项都只有一条入口：一枚 16px 的 **...** 按钮，且仅在指针停留于该行时才出现。要执行 Rename、Fork 或 Archive，就得先悬停到正确的行、找到按钮、再点击它——而桌面列表普遍响应的右击在这里毫无反应。归档同样严格按行进行，因此清理一串已完成的 Session，每一个都要各付出一次悬停、一次按钮点击和一次菜单选择。

## 决策

两种行都会在行内任意位置响应右击，打开与 **...** 按钮相同的菜单。`packages/client/ui-workspace/src/client/rows/Rows.tsx` 中的 `useRowMenu` 为二者统一持有这份状态：它保存打开标志，以及右击打开菜单时的指针位置。它向 `Menu` 传入返回该指针处零尺寸 `DOMRect` 的 `getAnchorRect`，使菜单落在光标之下，而不是落在那枚只在悬停时显现的按钮处；从按钮打开时指针位置被丢弃，`Menu` 一如既往地测量自身包裹元素。没有操作项的行保留平台自带菜单：临时的空白 **New Session** 行根本不渲染尾部操作区，Ungrouped 分组头也没有对应的 Workspace。

Session 行带有范围选择，由 `packages/client/ui-workspace/src/client/selection.ts` 中的 `useRowSelection` 持有。分组树与扁平列表各自拥有一份选择，以各自按渲染顺序渲染出的行为键：分组账目串接每个展开分组渲染出的行，因此按住 Shift 点击更下方的行，会像操作者阅读列表那样跨越 Workspace 分组头完成选择。普通点击确定范围锚点并清空选择，然后打开该 Session；Shift 点击选中自锚点起的闭区间切片；Ctrl/Cmd 点击增删单行并重设锚点；Escape 通过 document 监听器撤销选择——因为这些行不可获得焦点，列表本身也没有键盘席位。成员关系在读取时对照已渲染的 id 重新核对，因此被归档、被折叠或被搜索过滤掉的行会自动离开选择，无需单独的核对流程。在选择之外的行上右击，会先把选择收窄到该行，这是平台通行规则。

选中两行及以上时，行菜单去掉 Rename、Fork 与 Archive 这三个针对单个 Session 的操作项，改为一行 **Archive N sessions**。提交它会为每个选中的 id 各调用一次 `archiveSession`，并立即清空选择，而不等待那个让行消失的归档集合回声。这里没有新增线上操作：`workspace.archiveSession` 接受单个 Session，注册表把写入串行化在同一条操作链后，且每次响应都携带完整的归档集合，因此无论调用以何种顺序落定，最后到达的回声都是正确的。选择属于临时视图状态，从不持久化；它随挂载的列表一同消亡，包括在分组与扁平两种呈现之间切换时。

选中的行带上 `css.multiSelected`——悬停填充加一条前导强调线，使一段连续选择读起来是一个整体，并与可能重叠的单个当前 Session 高亮区分开——并给出 `aria-selected`；两个列表容器都声明 `aria-multiselectable`。一处视觉隐藏的 `role="status"` 播报实时计数，因为填充是仅有的另一条通道。

## 备选方案

**新增批量 `archiveSessions` 线上操作。** 已否决：相对于 N 次调用的扇出，客户端并无所得。注册表本就把归档写入串行化在同一条链后，且每次响应都携带完整集合，因此批量调用换来的原子性没有任何界面依赖，代价却是在 Typert 图、两个 SDK 及其预期输出中新增一种请求类型。

**让范围也覆盖 Workspace 分组头。** 已否决：Workspace 没有归档操作，只有 Delete，因此被选中的分组头只能贡献它的会话——这等于凭空发明一个无人要求的"归档整个项目"手势，而折叠分组里被隐藏的行还会让其成员关系含混不清。计算范围时会跳过分组头；范围本身仍可跨越它们。

**在批量项之外保留逐行操作项。** 已否决：Rename 与 Fork 针对单个 Session，在选中三行时提供它们会让目标无从确定。加宽后的菜单只保留对集合有定义的那一个操作。

**为 `Menu` 增加一等的按点定位模式。** 已否决：现有的 `getAnchorRect` 出口已经表达了"对着这个矩形定位"，而指针处的零尺寸矩形正是如此。在这个基础组件里再加一种定位模式，只会有一个调用方。

**给搜索结果加上选择。** 已否决：结果列表是对查询的排序投影，而非具有稳定顺序的账目，且它的行点击即导航。

## 影响

右击可以够到每一个行操作项，无需悬停搜寻；清理一串已完成的 Session 变成一次点击、一次 Shift 点击和一次菜单选择，而不是 N 次悬停。批量归档会扇出 N 个请求，因此极大的范围会引发一阵 RPC 突发；目前没有任何上限，而每次拒绝都会记录与单行操作相同的非致命 `session archive rejected:` 诊断。Escape 现在会在文档任意位置清空实时选择，同一次按键也会关闭已打开的行菜单。

单元覆盖直接钉住 `rowRange` 与各项选择手势（`packages/client/ui-workspace/tests/selection.client.spec.tsx`），行为覆盖钉住指针定位、空白行与分组头的豁免、带修饰键的点击路由以及加宽后的菜单（`tests/rows.client.spec.tsx`），装配后的浏览器覆盖钉住跨分组的 Shift 范围归档两个 Session，以及扁平列表的 Ctrl 挑选与其 Escape 撤销（`tests/workspace-browser.client.spec.tsx`）。
