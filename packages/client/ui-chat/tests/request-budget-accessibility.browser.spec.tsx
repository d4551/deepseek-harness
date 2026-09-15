import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { accessibilityFailures, auditSurface } from '@deepseek-ai/dsh-client-a11y'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { TurnLimitNotice } from '../src/client/chat/TurnLimitNotice.tsx'
import { en } from '../src/client/locale.ts'

afterEach(() => {
  cleanup()
  document.body.removeAttribute('data-ds-dark-theme')
})

it.each(['light', 'dark'])('keeps the request-limit notice readable and accessible in %s theme', async (theme) => {
  document.body.toggleAttribute('data-ds-dark-theme', theme === 'dark')
  const t = makeTranslate(en, commonEn)
  const view = render(<main><TurnLimitNotice
    title={t('message.requestBudget')}
    hint={t('message.requestBudget.hint')}
    usage={t('message.requestBudget.usage', { actor: 32, actorLimit: 32, root: 48, rootLimit: 64 })}
  /></main>)
  expect(view.getByRole('status').textContent).toContain('32/32 requests')
  const audit = await auditSurface(`request-budget-${theme}`, view.baseElement)
  expect(audit.passed + audit.failed).toBeGreaterThan(0)
  expect(audit.undecidedRules).toEqual([])
  expect(accessibilityFailures([audit], 100), JSON.stringify({
    title: getComputedStyle(view.getByText(t('message.requestBudget'))).color,
    background: getComputedStyle(document.body).backgroundColor,
    contrast: audit.violations.flatMap(rule => rule.nodes.map(node => node.failureSummary)),
  })).toBe('')
})
