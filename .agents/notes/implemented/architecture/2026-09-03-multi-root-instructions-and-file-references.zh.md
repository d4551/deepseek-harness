# Agent Note: 每个工作区根目录都能抵达指令与 `@` 提及

Status: implemented

[English](2026-09-03-multi-root-instructions-and-file-references.md) | 中文

## Problem

会话把它的附加工作区根目录记录在自己的日志中，消费方在读取时把它们折叠进来（[`packages/core/session/src/workspace-roots.ts`](../../../../packages/core/session/src/workspace-roots.ts)）。搜索覆盖、语言服务器路由与沙箱策略各自都投影了这次折叠。`packages/context/` 中有两个消费方没有。

`agent-instructions` 确实投影了它：[`files.ts`](../../../../packages/context/agent-instructions/src/files.ts) 为每个附加根目录走一条项目链，[`config.ts`](../../../../packages/context/agent-instructions/src/config.ts) 把这些根目录折进基线身份，于是新增或移除一个根目录的会话会重建基线，而不是继续沿用一份基于另一组目录加载出来的基线。两者都没有任何测试。`rg -ln additionalRoots packages/context/agent-instructions/tests/` 什么也没返回，发现循环与身份字段是该包中仅有的未覆盖代码行，CI 的逐文件 100% 覆盖率门禁在这两个文件上失败。未经测试的模型可见发现逻辑正是要紧的那种情形：这个循环决定了一个多根会话向模型发送什么指令文本。

`file-reference-local` 则完全没有投影它。`LocalFileReferenceService.list` 仅依据 `agent.session.header.cwd` 构建索引，因此在多根会话中，用户无法 `@` 引用附加根目录中的文件。该索引还从不察觉客户端在会话中途改动过的根目录集合，因为它按 agent（智能体）缓存且没有键。

## Decision

**指令循环由行为钉住，而不是由一条覆盖率豁免钉住。** `packages/context/agent-instructions/tests/agent-instructions.spec.ts` 新增了一个 `additional workspace root instruction discovery` 套件，断言一个多根会话到底发送了什么：每个附加根目录在主根目录之后贡献自己的项目链，并以绝对路径显示；每条链在该根目录自己的标记处停止，而不是在某个外层项目处停止；没有指令文件的根目录不贡献任何内容；重复的根目录只加载一次；主链已加载过的文件保留其相对项目的展示路径；记录顺序决定分节顺序；渲染出的基线携带附加根目录的文本且主链在前。其中三个用例端到端驱动插件：会话中途记录一个根目录会以新的身份追加一份替换基线；重新记录同一组根目录不追加任何内容；把主根目录也列入其根目录集合的日志，产出与不列入时逐字节相同的文本与身份。

**文件引用搜索覆盖每一个根目录，遵循 `tool-fs-search` 的先例而非 `tool-lsp` 的先例。** `searchRoots`（[`packages/fs/tool-fs-search/src/search-core.ts`](../../../../packages/fs/tool-fs-search/src/search-core.ts)）点名每一个根目录，因为 ripgrep 用一次查询从所有根目录中作答；`sessionWorkspaceRoot`（[`packages/lsp/tool-lsp/src/session-cwd.ts`](../../../../packages/lsp/tool-lsp/src/session-cwd.ts)）把每个文件路由到包含它的最深根目录，因为语言服务器 seam 每次查询恰好只接受一个根目录。`@` 补全属于前一类：一次查询返回一份排序列表，而用户必须能从中抵达任意根目录的文件。因此 `WorkspaceFileSearch` 接收 `readonly string[]` 形式的根目录并覆盖全部；`LocalFileReferenceService` 用 `sessionWorkspaceRoots` 解析它们，仅当会话既未记录 cwd 也未记录根目录时才回退到宿主进程目录。

逐文件路由仍然免费得到，无需额外的路由步骤：一个绝对目录查询恰好在包含它的那个根目录内部解析，对其他根目录则不产出任何结果，因为 `resolveDisplayDirectory` 本就拒绝其根目录之外的路径。这正是选中某个附加根目录的绝对候选项之后还能继续下钻的原因。

**提及文本对主根目录是相对根目录的，对其他根目录则是绝对的。** 来自第二份检出的相对根目录路径会与第一份检出中同名的文件冲突，而面向模型的指引写明 `@` 路径相对于工作区根目录。绝对路径也正是 `agent-instructions` 给附加根目录的指令展示路径所给出的答案，以及 `toWorkdirRelative` 为非工作目录搜索命中所保留的答案。

**排序按候选项在自己根目录内的路径打分。** 若按展示路径打分，某个根目录自身的位置就会决定匹配结果：`/home/me/checkouts/service/` 之下的每一个候选项都会匹配对 `checkouts` 的查询，而 `visibleForGlobalQuery` 会把整个绝对路径含有点号段的根目录隐藏掉。因此每个被索引的条目在其展示候选项旁边携带一个 `sortPath`（相对根目录），比较器最后再比较根目录的位置，于是持有相同路径的两个根目录会让主根目录排在前面。

**一次遍历，跨根目录广度优先。** 扫描队列以每一个根目录作为种子，因此 `maxEntries` 会先花在每个根目录的浅层路径上，然后才轮到任何根目录的深层路径；一个很深的主根目录不会饿死靠后的根目录，而这正是本次修复要防止的失败。两个根目录都能抵达的路径只索引一次，归属于先遍历到它的那个根目录。任何无法读取的根目录都会让整次遍历失败，这延续了既有规则：不可读的根目录不得让一份残缺索引覆盖仍然有效的条目。

**索引以它所构建的那组根目录为键。** `list` 把会话当前的根目录与缓存的集合比较，不同即退役该索引，这就是“消费方在读取时折叠”对一份缓存而言的含义。

## Verification

`bun x vitest run packages/context`——11 个文件、295 个测试全部通过（此改动之前为 268 个）。

`bun x vitest run packages/context --coverage --coverage.include='packages/context/**/src/**/*.ts'`——语句、分支、函数与行均为 100%，逐文件阈值已强制执行。此前：`files.ts` 为 96.66%（348-353 未覆盖），`config.ts` 为 92.30%（93 未覆盖），`index.ts` 缺少 `additionalRoots` 过滤回调。

`bun x tsx scripts/run-oxlint.ts packages/context`——干净。

每一条新断言都通过变异被证明确实承重。删除 `files.ts` 中逐附加根目录的循环，会让 11 个指令用例中的 7 个失败；存活的 4 个是钉住去重与身份稳定性的那些，它们在根目录集合为空时同样成立。从 `workspaceBaselineIdentity` 中去掉 `additionalRoots`，恰好让那个会话中途的用例失败，它也是唯一能观察到该字段的用例。把 `completionRoots` 缩减为会话 cwd，会让全部 3 个服务用例失败。按展示路径而非 `sortPath` 打分，会让根目录前缀用例与嵌套根目录用例失败。所有文件均已恢复，套件重新转绿。

对 `search.ts` 的覆盖还移除了 `compareText` 上的一处 `v8 ignore`：只有一个根目录时它的零分支不可达，而当两个根目录持有相同路径时，正是这个分支把并列结果交给根目录顺序裁决。

## Alternatives considered

**像 `tool-lsp` 那样，把 `@` 补全路由到每次查询一个根目录。** 已否决：这个 seam 返回的是一份列表而不是单个答案，而用户在看到候选项之前无从指明自己指的是哪个根目录。路由会为裸模糊查询重现同一个漏洞，而那正是常见情形。

**拼接逐根目录的结果页，而不是跨根目录重新排序。** 已否决：主根目录的结果页排在最前时，第二个根目录中的完美匹配会掉到主根目录的弱匹配之下，并被挤出 `maxResults` 之外。这是同一缺陷的更窄版本。合并逐根目录的结果页再重新排序是精确的，而非近似的——全局 top-k 中的候选项必然也在其所属根目录的 top-k 中。

**让 `WorkspaceFileSearch` 保持单根，另加一个做扇出的组合体。** 已否决：该组合体需要私有分数才能正确合并，因此排序逻辑无论如何都得导出，而且两个对象会共同拥有一个失效计数器和一份条目预算。一个带根目录列表的类把预算、陈旧计数器与遍历放在同一个拥有者里。

**用根目录的 basename 而不是绝对路径给附加根目录的候选项加前缀。** 已否决：basename 会冲突（同一个仓库的两份检出），而且结果不是 `read` 能打开的路径。

**依次把每个根目录遍历完，好让嵌套根目录中的文件按主根目录相对路径显示。** 已否决：那会把整份条目预算交给第一个根目录。让嵌套在别处的根目录失去更好看的显示是外观代价；让某个根目录被饿死则是本次要修的缺陷。

**用一条排除项或一处 `v8 ignore` 压掉覆盖率失败。** 直接否决：未覆盖的那些行就是功能本身。豁免等于记录下一条模型可见的发现路径未经测试，并让门禁认可这件事。

## Consequences

多根会话现在会从每一个根目录加载指令，并能 `@` 引用每一个根目录中的文件。会话中途新增或移除根目录的代价是一份替换基线，也就是该时点之后的整个指令前缀，这是设计如此，因为先前那份基线描述的是另一组目录。

`WorkspaceFileSearch` 的构造函数接收 `readonly string[]`；`file-reference-local` 为这次折叠依赖 `@deepseek-ai/dsh-session`。单根会话与此前逐字节相同：只有一个根目录意味着 `rootIndex` 恒为 0，因此展示、排序与遍历顺序都未改变，也没有任何录制会话快照发生移动。

`maxEntries` 约束的是整份索引而不是每个根目录，因此根目录数量多或体积大时会更快触顶，而一个不可读的根目录会丢弃整次重建，而不是把其余根目录发布出去。这两点都写在包 README 的 Known Limitations 一节中。

## Related

- [指令发现的读取边界与根目录稳定性](2026-09-01-instruction-discovery-bounds-and-root-stability.zh.md)——本次发现所运行其中的字节预算，以及按会话记忆的项目根。
