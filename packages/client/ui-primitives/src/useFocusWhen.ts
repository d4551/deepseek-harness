import { useLayoutEffect, useRef, type RefObject } from 'react'

/**
 * Focus a mounted element when `active` is true. Use this for user-initiated
 * surfaces (an opened inline editor, a newly presented field) instead of the
 * HTML `autoFocus` attribute, which steals focus on first paint.
 * @param active - whether the target should hold focus.
 * @returns a ref to attach to the focusable element.
 */
export function useFocusWhen<T extends HTMLElement>(active: boolean): RefObject<T | null> {
  const ref = useRef<T>(null)
  useLayoutEffect(() => {
    if (!active) return
    const node = ref.current
    if (node === null) throw new TypeError('focus target is not mounted')
    node.focus()
  }, [active])
  return ref
}
