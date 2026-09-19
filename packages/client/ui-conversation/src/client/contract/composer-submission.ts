/** Composer submission vocabulary shared by the input and settings domains. */

export { requireBusyEnterBehavior, type BusyEnterBehavior } from '../../submission-settings.ts'
import type { BusyEnterBehavior } from '../../submission-settings.ts'

/** Delivery mode requested for one ordinary composer message. */
export type InputSubmitMode = BusyEnterBehavior

/** Keyboard gesture whose delivery mode the submission policy resolves. */
export type ComposerSubmitGesture = 'enter' | 'accelerated'
