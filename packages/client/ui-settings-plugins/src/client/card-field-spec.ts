/**
 * Field conversion specs a plugin card declares for its settings section.
 *
 * Each spec converts between one section field's stored value and the draft
 * text its control renders. An empty draft always stages a clear, so emptying
 * a control and saving is the same gesture as resetting it.
 */

/** The value kinds a plugin card's section fields carry and stage. */
export type SettingValue = boolean | number | string | readonly string[]

/** The write one field's staged text performs when the card is saved. */
export type FieldWrite =
  | { kind: 'set'; value: SettingValue }
  | { kind: 'clear' }

/** The write every field spec stages for a draft that empties the field. */
export const CLEAR_WRITE: FieldWrite = { kind: 'clear' }

/** How one section field converts between its stored value and its draft text. */
export interface CardFieldSpec {
  /** Field name inside the namespace section. */
  field: string
  /** Render a stored value as draft text; the empty string when the section carries none. */
  format: (value: SettingValue | undefined) => string
  /**
   * The write this draft text stages, or undefined when the text is not a
   * value this field accepts — which blocks the save rather than discarding it.
   */
  parse: (text: string) => FieldWrite | undefined
}

/**
 * A boolean field. An empty draft clears the field, so the control renders
 * blank rather than guessing a switch position nobody chose; `true` and
 * `false` stage case-insensitively and any other draft blocks the save.
 * @param field - field name inside the namespace section.
 * @returns the field's conversion spec.
 */
export function booleanField(field: string): CardFieldSpec {
  return {
    field,
    format: value => typeof value === 'boolean' ? String(value) : '',
    parse: (text) => {
      const lowered = text.trim().toLowerCase()
      if (lowered === '') return CLEAR_WRITE
      if (lowered === 'true') return { kind: 'set', value: true }
      if (lowered === 'false') return { kind: 'set', value: false }
      return undefined
    },
  }
}

/**
 * A whole-number field. An empty draft clears the field; any other draft that
 * is not a finite number blocks the save.
 * @param field - field name inside the namespace section.
 * @returns the field's conversion spec.
 */
export function numberField(field: string): CardFieldSpec {
  return {
    field,
    // A section that carries no number for this field renders empty rather
    // than as a value nobody chose.
    format: value => typeof value === 'number' ? String(value) : '',
    parse: (text) => {
      const trimmed = text.trim()
      if (trimmed === '') return CLEAR_WRITE
      const parsed = Number(trimmed)
      return Number.isFinite(parsed) ? { kind: 'set', value: parsed } : undefined
    },
  }
}

/**
 * A free-text field. An empty draft clears the field, so emptying the control
 * and saving is the same gesture as resetting it.
 * @param field - field name inside the namespace section.
 * @returns the field's conversion spec.
 */
export function textField(field: string): CardFieldSpec {
  return {
    field,
    format: value => typeof value === 'string' ? value : '',
    parse: (text) => {
      const trimmed = text.trim()
      return trimmed === '' ? CLEAR_WRITE : { kind: 'set', value: trimmed }
    },
  }
}

/**
 * A string-list field edited as one entry per line. An empty draft clears the
 * field; otherwise each non-empty line stages as one entry. Entries are not
 * validated here: the Host section's schema is the authority, and a rejected
 * save keeps its drafts for correction.
 * @param field - field name inside the namespace section.
 * @returns the field's conversion spec.
 */
export function stringListField(field: string): CardFieldSpec {
  return {
    field,
    // The Host is the authority, but a hostile or stale document may carry
    // non-string rows: drop them instead of rendering the whole list unusable.
    format: value => (Array.isArray(value) ? value.filter(entry => typeof entry === 'string') : []).join('\n'),
    parse: (text) => {
      const entries = text.split('\n').map(line => line.trim()).filter(line => line !== '')
      return entries.length === 0 ? CLEAR_WRITE : { kind: 'set', value: entries }
    },
  }
}
