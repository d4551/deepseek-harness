import { inject } from 'vitest'

declare module 'vitest' {
  export interface ProvidedContext {
    /** Stryker command runner's mutation identity for this browser process. */
    strykerActiveMutant: string | undefined
  }
}

const activeMutant = inject('strykerActiveMutant')
if (activeMutant !== undefined) {
  const namespace: unknown = Reflect.get(globalThis, '__stryker__')
  if (typeof namespace === 'object' && namespace !== null) {
    Reflect.set(namespace, 'activeMutant', activeMutant)
  } else {
    Reflect.set(globalThis, '__stryker__', { activeMutant })
  }
}
