# Agent Note：机密脱敏要么映射节点，要么移除子树

Status: implemented

[English](2026-09-01-redaction-maps-or-removes.md) | 中文

## Problem

`redactSecrets` 会在 settings 值穿过 Host API 之前剥离 `role('secret')` 字段。它只遍历 `object`、`dict` 与 `array`，其余每一种节点类别都从 `default` 分支原样返回。schemastery 共解析十七种类别，因此 `tuple`、`union`、`intersect`、`transform`、`lazy` 以及任何经 `Schema.extend` 注册的类型都落到了那个分支。

结果是在最要紧的位置上 fail-open。声明在上述任一类别之下的 `role('secret')` 会随值一并返回，而 `secrets` 边录不记录任何东西，因此响应与记录都不会显示有机密被漏掉。该分支上的 `TODO(settings-wire-redaction)` 标记点出了这个缺口，[配置面边界笔记](2026-07-30-config-plane-boundaries.zh.md)与[插件自有 settings 表面笔记](2026-08-12-plugin-owned-settings-surface.zh.md)都把它带了下来——后者还指出，服务每一个已注册的 namespace 会把影响面从本仓库审计过的 schema 扩大到任意第三方 schema。

没有任何已发布的 schema 泄漏。本仓库恰好只声明了一处机密，即 `dsh-web-search-deepseek` 中直接位于 object 之下的 `apiKey`；`dsh-llm-pi-ai` 注册的 namespace 有十四处 union 与 transform，但每一处都是 const 枚举。缺陷在于：没有任何东西拦得住下一个。

## Decision

**一种节点类别要么被逐位置映射到值上，要么其子树被移除。** 没有第三种答案，也没有任何分支会返回它未曾遍历过的值。

`tuple`、`union` 与 `intersect` 属于可映射。tuple 按下标遍历其 `list`。union 与 intersect 同其成员描述同一个位置，因此剥离按声明顺序折叠成员：每一轮移除该成员声明的机密，并携带它未描述的键，因为 object 遍历本就保留其属性表之外的键。在与值不匹配的成员上折叠 union 会贡献它们未置位的 object 槽位，这属于对某个位置的多报，而不是漏掉某个位置未移除——对于消费方要渲染只写输入的边录来说，这是安全的方向。

`transform`、`lazy` 与 `Schema.extend` 类别无法映射。transform 的 `inner` 复述的是它的**输入**，而存储的值是变换后的结果；lazy 只在校验期间解析其成员；扩展类型命名的关系不在本结构视图的建模范围内。对这些类别，遍历器只问一个问题——该节点之下的任何位置是否声明了机密——并由 `declaresSecret` 作答：一次跨 `inner`、`dict` 与 `list` 的探查，以 `WeakSet` 护卫，使自引用 schema 能够终止。其下没有机密，即该值可被证明安全并原样通过；其下有机密，则整棵子树被移除并记录其根。


## Alternatives considered

**在不可映射节点上抛错。** 仓库的 fail-loud 规则指向这里，先前的笔记也把答案表述为一个拒绝自己无法证明安全的 schema 的 `describeForWire()`。在本层被否决：`redactSecrets` 由 `describe({ redactSecrets: true })` 调用，而后者一次性构建每个 namespace 的列表，因此一个无法证明的 schema 会让整个 settings 页面塌掉，而不只是它自己那一行。移除子树是在真正无法证明的那个位置上 fail-closed，并把拒绝留给能够将其收敛到单个 namespace 的协议层。

**无条件剥离每一个不可映射节点。** 更简单，也确实 fail-closed，但 `z.union([z.string(), z.number()])` 十分寻常且不含机密；为保护一个并不存在的机密而清空每个这样的字段，会删掉配置表面的大部分内容。`declaresSecret` 探查以一次结构扫描的代价买到同样的保证。

**保留标记并记录该风险。** 这正是先前的状态。它以散文强制“机密不可置于 union 之下”，而没有任何门禁校验这一点。

## Consequences

- 声明在 `tuple`、`union` 或 `intersect` 之下的机密，现在会像其他机密一样被移除并记录；声明在 `transform`、`lazy` 或扩展类型之下的机密，会移除该子树。
- `secrets` 边录现在可能命名一个容器根而非叶子，这与既有的“带 secret 角色的容器视作单个不透明机密叶子”行为一致。
- union 可能报出由与值不匹配的成员贡献的未置位机密槽位。表单会为该值可能持有的槽位渲染一个只写输入。
- `redactSecrets` 保持其签名不变，因此 `describe`、settings 控制器与 api-catalog 声明均未改动。
- 同一区域另有两处缺口保持开放，并继续记录在该包的 Known Limitations 中：`schema.toJSON()` 会带出 secret 字段的 `.default(...)`，写入被拒时返回的 schema 文本可能引用提交的值。两者都位于序列化封装而非值之中。

## Testing

`packages/settings/settings/tests/redact.spec.ts` 针对真实 schemastery schema 覆盖每一种可映射类别——按下标剥离且尾部成员交由其自身 schema 处理的 tuple、被移除的 union 成员机密、被原样携带的无机密 union、被剥离贡献而兄弟成员存活的 intersect——并对每一种不可映射类别覆盖两个方向：整体移除的含机密 transform，与原样通过的纯字符串 transform。结构化夹具覆盖自引用节点、机密位于 `list` 与 `dict` 中无机密兄弟之后的扩展节点，以及 `union` 与 `tuple` 的成员列表缺失路径。该文件保持逐文件 100% 的语句、分支、函数与行覆盖。
