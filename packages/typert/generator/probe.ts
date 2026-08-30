import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { WorkspaceAnalyzer } from './src/analyzer-workspace.ts'

const root = join(import.meta.dirname, 'tests/fixtures/type-model')
const model = new WorkspaceAnalyzer({ root }).analyze()
const lines: string[] = []
for (const face of model.faces) {
  lines.push(`face=${face.face}`)
  for (const pkg of face.packages) {
    lines.push(` package=${pkg.name}`)
    lines.push(`  exports=${JSON.stringify(pkg.exports.map(entry => ({ subpath: entry.subpath, name: entry.name })))}`)
    lines.push(`  services=${JSON.stringify(pkg.services.map(service => service.key))}`)
    lines.push(`  schemas=${JSON.stringify(pkg.schemas.map(schema => schema.export.name))}`)
  }
}
writeFileSync(join(import.meta.dirname, 'probe-out.txt'), `${lines.join('\n')}\n`)
