// Host clipboard write shared by Web UI copy controls. Success feedback stays
// with each control; this helper only reports whether the host accepted a write.

/** Values a Promise reject arm may deliver. */
type Thrown = object | string | number | boolean | bigint | symbol | null | undefined

/**
 * Walk own and prototype properties and return the value as `unknown`.
 * Lib DOM getters are typed `any`; the brand happens after an own-property gate.
 * @param target - object that may own or inherit `key`.
 * @param key - property name.
 * @returns the property value, or undefined when absent.
 */
function unknownOwn(target: object, key: string): unknown {
  let current: object | null = target
  while (current !== null) {
    if (Object.hasOwn(current, key)) {
      const boxed = Object.getOwnPropertyDescriptor(current, key)
      if (boxed === undefined) return undefined
      const getter = boxed['get']
      if (typeof getter === 'function') {
        return Reflect.apply(getter, target, []) as unknown
      }
      if (Object.hasOwn(boxed, 'value')) return boxed.value as unknown
      return undefined
    }
    current = Reflect.getPrototypeOf(current)
  }
  return undefined
}

/**
 * Write text through the async Clipboard API. Hosts that omit it (insecure
 * context, jsdom without a clipboard) report false — copy controls already
 * surface that refusal.
 * @param text - the exact text to place on the clipboard.
 * @returns true only when the host accepted the write.
 */
export function writeClipboard(text: string): Promise<boolean> {
  const clipboard = unknownOwn(navigator, 'clipboard')
  if (typeof clipboard !== 'object' || clipboard === null) return Promise.resolve(false)
  const writeText = unknownOwn(clipboard, 'writeText')
  if (typeof writeText !== 'function') return Promise.resolve(false)
  const written: unknown = Reflect.apply(writeText, clipboard, [text])
  if (written instanceof Promise) {
    return written.then(() => true, (_error: Thrown) => false)
  }
  return Promise.reject(new TypeError('clipboard.writeText must return a Promise'))
}
