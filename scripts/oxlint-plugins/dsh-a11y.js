/**
 * Accessibility rules that jsx-a11y does not model for custom editors.
 * A Lexical host cannot be a native textarea: decorator chips are element
 * children of the root. role=textbox belongs on the bound host element.
 */

function attribute(node, name) {
  return node.attributes.find((entry) => (
    entry.type === 'JSXAttribute'
    && entry.name?.type === 'JSXIdentifier'
    && entry.name.name === name
  ))
}

function tagName(node) {
  return node.name?.type === 'JSXIdentifier' ? node.name.name : undefined
}

function identifierName(node) {
  return node !== undefined && node !== null && node.type === 'Identifier' ? node.name : undefined
}

function literalString(node) {
  if (node === undefined || node === null) return undefined
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value
  return undefined
}

function literalRole(node) {
  const role = attribute(node, 'role')
  if (role === undefined || role.value === null || role.value === undefined) return undefined
  if (role.value.type === 'Literal' && typeof role.value.value === 'string') return role.value.value
  if (
    role.value.type === 'JSXExpressionContainer'
    && role.value.expression.type === 'Literal'
    && typeof role.value.expression.value === 'string'
  ) {
    return role.value.expression.value
  }
  return undefined
}

function jsxRefName(node) {
  const ref = attribute(node, 'ref')
  if (ref === undefined || ref.value === null || ref.value === undefined) return undefined
  if (ref.value.type !== 'JSXExpressionContainer') return undefined
  return identifierName(ref.value.expression)
}

function unwrapChain(node) {
  return node.type === 'ChainExpression' ? node.expression : node
}

function currentRefName(node) {
  const expression = unwrapChain(node)
  if (expression.type !== 'MemberExpression' || expression.computed) return undefined
  if (identifierName(expression.property) !== 'current') return undefined
  return identifierName(expression.object)
}

function setAttributeCalleeObject(node) {
  const callee = unwrapChain(node.callee)
  if (callee.type !== 'MemberExpression' || callee.computed) return undefined
  if (identifierName(callee.property) !== 'setAttribute') return undefined
  return callee.object
}

function isRoleTextboxArguments(node) {
  return literalString(node.arguments[0]) === 'role' && literalString(node.arguments[1]) === 'textbox'
}

function bindCurrentAlias(aliases, id, init) {
  const name = identifierName(id)
  const ref = init === undefined || init === null ? undefined : currentRefName(init)
  if (name === undefined || ref === undefined) return
  aliases.set(name, ref)
}

const plugin = {
  meta: { name: 'dsh-a11y' },
  rules: {
    'contenteditable-textbox': {
      meta: {
        type: 'problem',
        docs: {
          description: 'Generic contenteditable hosts must expose role=textbox; generic textboxes must declare contentEditable.',
        },
        messages: {
          missingRole: 'Contenteditable hosts that are not native text fields must set role="textbox" on the host element.',
          missingContentEditable: 'role="textbox" on a generic element requires a contentEditable attribute.',
        },
        schema: [],
      },
      create(context) {
        const aliases = new Map()
        const refsWithTextboxRole = new Set()
        const hosts = []
        return {
          VariableDeclarator(node) {
            bindCurrentAlias(aliases, node.id, node.init)
          },
          AssignmentExpression(node) {
            bindCurrentAlias(aliases, node.left, node.right)
          },
          CallExpression(node) {
            const object = setAttributeCalleeObject(node)
            if (object === undefined || !isRoleTextboxArguments(node)) return
            const direct = currentRefName(object)
            const alias = identifierName(object)
            const ref = direct ?? (alias === undefined ? undefined : aliases.get(alias))
            if (ref !== undefined) refsWithTextboxRole.add(ref)
          },
          JSXOpeningElement(node) {
            const tag = tagName(node)
            if (tag === 'input' || tag === 'textarea') return
            const role = literalRole(node)
            const contentEditable = attribute(node, 'contentEditable') ?? attribute(node, 'contenteditable')
            if (contentEditable !== undefined && role !== 'textbox') {
              hosts.push({ node, ref: jsxRefName(node) })
            }
            if (role === 'textbox' && contentEditable === undefined) {
              context.report({ node, messageId: 'missingContentEditable' })
            }
          },
          'Program:exit'() {
            for (const host of hosts) {
              if (host.ref !== undefined && refsWithTextboxRole.has(host.ref)) continue
              context.report({ node: host.node, messageId: 'missingRole' })
            }
          },
        }
      },
    },
  },
}

export default plugin
