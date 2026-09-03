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
