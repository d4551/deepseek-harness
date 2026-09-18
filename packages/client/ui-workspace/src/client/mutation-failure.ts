/**
 * Surface a rejected workspace mutation as an Error message.
 * @param reason - the promise rejection.
 * @returns the Error message.
 */
export function mutationFailureMessage(reason: Error): string {
  return reason.message
}
