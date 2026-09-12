/**
 * `makeTranslate` stands in for the locale lookup chain in component specs,
 * so its resolution order and interpolation have to match what LocaleRuntime
 * does: the first dictionary owning a key wins, an unowned key stays visible,
 * and `{name}` slots fill from the params while an unknown slot stays as is.
 */
import { describe, expect, it } from 'vitest'
import { makeTranslate } from '../src/translate.ts'

const zh = { 'menu.userOnly': '仅用户', 'greeting': '你好，{name}' }
const common = { 'greeting': 'hello, {name}', 'action.cancel': 'cancel' }

describe('makeTranslate', () => {
  it('resolves through the dictionaries in order and keeps an unowned key visible', () => {
    const t = makeTranslate(zh, common)
    expect(t('greeting')).toBe('你好，{name}')
    expect(t('action.cancel')).toBe('cancel')
    expect(t('menu.missing')).toBe('menu.missing')
  })

  it('fills template slots from the params and leaves an unknown slot untouched', () => {
    const t = makeTranslate(zh, common)
    expect(t('greeting', { name: 'Bao' })).toBe('你好，Bao')
    expect(t('greeting', { other: 'x' })).toBe('你好，{name}')
    expect(makeTranslate()('count: {n} of {total}', { n: 2 })).toBe('count: 2 of {total}')
  })
})
