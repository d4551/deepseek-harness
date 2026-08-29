/**
 * TS7 sync-API capability probe for the Strada→TS7 migration (scratch, deleted after run).
 * Answers: project opening semantics, printer behavior, checker gaps, node hydration.
 */
import { API, NodeBuilderFlags } from 'typescript/unstable/sync'
import * as ast from 'typescript/unstable/ast'
import * as factory from 'typescript/unstable/ast/factory'
import * as is from 'typescript/unstable/ast/is'

const out = (line: string): void => process.stdout.write(`${line}\n`)

const api = new API({ collectTiming: false })
const config = '/Users/brandon/Downloads/deepseek-harness/packages/util/atomic-write/tsconfig.json'
const snapshot = api.updateSnapshot({ openProjects: [config] })
const project = snapshot.getProjects()[0]
if (project === undefined) throw new Error('no project')
const program = project.program
const checker = project.checker

out('=== project ===')
out(`configFileName: ${project.configFileName}`)
out(`sourceFileNames: ${program.getSourceFileNames().length}`)
for (const name of program.getSourceFileNames()) out(`  file: ${name}`)

const mainFile = program.getSourceFile('/Users/brandon/Downloads/deepseek-harness/packages/util/atomic-write/src/index.ts')
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
const built = checker.typeToTypeNode(modeType, options, NodeBuilderFlags.NoTruncation)
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

out('=== optional property + optional param semantics ===')
const dirMode = options.members.find(m => is.isPropertySignatureDeclaration(m) && m.name?.kind === ast.SyntaxKind.Identifier && m.name.text === 'dirMode')
if (dirMode !== undefined && is.isPropertySignatureDeclaration(dirMode)) {
  const symbol = checker.getSymbolAtLocation(dirMode.name)
  const propertyType = symbol === undefined ? undefined : checker.getTypeOfSymbol(symbol)
  out(`dirMode authored: ${dirMode.type === undefined ? 'none' : checker.typeToString(checker.getTypeFromTypeNode(dirMode.type))}`)
  out(`dirMode symbol type: ${propertyType === undefined ? 'undefined' : checker.typeToString(propertyType)}`)
}
const withOptional = mainFile.statements.find(s => is.isFunctionDeclaration(s) && s.parameters.some(p => p.questionToken !== undefined || p.initializer !== undefined))
if (withOptional !== undefined && is.isFunctionDeclaration(withOptional)) {
  const optionalSignature = checker.getSignatureFromDeclaration(withOptional)
  if (optionalSignature !== undefined) {
    for (let i = 0; i < withOptional.parameters.length; i++) {
      const parameter = withOptional.parameters[i]
      const authored = parameter.type === undefined ? 'none' : checker.typeToString(checker.getTypeFromTypeNode(parameter.type))
      const fromSignature = checker.getParameterType(optionalSignature, i)
      out(`  optional-fn param ${i} (${parameter.name.kind === ast.SyntaxKind.Identifier ? parameter.name.text : '?'}): authored=${authored} fromSignature=${fromSignature === undefined ? 'undefined' : checker.typeToString(fromSignature)}`)
    }
  }
}

out('=== defaulted parameter semantics (scan program) ===')
let defaulted = 0
for (const name of program.getSourceFileNames()) {
  if (!name.includes('/packages/') && !name.includes('/vendor/')) continue
  const file = program.getSourceFile(name)
  if (file === undefined) continue
  const walk = (node: ast.Node): void => {
    if (defaulted >= 3) return
    if (is.isFunctionDeclaration(node) || is.isMethodDeclaration(node) || is.isArrowFunction(node) || is.isFunctionExpression(node)) {
      for (let i = 0; i < node.parameters.length; i++) {
        const parameter = node.parameters[i]
        if (parameter.initializer === undefined || parameter.type === undefined) continue
        const defaultedSignature = checker.getSignatureFromDeclaration(node)
        if (defaultedSignature === undefined) continue
        const fromSignature = checker.getParameterType(defaultedSignature, i)
        out(`  ${name.split('/').slice(-2).join('/')}:${parameter.name.kind === ast.SyntaxKind.Identifier ? parameter.name.text : '?'} authored=${checker.typeToString(checker.getTypeFromTypeNode(parameter.type))} fromSignature=${fromSignature === undefined ? 'undefined' : checker.typeToString(fromSignature)}`)
        defaulted += 1
        if (defaulted >= 3) return
      }
    }
    node.forEachChild(walk)
  }
  walk(file)
}
if (defaulted === 0) out('  (no defaulted annotated params found)')

api.close()
out('=== probe complete ===')
