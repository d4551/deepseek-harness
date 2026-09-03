# Agent Note：一个无法区分自身内容的版本令牌

Status: implemented

[English](2026-09-03-drive-version-identity-and-local-bounds.md) | 中文

## 问题

`localVersion` 为超过 `maxFileBytes` 的常规文件返回 `local:oversize:<size>`，而 `checkWriteIntent` 用 `versionOf(placement) !== expected.version` 守卫一次写入。于是：读取一个超限文件（版本 `local:oversize:5000000`），另一个写入方把它的内容换成**字节数相同的不同内容**，随后一次 `replaceIfVersion` 写入仍然看到 `local:oversize:5000000`，守卫放行，写入静默摧毁对方的内容。该令牌宣称了一份它从未确立的身份。

同一条本地路径完全没有字节上限。`DriveTransfer.hydrated` 对 drive 侧执行了两次 `maxFileBytes` 检查（先看上报的大小，再看传输到的字节），却把 `local` 放置直接交给 `readLocal`，由它用 `readFile` 读入整个文件。`NetworkDriveFileSystem.readText` 不接受调用方提供的上限，因此一个由 shell 创建的大文件会被整体读入内存；`readBytes` 不受影响，因为它应用自己的 `maxBytes`。[packages/AGENTS.md](../../../../packages/AGENTS.md) 要求对完整结果施加上限。

## 决定

`localVersion` 现在对**每个**常规文件流式计算 `digestOfFile`；`oversize:<size>` 短路与整文件 `readFile` 都已删除。`materialization.ts` 中新增的 `digestOfFile(localPath)` 把 `createReadStream` 接入既有的 `createHash('sha256')`，因此任何大小下内存都只占一个分块——比旧的未超限路径更严格，那条路径会持有整个文件。这里取的是第三条路：彻底移除大小分支，而不是为未超限文件保留它，因为该分支存在的唯一理由就是避免对巨大文件调用 `readFile`，而流式计算在任何大小上都消除了这个理由。

`hydrated` 现在在读取之前就拒绝上报大小超过 `maxFileBytes` 的 `local` 放置，`readLocal` 通过新的 `readBounded(localPath, maxBytes)` 读取，它在上限之后一个字节处停止并拒绝更长的结果——与 drive 路径的两次检查对称。一个私有的 `tooLarge()` 构造器为全部五个位置拥有该消息。`verifiedCopy` 也已加上上限：它现在按记录的长度读取，因为一份超出其记录长度的副本不可能是被记录的内容。

`mapError` 把 `node:fs` 的 `ENOENT` 归类为 `FS_NOT_FOUND`，与 `fs-local` 对同一事实的报告一致；此前它落到通用分支报 `FS_IO_ERROR`。

## 验证

`packages/fs/fs-network-drive/tests/filesystem.spec.ts` 钉住该守卫：一个超限工作文件被换成字节数相同的不同内容后版本随之改变，陈旧的 `replaceIfVersion` 写入被拒绝，替换内容留在磁盘上。还原 `oversize:` 令牌会让它在版本比较处失败。

`tests/hydration.spec.ts` 在工作区一侧钉住上限：一字节上限、恰好等于上限，以及一个 UTF-8 长度与字符串长度不同的多字节文件；随后钉住 `readLocal` 拒绝超上限副本，并把缺失副本报告为 `FS_NOT_FOUND`。`tests/write.spec.ts` 钉住低于上限的内容仍可覆盖一个超限工作文件并发布，且 `before: null`——这正是失败关闭的令牌方案会去掉的行为。在打开的 `streamText` 迭代器下被移除的工作副本，通过该 seam 报告 `FS_NOT_FOUND`。

`tests/hydration.spec.ts` 也钉住这项不对称本身：首个 NUL 位于采样之后的文件按文本读取，且不提供 diff 基准。它的缓存未命中用例现在按记录的长度篡改工作副本，因此有界探测证明的是摘要而非长度。

本提供方不被任何录制会话快照覆盖——它随可选的 `hosted-drive` 补丁包发布，而非默认 profile——因此从 `tests/fixtures/composition/cordis.yml` 启动的真实组合套件仍是本包证据的顶端。

## 备选方案

**一个永不相等的令牌。** 它失败关闭，但那样任何超限文件都无法被替换——这是功能退化，因为 `publish` 完全可以用低于 `maxFileBytes` 的内容合法覆盖一个超限文件。

**用 `size` 加 `mtime` 作为廉价的变更探测器。** 某些文件系统上 mtime 粒度是 1 秒，因此同一秒内两次字节数相同的编辑仍会相撞——这是真实窗口，不是理论窗口。

## 影响

- 定位一个 drive 不持有的工作文件，需要流式读完它的全部内容来为它定版本，包括随后会被读取拒绝的超上限文件。内存保持有界；I/O 与文件大小成线性，并按每次有针对性的操作付出。目录列举不受影响——仅存在于本地的子项不带版本。
- 超限工作文件不再能通过 `ctx.fs` 读取：`readText`、`streamText` 与 `editText` 报告 `FS_TOO_LARGE`，与 `readBytes` 早已如此一致。用低于上限的内容覆盖它仍然成功，且不报告 diff 基准。
- 消失的工作副本现在报告 `FS_NOT_FOUND`；此前靠 `FS_IO_ERROR` 来分辨本提供方缺失副本的消费方，将看到该 seam 的 not-found 码。
- `local:oversize:<size>` 从版本词汇中消失。没有任何代码解析版本令牌——`isProviderVersion` 只读取权威前缀——因此持有旧令牌的会话日志仍可读取，其守卫只是判定为陈旧，从而让模型回到一次新的读取。`SESSION_FORMAT_VERSION` 未变。
