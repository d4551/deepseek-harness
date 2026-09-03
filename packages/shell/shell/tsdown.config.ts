import { defineConfig } from 'tsdown'

/**
 * Builds each published entry as a self-contained file. The default workspace
 * entry list covers only the package root and its invariant companion, so the
 * `./sandbox-classify` and `./subprocess-executor` subpaths declared in
 * `package.json` need their own bundles or a packed install resolves them to
 * missing files. `./subprocess-executor` imports the root module, so its
 * bundle carries its own copy of the Service Definition: the seam holds no
 * mutable state and registers services by name, so the second copy changes
 * nothing a caller can observe.
 */
export default defineConfig([
  {
    entry: ['lib/types/index.js'], outDir: 'lib', format: ['esm'], platform: 'node', target: 'es2024',
    fixedExtension: false, outputOptions: { codeSplitting: false }, dts: false, clean: false,
  },
  {
    entry: ['lib/types/invariant.js'], outDir: 'lib', format: ['esm'], platform: 'node', target: 'es2024',
    fixedExtension: false, outputOptions: { codeSplitting: false }, dts: false, clean: false,
  },
  {
    entry: ['lib/types/sandbox-classify.js'], outDir: 'lib', format: ['esm'], platform: 'node', target: 'es2024',
    fixedExtension: false, outputOptions: { codeSplitting: false }, dts: false, clean: false,
  },
  {
    entry: ['lib/types/subprocess-executor.js'], outDir: 'lib', format: ['esm'], platform: 'node', target: 'es2024',
    fixedExtension: false, outputOptions: { codeSplitting: false }, dts: false, clean: false,
  },
])
