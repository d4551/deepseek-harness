# Agent Note: 两张模型选择卡片背后的同一条路由契约

Status: implemented

[English](2026-09-01-model-selection-card-family.md) | 中文

## 问题

有两张客户端设置卡片编辑 provider/model 路由：subagent 允许列表与 Agent 默认模型。第二张落地时把第一张已有的东西全部重述了一遍——`{provider, model}` 接口、`${provider}\0${model}` 身份函数（第三处还内联拼出同一个字符串）、让已存储但目录不再公布的路由仍可移除的目录连接、`'idle' | 'loading' | 'ready' | 'error'` 请求状态、按 provider 分组的循环、候选行标记，以及加载/失败/部分结果提示。两侧还各自重述了各自 Host 包所拥有的设置节，于是已存储的字段集有了两个归属，可以在没有任何门禁察觉的情况下漂移。这些重复掩盖了一个缺陷：默认模型卡片注入了 `retryCatalog` 动作却从不渲染对应控件，目录请求失败的用户没有任何办法重新发起，失败文案反而让他们去改设置或改提供方。

## 决策

`packages/client/ui-settings-plugins/src/client/model-route.ts` 拥有 `ModelRoute`、`ModelRouteCandidate`、`ModelRouteGroup`、`ModelCatalogStatus`、`modelRouteKey`、`modelRouteCandidates` 与 `groupModelRouteCandidates`。`ModelRouteChoices.tsx` 为两张卡片渲染同一个 fieldset，并把选择元数作为可辨识联合接收——`{ mode: 'single', groupName }` 把单选按钮绑成一组，`{ mode: 'multiple' }` 渲染复选框。`ModelCatalogStatusNotices.tsx` 渲染目录请求状态，其中包含两张卡片现在都提供的重试控件。两张卡片共享的样式表按家族命名为 `model-selection-card.module.css` 而不是沿用其中一位成员的名字，fieldset 自身的规则移入 `ModelRouteChoices.module.css`。

每个已存储的设置节只有一处声明，位于拥有它的 Host 包中：`@deepseek-ai/dsh-agent-default-model/types` 与 `@deepseek-ai/dsh-tool-subagent/types` 是浏览器安全模块，经由 `@deepseek-ai/dsh-api-remotes/client` 再导出——客户端本来就是这样读取 Host 词汇的。卡片把各自的 scope 绑定到这些声明上。

新增一个 `./types` 子路径需要同时照顾两个平面：包的 exports 映射，以及 `tsconfig.base.json` 中指向同一 `src` 文件的手写别名。`gen-tsconfig-paths` 只产出 `.` 与 `/invariant`，而 Typert 分析器正是通过这些别名解析的；因此一个有 exports 映射却没有别名的子路径能通过类型检查，随后却会以"导出缺失"让 `verify-cordis-inspect-catalog` 失败。

两份样式表都读取字号刻度——`font: var(--dsw-font-xxs-12)` 及其同族——而不再重复这些 token 已经命名的像素值。间距与圆角保持字面量，因为本设计系统没有为二者定义任何 token。

Subagent controller 的目录读取不再把自己的 `ok: false` 结果抛成 `Error` 再接住——Remote 本就会把 Host 报告的失败折入该分支。它仍然吸收的是唯一真正会 reject 的东西：装配故障；因为没有任何页面级处理器会接住它，而客户端其余部分也一贯避免把未处理的 rejection 送进浏览器控制台。现在它有一个测试证明卡片会报告目录读取失败，而不再只有一个证明故障被吞掉的测试。重复请求也会把进行中的结算留在 `background` 上，而不是用一次立即返回替换掉它。

卡片的 `currentRoute` 直接信任设置类型，不再重复检查 `null` 与 `typeof`，与它的同类保持一致；设置订阅者也不再重新加载处于 `idle` 的目录：构造函数会同步发起第一次请求，它所防护的状态不可能出现。

## 测试

`tests/model-route.client.spec.ts` 覆盖共享的连接与分组，并针对带反斜杠或 NUL 的 id 钉住键的单射性，同时钉住普通路由保留的可读形式。两张卡片都通过 `tests/section.client.spec.tsx` 渲染，置于插件页签提供的 `<main><ul>` 包含关系中，并由一次 axe 检查断言两种选择元数下均无违规。`tests/model-catalog-stub.client.ts` 为两张卡片的测试构造完整的 `ModelCatalog`，取代了两份各自用 `as never` 触达 Host face 的辅助函数。

## 考虑过的替代方案

**保留第二张卡片的副本，另加一道漂移门禁。** 当一条契约确实横跨两个彼此无法导入的程序时，门禁才是本仓库的答案。这两者可以导入：`@deepseek-ai/dsh-api-remotes/client` 正是为此再导出 Host 类型，因此门禁只会守住一份本不必存在的重复。

**把路由列表抽成一张带模式开关的卡片，而不是两张卡片共用一个列表。** 两张卡片的差异不止列表——一张带启用开关与校验提示，另一张带冲突提示——合并只会得到一个以"我是哪张卡片"为参数的组件。

**只依赖 NUL 分隔符。** 单纯的 `${provider}\0${model}` 拼接只有在 id 不含 NUL 时才是单射的，而这一点没有任何地方强制。先对每个 id 转义——反斜杠加倍、NUL 写作 `\0`——就能对任意一对字符串都单射；普通 id 逐字节不变，`alpha\0fast` 仍然读作它自己，代价只有一行。长度前缀或 JSON 编码能买到同样的保证，却要改写测试里每一处键字面量。

**与 Host 中 `tool-subagent/src/model-selection.ts` 里同名的 `modelRouteKey` 共用实现。** 两者用途不同——一个是 DOM 查找键，一个是策略等值键——且都不跨线传输，耦合两个 face 只会把客户端的渲染细节绑死在 Host 的实现选择上。

## 后果

第三张编辑 provider/model 路由的卡片只需新增一个 controller 及其文案，不再需要另一份连接、分组循环或行标记。默认模型卡片的目录失败可以就地恢复，其失败文案也不再描述绕行办法。往任一设置节添加字段现在只需在拥有它的 Host 包中改一处，而读取 Host 并未存储的字段的客户端会在编译期失败，而不是在用户面前失败。

`@deepseek-ai/dsh-api-remotes` 新增了 `@deepseek-ai/dsh-agent-default-model` 与 `@deepseek-ai/dsh-tool-subagent` 两个 peer 依赖，这扩大了 Remote 装配客户端 face 的编译范围。两者都是仅类型再导出，没有任何新东西进入浏览器 bundle。
