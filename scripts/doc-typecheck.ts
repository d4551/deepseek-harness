/**
 * Typecheck Markdown `ts` fences against the workspace API. `ignore-check` fences are reported as
 * opt-outs; generated catalog fragments and source-equivalence blocks are skipped here because their
 * owning gates verify them. Byte-identical `.zh.md` copies reuse their unsuffixed sibling's check. A
 * build-coordinated mode consumes existing declarations without emit.
 */

import { execFileSync } from 'node:child_process'
import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { builtDeclarationPath } from './doc-typecheck-paths.ts'
import { markdownFences } from './markdown.ts'
import { partitionPairedMarkdownDerivatives } from './paired-markdown-derivatives.ts'
import { isArchivedAgentNotePath } from './repo-files.ts'
import { API } from 'typescript/unstable/sync'
import { readConfigFile } from './ts7-session.ts'

const root = resolve(import.meta.dirname, '..')

/**
 * TypeScript-fence ownership. `check` compiles; `ignore` is an unchecked sketch
 * counted in the opt-out ratio; the catalog and type-equivalence variants are
 * excluded from that ratio because their owning gates verify them.
 */
type BlockKind = 'check' | 'ignore' | 'type-equiv' | 'cordis-catalog' | 'persistence-catalog' | 'config-catalog'

/** One extracted code block. */
interface Block {
  file: string
  /** 1-based line of the opening fence. */
  line: number
  kind: BlockKind
  code: string
}

/** The info-string → kind table this gate tracks. */
const KIND_BY_INFO: Record<string, BlockKind> = {
  'ts': 'check',
  'ts ignore-check': 'ignore',
  'ts type-equiv': 'type-equiv',
  'ts public-api': 'type-equiv',
  'ts cordis-catalog': 'cordis-catalog',
  'ts persistence-catalog': 'persistence-catalog',
  'ts config-catalog': 'config-catalog',
}

/** Extract every recognized TypeScript fence from one Markdown file. */
function extractBlocks(absPath: string): Block[] {
  const file = relative(root, absPath)
  return markdownFences(readFileSync(absPath, 'utf8')).flatMap((fence) => {
    const kind = KIND_BY_INFO[fence.info]
    return kind === undefined ? [] : [{ file, line: fence.line, kind, code: fence.code }]
  })
}

function builtTypePaths(): Record<string, string[]> {
  const api = new API()
  const parsed = api.parseConfigFile(join(root, 'tsconfig.host.json'))
  api.close()
  const paths = parsed.options.paths
  if (paths === undefined || typeof paths !== 'object' || Array.isArray(paths) || paths === null) {
    throw new Error('doc-typecheck: host tsconfig has no workspace paths')
  }
  const remapped: Record<string, string[]> = {}
  for (const [specifier, candidates] of Object.entries(paths)) {
    if (!Array.isArray(candidates)) continue
    remapped[specifier] = candidates.filter((candidate): candidate is string => typeof candidate === 'string')
      .map(builtDeclarationPath)
  }
  return remapped
}

/**
 * Reuse the Host aggregate references from a temp project one directory below
 * root. Generated Client API examples opt out because their declarations do
 * not exist until Host tsdown has run.
 */
function workspaceReferences(): { path: string }[] {
  const file = join(root, 'tsconfig.host.json')
  const result = readConfigFile(file)
  if (result.error !== undefined) {
    throw new Error(`doc-typecheck: cannot read ${file}: ${result.error.messageText}`)
  }
  const config = result.config
  if (config === null || typeof config !== 'object' || Array.isArray(config) || !('references' in config)) {
    throw new Error(`doc-typecheck: ${file} has no references`)
  }
  const references = Reflect.get(config, 'references')
  if (!Array.isArray(references)) throw new Error(`doc-typecheck: ${file} has no references`)
  const paths: { path: string }[] = []
  for (const entry of references) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry) || !('path' in entry)) continue
    const path: unknown = Reflect.get(entry, 'path')
    if (typeof path !== 'string') continue
    paths.push({ path: path.startsWith('./') ? `../${path.slice(2)}` : `../${path}` })
  }
  return paths
}

/** The standalone temp project used when no coordinated build owns declaration freshness. */
function tempTsconfig(useBuiltTypes: boolean): string {
  return JSON.stringify({
    extends: '../tsconfig.host.json',
    compilerOptions: {
      noUnusedLocals: false,
      noUnusedParameters: false,
      tsBuildInfoFile: './tsconfig.tsbuildinfo',
      ...useBuiltTypes ? { paths: builtTypePaths(), composite: false, incremental: false, declaration: false } : {},
    },
    include: ['block-*.ts'],
    references: useBuiltTypes ? [] : workspaceReferences(),
  })
}

/** Compile blocks through project references for the standalone command. */
function compileBlocksStandalone(blocks: Block[], useBuiltTypes = false): string | undefined {
  const tmp = mkdtempSync(join(root, '.doc-typecheck-'))
  try {
    writeFileSync(join(tmp, 'tsconfig.json'), tempTsconfig(useBuiltTypes))
    for (const [index, block] of blocks.entries()) {
      writeFileSync(join(tmp, `block-${index}.ts`), block.code.endsWith('\n') ? block.code : `${block.code}\n`)
    }
    try {
      // Invoke tsc's JS entry through Node instead of a platform-specific shell shim.
      execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-b', join(tmp, 'tsconfig.json')], {
        cwd: root,
        stdio: 'pipe',
      })
      return undefined
    } catch (error: unknown) {
      const failed = error as { stdout?: Buffer; stderr?: Buffer }
      return remapBlockPaths(`${failed.stdout?.toString() ?? ''}${failed.stderr?.toString() ?? ''}`, blocks)
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

/** Map virtual or temporary block paths back to their owning Markdown fences. */
function compileBlocksAgainstBuiltTypes(blocks: Block[]): readonly string[] {
  const error = compileBlocksStandalone(blocks, true)
  return error === undefined ? [] : [error]
}

function formatDiagnostics(diagnostics: readonly string[], _blocks: Block[]): string {
  return diagnostics.join('')
}

function remapBlockPaths(output: string, blocks: Block[]): string {
  return output.replace(/(?:[^\s:()]*[/\\])?block-(\d+)\.ts\((\d+),(\d+)\)/g, (_match, index: string, line: string, column: string) => {
    const block = blocks[Number(index)]
    if (!block) return `block-${index}.ts(${line},${column})`
    return `${block.file} (block at line ${block.line}, +${line}:${column})`
  })
}

const markdownGlobs = ['README.md', '.agents/notes/**/*.md', 'docs/**/*.md', 'packages/*/*.md', 'packages/*/*/*.md']

const files: string[] = []
for (const pattern of markdownGlobs) {
  for (const match of globSync(pattern, { cwd: root })) {
    if (!isArchivedAgentNotePath(match)) files.push(resolve(root, match))
  }
}
files.sort()

const extracted = files.flatMap(extractBlocks)
const { primary: all, derivatives } = partitionPairedMarkdownDerivatives(
  extracted,
  block => block.file,
  block => `${block.kind}\0${block.code}`,
)
const checked = all.filter(b => b.kind === 'check')
const ignored = all.filter(b => b.kind === 'ignore')
// Only compile-eligible fences belong in the opt-out ratio; every other skipped
// kind has an independent verifier named in the BlockKind rules above.
const ratioDenominator = checked.length + ignored.length

if (checked.length === 0) {
  console.log('doc-typecheck: no ts code blocks to check.')
  process.exit(0)
}

const useBuiltTypes = process.env.DSH_DOC_TYPECHECK_USE_BUILD_OUTPUT === '1'
const compilationError = useBuiltTypes
  ? (() => {
    const diagnostics = compileBlocksAgainstBuiltTypes(checked)
    return diagnostics.length === 0 ? undefined : formatDiagnostics(diagnostics, checked)
  })()
  : compileBlocksStandalone(checked)
if (compilationError !== undefined) {
  console.error('doc-typecheck: documentation code blocks failed to compile.\n')
  console.error(compilationError)
  process.exit(1)
}

const ratio = ignored.length / ratioDenominator
const skipped = all.length - ratioDenominator
console.log(`doc-typecheck: ${checked.length} block(s) compiled, ${ignored.length} ignored (${(ratio * 100).toFixed(0)}% opt-out), ${skipped} type-equiv/catalog (checked elsewhere), ${derivatives.length} paired derivative(s).`)
// Guard against the escape hatch becoming the norm.
if (ratioDenominator >= 4 && ratio > 0.5) {
  console.error(`doc-typecheck: too many blocks opt out of checking (${ignored.length}/${ratioDenominator}). Make them compile or delete them.`)
  process.exit(1)
}
