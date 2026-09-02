# Agent Note: 根 manifest 依赖版本下限按构造保持完整

Status: implemented

[English](2026-09-03-root-dependency-floors-complete-by-construction.md) | 中文

## Problem

[`scripts/live-stack-floors.ts`](../../../../scripts/live-stack-floors.ts) 断言已声明的依赖范围不低于某个版本下限，但它检查的依赖族是手工列出的。若某个依赖被加入根 manifest（元数据清单）而没有对应条目，它就不会与任何版本比较，于是以作者当初安装的版本发布并一直停留在那里。依赖缺少版本下限时没有任何检查失败，因此这份清单只能靠人记得去扩充。

`declaredRange()` 使这一问题更严重。它用正则表达式在 manifest 原始文本上匹配 `"name": "value"`，因此文件中任何位置的第一个此类键值对都会胜出，包括 `scripts`。根 manifest 在 `knip` 依赖之上声明了一个 `knip` 脚本（`knip --treat-config-hints-as-errors`），于是门禁把那条命令行读作 knip 的版本范围，并在第一次被查询时抛出 `unparseable version range`。

## Decision

`ROOT_DEPENDENCY_FLOORS` 列出根 manifest 声明的每一个非工作区依赖，并映射到本仓库发布的版本。当 manifest 声明了该映射中没有的依赖时，`unflooredRootDependencies()` 失败，因此新增依赖时必须说明它永不可低于的版本。工作区 manifest 同样检查的依赖族复用导出的版本下限常量，而不是重复写一遍数字。

之所以以根 manifest 为范围，是因为工具链在那里声明：编译器、打包器、测试运行器、lint 工具、变异测试运行器和文档工具都从那里解析，那里的陈旧声明会削弱其下的每一道门禁。`workspace:` 范围被排除，因为它们指向本仓库内的包，其版本随发布一同变化，注册表版本下限无法描述任何事实。

`declaredRange()` 解析 manifest，并按 `dependencies`、`devDependencies`、`peerDependencies`、`optionalDependencies` 的顺序读取。格式错误的 manifest、非对象的依赖分组或非字符串的范围都会抛错，而不是解析为 `undefined`。

完整性规则查出三处陈旧声明，并在同一次改动中提升：`jscpd` 从 `^5.0.16` 到 `^5.1.1`，`knip` 从 `^6.33.0` 到 `^6.34.0`，`oxlint` 从 `1.80.0` 到 `1.81.0`。`@types/node` 保持 `^26.4.0`。`26.4.1` 已存在，而 [`bunfig.toml`](../../../../bunfig.toml) 的 `minimumReleaseAge` 为 86400 秒，拒绝发布不足一天的版本；该供应链控制优先于一次补丁版本提升，因此版本下限停留在该策略允许安装落地的位置。

## Alternatives considered

**向注册表查询每个依赖的最新版本。** 这样无需手工映射即可发现陈旧声明，但门禁内需要网络访问，不同日期返回不同结果，且上游任何一次发布都会让未改动的代码树变红。

**要求每个工作区 manifest 中的每个依赖都有版本下限。** 包 manifest 声明的大多是 `workspace:` 范围，外加少量运行时依赖，而决定每道门禁强度的工具链在根 manifest 声明。扩大规则会为发现同样的漂移增加数百个条目。

**保留文本扫描，只把 `scripts` 排除在外。** 冲突范围比 `scripts` 更广：任何持有 `"name": "value"` 键值对的 manifest 字段都可能遮蔽同名依赖。读取依赖分组消除的是整类问题，而不是其中一个实例。

## Consequences

新增根依赖时必须在同一次改动中写明其版本下限，提升版本时也必须一并提升下限。这一代价换来一份不会在无人察觉时落后的清单：每次运行都会将该映射与 manifest 比对，遗漏即失败。

修复 `declaredRange()` 也惠及其他所有调用方。`rangeMisses()` 现在在所有工作区 manifest 中读取真实的依赖声明，因此与依赖同名的脚本或任何其他字段都不会再被当作该依赖的版本进行比较。
