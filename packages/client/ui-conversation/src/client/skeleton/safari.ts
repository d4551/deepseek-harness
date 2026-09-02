/** Safari-specific textarea layout recovery for the conversation composer. */

/** Browser identity fields needed to distinguish Safari from other WebKit-based browsers. */
export interface BrowserIdentity {
  readonly userAgent: string
  readonly vendor: string
}

const ALTERNATE_IOS_BROWSER = /\b(?:CriOS|FxiOS|EdgiOS|OPiOS|OPT|DuckDuckGo|Brave)(?:\/|\b)/

/**
 * Detect Safari's `Version/... Safari/...` form while excluding known alternate iOS browser tokens.
 * @param identity - Browser user-agent and vendor values.
 * @returns Whether the identity should use the Safari-specific recovery.
 */
export function isSafariBrowser(identity: BrowserIdentity): boolean {
  return identity.vendor === 'Apple Computer, Inc.'
    && /\bVersion\/[\d.]+.*\bSafari\/[\d.]+/.test(identity.userAgent)
    && !ALTERNATE_IOS_BROWSER.test(identity.userAgent)
}

/**
 * Repair Safari's stale native textarea layout and the scrollport auto height it can contaminate.
 * @param input - Composer textarea whose own scrollable overflow must stay zero.
 */
/** The property the nudge is spent through, declared in the composer sheet. */
const NUDGE_VARIABLE = '--dsh-safari-reflow-height'

export function repairSafariTextareaLayout(input: HTMLTextAreaElement | null): void {
  if (input === null || input.scrollHeight <= input.clientHeight) return
  const scrollport = input.closest<HTMLElement>('[data-input-scroll]')
  if (scrollport === null) return

  nudgeHeight(input)
  nudgeHeight(scrollport)
}

/**
 * Force one layout pass by changing an element's height and putting it back.
 *
 * The nudge crosses as a custom property the sheet spends, so the height rule
 * stays where every other height rule is; a script writing `style.height`
 * would be a geometry decision no theme or media query could reach. The value
 * is removed rather than restored to empty, because an element that never had
 * the property must not be left declaring it.
 * @param element - the element whose layout Safari has left stale.
 * @returns nothing.
 */
function nudgeHeight(element: HTMLElement): void {
  const held = element.style.getPropertyValue(NUDGE_VARIABLE)
  element.style.setProperty(NUDGE_VARIABLE, `${String(element.clientHeight + 1)}px`)
  void element.offsetHeight
  if (held === '') element.style.removeProperty(NUDGE_VARIABLE)
  else element.style.setProperty(NUDGE_VARIABLE, held)
  void element.offsetHeight
}
