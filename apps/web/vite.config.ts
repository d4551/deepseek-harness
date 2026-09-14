import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { clientBuildEnvironmentDefines } from '../../scripts/client-build-environment.ts'
import {
  DEFAULT_CLIENT_TITLE,
  projectDocumentTitle,
  projectManifestTitle,
} from '../../scripts/client-document-title.ts'

const src = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url))
const STANDALONE_ERROR = 'apps/web is not a standalone application: bare Vite cannot inject window.__DSH_BOOT__. '
  + 'From a repository checkout, run `bun run dsh web`; an installed package uses `dsh web`. '
  + 'For client-plugin HMR, run `bun run dsh web` together with `bun run dev:web`.'

/** Project the public build title into the HTML document and the install manifest. */
function clientDocumentTitle(): Plugin {
  const title = process.env.DSH_CLIENT_TITLE ?? DEFAULT_CLIENT_TITLE
  return {
    name: 'dsh-client-document-title',
    transformIndexHtml(html) {
      return projectDocumentTitle(html, title)
    },
    async closeBundle() {
      const manifestPath = src('./dist/manifest.webmanifest')
      const source = await readFile(manifestPath, 'utf8')
      await writeFile(manifestPath, projectManifestTitle(source, title))
    },
  }
}

/** Fail before a Vite dev or preview server can expose the boot-manifest-free shell. */
function rejectStandaloneServe(): Plugin {
  return {
    name: 'dsh-reject-standalone-web-serve',
    config(_config, env) {
      if (env.command === 'serve') throw new Error(STANDALONE_ERROR)
    },
  }
}

/**
 * Emit preview.html beside index.html: the built index page with one module
 * script — the worker bootstrap entry — spliced ahead of its entry tag. Both
 * pages share every chunk; the extra tag is the only difference, so the
 * static worker deployment ships the served page verbatim plus its
 * bootstrap.
 */
function emitPreviewPage(): Plugin {
  let bootstrapFile: string | undefined
  return {
    name: 'dsh-emit-preview-page',
    generateBundle(_options, bundle) {
      for (const item of Object.values(bundle)) {
        if (item.type === 'chunk' && item.isEntry && item.name === 'bootstrap') bootstrapFile = item.fileName
      }
      if (bootstrapFile === undefined) throw new Error('vite: preview bootstrap entry missing from the bundle')
    },
    async closeBundle() {
      // A build that failed before generateBundle has no page to splice.
      if (bootstrapFile === undefined) return
      const page = await readFile(src('./dist/index.html'), 'utf8')
      const anchor = page.indexOf('<script type="module"')
      if (anchor === -1) throw new Error('vite: built index.html lost its module entry tag')
      const tag = `<script type="module" crossorigin src="./${bootstrapFile}"></script>`
      await writeFile(src('./dist/preview.html'), `${page.slice(0, anchor)}${tag}${page.slice(anchor)}`)
    },
  }
}

/** Font asset extensions routed to assets/fonts/ (KaTeX's woff2/woff/ttf faces). */
const FONT_EXTENSIONS: readonly string[] = ['.woff2', '.woff', '.ttf']

export default defineConfig({
  // Relative asset URLs: preview.html mounts the same output under any base
  // directory, and the served index resolves identically from the site root.
  base: './',
  plugins: [rejectStandaloneServe(), clientDocumentTitle(), react(), emitPreviewPage()],
  build: {
    // The worker bootstrap holds its page at top-level await; Vite's default
    // `modules` target (es2020-era) rejects that syntax.
    target: 'es2022',
    sourcemap: true,
    rolldownOptions: {
      input: {
        index: src('./index.html'),
        // Standalone entry, not an index.html script tag: Vite folds every
        // module tag of one page into a single synthetic entry, and only a
        // separate input keeps the shared page chunks bootstrap-free.
        bootstrap: src('./src/preview.ts'),
      },
      output: {
        strictExecutionOrder: true,
        // The worker-preview surface groups under dist/preview/ (the page
        // itself stays at dist/preview.html), so the published payload can
        // exclude it as one directory.
        entryFileNames(chunk): string {
          return chunk.name === 'bootstrap' ? 'preview/[name]-[hash].js' : 'assets/[name]-[hash].js'
        },
        // Group grammar assets and fonts separately from application modules.
        chunkFileNames(chunk): string {
          const isLangChunk = chunk.moduleIds.some(id => id.includes('/node_modules/@shikijs/langs/'))
          return isLangChunk ? 'assets/langs/[name]-[hash].js' : 'assets/[name]-[hash].js'
        },
        assetFileNames(asset): string {
          const fileName = asset.names[0] ?? ''
          const isFont = FONT_EXTENSIONS.some(ext => fileName.endsWith(ext))
          return isFont ? 'assets/fonts/[name]-[hash][extname]' : 'assets/[name]-[hash][extname]'
        },
        codeSplitting: {
          maxSize: 450_000,
          groups: [
            {
              name: 'grammar',
              test: /node_modules[\\/]@shikijs[\\/]langs[\\/]/,
              priority: 20,
              entriesAware: true,
            },
            {
              name: 'vendor',
              test: /node_modules[\\/]/,
              tags: ['$initial'],
              priority: 10,
              entriesAware: true,
            },
            {
              name: 'shell',
              tags: ['$initial'],
              priority: -10,
              entriesAware: true,
            },
          ],
        },
      },
    },
  },
  worker: {
    // The preview worker rides dist/preview/ with the rest of that surface.
    rolldownOptions: { output: { entryFileNames: 'preview/[name]-[hash].js' } },
  },
  resolve: {
    // One instance per shared npm identity: a bare specifier otherwise resolves
    // from the importer's directory, so a diverging range ships a second React
    // and splits hook and element identity. Entries are package ids — they cover
    // react/jsx-runtime and react-dom/client — and resolve from this package's
    // node_modules, so react must stay a devDependency here and any watcher must
    // run vite from this directory (scripts/dev-web.ts). Workspace packages need
    // no entry: the isolated linker symlinks each of them to a single directory.
    dedupe: ['react', 'react-dom'],
    // Workspace packages are consumed as built lib products: each resolves
    // through its own package.json exports from the importer's directory, and
    // CSS still rides Vite's pipeline because the client build preset emits it
    // beside the bundle. Plugin packages never enter this graph; they arrive as
    // runtime bundles through the client module system. The remaining alias
    // browserizes the vendored Cordis Loader's only Node import.
    alias: [
      { find: /^node:module$/, replacement: src('./src/node-module-stub.ts') },
    ],
  },
  define: {
    ...clientBuildEnvironmentDefines(process.env),
    // vendored loader internal.ts: fromInternal() probes the Node major —
    // "0.0.0" takes neither branch, returning undefined (exactly the empty
    // internal slot the shell boot fills with the client module loader).
    'process.versions.node': '"0.0.0"',
    'process.execArgv': '[]',
    // vendored loader index.ts: envData falls to its default branch.
    'process.env.CORDIS_SHARED': 'undefined',
  },
})
