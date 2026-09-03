# Agent Note: 一道门禁，针对无论代码是否可用都会通过的测试用例

Status: implemented

[English](2026-09-03-assertionless-test-gate.md) | 中文

## Problem

一个走不到任何断言的测试用例，在绿色的代码树上通过的原因与它标题所指的行为无关。`packages/api/session-controller/tests/manager.client.spec.ts` 就是这类问题的典型例子："ignores Host status and error events for sessions without an instance" 调用了 `manager.handleSessionStatus(S2, true)` 与 `manager.handleSessionError(S2, '无实例')`，却什么都不断言，因此无论这两次调用是否被安全忽略，它都会通过。整个工具链里没有任何东西报出它。`syntax-duplication` 读取测试标题但不读主体，覆盖率统计的是被执行的代码行而非被检查的结果，而 oxlint 的规则集里没有与 `expect-expect` 对等的规则。

一个正则原型随着连续修复模式缺陷，先后产出 337、264、63、41 条发现，而每一个计数都是错的。逐行匹配无法把 `it.each(rows)(…)` 与 `test.ctx.on('goal/changed', cb)` 区分开，无法分辨用例主体与持有其断言的辅助模块，也完全看不出 `it('name', importedCase)` 发生了委派。

## Decision

[scripts/no-assertionless-tests.ts](../../../../scripts/no-assertionless-tests.ts) 遍历 TypeScript 7 AST（`typescript/unstable/ast`，通过共享的 [ts7-session](../../../../scripts/ts7-session.ts) 批量解析，方式与 `syntax-duplication` 相同），并报告三类发现：

- **`empty-body`**——用例主体不含任何语句。
- **`no-assertion`**——主体运行了代码却走不到任何断言，因此只有抛出的异常才能让它失败。
- **`callback-only-assertion`**——所有断言都位于监听器回调（`.on(…)`、`.subscribe(…)`）内部，而用例中没有任何东西迫使该回调运行，因此事件从不触发时用例照样通过。

[scripts/no-assertionless-tests.spec.ts](../../../../scripts/no-assertionless-tests.spec.ts) 即是门禁：为每一类发现和每一种被接受的写法注入红/绿 fixture（测试前置数据），再做一次实时全树扫描，断言被跟踪的语料是干净的，形式与 `no-barrels.spec.ts` 一样落在已执行的车道里。`scripts/**/*.spec.ts` 本就是一个 vitest 项目，因此 `bun run test` 会强制执行它。

解析过程感知调用目标，而这正是正则做不到的：

- **runner 调用是仅经由 vitest 修饰符抵达的 `it`/`test`**（`only`、`skip`、`todo`、`fails`、`concurrent`、`sequential`、`each`、`for`、`runIf`、`skipIf`、`extend`），可以嵌套一层或多层，也包括被调用的 `it.each(rows)(…)` 形式。任何其他成员名都会终止这条链，因此 `test.ctx.on(…)`——线上有 26 处——不是用例。自行绑定 `test` 的模块（`const test = await bench({…})`）会在该文件内遮蔽 runner。
- **委派解析三层**，可进入同模块声明，也可进入通过相对路径导入的模块，包括被重命名的 specifier。`packages/typert/generator/tests/type-model.spec.ts` 以 `it(title, importedCaseFunction)` 注册了 36 个用例；每一个都解析到执行断言的 `type-model-cases-*` 模块。
- **注册辅助函数不是用例。** `packages/util/atomic-write/tests/atomic-write.spec.ts` 中的 `itInScratch(name, run)` 由自己的参数构建主体，因此断言属于该模块看不到的调用点。
- **会抛出的 Testing Library 查询就是断言。** `screen.findByText(label)` 在标签始终不出现时 reject，因此它与 `expect` 一样对用例作出裁决；`queryBy*` 返回 `null`、不作任何裁决，因此不算。

`it.todo(…)` 与只有标题的 `it('name')` 注册被豁免：两者按设计就没有主体。

## 扫描发现了什么

二十二个包中的二十八个用例，全部是真阳性，现在也全部断言了各自标题所指的后果。最大的一族是不变量配套模块：`accepts <a valid sequence>` 这类用例发射或追加了一段合法事件序列却什么都不检查，因此即便面对一个完全没有观察这段序列的不变量，它们照样通过。现在每一个都断言被接受的序列留下的状态——工作流 trace 被退役、审批对消费掉它的未决问题、工具执行离开了 stage 表——当不变量没有在跟踪时，这些断言就会失败。空的不变量配套模块（`packages/e2b/*`、`packages/storage/storage-json`）断言包名预留在挂载期间被持有、在资源释放时被释放，与 `packages/api/settings-controller/tests/invariant.spec.ts` 中已有的写法一致。

其余是一些单独的用例：一个从未重新读取文件模式的数据库文件用例；一条游离的 JSON-RPC 响应，现在用来证明下一个真实请求仍会结算；一个 `dispose()`（资源释放）幂等性用例，现在把两次调用的结算结果都钉住；还有一对 HMR（热模块替换）监视器用例，其 `eventually(…)` 等待之后现在跟着一条针对确切观测状态的断言。

没有任何用例被删除、被削弱或被豁免，门禁也不携带任何允许清单。

## Alternatives considered

**保留正则原型。** 已否决：连续四个计数，每一个都错得很笃定。真正要命的两个错误——匹配任意 `test.<member>(…)` 链，以及报告每一个注册导入用例函数的测试套件——无法靠更好的模式修复，因为两者都要求解析一次调用究竟指向什么。

**报告一切没有内联 `expect` 的用例，并按路径豁免那些做委派的套件。** 已否决：以路径为键的允许清单在套件一移动就陈旧，而且它恰好掩盖了门禁存在的意义所在的那些用例。解析委派对每个未解析用例只花一次 AST 遍历，且结果精确。

**把任何包含 `throw` 的已解析辅助函数都算作断言。** 已尝试并否决：它消掉了八条发现，其中只有两条是真正的断言辅助函数。`makeBridgeHarness()` 与 `startMux()` 会在 fixture 出问题时抛出，于是该规则豁免了每一个碰过 harness 的用例。取而代之的是断言词汇保持封闭，`eventually(predicate, message)` 的调用方现在显式断言自己的观测——这比单纯等待更强。

**报告一切只能经由任意回调抵达的断言。** 已否决：传给 `waitFor`、`map` 或 `forEach` 的箭头函数通常都会运行，报告它们会把唯一真正不会运行的那种形态淹没掉。只有订阅方法（`on`、`once`、`subscribe`、`addEventListener` 及其同类）符合条件，而且仅当该用例完全没有其他断言时才符合。

**把这项检查加进 oxlint。** 已否决：oxlint 的规则集由其 Rust 二进制固定，因此无法在其中安装仓库本地规则——正是这条约束让 `syntax-duplication` 落在一个已执行的 spec 里。

## Consequences

`packages/*/*/tests/**`、`apps/*/tests/**` 与 `scripts/**` 中的每一个 `it`/`test` 用例现在都必须走到断言，新出现的空转用例会让 `bun run test` 失败，而不是悄悄通过。这次扫描的开销是对大约 1200 个 spec 文件做一次批量解析（约 5 秒），外加对每个被用例委派到的辅助模块做一次惰性解析；只有没有直接断言的用例才需要为解析付出代价。

有三条限制是刻意的，属于新的决定而非缺陷。委派止于三层，因此第四层上的断言会被报告。经由模块无法解析的值抵达的辅助函数——构造出的对象上的方法、裸 specifier 导入——不会豁免其调用方，这正是 `manager.handleSessionStatus(…)` 仍被报告的原因。而且门禁裁定的是可达性而非强度：`expect(() => run()).not.toThrow()` 就能满足它。收紧其中任何一条都是另一次改动，需要配上自己的红/绿 fixture。

`packages/client/ui-attachment/tests/message-image.client.spec.tsx` 点名了唯一一个鉴别力受其被测对象限制的用例：React 19 会静默忽略卸载之后的状态更新，因此 "ignores a load settling after unmount" 可以断言每一条分支都加载了一次且什么都没渲染，但没有任何可观测量能把带守卫的组件与不带守卫的组件区分开。
