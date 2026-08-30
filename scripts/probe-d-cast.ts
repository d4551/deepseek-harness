interface JsonModel { readonly name?: string }

export function readName(record: object): string | undefined {
  const model = record as JsonModel
  return typeof model.name === 'string' ? model.name : undefined
}
