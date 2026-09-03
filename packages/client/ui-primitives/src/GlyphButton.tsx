import type { ButtonHTMLAttributes, Ref } from 'react'
import clsx from 'clsx'
import css from './GlyphButton.module.css'

/**
 * Surface an icon button sits on. Each names one box and ink: `sidebar` the
 * shell controls, `header` a panel or composer control, `bar` a dock action,
 * and `message` a message action row that scales with the content font axis.
 */
export type GlyphButtonSurface = 'sidebar' | 'header' | 'bar' | 'message'

/**
 * Render an icon-only button.
 * @param props.surface - which surface's box and ink the button takes.
 * @param props.className - the owner's class, carrying its hover, focus, and
 * disabled treatments; it must outrank a single class selector, since sheet
 * order between packages is not fixed.
 * @param props.ref - the button element, for an owner that anchors a popover to
 * it or that Tooltip clones.
 * @returns the button element; native button attributes pass through.
 */
export function GlyphButton({ surface, className, ref, ...rest }: {
  surface: GlyphButtonSurface
  className?: string | undefined
  ref?: Ref<HTMLButtonElement> | undefined
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button ref={ref} type="button" className={clsx(css.root, css[surface], className)} {...rest} />
}
