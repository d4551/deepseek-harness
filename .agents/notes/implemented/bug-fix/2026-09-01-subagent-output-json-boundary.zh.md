# Agent Note: subagent 工具断言输出是 JSON，而不是去检查

Status: implemented

[English](2026-09-01-subagent-output-json-boundary.md) | 中文

## 问题

`subagent` 工具把自己的前台输出声明为 `{ type: 'array', items: { type: 'json' } }`，而 `settleForegroundRun` 用 `result.output as unknown as JsonValue[]` 来填充它。一次运行产出的是 `readonly ContentBlock[]`，`ContentBlock` 又派生自可合并扩展的 `ContentBlockMap`，因此插件可以贡献一种没有任何静态类型能保证可序列化的 block。那次双重断言把这种可能性洗掉了：没有任何检查，而声明的 item 类型宣称了一个类型系统给不出的保证。旁边的注释指向工具注册表才是真正的边界，这是事实——`snapshotToolValue` 会对非无损 JSON 的值抛出 `ToolOutputError`——但调用方依赖下游检查的方式不该是一次类型断言。

## 决策

`isJsonBlocks` 是一个建立在 `isJsonValue` 之上的类型谓词，因此这些 block 是通过运行时遍历而非断言收窄为 `JsonValue[]` 的，该路径上不再有任何 `as`。未通过遍历的输出会带着 run id 抛出，位置在注册表自身的非法输出失败之上一层，于是诊断信息指明是哪个 subagent 产生了该 block，而不只是哪个工具返回了它。所有核心 block 类型——text、reasoning、image、tool-call、tool-result——都是纯 JSON，因此没有任何已发布的 block 会触到这个新抛出；真会触到的值紧接着也会在注册表的快照处失败，所以这是一个更清晰的失败，而不是一个新增的失败。

脚本化 provider fixture 通过插件会使用的同一个 `ContentBlockMap` 合并贡献了一个 `scripted-unserializable` block，于是该检查是由一个真正有类型的 block 来执行的，而不是由一次伪造它的 cast。

## 考虑过的替代方案

**把载体声明为 `readonly ContentBlock[]`，交给注册表判断。** 工具自身声明的输出 schema 是一个 JSON item 数组，因此编译器会在工具定义处拒绝更宽的类型——固定这一点的是 schema，而不是载体。

**在此处用 `snapshotJsonValue` 做快照。** 它在校验之外还会分离拷贝，而注册表随后在每个前台结果上都会再做一次同样的拷贝。`isJsonValue` 遍历同一条边界，但不做这份拷贝。

**保留断言，依赖注册表。** 这正是此前那条注释的论点。它一直成立，直到某个插件 block 到达一个信任所声明的 `JsonValue[]` 的读取方——`outputValueText` 已经在逐字段结构性地重新检查而不是信任它，这等于把同一份怀疑写了两遍。

## 后果

非无损 JSON 的插件 block 现在会以一条指明该 run 的消息失败，而不是一个泛化的非法输出错误。`ContentBlockMap` 在 tool-subagent 测试程序内新增了一个仅测试用的条目；该 block 的存在就是为了被拒绝，没有任何生产路径会构造它。
