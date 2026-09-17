import assert from 'node:assert/strict'
import type { PropertySignatureDeclaration } from 'typescript/unstable/ast'
import { createIdentifier, createPropertySignatureDeclaration } from 'typescript/unstable/ast/factory'

const type: PropertySignatureDeclaration['type'] = undefined
const initializer: PropertySignatureDeclaration['initializer'] = undefined
const property = createPropertySignatureDeclaration(undefined, createIdentifier('entry'), undefined, type, initializer)
assert.equal(property.type, undefined)
assert.equal(property.initializer, undefined)
