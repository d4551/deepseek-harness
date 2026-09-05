/**
 * Hand-written controls for the plugin configuration forms. Each renders one
 * field's label, its staged text, whether saving would leave an override, and
 * — when one stands — the reset that stages a clear back to the composition
 * layer. Nothing here writes: a control reports what the user typed, and the
 * card's save is the single point where a draft becomes a document mutation.
 */

import { createElement, type ChangeEvent } from 'react'
import css from './fields.module.css'

/** What every field control needs regardless of its value type. */
export interface FieldProps {
  /** Stable id associating the label with its control. */
  id: string
  /** Visible label. */
  label: string
  /** One-line explanation rendered under the control. */
  hint: string
  /** Draft text this control renders. */
  text: string
  /** True when saving would leave a user-layer entry for this field. */
  overridden: boolean
  /** True when the draft is not a value this field accepts. */
  invalid: boolean
  /** Copy for the overridden badge. */
  overriddenLabel: string
  /** Copy for the reset control. */
  resetLabel: string
  /** Copy shown in place of the hint while the draft is invalid. */
  invalidLabel: string
  /** Disables every control (read-only document, or an unavailable namespace). */
  disabled: boolean
  /** Stage draft text. */
  onEdit: (text: string) => void
  /** Stage a clear so the field re-inherits the composition layer. */
  onReset: () => void
}

function OverrideBadge(props: Pick<FieldProps,
  'overridden' | 'overriddenLabel' | 'resetLabel' | 'disabled' | 'onReset'>) {
  return props.overridden
    ? createElement(
      'span',
      { className: css.badges },
      createElement('span', { className: css.badge }, props.overriddenLabel),
      createElement(
        'button',
        {
          type: 'button',
          className: css.reset,
          disabled: props.disabled,
          onClick: props.onReset,
        },
        props.resetLabel,
      ),
    )
    : null
}

/**
 * A staged value field. `numeric` only hints the keypad: which drafts a field
 * accepts is decided by its spec, so the control never silently rewrites what
 * the user typed.
 * @param props - the field's copy, its staged text, and the edit actions.
 * @returns the labelled control.
 */
export function ValueField(props: FieldProps & {
  /** Hints a numeric keypad without narrowing what the control accepts. */
  numeric?: boolean
  /** Placeholder shown while the draft is empty. */
  placeholder?: string
}) {
  return (
    <div className={css.field}>
      <div className={css.head}>
        <label className={css.label} htmlFor={props.id}>{props.label}</label>
        {createElement(OverrideBadge, props)}
      </div>
      <input
        id={props.id}
        className={`${css.input}${props.invalid ? ` ${css.inputInvalid}` : ''}`}
        type="text"
        {...props.numeric === true ? { inputMode: 'numeric' as const } : {}}
        {...props.invalid ? { 'aria-invalid': true } : {}}
        value={props.text}
        placeholder={props.placeholder ?? ''}
        disabled={props.disabled}
        onChange={(event) => { props.onEdit(event.target.value) }}
      />
      <p className={props.invalid ? css.invalid : css.hint}>
        {props.invalid ? props.invalidLabel : props.hint}
      </p>
    </div>
  )
}

export function MultilineField(props: FieldProps) {
  const hintId = props.id + '-hint'
  return createElement(
    'div',
    { className: css.field },
    createElement(
      'div',
      { className: css.head },
      createElement('label', { className: css.label, htmlFor: props.id }, props.label),
      createElement(OverrideBadge, props),
    ),
    createElement('textarea', {
      id: props.id,
      rows: 4,
      className: [css.input, css.multiline, props.invalid ? css.inputInvalid : undefined]
        .filter(Boolean).join(' '),
      'aria-describedby': hintId,
      'aria-invalid': props.invalid || undefined,
      value: props.text,
      disabled: props.disabled,
      onChange: (event: ChangeEvent<HTMLTextAreaElement>) => { props.onEdit(event.target.value) },
    }),
    createElement(
      'p',
      { id: hintId, className: props.invalid ? css.invalid : css.hint },
      props.invalid ? props.invalidLabel : props.hint,
    ),
  )
}

/** One option a {@link ChoiceField} offers. */
export interface ChoiceOption {
  /** Value staged when this option is picked; also its input value. */
  value: string
  /** Visible option name. */
  label: string
  /** One-line explanation rendered under the option name. */
  description: string
  /** Whether the staged value names this option. */
  selected: boolean
  /** Whether this option can be picked; a disabled option still renders. */
  pickable: boolean
  /** Copy explaining why an unpickable option cannot be picked. */
  unavailableLabel?: string
}

/**
 * A staged single-choice field, rendered as one radio group so the browser
 * treats the options as one selection and arrow keys move between them. An
 * option this deployment cannot serve stays visible and disabled: hiding it
 * would leave the user unable to learn that the backend exists.
 * @param props - the group's copy, its options, and the staging actions.
 * @returns the labelled radio group.
 */
export function ChoiceField(props: Pick<FieldProps,
  'id' | 'label' | 'hint' | 'overridden' | 'overriddenLabel' | 'resetLabel' | 'disabled' | 'onReset'> & {
  /** Radio group name; one per group on the page. */
    name: string
    /** Options in the order they render. */
    options: readonly ChoiceOption[]
    /** Stage the picked option's value. */
    onPick: (value: string) => void
  }) {
  return (
    <div className={css.field}>
      <fieldset className={css.choices} aria-describedby={`${props.id}-hint`}>
        <legend className={css.label}>{props.label}</legend>
        {createElement(OverrideBadge, props)}
        {props.options.map(option => (
          <label key={option.value} className={css.choice}>
            <input
              type="radio"
              name={props.name}
              value={option.value}
              checked={option.selected}
              disabled={props.disabled || !option.pickable}
              onChange={() => { props.onPick(option.value) }}
            />
            <span className={css.choiceText}>
              <span className={css.choiceName}>{option.label}</span>
              <span className={css.choiceHint}>{option.description}</span>
              {option.unavailableLabel === undefined
                ? null
                : <span className={css.choiceHint}>{option.unavailableLabel}</span>}
            </span>
          </label>
        ))}
      </fieldset>
      <p className={css.hint} id={`${props.id}-hint`}>{props.hint}</p>
    </div>
  )
}

/**
 * A write-only credential control. The value never rides a response, so the
 * control reports only whether one is configured and starts blank; a blank
 * draft writes nothing, which keeps the stored key rather than clearing it.
 * @param props - the field's copy, its staged text, and the configured state.
 * @returns the labelled control.
 */
export function SecretField(props: Pick<FieldProps, 'id' | 'label' | 'hint' | 'text' | 'disabled' | 'onEdit'> & {
  /** Whether the Host reports a configured credential for this reference. */
  configured: boolean
  /** Copy describing the configured state. */
  stateLabel: string
}) {
  return (
    <div className={css.field}>
      <div className={css.head}>
        <label className={css.label} htmlFor={props.id}>{props.label}</label>
        <span className={css.badges}>
          <span className={props.configured ? css.badge : css.badgeMuted}>{props.stateLabel}</span>
        </span>
      </div>
      <input
        id={props.id}
        className={css.input}
        type="password"
        autoComplete="off"
        value={props.text}
        disabled={props.disabled}
        onChange={(event) => { props.onEdit(event.target.value) }}
      />
      <p className={css.hint}>{props.hint}</p>
    </div>
  )
}
