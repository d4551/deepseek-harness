import { defineConfig } from 'tsdown'

/**
 * Builds each published entry as a self-contained file. The default workspace
 * entry list covers only the package root and its invariant companion, so the
 * `./identity` subpath declared in `package.json` needs its own bundle or a
 * packed install resolves it to a missing file. The `./types` subpath points at
 * the tsc-emitted `lib/types/types.js` and needs no bundle.
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
    entry: ['lib/types/identity.js'], outDir: 'lib', format: ['esm'], platform: 'node', target: 'es2024',
    fixedExtension: false, outputOptions: { codeSplitting: false }, dts: false, clean: false,
  },
])
