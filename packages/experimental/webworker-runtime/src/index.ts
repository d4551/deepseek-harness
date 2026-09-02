/**
 * Browser-only host runtime: the harness Cordis tree inside a dedicated Web Worker.
 *
 * This entry owns the module proxy table — the ONLY platform fork of the host
 * tree — and publishes the image, manifest, and pack-time symbols the
 * build-time packer and a deployment's page half consume. Every entry of the
 * table replaces a Node builtin or an external npm package; workspace and
 * vendored modules are always mounted as they ship.
 *
 * The worker build turns these into bundler aliases, and `node/builtins.ts`
 * turns the same modules into the loader's static table.
 *
 * The replacement path states the classification. `./node/builtin_modules/implemented/<module>.ts`
 * carries the module's real semantics over a worker-side data source (VFS, the
 * tunnel, a wasm codec, a browser primitive); `./node/builtin_modules/mock/<module>.ts` is a
 * structural placeholder that mounts silently and reports the missing capability
 * when a call finally reaches it. External npm replacements live in
 * `./node/external_packages/`, named after the package they stand in for.
 * @module @deepseek-ai/dsh-experimental-webworker-runtime
 */
export {
  DEFAULT_ROOT, IMAGE_CONFIG_PATH, IMAGE_EMPTY_DIRECTORIES, IMAGE_FILE_NAME, IMAGE_MANIFEST_PATH,
  IMAGE_OVERLAY_DIRECTORIES, LOWERING_VERSION,
} from './image-layout.ts'
export {
  PREVIEW_FIXTURE_MANIFEST_FILE, PREVIEW_FIXTURE_MANIFEST_VERSION, type PreviewFixtureManifest,
} from './fixture-manifest.ts'
export { lowerModuleSource } from './compile/transform.ts'
export { MemoryVfs } from './storage/memory.ts'
export { packTar } from './storage/tar.ts'
export { WorkerModuleLoader } from './module-system/module-loader.ts'

/**
 * Module proxy table. Keys are exact module specifiers; values are paths
 * relative to this module.
 */
export const MODULE_PROXIES: Record<string, string> = {
  // VFS-backed real implementations.
  'node:fs': './node/builtin_modules/implemented/fs.ts',
  'fs': './node/builtin_modules/implemented/fs.ts',
  'node:fs/promises': './node/builtin_modules/implemented/fs/promises.ts',
  'fs/promises': './node/builtin_modules/implemented/fs/promises.ts',
  'node:path': './node/builtin_modules/implemented/path.ts',
  'path': './node/builtin_modules/implemented/path.ts',
  'node:path/posix': './node/builtin_modules/implemented/path.ts',
  'node:os': './node/builtin_modules/implemented/os.ts',
  'os': './node/builtin_modules/implemented/os.ts',
  'node:url': './node/builtin_modules/implemented/url.ts',
  'node:module': './node/builtin_modules/implemented/module.ts',
  'node:crypto': './node/builtin_modules/implemented/crypto.ts',
  'crypto': './node/builtin_modules/implemented/crypto.ts',
  // `buffer` itself stays unaliased: the shim is backed by that npm package.
  'node:buffer': './node/builtin_modules/implemented/buffer.ts',
  // Tunnel request source: fake bind, real route face. `node:process` and
  // `process` are absent on purpose — the worker host installs that global
  // (`./node/globals/process.ts`).
  'node:http': './node/builtin_modules/implemented/http.ts',
  // Sync-stack AsyncLocalStorage semantics.
  'node:async_hooks': './node/builtin_modules/implemented/async_hooks.ts',
  // Real implementations over browser primitives.
  'node:util': './node/builtin_modules/implemented/util.ts',
  'node:util/types': './node/builtin_modules/implemented/util/types.ts',
  'node:events': './node/builtin_modules/implemented/events.ts',
  'node:timers/promises': './node/builtin_modules/implemented/timers/promises.ts',
  'node:perf_hooks': './node/builtin_modules/implemented/perf_hooks.ts',
  'node:tty': './node/builtin_modules/implemented/tty.ts',
  'tty': './node/builtin_modules/implemented/tty.ts',
  // Real zstd codec: session-log appends compress on every write.
  'node:zlib': './node/builtin_modules/implemented/zlib.ts',
  // The worker's own process layer: `bash -c` and the command table run against
  // the VFS, because a browser worker has no processes to fork.
  'node:child_process': './node/builtin_modules/implemented/child_process.ts',
  // Structural mocks: every symbol exists, every call throws.
  'node:dns/promises': './node/builtin_modules/mock/dns/promises.ts',
  'dns/promises': './node/builtin_modules/mock/dns/promises.ts',
  'node:net': './node/builtin_modules/mock/net.ts',
  'node:stream': './node/builtin_modules/implemented/stream.ts',
  'node:vm': './node/builtin_modules/mock/vm.ts',
  'node:worker_threads': './node/builtin_modules/mock/worker_threads.ts',
  'node:sqlite': './node/builtin_modules/mock/sqlite.ts',
  // External npm replacements, named after the package each stands in for.
  'koffi': './node/external_packages/koffi.ts',
  'sharp': './node/external_packages/sharp.ts',
  'node-pty': './node/external_packages/node-pty.ts',
  '@vscode/ripgrep': './node/external_packages/ripgrep.ts',
  '@earendil-works/pi-ai': './node/external_packages/pi-ai.ts',
  // Constructible fakes whose methods are never reached.
  'ws': './node/external_packages/ws.ts',
}

/** pi-ai subpaths (`/providers/all`, `/api/*.lazy`) share the one structural stub. */
export const MODULE_PROXY_PREFIXES: Record<string, string> = {
  '@earendil-works/pi-ai/': './node/external_packages/pi-ai.ts',
}
