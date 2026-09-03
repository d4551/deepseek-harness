# Agent Note: Windows subprocess 源文件获得覆盖率下限，win32 通道拿回它的测试套件

Status: implemented

[English](2026-09-03-windows-coverage-floor-and-lane-facts.md) | 中文

## 问题

`packages/subprocess/subprocess-local/src` 中有两个文件在任何平台上都没有被测量。`windows-inspector.ts` 与 `windows-job.ts` 以字面路径被排除在 POSIX 覆盖率通道之外，而 win32 通道整体排除了 `packages/subprocess/*`，因此逐文件 100% 门禁在这两个文件上都没有运行。`windows-job.ts` 走得更远：它整个可执行主体都位于 `/* v8 ignore start */` 之内，因此 `createWindowsProcessJob` 的挂接失败清理——先关闭 Job，再重新抛出——没有任何测试钉住，也没有任何通道测量。解除排除后，`windows-inspector.ts` 在 315 行运行中的判定逻辑上测得语句 37.33%、函数 64%。

这些排除项是以平台事实的名义写下的。它们不是：`packages/subprocess/win32-process/src/*` 是一个同级的 Win32 库，它通过接受一张注入的绑定表在 POSIX 上达到约 100%，因此「Win32 代码无法被覆盖」这个说法在同一个包分组内部早已不成立。

win32 测试通道带着与之对应的缺陷。它的注释写明每一个条目都要陈述把它排除在外的那条具体 Windows 事实；有五个条目只是光秃秃的路径——`subprocess` 包的各套件，加上 `local.spec.ts`、`process-inspector.spec.ts`、`spawn.spec.ts` 与 `terminal.spec.ts`。逐一读下来，其中四个按构造与宿主无关（`process-inspector.spec.ts` 与 `terminal.spec.ts` 向被注入的内部实现传入一个显式平台，并使用一个伪 PTY；`spawn.spec.ts` 与 `local.spec.ts` 携带 `skipIf(win32)` 守卫、win32 条件化的预期，以及为那条通道写的命令翻译表）。第五个则在一条断言中握有一条真实的 Windows 事实。

## 决策

**两个 Windows 文件都接受一个注入的 seam，与它们的 `win32-process` 同级完全一样。** `windowsJobFactory(bindings)` 在一个绑定表解析器之上组装出 Job，而 `createWindowsProcessJob` 就是它在共享的 `win32ProcessBindings` 之上的组装；组装它不会打开任何库，而一个套件可以通过一张替身表驱动 create/attach/terminate/count/release 以及被拒绝挂接后的清理。`lazyWin32Bindings(load)` 把 koffi 的库加载器当作一个值来接收，因此 `bindWin32`——那七个 `__stdcall` 绑定——可以在任何宿主上针对一个替身 kernel32 运行，而模块级的组装传入的是真实的 `koffi.load`。`windowsProcessInternals(bindings)` 在那个解析器之上暴露由 koffi 支撑的内部实现，因此 Toolhelp32 遍历以及 `GetProcessTimes`/`WaitForSingleObject` 状态读取都能在 Windows 之外针对预置的行数据执行。

`windows-inspector.ts` 中的三处 `/* v8 ignore */` 注释连同它们的排除一并删除：快照不可读守卫、创建时间不可读守卫与意外等待状态守卫都可以通过注入的表预置出来，现在也都被断言了。结构体大小断言保留它的 ignore——koffi 与 Windows 的 ABI 分歧无法预置。

那两条路径排除项与 `packages/subprocess/*` 的整体排除都已消失。覆盖率清单的规则现在写在它所在的地方：一个包之所以够格，仅仅因为它自己没有任何套件在 win32 上运行，而这与测试通道是同一份清单、同样的理由。

**那五个光秃秃的通道条目已经消失。** `packages/subprocess/subprocess/tests/service.spec.ts` 握有唯一一条真正的 Windows 事实：它在 `process.env` 的一份普通副本上断言 `env.PATH`，而 Windows 把该变量存为 `Path`，因此这份副本上区分大小写的查找会落空。这条断言现在提出的是 Windows 语义真正提出的那个问题——恰好有一个键，其大写形式是 `PATH`——于是该套件在那里也运行。另外四个原样重新纳入。

`spawn-support.ts` 中的两个共享助手 spawn 了一个只在 POSIX 上存在的 `kill` 可执行文件，因此在 win32 通道上 `killQuietly` 什么也没终止，`processAlive` 把每个进程都报告为已死，这会让重新纳入的那些套件中的 `waitGone` 变得空洞。两者现在都改用 Node 自己的信号投递（`process.kill(pid, 'SIGKILL')` 与零信号存在性探测），它在每一个受支持的宿主上都有定义。

**多根方言测试覆盖它所指名的每一种方言。** `sandbox-local` 的 `every dialect grants EVERY workspace root…` 用例断言了 bwrap、Landlock 与 Seatbelt；而 windows-acl runner 的 argv——它的 `--workspace` 重复来自同一个 `workspaceRoots(policy)` 推导——只在单个根目录下被执行过。现在它在那里也被断言了，做法是用一份无 agent（智能体）的 workspace-write 策略调用 `confine()`，因此不会触碰任何宿主 ACE。

**Windows 上的凭据与 spill README 不再宣称一项并不存在的保护。** `credentials-local` 曾说 Windows 上没有可供检查的 mode，机密性检查在那里被跳过；事实并非如此——`assertWindowsOwnerOnly` 会审计文档的 DACL 并拒绝一份暴露的文档，同时指名用于修复的 `icacls` 命令。两种语言的文本现在都这么写。写入路径才是那个诚实的缺口：`credentials-local` 中的 `{ mode: 0o600, dirMode: 0o700 }` 以及 `spill-local` 中的 `0o700`/`0o600` 都被 Windows 忽略，`win32-process/src/file-security.ts` 只做审计、没有设置 DACL 的原语，因此一份文档会继承其父目录的访问控制列表，并在下一次读取时被拒绝，而不是以仅属主可访问的方式被创建。这一点以两种语言、为两个包记录在 `## Known Limitations and Deferred Work` 之下，而不是被含糊带过。

## 考虑过的替代方案

**只为 koffi 加载器保留一条窄的 POSIX 排除。** 否决：加载器只是一次 `koffi.load('kernel32.dll')` 调用，而把加载器作为值传入，就把它移到了一个套件能驱动的 seam 之后。在那里留一条排除，只会让那七个绑定声明——那些名字与 stdcall 签名，打错一个字就会坏——毫无益处地保持未被测量。

**在 win32 通道上覆盖仅 Windows 的代码行，并在 Linux 上豁免它们。** 对这两个文件否决：逐文件门禁在两条通道上各自独立运行，因此只在其中一条上被覆盖的行，在另一条上仍然需要一条排除，而这正是当初把它们藏起来的那套安排。对 `sandbox-windows-acl` 它仍是正确答案，因为那个包的入口点打开的是一个 restricted token，而不是一张表。

**把那四个未经审视的通道条目继续排除在外，并写下一条理由。** 否决：四个中有三个根本不触碰宿主，因此为它们写的任何理由都会是编造的。仅仅是没在 Windows 上测试过的套件应当重新纳入，坏掉的东西要么修好，要么指名。

**在 Windows 上实现仅属主可访问的创建。** 暂缓：它需要一个 `win32-process` 目前没有的设置 DACL 的原语（`SetNamedSecurityInfo`，或创建时的一份 `SECURITY_ATTRIBUTES` 描述符），而且只能在 Windows 宿主上核验。记录这项暴露才是本次改动能够证明的事情。

## 后果

`packages/subprocess` 现在仅凭它自己的套件就达到逐文件 100% 门禁：18 个被测量的文件、1136/1136 语句、587/587 分支、233/233 函数、987/987 行。`windows-inspector.ts` 是 82/82 语句与 31/31 分支；`windows-job.ts` 是 13/13 语句与 5/5 函数，而它此前测得的是一条语句与零个函数。补上这个分组的同时还顺带补掉了测量过程中发现的四个相邻缺口：服务的 `ctx.logger.warn` 出口、`spawnSubprocess` 的默认 `process.emitWarning` 出口、携带状态码而无 spawn 错误的 taskkill 报告，以及 ACL 遍历的受托方截断守卫。

win32 覆盖率通道现在为每一个 `packages/subprocess` 源文件把关，win32 测试通道也运行每一个 subprocess 套件。两者都是仅 CI 的信号：本次改动是在 macOS 上核验的，而只有 Windows 通道能看到的逐文件缺口会在那里浮现，而不是被预先排除掉。移除整体排除的意义正在于这份可见性；一个确实无法在 Windows 之外执行的文件，应当凭它的理由获得一条逐文件条目，绝不是一条包级 glob。
