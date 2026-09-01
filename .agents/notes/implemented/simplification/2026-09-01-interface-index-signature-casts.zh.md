# Agent Note: 因目标是 interface 而存在的类型断言

Status: implemented

[English](2026-09-01-interface-index-signature-casts.md) | 中文

## 问题

读取已解码记录的代码——SQLite 行、MCP 内容块、LSP 线上对象——惯常以 `value as unknown as RowType` 收尾。那个 `unknown` 中转并不是对值本身偷懒，而是 TypeScript 直接拒绝该转换：`interface` 没有隐式索引签名，因此与 `Record<string, unknown>`、`Record<string, SQLOutputValue>` 或 `{ [key: string]: JsonValue }` 都不重叠。每位作者都撞上同一堵编译器墙，写下同一种逃逸，而这又顺带掩盖了究竟有没有人检查过这个值。在 `lsp-stdio` 里，两个完整的结构检查早已存在却只返回 `boolean`，于是它们旁边的断言看起来像是无人做过的校验。

## 决策

当目标类型声明在同一个包内时，改用 `type` 别名而非 `interface`，从而带上该转换所需的隐式索引签名。这让每处要么不再需要断言，要么只剩一次收窄：

`session-query-sqlite` 的行类型改为别名，因此四处 `.all() as unknown as Row[]` 各自变为一次 `as`，并只记录一次理由：`SELECT` 列出的正是该行类型所声明的列，而这些列所属的 schema 由该模块在单调的 `SCHEMA_VERSION` 下拥有。

`lsp-stdio` 的 `isLocationLink` 与 `isLocation` 改为声明 `value is WireLocationLink` / `value is WireLocation` 而非 `boolean`，于是它们旁边的两处断言消失了，而本就在运行的检查现在真正参与收窄。

`core/tools` 的 `JsonSchemaNode` 是其中最大的一例：作为别名它直接满足 `Record<string, unknown>`，因此 `defineTool` 无需任何转换即可传递其编译后的 parameters；随后编译器证明 `ts-types` 与工具 schema 测试中另有二十一处断言是多余的——oxlint 的 `no-unnecessary-type-assertion` 逐一点名。改动声明关键字每次都会牵动 `docs/subsystems/tools.md` 与 `docs/subsystems/persistence.md` 中的 `type-equiv` 区块，以及一处生成的目录条目，因为三者都逐字记录该声明。因此这类转换从来不只是源码改动：`verify-type-equiv` 与 `gen-cordis-api --check` 都必须运行。

`core/session` 的 `SessionHeader` 是同一堵墙出现在持久化边界上：`validateSessionHeader` 逐字段手工检查，随后却不得不把记录洗回去，因为它所证明的类型无法与它所持有的记录重叠。改为别名后，返回值陈述的正是这些检查已经证明的东西，且只需一次收窄而非两次。

`mcp-client` 用 `toMcpContentBlock` 取代了它的两处断言，该函数只保留远端服务器声明为字符串的字段。以数字形式到达的 `data` 在此处即为缺失，因此图像分支会报告 `the image data is not canonical base64`，而不是把一个数字从字符串座位上读出去。

## 考虑过的替代方案

**给每个 interface 加索引签名。** 那会让任意无关键名进入一个以精确字段集为要旨的类型，并削弱每一处构造点的多余属性检查。

**在每个读取点校验每个字段。** `mcp-client` 正是这么做的，因为它的输入是远端服务器的载荷。`session-query-sqlite` 没有这么做，因为行形状由三行之上写就的 `SELECT` 固定，其 schema 由同一模块拥有；在那里做逐行校验，是为一个别处代码无法改变的形状给热点搜索路径定价。

**保留中转并写明理由。** 对于 TypeScript 证明不可能的转换——Zod `discriminatedUnion` 的成员形状——这是对的；在这里则是错的，因为这堵墙来自声明风格，而非类型之间真的不一致。

## 后果

仓库中二十三处 `as unknown as` 连同二十一处多余的单次断言已消失，这些文件里留下的都写明了原因。此后撞上这堵编译器墙的读者，拿到的是一个能去掉断言的修法，而不是再写一个断言的先例。
