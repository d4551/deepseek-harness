/**
 * Accessibility rules that jsx-a11y does not model for custom editors.
 * A Lexical (or other) contenteditable host cannot be a native textarea
 * because decorator chips are element children of the root.
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
          missingRole: 'Contenteditable hosts that are not native text fields must set role="textbox".',
          missingContentEditable: 'role="textbox" on a generic element requires a contentEditable attribute.',
        },
        schema: [],
      },
      create(context) {
        return {
          JSXOpeningElement(node) {
            const tag = tagName(node)
            if (tag === 'input' || tag === 'textarea') return
            const role = literalRole(node)
            const contentEditable = attribute(node, 'contentEditable') ?? attribute(node, 'contenteditable')
            if (contentEditable !== undefined && role !== 'textbox') {
              context.report({ node, messageId: 'missingRole' })
            }
            if (role === 'textbox' && contentEditable === undefined) {
              context.report({ node, messageId: 'missingContentEditable' })
            }
          },
        }
      },
    },
  },
}

export default plugin
