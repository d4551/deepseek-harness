/**
 * Which pointer gestures the host platform has already spent. Apple platforms
 * spend Ctrl+click on the secondary menu, so a row reading Ctrl as "add to the
 * range" would edit the range from the press that asked for a menu; Cmd is the
 * additive modifier there, and everywhere else it is Ctrl. That press reaches
 * `contextmenu` reporting the primary button rather than button 2, so the
 * button alone cannot tell a cursor from a keyboard request.
 *
 * These readings decide placement and meaning, never safety: a row swallows
 * the click that arrives under its own open menu by reading that menu, so a
 * host whose `navigator.platform` misreports still cannot act twice on one
 * press.
 */

/**
 * Whether this host reserves Ctrl+click for the secondary menu.
 * `navigator.platform` is deprecated and the only platform reading every
 * browser answers; the modifier a keyboard-and-pointer convention hangs on is
 * the use MDN still documents it for.
 * @returns whether the host is an Apple platform.
 */
function applePointer(): boolean {
  return navigator.platform.startsWith('Mac') || navigator.platform.startsWith('iP')
}

/**
 * Whether a gesture carries the modifier this platform spends on editing a
 * range — adding one row from a click, or taking the whole account from a
 * keystroke — rather than replacing the range or activating the row.
 * @param event - the click or keystroke reaching the row.
 * @returns whether it carries this platform's additive modifier.
 */
export function additiveModifier(event: { ctrlKey: boolean; metaKey: boolean }): boolean {
  return applePointer() ? event.metaKey : event.ctrlKey
}

/**
 * Whether a `contextmenu` came from a pointer press, whose cursor the list
 * opens under and whose operator is not in the keyboard. An Apple Ctrl+click
 * reports the primary button, so the platform is what names it a press.
 * @param event - the contextmenu request reaching the row.
 * @returns whether a press asked, rather than the keyboard or a long touch.
 */
export function secondaryPress(event: { button: number; ctrlKey: boolean }): boolean {
  return event.button === 2 || (applePointer() && event.ctrlKey)
}
