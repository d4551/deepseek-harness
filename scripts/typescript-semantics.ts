/** Cross-file symbol and type reports from an explicitly selected TypeScript project. */
import { resolve } from 'node:path'
import { API, SymbolFlags, isErrorType } from 'typescript/unstable/sync'
import type { Identifier, Node } from 'typescript/unstable/ast'
import { isIdentifier } from 'typescript/unstable/ast/is'

/**
 * Resolve identifiers using the project's module resolution and compiler options.
 * Results contain plain data; compiler objects are released before returning.
 * @param configFile - tsconfig defining the analysis boundary.
 * @param fileName - source file belonging to that project.
 * @returns identifier symbols, original declarations, inferred types and diagnostics.
 */
export function analyzeTypescriptFile(configFile: string, fileName: string) {
  const config = resolve(configFile)
  const file = resolve(fileName)
  const api = new API()
  try {
    const snapshot = api.updateSnapshot({ openProjects: [config] })
    const project = snapshot.getProject(config)
    if (project === undefined) throw new Error(`TypeScript did not load project ${config}`)
    const source = project.program.getSourceFile(file)
    if (source === undefined) throw new Error(`Source ${file} does not belong to ${config}`)
    const nodes: Identifier[] = []
    function visit(node: Node): void {
      if (isIdentifier(node)) nodes.push(node)
      node.forEachChild(visit)
    }
    visit(source)
    const { checker, program } = project
    const symbols = checker.getSymbolAtLocation(nodes)
    const types = checker.getTypeAtLocation(nodes)
    const references = nodes.map((node, index) => {
      const symbol = symbols[index]
      const type = types[index]
      const alias = symbol !== undefined && (symbol.flags & SymbolFlags.Alias) !== 0
      const target = alias ? checker.getAliasedSymbol(symbol) : symbol
      const resolved = target !== undefined && !checker.isUnknownSymbol(target)
      return {
        name: node.text,
        start: node.getStart(source),
        end: node.getEnd(),
        alias,
        symbol: resolved ? target.name : null,
        declarations: resolved ? target.declarations.map((declaration) => {
          const definition = declaration.resolve()
          if (definition === undefined) throw new Error(`Unresolved declaration ${declaration.path}`)
          return {
            file: definition.getSourceFile().fileName,
            start: definition.getStart(),
            end: definition.getEnd(),
          }
        }) : [],
        type: type === undefined || isErrorType(type) ? null : checker.typeToString(type, node),
      }
    })
    return {
      config,
      file,
      references,
      diagnostics: [
        ...program.getConfigFileParsingDiagnostics(),
        ...program.getProgramDiagnostics(),
        ...program.getGlobalDiagnostics(),
        ...program.getSyntacticDiagnostics(file),
        ...program.getBindDiagnostics(file),
        ...program.getSemanticDiagnostics(file),
      ],
    }
  } finally {
    api.close()
  }
}
