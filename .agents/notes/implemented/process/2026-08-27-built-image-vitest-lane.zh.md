# Agent Note：构建镜像套件独立运行在自己的 vitest 车道

Status: implemented

[English](2026-08-27-built-image-vitest-lane.md) | 中文

## 问题

`packages/experimental/webworker-packer/tests/image-loadable.spec.ts` 在单元车道内一个文件里承担了两件不相关的工作：对仓库知识的快速源码树断言（工作区索引、配置树、preview fixture、pack 报告），以及物化已输出的 `lib/` 并通过真实 runtime 镜像 loader 加载的慢速 fixture。[覆盖率豁免名单](2026-07-31-coverage-exempt-heavy-suites.zh.md)把整个文件当作重型套件豁免，于是"单元断言坏了"与"构建产物缺失"无法区分，单元那一半还白付了自己从不需要的插桩开销。

## 决策

按平面拆分，遵循仓库的源码平面/产物平面规则：

- 单元车道（`vitest.config.ts`，有插桩）：`vfs-overlay.spec.ts` 从源码树打包 overlay 档案；`image-loadable.spec.ts` 只覆盖仓库知识。
- 内置产物车道（`vitest.built.config.ts`，`forks` 池，每进程一个文件）：`*.built.ts` 套件物化已输出的 `lib/` 并通过真实镜像 loader 加载。它们作为 `scripts/run-gates.ts` 中的 `built-image-specs` 门禁运行，插入在 `ci-primary` 与 `ci-artifact` 的 `built-artifact-specs` 之后，并声明 `build` 依赖。
- 名单条目已删除：内置产物车道完全位于覆盖率聚合之外，不再需要豁免；knip 通过 `knip.json` 中显式的 workspace 条目可达 `tests/*.built.ts`。

## 验证

- `bun run vitest run packages/experimental/webworker-packer/tests/image-loadable.spec.ts packages/experimental/webworker-packer/tests/vfs-overlay.spec.ts` —— 单元一半，通过。
- `bun run vitest run --config vitest.built.config.ts` —— 10 个内置用例，无跳过。
- `bun run vitest run scripts/run-gates.spec.ts` —— 聚合图覆盖新门禁。
- `bun run knip` —— `tests/*.built.ts` 可达。

## 备选方案

- **保留单一豁免套件并修正其注释。** 否决：插桩/无插桩拆分仍然把单元断言与产物可用性混在一起，而且每个新的 packer 测试都要么继承豁免、要么把子进程 fixture 拖进单元车道。
- **在 `vitest.config.ts` 内部加一个独立 vitest project。** 否决：单元配置通过 tsconfig `paths` 把工作区导入解析到 `src`，而内置产物套件必须解析已输出的 `lib/`；一份配置无法同时承载两种解析而不对其中一个平面说谎。

## 后果

- `lib/` 未输出或过期时，`built-image-specs` 大声失败，而不是被跳过或拖累单元覆盖率。
- 新的 packer 测试按读取对象选平面：源码树 → `*.spec.ts`；产物输出 → `*.built.ts`。
