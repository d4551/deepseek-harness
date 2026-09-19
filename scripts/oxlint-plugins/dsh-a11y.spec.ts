import { RuleTester } from 'oxlint/plugins-dev'
import { describe, it } from 'vitest'
import plugin from './dsh-a11y.js'

RuleTester.describe = describe
RuleTester.it = it

const ruleTester = new RuleTester({
  languageOptions: { parserOptions: { lang: 'tsx' } },
})

const rule = plugin.rules['contenteditable-textbox']
if (rule === undefined) throw new Error('dsh-a11y must export contenteditable-textbox')

ruleTester.run('contenteditable-textbox', rule, {
  valid: [
    {
      name: 'host ref receives setAttribute after a current alias',
      filename: 'Composer.tsx',
      code: `
        import { useLayoutEffect, useRef } from 'react'
        export function Host() {
          const ref = useRef(null)
          useLayoutEffect(() => {
            const el = ref.current
            if (el === null) return
            el.setAttribute('role', 'textbox')
          }, [])
          return <div ref={ref} contentEditable />
        }
      `,
    },
    {
      name: 'host ref receives setAttribute on current directly',
      filename: 'Composer.tsx',
      code: `
        import { useRef } from 'react'
        export function Host() {
          const ref = useRef(null)
          ref.current.setAttribute('role', 'textbox')
          return <div ref={ref} contentEditable={true} />
        }
      `,
    },
    {
      name: 'JSX textbox already declares contentEditable',
      filename: 'Composer.tsx',
      code: 'export function Host() { return <div role="textbox" contentEditable /> }',
    },
    {
      name: 'native textarea is not a generic host',
      filename: 'Composer.tsx',
      code: 'export function Host() { return <textarea contentEditable /> }',
    },
  ],
  invalid: [
    {
      name: 'contenteditable host without a host-bound role',
      filename: 'Composer.tsx',
      code: 'export function Host() { return <div contentEditable /> }',
      errors: [{ messageId: 'missingRole' }],
    },
    {
      name: 'JSX textbox without contentEditable',
      filename: 'Composer.tsx',
      code: 'export function Host() { return <div role="textbox" /> }',
      errors: [{ messageId: 'missingContentEditable' }],
    },
    {
      name: 'string mention of setAttribute does not satisfy the host',
      filename: 'Composer.tsx',
      code: `
        export function Host() {
          const decoy = "setAttribute('role', 'textbox')"
          return <div contentEditable data-decoy={decoy} />
        }
      `,
      errors: [{ messageId: 'missingRole' }],
    },
    {
      name: 'setAttribute on a different ref does not satisfy the host',
      filename: 'Composer.tsx',
      code: `
        import { useRef } from 'react'
        export function Host() {
          const decoy = useRef(null)
          const ref = useRef(null)
          const el = decoy.current
          el.setAttribute('role', 'textbox')
          return <div ref={ref} contentEditable />
        }
      `,
      errors: [{ messageId: 'missingRole' }],
    },
  ],
})
