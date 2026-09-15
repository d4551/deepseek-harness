import type { HighlighterCore } from 'shiki/core'
import type { LangModule } from './highlight-grammars.ts'

type GrammarLoadState =
  | { status: 'loading'; completion: Promise<void> }
  | { status: 'failed'; error: Error }
  | { status: 'ready' }

interface GrammarLoadObserver {
  loaded(): void
  failed(error: Error): void
}

/** Owns each grammar attempt for the document, including retained import failures. */
export class GrammarLoads {
  private readonly states = new Map<string, GrammarLoadState>()
  private readonly highlighter: () => HighlighterCore
  private readonly loaders: ReadonlyMap<string, () => Promise<LangModule>>
  private readonly observer: GrammarLoadObserver

  constructor(
    highlighter: () => HighlighterCore,
    loaders: ReadonlyMap<string, () => Promise<LangModule>>,
    observer: GrammarLoadObserver,
  ) {
    this.highlighter = highlighter
    this.loaders = loaders
    this.observer = observer
  }

  /** Returns readiness synchronously while retaining ownership of pending work. */
  ensure(resolved: string): boolean {
    const load = this.loaders.get(resolved)
    if (load === undefined) return true
    if (this.highlighter().getLoadedLanguages().includes(resolved)) return true
    const state = this.states.get(resolved)
    if (state?.status === 'loading' || state?.status === 'failed') return false
    const operation = Promise.resolve().then(load).then((module) => {
      const instance = this.highlighter()
      instance.loadLanguageSync(module.default)
      if (!instance.getLoadedLanguages().includes(resolved)) {
        throw new Error(`Loaded syntax grammar does not register "${resolved}"`)
      }
    })
    const completion = Promise.allSettled([operation]).then(([result]) => {
      if (result.status === 'rejected') {
        const error = new Error(`Could not load syntax grammar "${resolved}"`, { cause: result.reason })
        this.states.set(resolved, { status: 'failed', error })
        queueMicrotask(() => { this.observer.failed(error) })
      } else {
        this.states.set(resolved, { status: 'ready' })
        queueMicrotask(() => { this.observer.loaded() })
      }
    })
    this.states.set(resolved, { status: 'loading', completion })
    return false
  }

  /** A stable error while the grammar remains unavailable; another module may register it. */
  failure(resolved: string): Error | undefined {
    const state = this.states.get(resolved)
    return state?.status === 'failed' && !this.highlighter().getLoadedLanguages().includes(resolved)
      ? state.error
      : undefined
  }
}
