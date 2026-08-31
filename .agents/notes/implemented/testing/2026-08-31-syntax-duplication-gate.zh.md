# Agent Note: TS7 语法级重复检测门取代被移除的 sonarjs 规则

Status: implemented

[English](2026-08-31-syntax-duplication-gate.md) | 中文

## 问题

移除 `eslint-plugin-sonarjs`（[TS7-only lint 决策](../process/2026-08-30-manual-same-major-dependency-bump.zh.md)时期；提交 `5cc29d5ce0`）时，八条规则中只有三条交给了幸存者 —— `no-dupe-else-if`、`typescript/no-duplicate-type-constituents` 和 jscpd `duplication` 门 —— 其余五条被无声退役：字符类重复成员、分支全同的条件链、重复的多语句分支、短路运算符两侧相同操作数、以及重复的测试标题。没有可安装的替代品：该插件在模块加载时硬性要求 TypeScript 6 API，而经过审计的替代方案都不在依赖树中。

## 决策

[scripts/syntax-duplication.ts](../../../../scripts/syntax-duplication.ts) 在 TypeScript 7 解析器上（`typescript/unstable/ast`，通过共享的 [ts7-session](../../../../scripts/ts7-session.ts) 批量解析，与 Strada 导入扫描同一方式）精确重实现了这五条退役检查。[scripts/syntax-duplication.spec.ts](../../../../scripts/syntax-duplication.spec.ts) 即是门：每条规则一组红/绿契约，然后 `git ls-files` 全树扫描断言零发现，形式与 `typescript7-unstable-api.spec.ts` 相同，落在已执行的测试车道里。

校准对齐被替换的规则，而非发明更严的规则：

- **单语句分支豁免** `duplicated-branch`（S1871 文档化的例外 —— `case a: return x` 映射表是惯用法）；全同检查仍拥有完全退化的链（S3923），包括 switch。
- **携带 `$`/`%` 占位符的 `.each` 模板标题不注册静态标题** —— 它们按表格行展开 —— 但 `describe.each` 的函数体仍开启自己的标题作用域。
- **转义序列整体成为一个 token**（`\u{…}`、`￿`、`\xFF`、`\cX`、`\p{…}`）：首次扫描因把 `\uXXXX` 拆成单字符而误报了 221 个重复。
- **仅短路运算符**（`&&`、`||`、`??`）：算术自配对（`x * x`）是合法的，`x === x` 仍归 oxlint `no-self-compare`。

函数体克隆仍归 jscpd。全树扫描零真实发现 —— 与两天前该树仍通过 sonarjs 一致。

## 伴随修复

同一轮审计回退了 [tool-bash 集成测试](../../../../packages/shell/tool-bash/tests/integration.spec.ts) 中 `838c5e7328` 的放宽：让惰性 JSONL 探针接受 `'absent' | 'present'` 恰好取消了该测试名称所声明的惰性证明。测试装置现在把 `writeBatchMaxDelayMs` 固定到远超单轮的窗口，使 write-behind 截止时间不可能在测试中途触发，严格的单字符串 `absent` 断言得以恢复 —— 竞态被确定化，而不是被容忍。
