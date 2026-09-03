/**
 * Platform-singleton module-table. Fetch bundles resolve their externals
 * against this set through the loader's require. Keys for first-party
 * tsdown come from {@link ./platform.ts}; values stay shell-static imports
 * so every bundle sees the same instance. Historical out-of-tree specifiers
 * listed after the `satisfies` pin share those same instances and are not
 * `PLATFORM_MODULES` words.
 */
import * as React from 'react'
import * as ReactJsxRuntime from 'react/jsx-runtime'
import * as ReactDom from 'react-dom'
import * as ReactDomClient from 'react-dom/client'
import * as Cordis from '@deepseek-ai/cordis'
import * as ClientStore from '@deepseek-ai/dsh-client-store'
import * as UiSlots from '@deepseek-ai/dsh-client-ui-slots'
import * as UiPrimitives from '@deepseek-ai/dsh-client-ui-primitives'
import * as UiProjection from '@deepseek-ai/dsh-client-ui-projection'
import type { PlatformModule } from './platform.ts'

/**
 * Build the static table handed to the module loader at boot.
 * @returns module specifier → exported entity (every platform word, plus historical out-of-tree specifiers).
 */
export function getStaticModules(): Record<string, unknown> {
  // The satisfies pin is the projection contract: a word added to
  // PLATFORM_MODULES without a static import here (or vice versa) fails to
  // compile instead of drifting into a runtime require miss.
  const modules = {
    'react': React,
    'react/jsx-runtime': ReactJsxRuntime,
    'react-dom': ReactDom,
    'react-dom/client': ReactDomClient,
    '@deepseek-ai/cordis': Cordis,
    '@deepseek-ai/dsh-client-store': ClientStore,
    '@deepseek-ai/dsh-client-ui-slots': UiSlots,
    '@deepseek-ai/dsh-client-ui-primitives': UiPrimitives,
    '@deepseek-ai/dsh-client-ui-projection': UiProjection,
  } satisfies Record<PlatformModule, object>
  return {
    ...modules,
    '@deepseek-ai/dsh-client-runtime': ClientStore,
    '@deepseek-ai/dsh-client-runtime/client': ClientStore,
  }
}
