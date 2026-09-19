export type Thrown = object | string | number | boolean | bigint | symbol | null | undefined

/**
 * Surface a rejected workspace mutation as text.
 * @param reason - the promise rejection.
 * @returns the Error message, or the stringified refusal.
 */
export function mutationFailureMessage(reason: Thrown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
