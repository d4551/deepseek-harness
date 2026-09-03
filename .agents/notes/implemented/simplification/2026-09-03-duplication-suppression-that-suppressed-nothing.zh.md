# Agent Note：一个在 562 处文件内豁免之上报告零结果的重复检测门禁

Status: implemented

[English](2026-09-03-duplication-suppression-that-suppressed-nothing.md) | 中文

## 问题

`bun run duplication` 在 1,657 个文件上报告零处克隆，而源码中立着 562 个 `jscpd:ignore` 标记。281 个被标记的区域中，223 个以裸的 `/* jscpd:ignore-start */` 开头，58 个在 `--` 之后带行内理由。

对这套机制的第一次判读是错的，之所以记在这里，是因为错的是方法。`.jscpd.json` 带有一条只匹配裸分隔符的 `ignorePattern` 正则，带理由的写法匹配不上它——本笔记据此断定凡是写了理由的标记都没有豁免任何东西。那测的是配置里的正则，不是工具本身。jscpd 通过它自己内建的标记处理承认两种写法，而 `ignorePattern` 条目只是重复了这件事。对着 jscpd 本身在一个双文件夹具上实测：保留带理由的标记，0 处克隆；移除标记，1 处克隆；换成裸标记，0 处克隆。两种写法的豁免都是真的。

这些标记实际藏起了什么，用移除标记后重跑门禁来度量：223 个裸标记后面 45 处克隆，58 个带理由的标记后面约 90 处。一个在 135 处克隆立在文件内注释后面时报告零结果的门禁，度量的是注释，不是代码。

## 决定

三组里有两组已经了结，第三组是本笔记并不声称已完成的开放工作。

223 个裸标记已经删除。一个不说明理由就压制发现的标记，就是没有正当理由的覆盖，而它们后面的 45 处克隆是真的：25 处在三个生成的目录文件里，20 处是人写的。生成的目录文件写进 `.jscpd.json` 的 `ignore` 列表——豁免变成每个文件一行可供评审的声明，而不是埋在生成器输出里的一对分隔符；`scripts/gen-client-catalog.ts` 与 `packages/typert/generator/src/cordis-catalog.ts` 不再往它们写出的文件里发射标记。20 处人写的克隆用提取修复：共享的 hook 桥接与 invariant 伴生插件管道、两个 `cordis-*-runner` 平面、`bash-sandbox`/`pwsh-sandbox` 的 helpers，以及两个 session-persistence 提供方。

58 个带理由的标记同样已经删除，它们的散文以普通注释的形式留在原处。它们的理由是真实的——多数指明一处记录在 Agent Note 里的、刻意的 bash/pwsh 镜像——但写在豁免旁边的理由仍然是门禁看不穿的豁免；而其中一处镜像，在标记不再遮挡之后，被发现是 110 行逐字节相同的代码，干净地提取进了 `@deepseek-ai/dsh-shell/sandbox-classify`。为它辩护的那条注释是借口，不是平台差异。

移除它们让门禁停在约 90 处克隆的红色状态，集中在 `client/ui-chat`、`shell/tool-bash*`、`shell/bash-local`、`core/session` 与 `credentials/credentials-local`。这就是诚实的现状：重复一直都在，现在它可见了，而不是被压制着。

## 备选方案

**保留带理由的写法，只删裸的那种。** 这是站得住脚的折中：有记录的豁免与无记录的豁免不是一回事。之所以否决，是因为本分支的既定要求是任何理由都不能使一次覆盖变得可接受，也因为被仔细检查的那一处镜像是可提取的，这说明那些理由并非都承重。

**把标记恢复回去，让门禁重新变绿。** 只要它们存在，门禁就一直报告零结果。用重新藏起刚刚度量到的东西换来的绿色，价值低于点名工作量的红色。

**修正 `ignorePattern` 正则。** 既然真正实施豁免的是 jscpd 内建的处理，这条就无关紧要；配置条目只是重复它，单独删掉该条目什么也不改变。

## 影响

`bun run duplication` 覆盖整棵人写的树，并在剩余的克隆上以非零码退出。三个生成的目录文件按路径豁免。

这三个是 `packages/extensions/cordis-client-runner/src/client/slot-catalog.ts`（由 `scripts/gen-client-catalog.ts` 写出）、`packages/extensions/cordis-client-runner/src/client/api-catalog.ts`（`scripts/gen-cordis-inspect-catalog.ts`）和 `packages/extensions/tool-cordis/src/api-catalog.ts`（`scripts/gen-cordis-catalog.ts`）。没有一个是人写的：每个都从类型图重新生成，并由各自的 `verify-*-catalog` 门禁逐字节比对，签入的文本一旦偏离生成器的产出就失败。它们的克隆是投影器按构造发出的、每个 Service、每个方法、每个类型各一条的统一文本，因此要删掉一处克隆只能改生成器写出的内容，而那是为了满足一个以人写代码为对象的门禁去改动模型可见的目录文本。路径条目把这件事记下来；`duplication` 对每个由人编辑的文件保留全部权威。

文件内的逃生通道由一个门禁而非配置关闭，因为 jscpd 的标记处理是内建的，没有任何设置能关掉它：`scripts/no-duplication-overrides.ts` 在任何人写的源文件携带标记时失败，包括生成器写进其输出的那种，而 `.jscpd.json` 中现已冗余的 `ignorePattern` 条目已删除。豁免必须是该配置里的一条路径，评审看得见的地方。

度量方法记在上面，因为检查配置的正则而非工具的行为，产生了一个自信而错误的答案。
