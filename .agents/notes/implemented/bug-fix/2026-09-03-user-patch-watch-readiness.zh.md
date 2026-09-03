# Agent Note: 报告就绪的 watcher 还不是能报告变更的 watcher

Status: implemented

[English](2026-09-03-user-patch-watch-readiness.md) | 中文

## 问题

`watchUserPatches` 只注册了一个触发源——一次 HMR 精确路径 watch——并把 Chokidar 的 `ready` 事件当作用户 patch 层开始生效的时刻。`ready` 在 Chokidar 的初始扫描完成且 `fs.watch()` 返回后触发一次。在 macOS 上，`fs.watch()` 返回并不等同于平台层 watch 已经在观察变更：libuv 把路径交给它的 CoreFoundation run-loop 线程，并在该调用返回之后才在那里装配 FSEvents 流。落在扫描（已结束）与已装配的流（尚未开始）之间的变更根本不会产生任何 event，而由于初始扫描是唯一的另一处观察，已挂载的层此后就与文件不一致，直到某次后来的变更恰好被报告出来。

`packages/boot/app-boot/tests/user-patches.spec.ts` :: `watches add, failure, recovery, and removal through transactional HMR` 正好坐在这个窗口里：它在 `watchUserPatches` resolve 之后的那一轮写入 patch 文件，然后等待该层变更 10 秒。在一台负载中的 18 核主机上，它大约每十二次运行失败一次，报 `user patch addition was not applied`；机器越忙失败越频繁——CPU 压力会拖慢 run-loop 线程，从而拉宽这个窗口。

对注册所用 `FSWatcher` 的插桩表明，丢失发生在 Chokidar 之下，而非某个过滤器或节流。一次失败回合中该 watcher 发出的全部 event，包括它对每次 `fs.watch` 回调的 `raw` 再发出：

```
addDir:/private/var/folders/…/T/dsh-diag-WIn6P9
THROTTLE:readdir:dsh-diag-WIn6P9:1000:ok
ready:undefined
```

其后从未出现 `raw` 行，因此 `fs.watch` 从未回调，注册的刷新也从未运行。一次成功回合会带有 `RAW:rename:cordis.patch.yml`，随后是 `add`。完全不含 Harness 代码也能复现同样的形态：`fs.watch(dir)` 紧接一次 `writeFileSync`，200 次迭代会丢失一次事件；在负载下，Harness 这条路径 200 次丢 3 次。

本包能用的任何手段都无法靠等待关闭这个窗口。Chokidar 的 `ready` 已是该库提供的最强就绪信号；装配过程在 `watchUserPatches` 中不可观察（它注册的回调只对被 watch 的路径触发，因此探测就得去创建用户自己的配置文件）；而 stat 轮询在下一层有同样的缺陷：`fs.watchFile` 在自己第一次 stat 时记录基线，对在此之前就已创建的文件什么都不报告。

## 决策

文件系统 event 不再是唯一的触发源。`watchUserPatches` 还会按 `repairInterval` 做协调——除非调用方另行指定，否则为 100 毫秒——两个触发源共用同一套协调逻辑：读取文件，并对它文本的每一代恰好应用一次：

- 已挂载树所反映的那一代在注册时以文件内容播种，因为 `boot()` 在该调用之前已经应用过同一份内容。因此未变更的文件每个 tick 只花一次读取，不产生树更新。
- 该代在被尝试之前就先记录下来，因此无论哪个触发源观察到它，损坏的文件都只被应用并报告一次；读取失败按其消息去重，所以持续不可读的文件不会每个 tick 都被重复报告。
- 各次协调运行在同一条 promise 链上。两次同时在途的 `entry.update()` 会在同一棵 Include 树上交错地应用候选与回滚，而两个触发源观察的是同一个文件。
- 修复触发源通过 `hmr/config-update-failed` 报告自身失败，该 event 正是 HMR 为 watch 触发源广播的那一个，因此同一个损坏文件在两条路径上读起来一致。它自己观察方的 rejection 被就地容纳。
- 该节拍是一个 `ctx.effect`，因此树的释放会停止它——`apps/cli/src/profile-boot.ts` 丢弃返回的 disposer，正是依赖这一点。它的定时器做了 `unref`：修复节拍绝不能成为一个已结束进程仍然存活的原因。返回的 disposer 会先停止两个触发源，再排空该链。

这样换来的界限是明确的：无论平台层 watch 丢失了什么，已挂载的层与文件不一致的时间最多为一个 `repairInterval`。watch 触发源仍是快速路径，未作改动。

`settleChokidarChangeThrottle()`——测试套件在两代之间保持的一次 75 毫秒睡眠——已被删除。它的存在是为了应对 Chokidar 独立的 50 毫秒每路径 `change` 节流，该节流会静默丢弃窗口内的第二次写入；有了修复节拍，被节流掉的 event 就与任何其他未送达的 event 一样被修复。回退源码而保留这处删除，会让该用例在 `parse failure was not broadcast` 处失败，那正是这个节流。

## 考虑过的替代方案

**在返回之前证明 watch 已装配。** 这是「让就绪名副其实」的直接解读，而这个证明必须是一次由该 watcher 自己报告的变更。`watchUserPatches` 只会听到被 watch 的那个路径的消息，因此探测对象只能是用户自己的 `cordis.patch.yml`——也就是去创建并删除它本应观察的那个文件。在 watch 根目录下探测另一个名字比听起来更糟：`registerConfig` 把 watcher 扎根在最深的已存在祖先目录上，对于尚不存在的 profile 目录来说那就是 Harness home 或用户 home，而一个在启动中途被杀掉的 `dsh` 会把探测残留在那里。

**用 `fs.watchFile` 轮询文件而不是用定时器。** 它看起来是更小的改动，却修不了这个缺陷。libuv 的 `uv_fs_poll` 把第一次 stat 存为基线而不报告它，因此在 `watchFile()` 与那次 stat 之间创建的文件会被轮询漏掉，正如它被 watch 漏掉一样。把文件文本与已应用的那一代作比较则不存在基线时刻，这也正是修复逻辑读取内容而非 stat 元数据的原因——与 `hmr-config.spec.ts` 采用增长 fixture（测试前置数据）文件而非信任时间戳是同一个理由。

**在 `ready` 之后再协调一次。** 在注册之后多读一次，能关闭 Chokidar 扫描与那次读取之间的空隙，却留下那次读取与已装配的流之间的空隙——而测试正好落在后者，因为它是在 `watchUserPatches` 返回之后才写入的。

**改为修 `Hmr.registerConfig`。** 这个窗口属于 watch seam，而 `registerConfig` 的另一个调用方也有同样的缺陷：`hmr-config.spec.ts` :: `observes creation when the config parent did not exist at registration` 在本次工作期间以 `HMR did not observe config creation under a new parent` 失败过。seam 层面的修法同样需要一个装配证明，也就撞上上面那个探测难题，因此改由拥有 patch 文件约定的那一层来强制它。vendored seam 未作改动。

## 后果

每个已注册的 patch 文件每 100 毫秒读一次小文件——一个 `dsh` profile 是两个——持续整个会话，换来的是该层与文件可以不一致多久的界限。位于更易丢事件或更昂贵文件系统上的调用方可以调整 `repairInterval`。

该 seam 的就绪约定未变，并且仍比字面读起来更弱：`registerConfig` 在 Chokidar 报告就绪时报告就绪。它的其他所有消费方都保留着这个窗口，`hmr-config.spec.ts` 也包含在内。

`user-patches.spec.ts` 直接钉住修复路径，而不是去和它赛跑。有三个用例注册了一个永不回调的 watcher——即「watch 在自身就绪信号之后才装配」的形态——因此它们测量的是节拍：一次未被报告的新增与删除会被应用，一代损坏内容只被广播一次且随后的恢复仍能落地，一个非 `Error` 的 rejection 会被规范化而抛错的观察方不会中断节拍。第四个用例把节拍设到够不着的位置，改为手工驱动共享的协调逻辑，钉住未变更的、不可读的以及已应用过的三种代都协调为无操作。
