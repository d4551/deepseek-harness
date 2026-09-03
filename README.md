# DeepSeek Harness

English | [中文](README.zh.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Runtime: Node](https://img.shields.io/badge/node-%E2%89%A524-339933?logo=node.js&logoColor=white)](package.json)
[![Package manager: bun](https://img.shields.io/badge/bun-1.4-deadck?logo=bun)](package.json)
[![TypeScript 7](https://img.shields.io/badge/TypeScript-7-3178c6?logo=typescript&logoColor=white)](package.json)
[![Status: developer preview](https://img.shields.io/badge/status-developer%20preview-orange)](SAFETY.md)

## Explain it like I'm five

DeepSeek Harness is a robot helper's toolbox. You tell the robot what to do in plain words. The robot picks tools from the box — read files, run commands, search the web — does the job step by step, and shows you everything it did. If it wants to do something risky, it asks you first. This toolbox has a window (the Web UI) where you can watch the robot work and talk to it, and it can even bring in more robots that share a to-do list (Agent Teams).

DeepSeek Harness (`dsh`) is an open-source agent harness developed by [DeepSeek AI](https://deepseek.com).

It is built on an **everything-is-a-plugin** architecture and powered by [Cordis](https://github.com/cordiverse/cordis), whose design is described in [_A Programming Paradigm for Spatiotemporal Composability_](https://arxiv.org/abs/2608.25512).

Documentation: [https://deepseek-harness.github.io/deepseek-harness/](https://deepseek-harness.github.io/deepseek-harness/)

## This repository

This repository is a fork of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) with a different contributor toolchain. Product identity, plugin architecture, Node runtime, community channels, and license stay with upstream.

- **bun 1.4** is the package manager and script runner (`packageManager` in `package.json`). Workspace linking uses bun's isolated linker; `dsh plugin` forwards to bun. Native addons and the single-exe build remain Node artifacts on the documented Node engines.
- **TypeScript 7** (`typescript` ^7.0.2) compiles Host and Client programs. The package exports the compiler API at `typescript/unstable/sync` and `typescript/unstable/ast`, and every compiler-API consumer imports it from there.

No package is published from this fork: `npx @deepseek-ai/dsh` fetches the upstream release, so building from source below is the only way to run this repository. Contributor setup is in the [development guide](docs/development.md).

## What this fork adds

Capabilities and surfaces beyond the upstream checkout:

- **Swarm profiles** — the shipped `swarm` and `swarm-web` profiles stack [`dsh-swarm-profile`](packages/preset/) over `headless`/`web-app` to turn on [Agent Teams](docs/subsystems/agent-team.md): a durable roster, task board, and mailbox over continuable subagents, with the Team row rendered in the Web UI.
- **Web UI surfaces** — workspace-roots projection and picker, settings-plugin cards for every served namespace, and diff/search/todo/trajectory cards.
- **Browser-rendered web access** — the `web-fetch-playwright` provider fetches with a real browser (configurable executable, `User-Agent`, render concurrency) for pages that need JavaScript.
- **Mandatory approval audit** — [`dsh-approval-assessor`](packages/guard/approval-assessor/) rejects work-avoidance justifications before any approval answerer decides, redirecting the model to the user's instruction.
- **Modern toolchain** — bun 1.4 workspace with the isolated linker, TypeScript 7 for Host and Client programs, Node `^22.19 || >=24` engines (CI on Node 24), and tsx-based ESM source launch for the `dsh` CLI.

A local build runs the Web UI under the name **DeepMeow** with a cat-face mark instead of the upstream wordmark. The [Web UI guide](docs/user/guide/index.md#local-build-identity) records where that name appears and which build profile restores the official wordmark.

## Developer preview

DeepSeek Harness is in _developer preview_ and iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**

Review the [safety notice](SAFETY.md) before running the project.

## Run

### Run from source

Install `Node.js`, then run:

```sh
git clone https://github.com/d4551/deepseek-harness.git
cd deepseek-harness
bun install
bun run build
bun run dsh web
```

`bun run build` prepares the repository artifacts. `bun run dsh web` uses those built artifacts without rebuilding.

The last command starts the Web UI at `http://127.0.0.1:3080` by default and opens it in the default browser for a local launch. An SSH launch only prints the host URL because the SSH client or editor owns the local forwarded address. Pass `--no-open` to run the server without opening a browser. See [Web UI guide](docs/user/guide/index.md).

## Community and support

- Submit feedback or bug reports through [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions).
- Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to your plugin repository for discoverability.
- Join <a href="https://discord.gg/Ycq5dCaS4">DeepSeek Harness Discord community</a>.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

Start with the [development guide](docs/development.md) and [architecture documentation](docs/architecture.md).

For agents, follow [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
