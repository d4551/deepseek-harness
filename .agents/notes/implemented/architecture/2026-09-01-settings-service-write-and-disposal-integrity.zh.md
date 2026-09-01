# Agent Note：settings 服务的写入与释放完整性

Status: implemented

[English](2026-09-01-settings-service-write-and-disposal-integrity.md) | 中文

## Problem

`packages/settings/settings/src/index.ts` 中的三个标记，分别指出了服务可能报告出存储中并不存在的值的三条路径。

`TODO(settings-json-properties)` 覆盖两处以普通赋值重建文档的位置。`cloneJsonShaped` 写的是 `out[key] = ...`，`mergeLayers` 写的是 `merged[key] = ...`。`__proto__` 在 JSON 文档中是一个普通键，但普通赋值会经由继承而来的 `Object.prototype.__proto__` setter，因此该条目永远不会成为自有数据。`mergeLayers` 还以 `key in merged` 判断存在性，而 `in` 会查原型链，于是名为 `toString` 或 `constructor` 的键会被读成已存在，从而走合并路径而非赋值路径。

`TODO(settings-registration-quiescence)` 覆盖注册释放器，它执行 `this.registrations.delete(ns)` 后即返回。经该 scope 注册的 watcher 仍保持 `active: true`，其排队的 tail 也继续运行，因此某个 fiber 所拥有的回调可能在该 fiber 卸载之后才执行。单个 watcher 的释放器已能停用它自己；但没有任何东西为整个注册做这件事。

`TODO(settings-replacement-resync)` 覆盖写队列的提交步骤。排队的写入读取队首时刻的 section，持久化，然后仅在 `if (this.registrations.get(ns) === registration)` 成立时提交。当原注册方在持久化中途被释放、而一个替代者注册了同一 namespace 时，该判断为假，于是写入落进了存储，新的持有者却从未被告知。替代者是依据写入落盘之前的 section 解析的，并会无限期保留那个值。

## Decision

**文档键以自有数据形式存储。** `defineOwn` 辅助函数以 writable、enumerable、configurable 的描述符经 `Object.defineProperty` 写入，两处重建位置均改用它。`mergeLayers` 以 `Object.hasOwn` 而非 `in` 判断存在性，因此继承而来的方法名是一个不存在的键，而不是合并目标。

**释放达到静默。** 注册释放器改为异步。它删除注册表条目，停用该注册所拥有的每一个 watcher，清空集合，然后等待此前捕获的 tail。这个顺序正是[防御式模式](../../../../docs/defensive-patterns.zh.md)所述：先关闭通知登记表，使排队中的调用在其开始时读到 `active` 并静默返回，再等待已开始的调用，从而不会有回调比注册方 fiber 活得更久。

**已持久化的写入总会抵达 namespace 的持有者。** 提交步骤只解析一次当前持有者。持有者即写入方时，按原方式提交。当持有者是替代者时，则依据真正落盘的 section、按替代者自己的 schema 重新解析并提交。若该 section 无法通过替代者的 schema，则保留其上一个良好值并告警，与 `publish` 处理无效存储 section 的既有方式一致。

## Alternatives considered

**以 `Object.create(null)` 重建对象。** 通过去掉原型来消除 setter 风险。否决：它会改变每一个在解析后的 settings 值上调用原型方法的消费方，是远超该缺陷所需的行为变更，并会让解析值的打印与比较方式都发生变化。

**只停用 watcher 的同步释放器。** 能阻止新的调用，但会在某个已开始的回调仍在运行时返回，而这正是静默规则所指的孤儿。

**让替代者自行重新读取。** 替代者无从得知自己注册时有一笔写入正在途中，因此该读取只能是轮询，或是每次注册都无条件重新解析。写入方本就持有已持久化的 section 与持有者查找结果，因此由它据此提交。

## Consequences

- 名为 `__proto__` 的文档键可经一次写入往返，并出现在 `describe()` 报告的 `user` 层中。
- 注册方 fiber 的 `dispose()` 只在其 watcher 回调结束后才落定；等待释放的调用方现在会等待它们。
- 在替代者接手 namespace 时仍在途中的写入，会给该替代者送达一次 `settings/updated` 提交与一次修订号递增。
- 服务之下的 schema 层此前以普通赋值重建，会在回传途中丢掉该键，因此 `vendor/schemastery` 同步带有一处自有属性构造的改动，作为本地修改 20 记录在 [vendor/README.md](../../../../vendor/README.md) 中。

## Testing

`packages/settings/settings/tests/settings.spec.ts` 新增三组用例。原型冲突键：一次写入将 `__proto__` 以自有数据记入持久化 section，所报告的 `user` 层保留其自有性且原型不变，继承方法名被解析为普通键。释放静默：在已开始的回调阻塞期间释放保持挂起，并在其结束后落定；在释放开始时仍处于排队中的调用绝不运行。替代者重解析：在被挂起的 `persist` 期间接手 namespace 的替代者会依据已持久化的 section 重新解析，而 schema 无法接受该 section 的替代者则保留其上一个良好值并告警。三处修复均在原位被逐一回退，并在恢复之前观察到对应用例失败。该文件保持逐文件 100% 的语句、分支、函数与行覆盖。
