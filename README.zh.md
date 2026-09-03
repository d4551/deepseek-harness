# DeepSeek Harness

[English](README.md) | 中文

[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE) [![Node](https://img.shields.io/badge/node-%E2%89%A524-339933?logo=node.js&logoColor=white)](package.json) [![bun 1.4](https://img.shields.io/badge/bun-1.4-deadck?logo=bun)](package.json) [![TypeScript 7](https://img.shields.io/badge/TypeScript-7-3178c6?logo=typescript&logoColor=white)](package.json) [![Status: developer preview](https://img.shields.io/badge/status-developer%20preview-orange)](SAFETY.zh.md)

## 像给五岁小孩一样解释

DeepSeek Harness 是一个机器人助手的工具箱。你用大白话告诉机器人要做什么。机器人从箱子里挑工具——读文件、跑命令、搜网页——一步步完成工作，并把做过的一切展示给你。如果它想做有风险的事，会先征求你的同意。这个工具箱有一扇窗户（Web UI），你可以在里面看机器人干活并和它对话；它甚至能召唤更多机器人，一起共享一张待办清单（Agent Teams）。

DeepSeek Harness（`dsh`）是由 [DeepSeek AI](https://deepseek.com) 开发的开源 agent harness（智能体框架）。

它构建于**一切皆插件**的架构之上，由 [Cordis](https://github.com/cordiverse/cordis) 驱动，其设计参见论文 [_A Programming Paradigm for Spatiotemporal Composability_](https://arxiv.org/abs/2608.25512)。

文档：[https://deepseek-harness.github.io/deepseek-harness/](https://deepseek-harness.github.io/deepseek-harness/)

## 为什么选择本 fork

本仓库在上游 harness 之上扩展了 npm 包里拿不到的能力与工具链：

- **多智能体 swarm** —— 运行一个共享持久名册、任务看板与邮箱的智能体团队。一个 profile（`dsh --profile swarm`）即可无界面运行；`swarm-web` 把同一个团队带进 Web UI，并渲染实时 Team 行。
- **展示真实状态的 Web UI** —— 在浏览器里管理 workspace 根目录、通过生成的卡片编辑每个插件的设置，并用 diff、搜索、todo、轨迹卡片跟进工作。
- **浏览器级网页访问** —— 模型可以用真实 Chromium 实例抓取页面，需要 JavaScript 的站点也能读取；浏览器可执行文件、user agent 与渲染并发数均可配置。
- **强化的审批** —— 每次工具审批都必须给出理由，试图跳过或弱化用户指令的理由会被自动拒绝。
- **现代化工具链** —— bun 1.4 workspace、TypeScript 7、Node 24+（CI 验证），取代上游的 npm/yarn 时代配置。

## 获取本仓库的代码

本仓库不向 npm 发布任何包。`npx @deepseek-ai/dsh` 安装的是上游官方发行版而非本 fork——运行本仓库的代码请按下文[运行](#run)从源码构建。搭建细节见[开发指南](docs/development.zh.md)。

工具链要点：**bun 1.4** 是包管理器与脚本运行器（isolated workspace linker；`dsh plugin` 转发给 bun）；**TypeScript 7**（`typescript` ^7.0.2）编译 Host 与 Client program，并在 `typescript/unstable/sync` 与 `typescript/unstable/ast` 导出 compiler API。

从本仓库构建出的 Web UI 自称 **DeepMeow**，搭配猫脸标记；[Web UI 指南](docs/user/guide/index.zh.md#local-build-identity)说明了该名称出现的位置以及如何恢复 official 名称。

## 开发者预览

DeepSeek Harness 处于 _开发者预览_ 阶段，正在快速迭代。**未来将出现破坏兼容性的变更。**

运行本项目前，请阅读[安全说明](SAFETY.zh.md)。

<a id="run"></a>

## 运行

<a id="run-from-source"></a>

### 从源码运行

安装 `Node.js`，然后运行：

```sh
git clone https://github.com/d4551/deepseek-harness.git
cd deepseek-harness
bun install
bun run build
bun run dsh web
```

`bun run build` 会准备仓库产物。`bun run dsh web` 会直接使用这些已构建产物，不会重新构建。

最后一条命令默认会在 `http://127.0.0.1:3080` 启动 Web UI，本机启动时还会用默认浏览器打开页面。通过 SSH 启动时只打印宿主机 URL，因为本地转发地址由 SSH 客户端或编辑器持有。传入 `--no-open` 可仅运行服务器而不打开浏览器。详见 [Web UI 指南](docs/user/guide/index.zh.md)。

## 社区与支持

- 通过 [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions) 提交反馈或 bug 报告。
- 为你的插件仓库添加 [`dsh-plugin`](https://github.com/topics/dsh-plugin) 话题，便于被发现。
- 欢迎加入 DeepSeek Harness 企微群：扫码添加企微小助手并填写入群问卷，完成后小助手会邀请你入群。

<table>
  <thead>
    <tr>
      <th align="center">企微小助手</th>
      <th align="center">入群问卷</th>
      <th align="center">微信公众号</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="center"><img src="https://cdn.deepseek.com/harness/readme/community-wecom-assistant.png" alt="DeepSeek Harness 企微小助手二维码" width="180" height="180"></td>
      <td align="center"><a href="https://trtgsjkv6r.feishu.cn/share/base/form/shrcnIt5twSVdLGD52KJBckGCgg"><img src="https://cdn.deepseek.com/harness/readme/community-wecom-survey.png" alt="DeepSeek Harness 入群问卷二维码" width="180" height="180"></a></td>
      <td align="center"><img src="https://cdn.deepseek.com/harness/readme/community-wechat-official-account.png" alt="DeepSeek Harness 团队微信公众号二维码" width="180" height="180"></td>
    </tr>
  </tbody>
</table>

## 参与贡献

参见 [CONTRIBUTING.md](CONTRIBUTING.zh.md)。

## 开发

请先阅读[开发指南](docs/development.zh.md)与[架构文档](docs/architecture.zh.md)。

面向 agent：请遵循 [AGENTS.md](AGENTS.md)。

## 许可证

[MIT](LICENSE)

第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
