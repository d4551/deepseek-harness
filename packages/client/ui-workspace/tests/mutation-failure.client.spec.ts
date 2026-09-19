import { describe, expect, it } from 'vitest'
import { mutationFailureMessage } from '../src/client/mutation-failure.ts'

describe('mutationFailureMessage', () => {
  it('reads the Error message', () => {
    expect(mutationFailureMessage(new Error('reorder rejected'))).toBe('reorder rejected')
  })

  it('stringifies a non-Error refusal', () => {
    expect(mutationFailureMessage('plain refusal')).toBe('plain refusal')
  })
})
