# @cordisjs/plugin-hmr

Hot module replacement for loader-managed Cordis plugins.

The HMR plugin watches source files, traces Node's module graph, clears affected
module caches, and reloads only the plugin entries that depend on changed
application files. Changes to framework-level dependencies fall back to
`loader.exit()`, letting the host process restart.

Module watches canonicalize their existing base directory before opening
Chokidar. Exact config watches likewise canonicalize the deepest existing
ancestor, then restore any missing suffix. Callbacks and diagnostics retain the
requested absolute filename, while the native backend receives one filesystem
spelling even when Windows supplied an 8.3 alias.

An exact config watch does not rely on the platform watch alone. Chokidar
reports `ready` once its initial scan finished and `fs.watch()` returned, which
on macOS is before libuv arms the FSEvents stream on its own run-loop thread,
so a change landing in that gap is reported by neither. A repair cadence
re-reads the registered path every `repairInterval` milliseconds; it shares one
serialized reconciliation with the watch, and each generation of the file's
content — including its absence — reaches the callback exactly once, whichever
trigger observed it.

## Requirements

- `@cordisjs/plugin-loader`
- `@cordisjs/plugin-timer`
- A runtime that exposes Node's internal module loader. The package throws if
  the loader service has no internal module loader available.

## Usage

```yaml
- id: timer
  name: '@cordisjs/plugin-timer'
- id: hmr
  name: '@cordisjs/plugin-hmr'
  config:
    root:
      - src
    ignored:
      - '**/node_modules'
      - '**/.*'
    debounce: 100
```

## Config

| Field | Description |
| --- | --- |
| `base` | Optional base directory resolved from `ctx.baseUrl`. |
| `root` | Chokidar roots to watch. Defaults to `['.']`. |
| `ignored` | Picomatch patterns excluded from watch and reload analysis. |
| `debounce` | Milliseconds to wait before processing a burst of changes. |
| `repairInterval` | Milliseconds between the reconciliations that repair an exact config change no filesystem event reported. Defaults to `100`; `0` runs the watch alone. |

## Events

| Event | Description |
| --- | --- |
| `hmr/change` | Emitted for changed files that are not handled by plugin reload or config reload. |
| `hmr/reload` | Emitted after one or more plugin entries are reloaded. |
