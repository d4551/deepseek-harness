# DeepSeek Harness

English | [中文](README.zh.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE) [![Node](https://img.shields.io/badge/node-%E2%89%A524-339933?logo=node.js&logoColor=white)](package.json) [![bun 1.4](https://img.shields.io/badge/bun-1.4-deadck?logo=bun)](package.json) [![TypeScript 7](https://img.shields.io/badge/TypeScript-7-3178c6?logo=typescript&logoColor=white)](package.json) [![Status: developer preview](https://img.shields.io/badge/status-developer%20preview-orange)](SAFETY.md)

## Explain it like I'm five

DeepSeek Harness is a robot helper's toolbox. You tell the robot what to do in plain words. The robot picks tools from the box — read files, run commands, search the web — does the job step by step, and shows you everything it did. If it wants to do something risky, it asks you first. This toolbox has a window (the Web UI) where you can watch the robot work and talk to it, and it can even bring in more robots that share a to-do list (Agent Teams).

DeepSeek Harness (`dsh`) is an open-source agent harness developed by [DeepSeek AI](https://deepseek.com).

It is built on an **everything-is-a-plugin** architecture and powered by [Cordis](https://github.com/cordiverse/cordis), whose design is described in [_A Programming Paradigm for Spatiotemporal Composability_](https://arxiv.org/abs/2608.25512).

Documentation: [https://deepseek-harness.github.io/deepseek-harness/](https://deepseek-harness.github.io/deepseek-harness/)

## Why this fork

This repository extends the upstream harness with capabilities and a toolchain you will not get from the npm package:

- **Multi-agent swarms** — run a team of agents that share a durable roster, task board, and mailbox. One profile (`dsh --profile swarm`) runs it headless; `swarm-web` adds the same team to the Web UI with a live Team row.
- **A Web UI that shows real state** — manage workspace roots from the browser, edit every plugin's settings through generated cards, and follow work through diff, search, todo, and trajectory cards.
- **Browser-grade web access** — the model can fetch pages with a real Chromium instance, so JavaScript-rendered sites are readable, with the browser executable, user agent, and render concurrency configurable.
- **Hardened approvals** — every tool approval needs a justification, and justifications that try to skip or soften the user's instructions are rejected automatically.
- **A current toolchain** — bun 1.4 workspaces, TypeScript 7, and Node 24+ (CI-verified), instead of the upstream npm/yarn-era setup.

## Getting this code

This repository publishes nothing to npm. `npx @deepseek-ai/dsh` installs the official upstream release, not this fork — to run this code, build it from source as shown in [Run](#run). Setup details are in the [development guide](docs/development.md).

Toolchain specifics: **bun 1.4** is the package manager and script runner (isolated workspace linker; `dsh plugin` forwards to bun), and **TypeScript 7** (`typescript` ^7.0.2) compiles the Host and Client programs and exports the compiler API at `typescript/unstable/sync` and `typescript/unstable/ast`.

A build from this repository runs the Web UI under the name **DeepMeow** with a cat-face mark; the [Web UI guide](docs/user/guide/index.md#local-build-identity) explains where the name appears and how to restore the official one.

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
