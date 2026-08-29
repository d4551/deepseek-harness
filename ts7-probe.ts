/**
 * TS7 sync-API capability probe for the Strada→TS7 migration (scratch, deleted after run).
 * Answers: project opening semantics, printer behavior, checker gaps, node hydration.
 */
import { API } from 'typescript/unstable/sync'
import * as ast from 'typescript/unstable/ast'
import * as factory from 'typescript/unstable/ast/factory'
import * as is from 'typescript/unstable/ast/is'

const out = (line: string): void => process.stdout.write(`${line}\n`)

const api = new API({ collectTiming: false })
const config = 'packages/util/atomic-write/tsconfig.json'
const snapshot = api.updateSnapshot({ openProjects: [config] })
const project = snapshot.getProjects()[0]
if (project === undefined) throw new Error('no project')
const program = project.program
const checker = project.checker

out('=== project ===')
out(`configFileName: ${project.configFileName}`)
out(`sourceFileNames: ${program.getSourceFileNames().length}`)
for (const name of program.getSourceFileNames()) out(`  file: ${name}`)

const mainFile = program.getSourceFile('packages/util/atomic-write/src/index.ts')
if (mainFile === undefined) throw new Error('index.ts not in program')
out(`isDeclarationFile: ${mainFile.isDeclarationFile}`)
out(`imports: ${mainFile.imports.map(n => n.kind === ast.SyntaxKind.StringLiteral ? n.text : String(n.kind)).join(', ')}`)
out(`statements: ${mainFile.statements.length}`)

out('=== diagnostics ===')
const syn = program.getSyntacticDiagnostics()
const sem = program.getSemanticDiagnostics()
out(`syntactic: ${syn.length} semantic: ${sem.length}`)
for (const d of [...syn, ...sem].slice(0, 12)) out(`  diag: ${d.code} ${d.text.slice(0, 140)}`)

out('=== node hydration ===')
const options = mainFile.statements.find(s => is.isInterfaceDeclaration(s) && s.name?.text === 'WriteFileAtomicOptions')
if (options === undefined || !is.isInterfaceDeclaration(options)) throw new Error('options interface missing')
out(`options.parent: ${options.parent?.kind}`)
out(`options.jsDoc: ${options.jsDoc?.map(d => d.kind).join(', ')}`)
const jsdocNode = options.jsDoc?.[0]
if (jsdocNode !== undefined) out(`jsdoc text: ${JSON.stringify(mainFile.text.slice(jsdocNode.pos, jsdocNode.end))}`)
const fn = mainFile.statements.find(s => is.isFunctionDeclaration(s) && s.name?.text === 'writeFileAtomic')
if (fn === undefined || !is.isFunctionDeclaration(fn)) throw new Error('writeFileAtomic missing')
out(`fn params: ${fn.parameters.map(p => p.name.kind === ast.SyntaxKind.Identifier ? p.name.text : '?').join(', ')}`)
out(`fn modifiers: ${fn.modifiers?.map(m => m.kind).join(', ')}`)

out('=== checker: getParameterType semantics ===')
const signature = checker.getSignatureFromDeclaration(fn)
if (signature === undefined) throw new Error('no signature')
for (let i = 0; i < fn.parameters.length; i++) {
  const parameter = fn.parameters[i]
  const authored = parameter.type === undefined ? 'none' : checker.typeToString(checker.getTypeFromTypeNode(parameter.type))
  const fromSignature = checker.getParameterType(signature, i)
  out(`  param ${i}: authored=${authered(authored)} fromSignature=${fromSignature === undefined ? 'undefined' : checker.typeToString(fromSignature)}`)
}
function authered(value: string): string {
  return value
}

out('=== checker: typeToTypeNode + Emitter.printNode ===')
const modeType = checker.getTypeFromTypeNode(options.members[0]?.type ?? fn.parameters[0]?.type)
if (modeType === undefined) throw new Error('no type')
const built = checker.typeToTypeNode(modeType, options, ast.NodeBuilderFlags.NoTruncation)
out(`typeToTypeNode kind: ${built?.kind}`)
if (built !== undefined) out(`printNode(typeToTypeNode): ${JSON.stringify(project.emitter.printNode(built))}`)
out(`printNode(interface with jsDoc): ${JSON.stringify(project.emitter.printNode(options))}`)

out('=== factory node printing ===')
const synthetic = factory.createUnionTypeNode([
  factory.createKeywordTypeNode(ast.SyntaxKind.StringKeyword),
  factory.createKeywordTypeNode(ast.SyntaxKind.UndefinedKeyword),
])
out(`printNode(factory union): ${JSON.stringify(project.emitter.printNode(synthetic))}`)

out('=== symbol declarations ===')
const firstImport = mainFile.imports[0]
if (firstImport === undefined) throw new Error('no imports')
const moduleSymbol = checker.getSymbolAtLocation(firstImport)
out(`module symbol: ${moduleSymbol?.name} declarations: ${moduleSymbol?.declarations.length}`)
const handle = moduleSymbol?.declarations[0]
if (handle !== undefined) {
  out(`handle kind: ${handle.kind} path: ${handle.path}`)
  const resolved = handle.resolve(project)
  out(`resolved kind: ${resolved?.kind}`)
}

out('=== getJSDocTags (unstable/ast) ===')
out(`getJSDocTags: ${ast.getJSDocTags(options).length}`)

api.close()
out('=== probe complete ===')
