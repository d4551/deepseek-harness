import { CatLogo } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HeroBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import css from './Brand.module.css'

type OfficialBrandMarkProps = HeroBrandMarkOwnerProps & SidebarBrandMarkOwnerProps

/** The product name every official artifact carries; a brand token, identical in every locale. */
const OFFICIAL_BRAND_NAME = 'DeepMeow'

/**
 * Render the official mark with the presentation requested by its host surface.
 * @param props - Host-supplied mark presentation.
 * @returns the official cat-face mark.
 */
export function OfficialBrandMark({ size, className }: OfficialBrandMarkProps) {
  return <CatLogo size={size} className={className} />
}

/**
 * Render the official name as text beside its independently slotted mark.
 * @returns the official name.
 */
export function OfficialBrandName() {
  return <span className={css.name}>{OFFICIAL_BRAND_NAME}</span>
}
