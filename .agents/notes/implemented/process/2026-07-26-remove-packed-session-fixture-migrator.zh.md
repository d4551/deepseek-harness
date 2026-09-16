# Agent Note: 移除打包会话 fixture 分支迁移器

Status: implemented

[English](2026-07-26-remove-packed-session-fixture-migrator.md) | 中文

## 问题

[规范 fixture 写入器](../bug-fix/2026-09-03-canonical-session-fixture-write-back.zh.md)将录制与刷新的会话投影为独立布局检查要求的打包布局。独立的仓库级转换命令曾帮助较旧的开放分支在不重新录制模型输出的情况下收敛。该分支过渡结束后，保留第二个写入命令会模糊 fixture（测试前置数据）维护的归属。

## 决策

移除分支迁移器及其根包命令。2026-09-16 对 `d4551/deepseek-harness` 与 `deepseek-ai/deepseek-harness` 的实时开放拉取请求清单均为空，满足提案中没有开放分支仍依赖转换的条件。

保留[规范布局转换器](../../../../scripts/session-fixture-layout.ts)、[布局测试](../../../../scripts/session-fixture-layout.spec.ts)和常规录制/刷新投影。检查继续发现仓库 fixture、比较规范字节、保留 header 与解码后的事件 payload、验证幂等性，并拒绝畸形记录。诊断引导维护者检查 fixture 写入器，而非运行第二个修改命令。

测试政策和快照包 README 描述永久投影与只读检查。[打包行默认值](../architecture/2026-07-26-packed-chunk-rows-by-default.zh.md)保持不变。删除保留 fixture 投影与严格比较约定。

## 验证

布局与快照规范化测试的全部 73 个用例通过，覆盖永久投影、存储来源区间展开、被 flush 切分的 chunk run、保留的时间间隔，以及仓库 fixture 清单。完整录制会话通道的全部 107 项测试在不写回、不跳过用例的情况下通过，包括 15 项 ACP（Agent Client Protocol）回放检查和两种 PowerShell 组合。运行使用 PowerShell 7.6.6，以及终端清理所需的宿主进程检查权限。ACP 发现由宿主 TypeScript 项目负责，共享预期遵循各自的规范责任方。责任方刷新保留当前运行时策略事件、工具约定和生成的时间间隔，同时保留回放的模型 payload。开放分支清单不能替代 fixture 检查。

## 曾考虑的替代方案

**无限期保留命令。** 已知分支过渡结束后，转换方便不足以支持保留仓库级写入器。投影与独立检查负责持续维护。

**随 CLI 一起移除规范布局转换模块。** 该模块定义布局测试使用的独立判据。移除它会移除强制机制，而不是债务。

**打包行首次进入 master 时就移除命令。** 较旧的开放分支仍可能需要转换，这会增加冲突风险，并让事件 payload 保真度更难评审。移除必须依据实时分支清单，而不是经过的时间。

## 后果

fixture 维护只有一条写入路径和一项独立的只读布局检查。实时拉取请求清单之外的分支，在解决旧 fixture 改动时必须使用当前投影并保留解码后的 payload。未来若需要转换命令，必须有明确的迁移责任方及新的有界移除条件。
