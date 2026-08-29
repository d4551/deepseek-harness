import type { IconProps } from './icons/props.ts'

/**
 * Render the local-build cat-face mark.
 * @param props.size - square edge in px (default 24).
 * @param props.className - extra class for layout placement.
 * @returns the logo svg (aria-hidden; pair with the product name for accessibility).
 */
export function CatLogo({ size = 24, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M4 9.2 5.2 2.2 10.2 7.1h3.6L18.8 2.2 20 9.2C22.8 11 23.2 15.2 21.4 18.6 19.6 22.2 15.8 23.8 12 23.8S4.4 22.2 2.6 18.6C.8 15.2 1.2 11 4 9.2ZM8.4 12.2a1.7 1.7 0 1 0 0 3.4 1.7 1.7 0 1 0 0-3.4ZM15.6 12.2a1.7 1.7 0 1 0 0 3.4 1.7 1.7 0 1 0 0-3.4ZM12 16.2 13.15 17.9h-2.3z"
      />
    </svg>
  )
}
