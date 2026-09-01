# Agent Note: 断言而非产出其解析类型的 Zod schema

Status: implemented

[English](2026-09-01-zod-schema-type-casts.md) | 中文

## 问题

八个手写 Zod schema 以 `as unknown as z.ZodType<T>` 收尾。这种双重断言掩盖了推导类型与声明类型为何不一致，而每一处的原因其实各不相同：一处是从未告知 Zod 的 readonly 声明；一处是 Zod 无法表达的 `exactOptionalPropertyTypes` 差异；一处是 schema 仅按普通字符串校验的品牌化 id；还有一处是其成员形状与解析后信封确实不重叠的 `discriminatedUnion`。合起来看它们像同一个习惯；拆开看，其中四处可以去掉，还有一处掩盖着一个未被强制的品牌。

## 决策

`.readonly()` 声明了这些投影类型所声明的 readonly 那一半，而这正是 `packages/typert/generator/src/schema-emitter.ts` 为 readonly 类型已经产出的形式——手写 schema 与生成器发生了偏离。仅此一项就清理了 `list.ts`、`spec.ts` 以及 `model-selection-projection.ts` 中三个 schema 里的两个。

`rpcIdSchema` 现为 `z.string().transform(RpcId)`，因此解析 Connection RPC 信封时会真正*产出*品牌化的关联 id，而不是断言一个未品牌化的字符串就是它。`RpcId` 在运行时是恒等函数，因此没有任何线上行为改变；改变的是品牌在值进入之处即被建立。

其余四处断言各自在原地记录了理由。`model-selection-projection.ts` 保留一处单次 `as`，因为 Zod 推导出 `reasoningEffort?: string | undefined`，而 `exactOptionalPropertyTypes` 不接受它对应 `reasoningEffort?: string`，且没有可写的精确可选形式。`rpc-schema.ts` 与 `subagent/projection.ts` 保留 `unknown` 中转，因为 `discriminatedUnion` 报告的是原始成员形状，TypeScript 证明它与解析后信封并不重叠（TS2352）。

## 考虑过的替代方案

**把声明类型放宽为 `?: string | undefined`。** 这能让 schema 匹配上，代价是把一个显式 undefined 的字段放进已发布的线上类型，而 `exactOptionalPropertyTypes` 的存在正是为了挡住它。

**用 `z.infer` 从 schema 反推接口。** 这会颠倒归属：`ModelSelection` 与 `RpcMessage` 是多个包依赖的线上词汇，而校验库的推导并不是该词汇应当存放的地方。

**重构这些可辨识联合，让成员携带解析后类型。** TypeScript 拒绝的那次转换发生在 Zod 自身的内部形状之间，而非值之间；为迁就某个库的泛型而重塑产品 schema，是用一处已记录的断言换来一个更差的 schema。

## 后果

四处断言已消失，留下的四处都写明了原因，读者因此能区分"无法表达"与"未经检视"。Connection RPC id 现在由它的解析过程品牌化，而不是由它下游的一次类型断言。
