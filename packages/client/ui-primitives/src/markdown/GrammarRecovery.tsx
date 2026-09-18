import { useSyncExternalStore } from 'react'
import { Button } from '../Button.tsx'
import { grammarFailure, subscribeGrammarChanges } from './highlight.ts'

/** Localized explanation and explicit recovery action for a failed grammar download. */
export interface GrammarRecoveryLabels {
  failed: string
  reload: string
}

/** Keep code readable while offering a document reload that clears failed module imports. */
export function GrammarRecovery({ lang, labels }: {
  lang: string | undefined
  labels: GrammarRecoveryLabels
}) {
  const failure = useSyncExternalStore(
    subscribeGrammarChanges,
    () => grammarFailure(lang),
    () => grammarFailure(lang),
  )
  if (failure === undefined) return null
  return (
    <output>
      <span>{labels.failed}</span>{' '}
      <Button onClick={() => { window.location.reload() }}>{labels.reload}</Button>
    </output>
  )
}
