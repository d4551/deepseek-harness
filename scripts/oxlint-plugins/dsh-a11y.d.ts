import type { RuleTester } from 'oxlint/plugins-dev'

type ContentEditableTextboxRule = Parameters<RuleTester['run']>[1]

declare const plugin: {
  readonly meta: { readonly name: 'dsh-a11y' }
  readonly rules: {
    readonly 'contenteditable-textbox': ContentEditableTextboxRule
  }
}

export default plugin
