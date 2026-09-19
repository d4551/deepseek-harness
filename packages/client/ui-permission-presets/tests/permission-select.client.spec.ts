// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { permissionSelectOf } from '../src/client/index.ts'

describe('permissionSelectOf', () => {
  it('claims a permissions projection and refuses anything else', () => {
    expect(permissionSelectOf(undefined)).toBeUndefined()
    expect(permissionSelectOf({})).toBeUndefined()
    expect(permissionSelectOf({ currentValue: 'default', options: 'nope' })).toBeUndefined()
    expect(permissionSelectOf({
      currentValue: 'default',
      options: [{ value: 'default', name: 'Default' }],
    })).toEqual({
      currentValue: 'default',
      options: [{ value: 'default', name: 'Default' }],
    })
  })
})
