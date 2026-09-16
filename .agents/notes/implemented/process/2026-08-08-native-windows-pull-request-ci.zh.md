# Agent Note: Wine 与原生 Windows 双通道拉取请求 CI

Status: implemented

[English](2026-08-08-native-windows-pull-request-ci.md) | 中文

## 问题

拉取请求必需的 Windows 判定既需要快速的 win32 工具链信号，也不能让聚合流程等待稀缺的 Windows 容量。Wine 提供这项关键路径信号，但它运行在 Linux 内核与区分大小写的 ext4 之上，采用 hoisted 依赖布局，且无法证明 NTFS、DACL、ConPTY、崩溃持久性或原生进程行为。原生串行参考流程停用期间，每个拉取请求分支头还需要自动取得真实 Windows 内核结果。

覆盖率审计发现，陈旧分支状态恢复了针对受支持 LSP 源码的临时排除项。因此，原生 Windows 需要按同一逐文件 100% 阈值执行完整的受支持源码清单，而不能依赖缩小后的平台专用分母。

## 决策

[ci.yml](../../../../.github/workflows/ci.yml) 中必需的 `windows` 作业仍是在 `ubuntu-latest` 上运行的 `windows node 24 / wine blocking`。它保留经过校验和验证的 Windows Node、Wine apt 与 bun 安装缓存、仅限工作区快照的 hoisted 安装，以及运行工作区构建与生产网站的[共享 Wine 门禁脚本](../../../../scripts/wine-windows-gates.sh)。Node 分发文件传输采用有界重试；nodejs.org 的大文件传输停滞时，由支持范围请求的传输镜像续传相同字节，但版本和 SHA-256 权威仍属于 nodejs.org，归档通过该校验前绝不会投入使用。稳定的 `windows` 作业 ID 仍是 `all checks passed` 的依赖项。[已归档的 Wine 实验](../../archived/process/2026-07-27-wine-windows-gates-experiment.md)保留其实测取舍，而本文负责当前双通道拓扑。

每个拉取请求还会在组织自有的 `dsh-windows-2025-16core` 运行器上启动 4 个相互独立的原生作业：`windows-build`、`windows-coverage`、`windows-native-tests` 与 `windows-observational`。每个作业都会为工作区符号链接启用开发人员模式，通过 `oven-sh/setup-bun` 提供仓库固定版本的 bun，在不传输 store 归档的情况下执行不可变安装，并在原生 PowerShell 下运行自己的清单。Windows 故障切换变量会把这 4 个作业全部重定向到公司内部运行器池。各作业采用 60 至 120 分钟的截止时间，以约束卡住的工作，同时不把性能目标当作正确性截止时间。

全部 4 个原生作业都是 `all checks passed` 的依赖项。[完整源码质量门禁](../testing/2026-09-16-complete-source-quality-gates.zh.md)取代本文静态作业不阻断合并的策略：Linux 通过不能抵消 Windows 失败。`windows-observational` 作业保留其标识符，但其静态检查、文档、包与构建产物结果均为必需。工作流与门禁调度器都不允许失败结果让聚合流程通过。

`windows-coverage` 在完整工作区构建后，以 6 个 worker 和 90 秒默认测试及轮询预算运行完整插桩套件。根覆盖率配置按逐文件 100% 阈值测量完整源码清单；这不代表当前套件已达到该阈值。`windows-observational` 拥有工作区构建与文档验证，会一起启动独立静态门禁，并将 `publint` 限制为最多 8 个 worker。built-bin 冒烟测试属于 `windows-build`：其构建依赖要求成功，其顺序依赖等待生产网站结算后，才测量真实应用启动。

16 核配置依据历史容量对比选定。6 个 coverage worker 的试验分别在 6 分 27 秒和 7 分 50 秒内完成，而使用 4 个、3 个和 2 个并发 worker 的试验暴露了 fixture（测试前置数据）不稳定和 worker 退出。历史 16 分片样本在 112.66–122.01 秒内完成。32 核对比仅将聚合门禁时间缩短 1.47 秒，且仍在 fork worker 内触发 CJS lexer 故障。这些测量采用较早的源码清单和阈值策略，不能作为完整源码门禁通过的证据或延迟保证。

首次原生运行暴露出两项被兼容性通道掩盖的故障。文档投影测试此前只按 `/` 拆分来派生图片 basename；现在改为使用 Node 根据平台计算的 basename。Chokidar 消费方收到的 `%TEMP%` 以 `C:\\Users\\RUNNER~1` 这个 8.3 别名表示，而 libuv 返回的是长目录名，导致其 Windows 事件路径断言失败。共享的设置 watcher 与凭据 watcher，以及 Cordis 的模块 HMR（热模块替换）与精确配置 HMR，现在都会在打开 watcher 前规范化现有的原生监听基准路径或层级最深的现有祖先路径，并保留尚不存在的后缀；文件访问和诊断仍使用配置路径。模块 HMR 会挂接监听器并等待主 watcher 的 ready 事件，之后插件启动才会完成，因此启动后立即发生的编辑无法与初始扫描形成竞态。HMR 验收通过相同的异步原生 realpath 操作派生预期身份，避免同步 Windows 路径写法仍保留 8.3 别名。

可移植文件系统 fixture（测试前置数据）通过 `node:path` 派生路径、比较原生 realpath 标识、在 Node 启动器边界保留文件 URL，只规范化由 API 负责的分隔符或行尾，并使用每个宿主均允许的文件名。仅适用于 POSIX 的信号、模式位、不可读状态和 writer lock 场景按平台设门禁；可移植故障约定则通过每个宿主均可构造的冲突，断言结构化错误码、回滚、最后有效状态、原子替换及不存在临时残留。凭据权限验证采用无效路径 fixture；该路径在每个宿主上都会于系统查找前产生表示“非缺失”的 `ERR_INVALID_ARG_VALUE`，而不依赖文件祖先究竟产生 `ENOTDIR` 还是 `ENOENT`。worker 死亡 fixture 会先观察其协议前置条件，再由宿主触发真实终止，而不在嵌套 Windows Worker 中调用 `process.exit()`；这样既保留了 worker 退出约定，也不会让外围 Vitest fork 暴露于 Node 进程级的原生退出断言。压力与集成工作负载保留原有断言；如果 Windows 插桩或进程拆卸可能超过 Vitest 默认上限，就为其设置显式的有界时间预算。SQLite 随机差分属性测试保留全部 100 次固定 seed 运行，并采用 120 秒 Windows 预算，因为多个原生作业可能争用共享的运行器宿主；POSIX 仍采用 60 秒预算。

原生 watcher 使用 `canonicalizeWatchPath()` 对层级最深的现有祖先执行 realpath 解析；后缀缺失时，先证明该祖先是可枚举目录，再拼回后缀。这可避免 Windows 8.3 别名与长格式 libuv 事件混用，并让所有宿主在祖先为普通文件时都保留 `ENOTDIR`。设置、凭据、skill（技能）根与 Cordis HMR（热模块替换）在发现和诊断时保留配置路径；模块 HMR 则使用规范写法作为 Node 加载缓存标识、挂接监听器并在插件启动完成前等待主 watcher 就绪，因此启动后立即发生的编辑不会与初始扫描形成竞态。`watchFollowSymlinks: false` 时，若 skill 根本身是符号链接，系统不会展开最后这一级链接，从而让 Chokidar 强制执行该边界。

Windows 的持久 JSONL 路径会保留驱动器根目录的原生写法，并仅对后代路径与暂存路径应用扩展长度命名空间。ACP（Agent Client Protocol）拆卸阶梯使用真实 Node 子进程，以符合宿主语义的结果证明优雅终止与强制终止两个层级，并避免声称 Windows 会交付 POSIX 信号。产品接受裸命令时，可执行 fixture 会提供 `.cmd` 包装脚本与 `PATHEXT`。repository-cache 辅助包位于所选 Git 子路径内，因此它们声明的 `file:` 依赖会在 Windows 上以相同方式暴露命令包装脚本。随附的安装器会导出包管理器自有的 workspace-ignore 配置，保留其主目录作为包管理器 数据配置，同时从生命周期 `PATH` 中移除该目录，并在 `PATHEXT` 中优先选择 `.CMD`；因此，嵌套 Git 包安装既不会重新加入外层 workspace，也不会让继承的 Windows 包管理器可执行文件抢在事务持有的 wrapper 之前。

启动后，只有根 fiber 与 Loader 均处于活跃状态时，系统才会继续设置 profile watcher。只有当同一次调用所记录的信号已取得关闭流程所有权时，系统才会隔离并发设置错误；无关 HMR 故障仍会响亮失败。[进程关闭控制器](../bug-fix/2026-08-03-cli-signal-shutdown-escalation.zh.md)会在根级 dispose 成功后让单次任务的正常完成流程排空 Node 剩余句柄，同时让拆卸失败、截止时间到期和信号升级继续强制退出。vendored Include 会串行化防抖写入，只对瞬时访问或忙碌故障执行有界退避重试，并确保每个由计时器触发的拒绝都得到观察。持久化最终失败后，该故障会保留在队列中，并重新抛给拆卸责任方；成功拆卸则会排空最新写入。

Shiki 会禁用 TextMate 正则的延迟编译，并在用户内容进入保持不变的逐行 tokenization（词元化）预算前预热每种启动语法，从而避免调度器争用发布不完整的高亮流。Codex 真实产品 fixture 固定使用稳定版 0.149.1 schema，并选择实际提供的命令工具与对应参数形态；这样既保留由提供方负责的协议，也能在每种宿主上证明无人值守拒绝和整棵进程树退出。

## 曾考虑的替代方案

**要求每项原生 Windows 结果通过。** 原拓扑为避免等待重复的静态检查与文档检查而否决该方案。完整源码质量门禁决策采用该方案：平台结果彼此独立，每项原生失败都会阻断分支。

**只在拉取请求上运行 Wine。** Wine 能快速触达阻断性 win32 工具链分支，但即使真实 NT、NTFS、PowerShell、进程或原生插件约定已经损坏，也可能报告绿灯。

**原生检查失败后继续执行，却不让作业失败。** 完整源码质量门禁决策撤销原有静态作业例外。即使另一宿主通过相同检查，聚合流程也必须呈现每项失败。

**从测量中移除源码或削弱 Windows 断言。** 不予采纳，因为缺失覆盖率仍是需要修复的缺陷。平台执行差异不构成缩小源码清单或降低阈值的授权。

**保留 GitHub 标准的 `windows-2025` 运行器。** 该可移植双核镜像能可靠完成这份完整清单，但其 32 分钟的串行结果使自动原生信号的实用性远低于所选的 16 核运行器。

**使用 32 核或更大的运行器。** 32 核对比仅比 16 核将聚合门禁时间缩短 1.47 秒，且仍因 Node 的 CJS lexer 失败；先前高并发的 32 核和 64 核试验也以同类故障失败。因此，增加容量只会提高资源分配成本，却不能带来稳定的端到端收益。

## 后果

Wine 保留其作业身份，并提供独立的工具链结果。分支保护等待 Wine 与全部 4 个原生作业，包括静态分析和文档分析。待完成或失败的原生结果会阻止 `all checks passed` 报告成功，代价是等待最慢的必需结果。

尽管如此，每个拉取请求都会获得真实 NT 内核、NTFS、PowerShell、Windows 进程、原生插件和受支持源码覆盖率信号。原生作业会重复设置流程，并在构建、覆盖率与观测性工作区中重复构建，但它们会降低每个作业的进程数，并暴露兼容性通道掩盖的路径、watcher、生命周期与 fixture 缺陷。

维护者必须保留两种有意设计的执行拓扑：Wine 快照使用 Linux 安装加 hoisted 布局来触达 win32 二进制文件，而原生作业在组织自有的 16 核 Windows 运行器上使用相互独立的不可变工作区。任一拓扑独有的失败都必须依据该边界分类，不得削弱或静默跳过。
