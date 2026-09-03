# Agent Note: 挂载 hosted-drive 不变式，并定位每一次带范围的 drive 读取

Status: implemented

[English](2026-09-03-hosted-drive-invariant-mount-and-range.md) | 中文

## 问题

hosted-drive 层交付了四样东西：一项没有任何交付组合会运行的单执行世界检查、一次可能返回文件错误区间的带范围读取、一个没有部署能改动的传输上限，以及一个不可能失败的测试。

`packages/bundle/hosted-drive/src/invariant.ts` 把运行中的 `fs.materializationRoot` 与运行中的 `sandboxPolicy.resolve().workspaceRoot` 相比较，两者背离时失败，它的单元套件也证明了它会抛错。`packages/bundle/` 下没有任何 `cordis.patch.yml` 挂载 `@deepseek-ai/dsh-invariants` 或任何 `/invariant` 伴随插件，因此在真实的 `dsh --profile hosted` 中这项检查从未被安装。一个把沙箱围栏移离物化根目录的 `--patch` overlay，恰好造出这一层存在的意义所要防止的分裂世界——每个 spawn 出来的进程仍然针对物化根目录运行，而限制范围却指向别处——却没有任何东西观察到它。`scripts/package-invariants.ts` 强制要求伴随插件的导出、发布与构建接线，对组合则只字未提。

`packages/fs/network-drive-webdav` 依据响应体的长度判定一个带范围的应答落在文件的什么位置：长度不超过所请求窗口的响应体，被当作被服务的窗口整体返回。忽略 `Range` 的服务器会以 200 返回整个实体，而该实体可能短于所请求的长度，因此任何非零偏移处的读取都会不报错地返回文件开头的字节。长度无法区分这两种情形，只有状态码可以，而当时既没有读取状态码，也没有读取 `Content-Range`。该 seam 的 `read(path, range, signal?)` 接受任意偏移，而当前唯一的调用方传入 `offset: 0`，因此这个缺陷处于潜伏状态。

`maxFileBytes: 10485760` 以字面量形式写在交付的补丁里，而每一个随部署变化的同级字段都读取环境变量。drive 延迟与各套餐的传输限制随部署而不同，而这个值从 `cordis.yml` 无法触及。

`hosted-drive.spec.ts` 断言 `sandbox-policy.workspaceRoot` 等于 `fs-network-drive.materializationRoot`，做法是从它刚刚解析过的那个补丁文件里读出这两个值，而两者在文件中是完全相同的 `!!js process.env.DSH_DRIVE_WORKSPACE` 表达式。这条断言只有在改动那个文件时才可能失败，而交付成果恰恰建立在它所宣称的事实之上。

## 决策

**这一层挂载它自己的不变式。** 运行时不变式在整个仓库范围内保持按需选用：[omit-invariants-from-shipped-config](../simplification/2026-08-03-omit-invariants-from-shipped-config.zh.md)决定交付的 `dsh` 配置树既不挂载注册表，也不挂载任何伴随插件，因此诊断成本与 `InvariantError` 终止不会强加给普通运行。这里并没有推翻那项决定。`packages/bundle/hosted-drive/cordis.patch.yml` 以 `package_allowlist: ['^@deepseek-ai/dsh-hosted-drive$']` 插入该注册表，并在它旁边插入本包的 `/invariant` 伴随插件，因此一次 hosted 运行获得的是这一层的检查，而不是任何其他包的检查。该注册表进入组合包的 `dependencies`，因为 profile 安装的是组合包所声明的内容；按 `verify-package-invariants` 的要求，它同时保留 `peerDependency` 与 `devDependency`，与 `@deepseek-ai/dsh-fs-network-drive` 在这份 manifest（元数据清单）中早已存在的双重列出方式相同。

这项检查刻意做得很窄。当 `ctx.fs` 不是由 drive 支撑的提供方时，以及没有挂载 `sandboxPolicy` 时，它都保持沉默：它拥有的是两条已挂载配置行之间的一致性，而不是其中任何一条是否存在，没有围栏的目录树是沙箱层的主题。

**带范围的读取由应答定位，而不是由它的长度定位。** 提供方现在请求 `details: true`，因此 `webdav` 会在响应体之外一并返回状态码与响应头。200 的响应体是整个实体，从所请求的偏移处截取；206 的响应体从它的 `Content-Range` 所述位置开始，按两者之差截取，因此服务器放宽后的窗口仍然产出所请求的区间。任何其他状态码、`Content-Range` 无法解析的 206，以及起点越过所请求偏移的窗口，都会使该区间无法核验，于是抛出 `DRIVE_IO_ERROR`，而不是返回调用方没有请求的字节。起点越过文件末尾的窗口不返回任何字节，这正是 Definition 在文件先结束时所承诺的行为。

`webdav` 把 `getFileContents` 的类型定义为两种应答形式的联合，因为它的签名并未按该标志位重载，所以代码先断言到带详情的那一支，随后再次核验：`bodyBytes` 在应答不携带二进制响应体时大声失败，而一次错误的断言同样会产生这种结果。

**两个传输边界都读取环境变量。** `maxFileBytes` 与 `requestTimeoutMs` 变成了 `!!js Number(process.env.DSH_DRIVE_MAX_FILE_BYTES ?? 10485760)` 与 `!!js Number(process.env.DSH_DRIVE_REQUEST_TIMEOUT_MS ?? 30000)`，也就是 `dsh-sdk-minimal` 为 `DSH_CONTEXT_WINDOW` 已经在用的写法。10 MiB 的默认值是 `fs-network-drive` 在本地磁盘上所允许值的十分之一，因为这里的每个字节都要两次穿过网络；README 记录了这两个默认值。

**同义反复已经消失，取而代之的是一次真实组合。** 围栏与根目录的比较已从 `hosted-drive.spec.ts` 中删去，该文件的模块注释现在说明了原因，以及诚实的检查落在何处。`packages/bundle/hosted-drive/tests/invariant-composition.spec.ts` 通过 `loadOverlayPatches` 与 `boot()`——启动器自己的解析器、补丁算法、Loader 与 Include——把已发布的 `cordis.patch.yml` 叠在一份基础层 fixture（测试前置数据）之上启动，其中只对 WebDAV 端点做了桩替换，并证明组合出的 `ctx.fs` 在有围栏的工作区内提供 drive、挂载的检查在那里通过，以及移动围栏的 `--patch` overlay 会在第一次观察时被拒绝。从补丁中删除那两条不变式配置行会让这个套件失败。

文件名之所以带 `invariant`，是因为 `scripts/test-invariants.ts` 会把注册表和每个包自己的伴随插件挂载进每一个普通的包测试根：换成任何别的名字，无论交付的补丁是否携带该挂载，测试都会通过。`usesManualInvariantTree` 豁免匹配 `*invariant*.spec.ts` 的套件，因此这个套件拥有自己的拓扑，而补丁是唯一能安装这项检查的东西。

两层中的插件名都被改写为从源码注册的 `cordis:` 内建项。Loader 通过 Node 解析裸标识符，而 Node 给出的是构建后的 `lib/`，源码平面的套件不得加载产物；`packages/fs/fs-network-drive/tests/composition.spec.ts` 使用同一手法。配置行 id、配置、`!!js` 表达式、禁用项以及补丁算法都保持交付时的样子，而一条指名了没有已注册源码模块的插件的配置行，会让改写失败，而不是被跳过。

## 考虑过的替代方案

**不加过滤地挂载注册表。** 交付的 hosted 配置树中唯一一条伴随插件配置行就是这一条，因此 allowlist 今天不改变任何东西。它相对于仓库范围的那项决定写明了这次按需选用的范围，并防止日后在别处新增的伴随插件在一次 hosted 运行中悄然生效。

**在启动时检查一次根目录，而不是在 `fs/observed` 上检查。** 启动检查读取的是同样的两个值，却看不到日后解析结果发生变化的策略，而 `fs/observed` 正是分裂世界造成危害的路径：它在一次读取为后续受保护的写入授权时触发。代价是每次观察两次 `realpath` 调用，与之相对的是一次网络往返。

**拒绝客户端无法核验的任何非零偏移。** 这样无需读取应答也能让 seam 保持诚实，但 Definition 记载 `read` 接受任意偏移，而一个合规的 206 应答是可核验的——拒绝它等于否掉 WebDAV 提供的一项能力。

**把围栏与根目录的比较保留为一次 schema 检查。** 同一个文件里两条配置行读取同一个表达式，并不构成一种关系；必须一致的是运行中的那两个值，而不变式现在比较的正是它们。

## 后果

围栏与物化根目录背离的 hosted profile，会在第一次文件观察时以 `invariant violated by "@deepseek-ai/dsh-hosted-drive"` 失败并指名这两个目录，而不是作为分裂世界继续运行。其他每个 profile 都不受影响：没有注册表，没有伴随插件，没有诊断成本。

带范围的 drive 读取要么返回所请求的区间，要么失败；它不再可能静默地返回另一个区间。现网的调用方从偏移零开始读取，无论如何都不受影响。

部署可以通过环境变量设定自己的传输上限与请求截止时间，而组合包自己的补丁成了最后才需要改动的文件。
