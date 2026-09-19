/**
 * Runtime claims for optional sibling services the conversation hub may
 * resolve. Those plugins are not package dependencies; the hub reads them
 * through Context.get and claims the published faces here.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { InputTriggerController } from '../contract/input.ts'
import type { PopupDismissFace } from './facade.ts'

/** Slash registry that can mint a per-session controller. */
interface InputTriggerServiceFace {
  sessionOf(actx: Context): InputTriggerController
}

/** Command UI registry that can mint a per-session popup controller. */
interface CommandPopupServiceFace {
  popupFor(actx: Context): unknown
}

function isInputTriggerService(value: object): value is InputTriggerServiceFace {
  return 'sessionOf' in value && typeof value.sessionOf === 'function'
}

function isCommandPopupService(value: object): value is CommandPopupServiceFace {
  return 'popupFor' in value && typeof value.popupFor === 'function'
}

function isPopupDismissFace(value: object): value is PopupDismissFace {
  return 'dismiss' in value && typeof value.dismiss === 'function'
}

/**
 * Read a Context service that is not part of this package's typed merge.
 * @param ctx - lookup context.
 * @param name - published service name.
 * @returns the stored value, or undefined when absent.
 */
export function namedServiceOf(ctx: Context, name: string): unknown {
  const value: unknown = ctx.get(name)
  return value
}

/**
 * Resolve a session input-trigger controller from an optional service value.
 * @param service - Context.get('inputTriggers') result.
 * @param actx - session scope.
 * @returns the controller, or undefined when the service is absent or not that face.
 */
export function inputTriggerControllerOf(
  service: unknown,
  actx: Context,
): InputTriggerController | undefined {
  if (service === undefined || service === null || typeof service !== 'object') return undefined
  if (!isInputTriggerService(service)) return undefined
  return service.sessionOf(actx)
}

/**
 * Resolve a popup dismiss face from an optional command UI service value.
 * @param service - Context.get('commandUi') result.
 * @param actx - session scope.
 * @returns the dismiss face, or undefined when the service or popup is absent.
 */
export function commandPopupDismissOf(
  service: unknown,
  actx: Context,
): PopupDismissFace | undefined {
  if (service === undefined || service === null || typeof service !== 'object') return undefined
  if (!isCommandPopupService(service)) return undefined
  const popup = service.popupFor(actx)
  if (popup === undefined || popup === null || typeof popup !== 'object') return undefined
  if (!isPopupDismissFace(popup)) return undefined
  return popup
}
