// @vitest-environment jsdom
import * as Cordis from '@deepseek-ai/cordis'
import * as ClientStore from '@deepseek-ai/dsh-client-store'
import * as UiPrimitives from '@deepseek-ai/dsh-client-ui-primitives'
import * as UiProjection from '@deepseek-ai/dsh-client-ui-projection'
import * as UiSlots from '@deepseek-ai/dsh-client-ui-slots'
import * as React from 'react'
import * as ReactDom from 'react-dom'
import * as ReactDomClient from 'react-dom/client'
import * as ReactJsxRuntime from 'react/jsx-runtime'
import { describe, expect, it } from 'vitest'
import { PLATFORM_MODULES } from '../src/platform.ts'
import { getStaticModules } from '../src/seed.ts'

describe('static module table', () => {
  it('seeds every PLATFORM_MODULES word with the shell singleton', () => {
    const table = getStaticModules()
    expect(PLATFORM_MODULES).toEqual([
      'react',
      'react/jsx-runtime',
      'react-dom',
      'react-dom/client',
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-client-store',
      '@deepseek-ai/dsh-client-ui-slots',
      '@deepseek-ai/dsh-client-ui-primitives',
      '@deepseek-ai/dsh-client-ui-projection',
    ])
    expect(table['react']).toBe(React)
    expect(table['react/jsx-runtime']).toBe(ReactJsxRuntime)
    expect(table['react-dom']).toBe(ReactDom)
    expect(table['react-dom/client']).toBe(ReactDomClient)
    expect(table['@deepseek-ai/cordis']).toBe(Cordis)
    expect(table['@deepseek-ai/dsh-client-store']).toBe(ClientStore)
    expect(table['@deepseek-ai/dsh-client-ui-slots']).toBe(UiSlots)
    expect(table['@deepseek-ai/dsh-client-ui-primitives']).toBe(UiPrimitives)
    expect(table['@deepseek-ai/dsh-client-ui-projection']).toBe(UiProjection)
  })

  it('answers historical dsh-client-runtime specifiers with the client-store singleton', () => {
    const table = getStaticModules()
    expect(table['@deepseek-ai/dsh-client-runtime']).toBe(ClientStore)
    expect(table['@deepseek-ai/dsh-client-runtime/client']).toBe(ClientStore)
  })
})
