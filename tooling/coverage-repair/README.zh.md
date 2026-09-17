---
description: "审查并重建覆盖率工具链的源码候选版本及其验证证据。"
---

# 覆盖率工具链源码候选版本

[English](README.md) | 中文

## Summary

审查运行器、转换器、编译器、运行时和包管理器修复的完整源码变更。根依赖图未安装这些候选版本。尚未通过的检查记录在 [status.json](status.json) 中。

## Table of Contents

- [重建源码](#reconstruct-source)
- [审查输入](#review-inputs)
- [Dev Note](#dev-note)

<a id="reconstruct-source"></a>

## 重建源码

使用 Python 3.12 或更高版本、Git，以及摘要与 [manifest.json](manifest.json) 一致的官方归档。重建命令会拒绝已存在的目标目录，并在应用可读的源码补丁后验证每个修改或新增的输入文件。该命令不会构建或安装候选版本。

```sh
repair_dir=$(mktemp -d)
python3 tooling/coverage-repair/reconstruct.py pnpm /tmp/dsh-pnpm-12.4.2-source.tgz "$repair_dir/pnpm"
```

从清单中选择其他源码及其归档，即可重建相应候选版本。清单保留原始本地路径以追溯来源。候选版本的依赖清单也保留验证时使用的路径；依赖迁移及锁文件协调仍属于集成工作。

<a id="review-inputs"></a>

## 审查输入

[源码补丁](patches/)包含实现、测试和构建输入的变更。[包产物](artifacts/)保留生成的包及其记录的哈希值。证据目录包含[历史规划归档](evidence/full-green-plan.tar.gz)、其[文件清单](evidence/full-green-plan-files.json)和[辅助证据清单](evidence/inputs.json)。历史报告保留失败结果，也可能描述中间状态；状态记录明确标识最终汇总状态。

## Dev Note

全部检查通过的目标尚未完成。此次汇总保留源码工作以供审查和提交，不代表已满足发布条件，也不会启用未完成的工具链。
