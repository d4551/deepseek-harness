# Agent Note: 共享平台行为的 Windows 对等

Status: implemented

[English](2026-09-03-windows-parity-for-shared-platform-behavior.md) | 中文

## Problem

Windows 支持在结构上无法被证伪。整包整包地列在 Windows 测试通道的排除清单里，只有裸路径而没有任何理由，于是 `packages/hooks/*`——一个并非 bash 专属的桥接——在 Windows 上完全没有覆盖，而 `packages/terminal/terminal-bash` 即便拥有出厂 Windows 预设所挂载的 `pwsh` PTY 方言，也照样被排除。Windows 覆盖率可以在判定变绿的同时保持红灯，而且判定门禁中没有任何作业运行证明真实 ACL 限制的 win32 专属套件。

在这之下，多个共享组件要么用 POSIX 假设回答 Windows 专属问题，要么根本不回答。`assertOwnerOnly` 在 win32 上直接返回，于是任何本机账户都能读取的凭据文档被照常提供；spill 清扫的属主、全局可写与 sticky 位检查在那里全部返回“安全”。三条原子写路径在 win32 上跳过目录 fsync 且没有 Windows 对等实现，因此已发布的名字并不具备崩溃持久性。本地子进程 Provider 通过 `taskkill /T /F` 拥有 Windows 进程树，而其结果被显式丢弃，存活探测则退化为直接子进程。`resolveExecutable` 请求 `X_OK`，而 Node 在 Windows 上把它映射为 `F_OK`，使“是否可执行”的检查成为静默空操作。本地沙箱在平台只有一个候选时不做探测就返回，于是损坏的 Windows 后端只会在任务中途以 exit 127 的形式首次显现。

## Decision

**每一条 Windows 测试通道排除都写明其平台事实。** [vitest.config.ts](../../../../vitest.config.ts) 只保留主题本身就是 POSIX 程序的四个包——bash 执行器、其沙箱形态、bash 工具 Consumer 与 POSIX runner 链——每条都就地写明具体理由并点名其 Windows 对等物。`packages/hooks/*` 与 `packages/terminal/terminal-bash` 已从清单中移除：两者现在都在 Windows 上运行。

**hook 程序是 Node 程序，hook 的 shell 是宿主的 shell。** 桥接套件此前编写 `#!/usr/bin/env bash` 脚本，这让一个平台中立的桥接只获得了 POSIX 专属的测试。[`hook-program.ts`](../../../../packages/hooks/hook-protocol/tests/hook-program.ts) 把每个 hook 写成 `.mjs` 文件并以 `node "<path>"` 调用——bash 与 PowerShell 对该命令行的解析完全一致——并提供一小段前置代码，使 hook 主体表达其行为而非 shell 语法；在 Windows 上挂载 `PwshLocalExecutor`，取代 POSIX 套件挂载的 `LocalBashExecutor`。[`pwsh-shell.spec.ts`](../../../../packages/hooks/hook-protocol/tests/pwsh-shell.spec.ts) 通过真实的 PowerShell `ctx.shell` 驱动 `runHook`，覆盖 stdin 负载、结构化 stdout 解码、带 stderr 原因的阻断退出码，以及桥接提供的可信环境项。pwsh PTY 方言套件同样在 Windows 上永不跳过：PowerShell 随操作系统发行，因此那里探测失败意味着宿主损坏，并会在第一次 spawn 时大声失败。

**拉取请求判定纳入 Windows 覆盖率与 win32 专属限制套件。** `windows-coverage` 加入 `all checks passed`；已在门禁中的 `windows-native-tests` 现在运行 ACL 沙箱套件、通过 e2e 配置运行 `pwsh-sandbox` 的端到端限制套件，以及新的 win32 专属凭据、spill 与 pwsh hook 套件。[Wine 与原生 Windows 双通道 CI 记录](../process/2026-08-08-native-windows-pull-request-ci.zh.md)拥有该拓扑，并记录 `windows-observational` 为何留在门禁之外。

**Windows 的机密性问题交由 DACL 回答。** [`file-security.ts`](../../../../packages/subprocess/win32-process/src/file-security.ts) 通过共享 Win32 绑定表上的 `GetFileSecurityW` 读取一条路径的属主与 DACL，然后完全基于返回的字节做判断：受托方既不是属主也不是管理账户、却能获得所请求访问权的允许项即为暴露；缺失 DACL 即为完全暴露；拒绝项被忽略，使审计宁可多报暴露也不漏报。`credentials-local` 拒绝任何其他账户可读的文档，并给出 `icacls` 修复方式；`spill-local` 用同一套机制询问某个根是否可被他人写入、以及是否有祖先能替换它。祖先掩码刻意省略创建权限：Windows 卷根向每个用户授予“创建文件夹/追加数据”，同时拒绝删除他人条目，这正是 POSIX sticky 位为 `/tmp` 表达的语义。

**已发布的名字在 Windows 上是持久的。** [`win32.ts`](../../../../packages/util/atomic-write/src/win32.ts) 拥有持久命名空间原语——带 `MOVEFILE_WRITE_THROUGH` 的 `MoveFileExW`，以及用于原子替换的 `MOVEFILE_REPLACE_EXISTING`——并通过该包真实的 `./win32` 子路径导出对外提供。`dsh-atomic-write` 用它提交自身写入，`storage-json` 用它替换单元文件，`attachment-local` 用它创建每个目录并发布每个内容寻址对象，`session-persistence-jsonl` 也消费同一批原语而非自带副本。

**Windows 进程树由 Job 对象拥有。** [`job.ts`](../../../../packages/subprocess/win32-process/src/job.ts) 创建 kill-on-close Job 并把已 spawn 的进程分配进去，一次性终止全部成员，并报告内核统计的已分配进程数。`subprocess-local` 在 spawn 的同一轮里挂接首进程，因此其后创建的每个后代都继承成员身份；整树存活性即该计数，而非直接子进程的退出；Job 句柄只在确认树已消失后释放。对内核拒绝授予 Job 的情况，`taskkill` 仍是回退路径，并且其结果现在会被检查：非成功且非“进程不存在”的状态、spawn 失败，或抛出异常的 Job 调用，都会通过 Provider 的告警出口上报，而不再被丢弃。

**`resolveExecutable` 在 Windows 上检查它所声称的事情。** POSIX 分支保留 `access(X_OK)`；Windows 分支要求候选文件的扩展名位于 `PATHEXT` 之中，也就是裸名候选展开早已采用的同一规则。

**每个沙箱候选都会被探测，包括只有一个候选的链。** `chainVerdict` 不再不加探测地返回唯一候选，因此无法运行的 Windows 或 darwin 后端会在组合期以 `SandboxUnavailableError` 失败，而不是在第一条受限命令时才失败。

## Testing

只要主题是决策而非系统调用，平台特定行为就在每个宿主上被执行：DACL 审计解析逐字节拼装的安全描述符，`readFileSecurity` 与每个 Job 原语都接受注入的绑定表，持久化移动的消费者在被 mock 的平台下驱动被替身化的原语，Job 拥有的进程树则在注入平台下由注入的 Job 驱动。只有四类确实需要真实 NTFS ACL 或真实 PowerShell 的用例——凭据与 spill 机密性套件、pwsh hook 套件、ACL 限制套件——按 win32 门控，而它们全部运行在 `windows-native-tests` 中，该作业是拉取请求判定的依赖项。

## Alternatives considered

**继续排除 `packages/hooks/*`，仅在 Linux 上覆盖桥接。** 桥接的 Windows 行为就是它用来运行配置命令的 shell，而 Linux 根本无法执行这一点。该排除并不是关于 hooks 的结论，而是结论的缺席。

**把套件里的 bash hook 翻译成 PowerShell。** 那会让每个 fixture 翻倍，并把每个套件钉死在产品并不关心的方言上。Node 程序则是桥接在两个宿主上一视同仁的 hook，套件也因此读起来像 hook 行为而非 shell 文本。

**为安全调用保留第二张 Win32 绑定表。** `extendWin32ProcessBindings` 的存在本就是为了让调用方把自己的 API 家族加到同一张已加载的表上；每个消费者各自 `koffi.load` 只会在无人负责的情况下扩大 ABI 面。

**让每个持久写入的包各自拥有一份 `MoveFileExW` 模块。** `session-persistence-jsonl` 已经有一份，而复制它正是重复检测门禁存在的意义。由 atomic-write 包统一拥有、经真实子路径导出对外提供，可把标志选择与 errno 映射保持在同一处。

**通过在 Job 内部 spawn 进程来创建 Job。** `spawnInheritedJobProcess` 正是这么做的，但它走的是 `CreateProcessAsUserW` 加受限令牌，而 Node `child_process.spawn` 路径并没有这样的令牌。在首进程还未执行前把它分配进 Job，可以在不重复实现进程创建的前提下覆盖整棵树。

**把 `taskkill` 保留为唯一的 Windows 终止路径，只检查其状态。** 即便检查了状态，也仍然看不到父进程已退出的孙进程，也无法回答树是否存活。Job 两个问题都能回答，而 taskkill 只保留给内核拒绝授予 Job 的情形。

**用知名 SID 黑名单近似 Windows 机密性检查。** 只拒绝 Everyone、Authenticated Users 与 Users，会放过一份被显式共享给某个具体账户的文档。从描述符读取属主使该检查成为白名单，而这正是其 POSIX 对等实现的形态。

## Consequences

Windows 回归现在会让拉取请求失败：Windows 覆盖率与 win32 专属限制套件会阻断分支，而被排除出 Windows 通道的包必须写明使其排除的平台事实。hooks 桥接与 pwsh PTY 方言，如今在它们本就为之存在的那个平台上被执行。

三类此前静默的 Windows 行为现在会拒绝以往照常进行的工作。DACL 允许其他账户的凭据文档会在加载时失败，而不是继续提供机密；其他账户可写入或可替换的 spill 根或祖先会被跳过并告警，而不是被清扫；扩展名不在 `PATHEXT` 中的绝对命令会被拒绝，而不是交给注定稍后失败的 spawn。每次拒绝都写明修复方式。

`dsh-atomic-write` 不再零依赖：它为持久命名空间原语引入 `koffi`；`credentials-local`、`spill-local` 与 `subprocess-local` 则为安全与 Job 家族依赖 `dsh-win32-process`。Win32 库仍按需惰性加载，因此其他平台不会打开它们。
