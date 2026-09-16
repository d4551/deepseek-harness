# Agent Note: 存储根目录落点与派生介质恢复

Status: implemented

[English](2026-07-28-storage-root-and-derived-medium-recovery.md) | 中文

## 问题

持久投影缓存需要稳定的存储位置和适合派生数据的恢复方式。工作目录改变后再解析相对后端根目录，可能使同一个后端的记录分散到多个目录。一个检查点不符合 schema 就拒绝整个缓存，可能阻止初始化，即使权威会话历史可以重建缺失的值。权威工作区记录则需要相反的保护：打开损坏数据不能将其删除。

## 决策

### 共享存储根，在构造时解析

[base 组合包](../../../../packages/bundle/base/cordis.patch.yml)通过 `!!js dshHomePath('storages')` 配置 `storage-json.root`，使其位于会话根旁边。[home 解析器](2026-07-24-single-harness-home-resolver.zh.md)负责 `$DSH_HOME` 和默认的 `~/.dsh`；组合配置不重复其路径规则。部署可以通过配置 patch 层覆盖拥有该配置的插件行。

[`JsonStorageBackend`](../../../../packages/storage/storage-json/src/index.ts) 在构造时保存 `resolve(root)`。首次打开、通过现有句柄操作以及后续打开 unit，在工作目录改变后都使用这一位置。解析既不移动已有文件，也不重置记录。共享位置同时保护缓存和权威 `workspace.json`。

### 显式恢复单条派生记录

[`DomainTableSpec`](../../../../packages/storage/storage-domain/src/spec.ts) 包含 `rebuildable?: true`；`domainTable(schema, { rebuildable: true })` 声明可以从权威来源重建的记录。[投影缓存 spec](../../../../packages/session/session-projection-cache/src/spec.ts) 为 `sessions` 表启用此策略，并保留版本 4 和 `per-record` 布局。[每会话文件决策](2026-08-19-projection-cache-per-session-files.zh.md)负责介质布局和写入隔离的理由。

[`DomainFacility.open`](../../../../packages/storage/storage-domain/src/index.ts) 按各表 schema 校验后端返回的值。显式声明为可重建的表中，不符合 schema 的值会经 `KvUnit.deleteRecord` 持久删除；警告标明领域、表和键。相邻的有效记录保持不变。传到 facility 的后端读取或删除失败会拒绝打开，facility 仅在校验和恢复完成后发布领域。这是在一次打开期间删除记录，没有全域销毁或重新打开循环。

没有此声明的表会保留不符合 schema 的记录，并以 `invalid-record` 拒绝。无效的 global 始终拒绝。删除派生检查点不会触碰权威会话历史或工作区数据。消费方向缓存的 `coldSnapshot` 提供会话历史以重建检查点；正常缓存写入会持久保存重建的值。

JSON 逐记录后端通过不含检查点值的带版本不存在文档表达持久删除。其持久初始化状态可防止保留的整单元源恢复已删除记录。重建以原子方式替换不存在文档；[每会话文件决策](2026-08-19-projection-cache-per-session-files.zh.md)负责初始化与发布细节。

### 后端损坏和 schema 损坏由不同层负责

JSON [逐记录读取器](../../../../packages/storage/storage-json/src/per-record-unit.ts) 将格式错误、版本不同和不可读的记录文档视为缺失，但不删除它们。领域恢复策略只作用于读取器返回的值。当目录允许替换时，后续原子替换可以重建不可读的普通文件；占据记录路径的目录不会被自动移除。unit 或表的枚举失败、整单元导入期间的源文件读取失败以及删除失败仍然可见。JSON 单文档读取器拒绝格式错误或版本不同的介质；可重建表选项不会重置在记录校验之前就拒绝的后端。

## 备选方案

**按启动目录存储。** 会话历史是全局的，因此依赖目录的存储会使派生检查点与其权威来源分离，并使工作区记录依赖启动位置。

**launcher patch 加独立的 `storageRoot` profile 键。** 拥有配置的插件行已经接受路径表达式和部署覆盖。第二个改写点会重复根目录策略，却没有增加消费方需求。

**仅让缓存使用全局根，工作区仍按目录存储。** 工作区记录需要同样的位置稳定性。一个后端根使两类介质保持同址。

**在缓存插件内恢复。** 在该层命名或删除后端文件会越过存储抽象，并让每个派生消费方重复实现 schema 恢复。领域 facility 已经负责记录校验。

**损坏后使用仅内存的短生命周期领域。** 这会在进程余生静默失去持久性，并在下次启动时留下未修复的损坏介质。

**将损坏的派生记录改名旁置。** 会话历史可以提供重建，而保留副本会无界累积。此决策只允许删除显式声明为可重建的记录；权威数据的恢复需要独立的保留策略。

**自动重置每个领域。** 工作区记录是权威用户数据。其 schema 失败不能授权删除；拥有方必须逐表声明可重建性。

**通过 `KvFacet.destroy` 重置全域。** 一个无效的会话检查点不足以支持丢弃相邻有效记录或增加破坏性的后端操作。逐记录恢复使用现有删除约定，并保留未受影响的数据。

## 后果

根目录位置在多次启动和后续工作目录变化中保持稳定。不符合 schema 的派生检查点需要从会话历史重建，但不会阻止其余缓存打开。错误的可重建声明可能删除数据，因此表的拥有方必须具备权威重建来源。恢复不是覆盖所有表的事务：后续失败不会还原已经删除的派生记录。领域层不会把环境故障重新分类为 schema 损坏。

## 验证

[根目录位置测试](../../../../packages/storage/storage-json/tests/root-location.spec.ts)覆盖两种布局，在首次打开前和句柄存续期间改变目录。[领域恢复测试](../../../../packages/storage/storage-domain/tests/recovery.spec.ts)检查持久删除、保留相邻记录、拒绝无效权威记录和 global，以及 unit 读取失败。[缓存恢复测试](../../../../packages/session/session-projection-cache/tests/recovery.spec.ts)通过真实 Loader、JSON 存储和 JSONL 历史跨重启验证，包括重建前重启、工作区和会话日志字节不变、替换不可读记录和拒绝删除。本地证据来自 macOS；权限 fixture（测试前置数据）的原生 Windows ACL 路径未在本地验证。这些检查不代表仓库整体覆盖率、变异测试或平台验证完成。
