# Agent Note: 精确配置 watch 会修复平台 watch 从未报告的变更

Status: implemented

[English](2026-09-03-hmr-exact-config-repair-cadence.md) | 中文

## 问题

`Hmr.registerConfig(filename, refresh)` 只有一个触发源：Chokidar 在被 watch 路径上的 `add`、`change` 与 `unlink`。Chokidar 在初始扫描完成且 `fs.watch()` 返回后才报告 `ready`，而在 macOS 上，libuv 是在该调用返回之后，才在自己的 CoreFoundation run-loop 线程上装配 FSEvents 流。落在「扫描已结束」与「流已装配」之间的变更两边都不属于，不产生任何 event，并且永久丢失——注册的回调因此与文件不一致，直到某次后来的变更恰好被报告出来。

[用户 patch 那篇笔记](2026-09-03-user-patch-watch-readiness.zh.md)通过给该消费方增加第二个触发源，为 `watchUserPatches` 关闭了这个窗口，并记录了 seam 本身仍保留该窗口：「它的其他所有消费方都保留着这个窗口，`hmr-config.spec.ts` 也包含在内。」那正是仍然存活的缺陷。`packages/boot/app-boot/tests/hmr-config.spec.ts` 直接调用 `registerConfig`，且不从 `app-boot/src` 导入任何东西，因此消费方层面的修复够不到它。在 CPU 负载下，它 20 次运行失败 2 次，报 `HMR did not observe config creation` 与 `HMR did not observe config creation under a new parent`：

```
FAIL  packages/boot/app-boot/tests/hmr-config.spec.ts > HMR exact config paths >
      observes creation when the config parent did not exist at registration
Error: HMR did not observe config creation under a new parent
 ❯ eventually packages/boot/app-boot/tests/hmr-config.spec.ts:29:39
```

在 seam 层而非经由测试套件度量：注册一个配置路径、并在注册 resolve 之后的那一轮创建该文件，在一台负载中的 18 核主机上，分 10、300、500 三批共 810 个回合丢失 6 次。加入该节律后在更重负载下重跑最大的一批，500 个回合丢失 0 次。丢失来自装配窗口，而不是 Chokidar 的某个过滤器——姊妹笔记的插桩显示 watcher 发出了 `ready`，其后从未出现 `raw` 行。

## 决策

文件系统 event 不再是唯一的触发源。`registerConfig` 每 `repairInterval` 毫秒运行一次修复协调——这是 `Hmr.Config` 的新字段，`z.natural().role('ms').default(100)`，取 `0` 表示只跑 watch——两个触发源共用既有的串行 `refreshConfig` 队列，经由同一套协调逻辑，对每一代恰好宣告一次：

- 一代是文件内容的 SHA-256；路径不存在时为 `absent`，路径存在但不可读时为 `error:<code>`。用内容而非 stat 元数据：时间戳精度为一秒的文件系统，对两次等长写入会报告相同的 mtime 与 size，而这正是一次普通的配置编辑；轮询自己的第一次 stat 又是它永不报告的基线——同一缺陷只是下沉了一层。
- 读取是同步的，因此本线程上的写入方不可能在其截断与写入之间被观察到。异步读取会采到一个撕裂的零字节代并把它宣告出去。
- 播种值是 absent 那一代，这正是 `ignoreInitial: false` 本就承诺的语义：注册时已存在的文件宣告一次，不存在的文件完全不宣告。
- 该代在回调运行之前就先记录下来，因此刷新抛错的那一代只被报告一次——仍通过 `hmr/config-update-failed`——无论哪个触发源观察到它；持续不可读的路径也不会每个 tick 都被重复报告。
- 注册释放与 `Service.init` 拆卸会在排空队列之前先停掉该节律，因此不会再有新工作进入队列。其 timer 做了 `unref`：修复节律绝不能成为一个已完成的进程仍然存活的原因。

于是，无论平台 watch 丢失什么，回调落后其文件至多一个 `repairInterval`，并且绝不会看到同一代两次。watch 仍是快路径，其余部分未作改动。

`hmr-config.spec.ts` 直接钉住该节律，而不是与它赛跑：一个用例注册了一个在自身生命周期内不可能报告任何东西的 watch——Chokidar 以一分钟为间隔轮询，对空目录的初始扫描是它唯一的投递——并断言一次创建、一次等长变更与一次移除各自恰好抵达回调一次。两个既有用例从去重断言收紧为精确的宣告序列，因为那已是当前的保证；失败用例则删去了它为 Chokidar 单路径变更节流而保留的 250 毫秒等待：被节流丢掉的 event，就是修复节律会像宣告任何其他「无 event 报告」的一代那样宣告的一代。

## 备选方案

**在返回之前证明 watch 已装配。** 这个证明必须是一次由 watcher 自己报告的变更，而 `registerConfig` 把 watcher 扎根在最深的已存在祖先目录上——对尚不存在的 profile 目录来说，那就是 Harness home 或用户 home。探测要么去创建调用方自己的配置文件，要么在进程于启动中途被杀时把一个残留文件留在用户 home 里。姊妹笔记在上一层出于同样理由否决了它。

**对 `stat` 而非内容做指纹。** 每个 tick 一次 stat 而非一次读取，也正是轮询式 watcher 所比较的东西。它会漏掉落在同一个文件系统时间戳刻度内的两次等长写入，而在精度为一秒的文件系统上那就是一次普通编辑——恰恰是该节律要捕捉的那类丢失。它省下的成本是每 100 毫秒读取一个配置文件。

**既然 `watchUserPatches` 已修复自己的文件，就不动 seam。** 那个修复覆盖的是一个消费方里的一条路径。`registerConfig` 是一个已公布的 seam 方法，其就绪约定读起来比实际更强，而它的覆盖率位于一个完全不经过该消费方的测试套件里。在 seam 层修复能让当前与将来的每个调用方都正确，且消费方自己的节律保留：它按已应用文本去重，因此多出的触发源协调下来什么也不做。

**watch 投递首个 event 之后就停掉节律。** 这会把成本限制在装配窗口内，而该缺陷正是在那里度量到的。但它同时假设装配窗口是唯一的丢失来源，而 FSEvents 合并、网络文件系统与 Chokidar 自己的变更节流，都会在装配之后很久继续丢事件。常驻节律是一种行为加一条明确的界限，而不是两种行为外加一次交接。

**把精确 watch 改成 `usePolling`。** Chokidar 的轮询后端把自己的第一次 stat 当作永不报告的基线，因此在扫描与该次 stat 之间创建的文件会被漏掉，与原生 watch 漏掉它的方式完全一样，而此后每次变更都要付出一个轮询间隔。

## 影响

每个已注册路径在其注册存续期内，每 100 毫秒读取一次配置文件，换来的是「回调落后其文件多久」的一条界限。文件系统更易丢事件或读取更昂贵的部署可以调高 `repairInterval`；取 `0` 则恢复平台自身的丢失。

`dsh` 现在每 100 毫秒读取 profile 的 `cordis.patch.yml` 两次——本节律一次，消费方节律一次。两者都会把未变更的文件协调为无操作，而消费方的节律覆盖的是 seam 被打桩的场景。

vendored 分歧记为 [vendor/README.md](../../../../vendor/README.md) 的第 21 条，以便下次上游同步时有意识地重新施加或退役它。

seam 的就绪约定未变：`registerConfig` 仍在 Chokidar 报告就绪时报告就绪。变的是就绪不再承重——错过装配窗口的回调会被修复，而不是被搁浅。

普通 HMR watcher 的配置刷新路径（`refreshConfig(include, …)`）未作改动，仍保留该窗口。它以 `ignoreInitial: true` 监视模块根目录，其文件在启动时已被应用过，且它那一代归拥有该文件的 Include 所有。
