# Agent Note: profile 回退链接存储规范 realpath 目标

Status: implemented

[English](2026-08-31-canonical-profile-fallback-link-targets.md) | 中文

## 问题

`healProfilesModuleFallback` 用 `packageDirFromAnchor` 解析安装的每个依赖，并把字面探测路径直接存为 `$DSH_HOME/profiles/node_modules` 的符号链接目标。在 bun workspace checkout 里，依赖可能解析到一个经由符号链接父包才能到达的嵌套 `node_modules` 条目，其最后一跳是只有从物理父目录出发才能解析的相对链接。Node 的解析器会走完整条链，但不跟随中间符号链接的消费者——web profile 的 `assert-single-dsh-tools` 大声失败探测器，其词法回溯是为了绕开 bun 的 `realpathSync` 在悬空链接上抛 `ENOENT` 的行为——会把这种目标判定为悬空。一旦 `bun install` 重排嵌套布局，heil 会把符号链接重写到新的字面嵌套路径，`dsh web` 便以 "the host tree has no copy" 大声失败拒绝启动，尽管 host 与 profile 副本解析到同一个物理包。

## 决策

`resolveModuleFallbackEntries` 为每个依赖同时保留两种写法（`ResolvedPackage`）：安装解析出的目录，以及用 `realpathSync.native` 把每一层链接都解开之后的同一目录。物理写法用作存储的符号链接目标和下一跳 BFS 的锚点——符号链接工作区布局中嵌套的相对链接需要它，按词法回溯的消费者也只能跟随它。安装写法则继续作为打包可执行体代理目标的来源，那些 file URL 是从启动器自身所在的安装里导入的；若改用规范化写法，只要某个依赖是被链接进安装的，代理就会指向安装之外的物理目录。这与 `dependencyClosure` 一致——后者已经为 profile 自有链接规范化锚点。[profile-plugin-bundles 决策](../architecture/2026-08-05-profile-plugin-bundles.zh.md)继续拥有回退目录的双锚点解析，[unlink 决策](2026-08-12-unlink-stale-profile-fallback-links.zh.md)拥有删除原语；本 note 拥有"存储目标取什么形式"这一决定。

## 考虑过的替代方案

**保留字面探测路径。** 运行时 Node 的父级遍历能解析它，但任何在不跟随中间符号链接的情况下比较或回溯存储目标的消费者都会误读它，而且安装布局的每次变动都会改写物理位置并未移动的目标。

**修复消费者以解析中间符号链接。** 大声失败探测器是本仓库之外的已安装 profile 状态，其词法回溯的存在正是因为 bun 的 `realpathSync` 会在悬空链接上抛错；harness 不能要求每个存储路径的消费者都去解析文件系统已经规范化的链。

**在 `packageDirFromAnchor` 内部规范化。** 会一并改变 `resolveBundleDir` 的结果，而其层目录供给补丁加载与 loader 导入；存储回退目标的契约属于 heal，规范化因此放在 heal 一侧。

**只规范化一次并用于所有条目种类。** 已否决：代理目标是打包可执行体导入的 file URL，用物理目录取代安装自身的解析，会让任何被链接进安装的依赖把代理送出安装之外，`preserves the installation path while resolving packaged exports` 测试正是拒绝这一点。只有存储的符号链接与下一跳 BFS 锚点需要物理写法。

## 后果

回退链接为安装的每个依赖持有唯一的规范绝对路径，在 `bun install` 重排布局时保持稳定；本变更后的首次启动会把既存字面链接一次性重新指向，`moduleFallbackEntryCurrent` 的字符串比较此后比较的是规范路径。在临时目录本身被符号链接的平台（macOS `/var` → `/private/var`）上，存储的链接内容会变化，解析结果不变。`links canonical realpaths when a dependency resolves through a symlinked workspace layout` 测试固定了"符号链接父包加相对跳"的夹具，`preserves the installation path while resolving packaged exports` 则固定了代理一侧仍然保留安装自身解析这一点。
