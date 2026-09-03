# Agent Note：被丢弃的菜单分组，是用户永远看不到、客户端却永远重试的失败

Status: implemented

[English](2026-09-03-trigger-menu-failed-group-is-terminal.md) | 中文

## Problem

当宿主的 `commands/list` 返回应用级错误时，在 Web composer 中键入 `/` 得到的是一个只有分组标题、没有分组内容的菜单：DOM 中任何位置都没有错误，而一次按键会话发出了 118 次完全相同的失败请求。宿主的应答本身既精确又可操作：

```
POST /api/commands/list → 200
{"result":{"ok":false,"error":{"code":"internal","message":
"resume failed for session \"session-d5b2600d-…\": Error: agent-presets: preset \"meowbao\" failed to mount:
failed to import loader entry tool-bash (@deepseek-ai/dsh-tool-bash): Cannot find package '@deepseek-ai/dsh-tool-bash'"}}}
```

三个各自独立的缺陷把这条应答变成了一个空白菜单。

**这条消息无处可去。** `MenuState.groups[].status` 只有 `'pending' | 'ready'`——词汇表里既没有失败状态，也没有承载消息的字段。`menuReduce` 的 `source-failed` 分支直接**移除**分组，而 `InputTriggerController.fetchCandidates` 把拒绝丢进 `console.error`。确实存在的那个 `role="alert"` 分支位于 `ui-commands` 的 `PopupSelectView`，它属于另一个组件：那层外壳渲染的是已注册 contribution 的选项选择器（`/model`、`/permission`），目录列表失败根本不会打开它。`/` 路径上没有任何组件能渲染这个失败。

**移除分组让失败自我重复。** web profile 上跑着两个 `/` source。`command` 被移除、`skill` 又结算为空时，`allReadyEmpty` 成立，归约器自动关闭菜单。`InputTriggerController.track` 只在 `prev.open` 期间才把未变的 hit 当作空操作——于是菜单一旦关闭，之后每一次草稿或光标通知都会重新播种 roster 并重新拉取每个 source。composer 每次按键会发出多条这样的通知，每一条都要再花一次 `commands/list`。它们之间的瞬时状态是两个 pending 分组，这正是用户看到的「有标题、无内容」的菜单：渲染从未安定，因为管线一直在把它重启。

**两个瞬时状态都没有可访问文本。** pending 块只是在包着两根装饰性骨架条的 `role="status"` 容器上挂了 `aria-label`，没有任何文本节点；失败状态则根本没有元素。对打开的菜单执行 `read_page`，返回的是没有 listbox、没有 option、没有 alert。

## Decision

source 的失败是菜单要保持的状态，而不是要丢掉的分组。

`MenuGroup` 成为三支的可辨识联合——`pending`、`ready`，以及携带 `error: string` 的 `failed`。`source-failed` 带上该消息并就地改写分组；分组保留它在 roster 中的席位与标题。新增的 `source-removed` 事件承接旧的静默丢弃语义，而它如今只有一个生产者：source 注销时由 `InputTriggerController.sourceRemoved` 抛出。把这两者混为一谈，正是让「preset 挂载不了」看起来像「插件没装」的原因。

failed 分组永远不是 `ready`，因此 `allReadyEmpty` 不成立，菜单靠它自己就保持打开。这就是循环修复的全部：打开的菜单让 `track` 对未变的 hit 短路，于是 118 次请求变成 1 次。拉取路径的其余部分没有改动，也没有加入任何防抖或延时——请求数下降是因为状态安定了。

`MenuView` 把 failed 分组渲染为 listbox 之外的 `role="alert"` 块（listbox 只能容纳 option），其中包含以该分组本地化名称代入的本地化 `error.title`、逐字的宿主消息，以及一个「重试」按钮。`retrySource` 是管线中唯一重复已放弃加载的路径：它经 `source-retry` 把某一个 failed 分组翻回 `pending`，并只重跑该 source，不触碰仍在飞行中的兄弟分组。它搭乘当前轮次的 `AbortController`，因此关闭菜单或再键入一个字符，都会像丢弃它所替代的那次拉取一样丢弃这次重试。

`CommandDirectory` 未作改动。它「cold 或 failed 即发起新拉取」的既有约定，正是让「重试」、新查询、`commands/change`、`agent-preset/selected` 与 `connection/reset` 全都能恢复，而无需在 seam 上再造一套重试词汇。

两个瞬时状态现在都带文本了。failed alert 的消息是可见内容。pending 块保留 `aria-label`，并额外加入一份视觉隐藏的同一字符串，因为读取文本节点的工具从装饰性条上的 `aria-label` 里读不到任何东西。

文案归 locale 所有：`slash.menu` 在 `zh` 与 `en` 中新增 `error.title` 与 `retry`。宿主消息不是文案——它是服务端自己的诊断信息，作为数据渲染在本地化框架旁边，这正是展示它的意义所在。

## Alternatives considered

**给候选拉取加防抖或限流。** 那只会掩盖请求数，菜单依旧空白，因为分组仍被移除、菜单仍会关闭。缺陷在于失败没有静止状态，而不在于请求来得太快。

**让 `CommandDirectory.ensureReady` 对 failed 键直接拒绝、不再重拉。** 这是更深一层的终态，能把失败目录压到每**会话**一次请求，而非每 hit 一次。之所以否决，是因为它会切断恢复路径：宿主恢复之后 `matchEnter` 仍将永远拒绝，而「重试」将不得不把一个 `retry` 标志穿过 `CandidateRequest` 与每个 source，去击穿它刚刚变成永久的缓存。菜单层的修复已经把循环限制在用户意图上，目录既有的失效事件仍是诚实的恢复信号。

**保留分组移除，把失败以 composer 通知形式呈现。** 通知通道属于输入状态机，它与菜单的生命周期无关，也无法承载一个知道「是哪个 source 失败」的「重试」。而且菜单仍会自动关闭，循环依然存在。

**改在 `PopupSelectView` 里展示失败。** 那层外壳本就有带重试按钮的错误条，缺陷报告也正是指向它的。但它是错误的组件：它在菜单已被关闭之后渲染某个已注册 contribution 的选项，而目录列表失败发生在任何 pick 之前。它的错误分支原地不动，继续服务于选项加载失败或 `onSelect` 失败。

**为已结算但无行的分组渲染显式的空行。** 菜单刻意对单个空分组不显示任何内容，并在所有分组皆空时关闭，以免用一个无可奉告的盒子挡住 composer。该行为未变；只是现在失败的兄弟分组会把菜单撑开在它周围。

## Consequences

失败的 `/` source 变得可见、安静且可恢复：分组说出自己的名字，展示宿主的消息，并提供一个「重试」。所报告会话的请求数从 118+ 降到 1，此后每按一次「重试」或改变一次查询再各加一次。

菜单不再在最后一个 source 失败时关闭。用户对着完全损坏的宿主键入 `/`，现在得到的是一个装着错误的盒子，而不是什么都没有——这正是本意，同时对任何经常失败的 source 而言，这是一处可见的行为变化。

`MenuEvent` 增加了两个成员，`MenuState.groups` 变成联合类型。所有本就以 `status === 'ready'` 分派的读取方原样正确；唯一不正确的那处——`MenuView` 的 listbox 过滤，它列举的是要排除的状态而非想要的状态——本会把新状态渲染成 listbox 内一个有标题的空分组，现在改为直接要求 `ready`。

`packages/client/ui-commands/tests/menu-load-failure.client.spec.tsx` 以所报告的宿主应答钉住整条 seam：真实的 `CommandUiRuntime` source、真实的 `InputTriggerController`、真实的 `MenuView`，只有 Remote 与会话面是替身。它断言宿主消息抵达 alert、其后三十次草稿通知不发出任何请求、「重试」恰好发出一次并渲染恢复后的行，以及健康目录不受影响。回退归约器会让它六个用例中的五个失败；回退视图的 failed 分支会让其中四个加上五个视图用例失败；回退 `retrySource` 会让两个包中共五个用例失败。

source 分组的四种状态——加载中、空、错误、成功——在 `menu-view.client.spec.tsx` 中各有断言，`PopupSelectView` 外壳的同样四种在 `popup-view.client.spec.tsx` 中各有断言。失败菜单另有它自己的 axe 审计。
