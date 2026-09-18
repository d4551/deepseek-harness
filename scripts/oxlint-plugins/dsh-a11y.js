/**
 * Accessibility rules that jsx-a11y does not model for custom editors.
 * A Lexical (or other) contenteditable host cannot be a native textarea
 * because decorator chips are element children of the root.
 * jsx-a11y/prefer-tag-over-role wants a textarea for role=textbox, so the
 * host must apply role=textbox on the element (setAttribute) rather than in JSX.
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

function setsTextboxRoleOnHost(context) {
  const source = context.sourceCode.getText()
  return source.includes("setAttribute('role', 'textbox')")
    || source.includes('setAttribute("role", "textbox")')
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
        return {
          JSXOpeningElement(node) {
            const tag = tagName(node)
            if (tag === 'input' || tag === 'textarea') return
            const role = literalRole(node)
            const contentEditable = attribute(node, 'contentEditable') ?? attribute(node, 'contenteditable')
            if (contentEditable !== undefined && role !== 'textbox' && !setsTextboxRoleOnHost(context)) {
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
