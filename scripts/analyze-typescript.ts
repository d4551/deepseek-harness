/** Print a TypeScript project's semantic report for one source file. */
import { DiagnosticCategory } from 'typescript/unstable/sync'
import { analyzeTypescriptFile } from './typescript-semantics.ts'

const [config, file, ...extra] = process.argv.slice(2)
if (config === undefined || file === undefined || extra.length > 0) {
  throw new Error('Usage: bun run analyze:typescript <tsconfig> <source-file>')
}
const report = analyzeTypescriptFile(config, file)
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
if (report.diagnostics.some(diagnostic => diagnostic.category === DiagnosticCategory.Error)) {
  process.exitCode = 1
}
