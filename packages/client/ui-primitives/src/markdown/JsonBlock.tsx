// JsonBlock: collapsible JSON block (conversation side; independent from the RPC panel's PayloadJson to avoid cross-panel coupling).

import { useMemo, useState } from 'react'
import css from './JsonBlock.module.css'

const MAX_CHARS = 20_000

export function JsonBlock({ label, payload, defaultOpen = false, truncatedLabel }: {
  label: string
  payload: unknown
  defaultOpen?: boolean
  /** Footer appended when the body exceeds the char cap, given the full length (this package is cordis-free, so copy arrives via props). */
  truncatedLabel: (total: number) => string
}) {
  const [open, setOpen] = useState(defaultOpen)
  const body = useMemo(() => {
    if (!open) return ''
    const serialized = serializeUnknown(payload)
    return serialized.length > MAX_CHARS
      ? `${serialized.slice(0, MAX_CHARS)}\n${truncatedLabel(serialized.length)}`
      : serialized
  }, [open, payload, truncatedLabel])
  return (
    <div className={css.root}>
      <button
        type="button"
        className={css.toggle}
        aria-expanded={open}
        onClick={() => { setOpen(v => !v) }}
      >
        {open ? '▾' : '▸'} {label}
      </button>
      {open && <pre className={css.body}>{body}</pre>}
    </div>
  )
}

function serializeUnknown(payload: unknown): string {
  if (payload === undefined) return 'undefined'
  if (typeof payload === 'function' || typeof payload === 'symbol') return String(payload)
  const seen = new WeakSet<object>()
  const json = JSON.stringify(payload, (_key, value: unknown) => {
    if (typeof value === 'bigint') return `${value}n`
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) return '[Circular]'
      seen.add(value)
    }
    return value
  }, 2)
  if (typeof json === 'string') return json
  return '[Unserializable]'
}
