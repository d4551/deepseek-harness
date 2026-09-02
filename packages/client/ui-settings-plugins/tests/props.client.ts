/**
 * Typing crossing the card specs share: feeding a direct-props component spec
 * its props.
 */

/**
 * Feed a component spec the props it can satisfy directly. Card props derive
 * their framework shares from the render machinery a direct-props spec runs
 * without; the shares the spec does drive (actions, `t`, a bound selector)
 * cross to the real props type once, here.
 * @param partial - the actions, locale seat, and bound selector the spec drives.
 * @returns the same object typed as the component's props.
 */
export function cardProps<P extends object>(partial: Partial<P>): P {
  return partial as P
}
