/**
 * Versionless, JSON-lines wire protocol between the Node host and the CPython subprocess. Frames
 * travel on the child's fd 3 (one JSON object per line), leaving stdout/stderr free for the
 * program's own output. Host treats every inbound frame as hostile because model code can post
 * anything through the same fd; the Python bootstrap trusts host replies.
 * @module @deepseek-ai/dsh-code-runtime-python/src/protocol
 */

/**
 * The framed-JSON channel's file descriptor from the child's perspective. The
 * host pins it positionally when it spawns the child (`stdio` index 3, i.e.
 * `['pipe','pipe','pipe','pipe']`), and the Python bootstrap reads the same
 * number from its own `protocol.py`. Exported as the single TS-side source of
 * truth: the host wiring uses it, and the cross-language mirror test asserts the
 * Python constant equals it, so a drift on either side breaks the boot channel
 * loudly rather than silently.
 */
export const PROTOCOL_FD = 3

/**
 * One binding namespace declaration inside a {@link BootMessage}. `global` is
 * the program-visible name the namespace is materialized under; `errorClass`,
 * when present, asks the bootstrap to mint a program-visible exception class.
 */
interface Namespace {
  global: string
  names: string[]
  errorClass?: ErrorClass
}

/**
 * A namespace's program-visible exception class: rejected calls raise its
 * instances carrying the failed member name on `memberNameProperty`.
 */
interface ErrorClass {
  name: string
  memberNameProperty: string
}

/**
 * What the host sends immediately after spawn, as the first line on fd 3. The
 * Python bootstrap reads this, applies resource limits, then waits for the
 * subsequent run frame. Separated from the run so the run message stays
 * pure model input.
 */
export interface BootMessage {
  type: 'boot'
  /** RLIMIT_CPU seconds; the Python bootstrap sets this on itself before executing model code. */
  cpuSeconds: number
  /** RLIMIT_AS bytes; caps address space so a runaway allocation fails cleanly. */
  addressSpaceBytes: number
  /** Shared byte budget for captured log text (Python-side ledger). */
  maxLogBytes: number
  /** Byte cap for the rendered completion value. */
  maxValueBytes: number
  /**
   * The namespaces to materialize inside the program (globals + names;
   * functions stay host-side). See {@link Namespace}.
   */
  namespaces: Namespace[]
}

/** Host → Python: sent after `boot-ack`; carries only the model's program body. */
interface RunMessage {
  type: 'run'
  program: string
}

/** Python → host: acknowledges boot completed and resource limits are in place. */
interface BootAckMessage {
  type: 'boot-ack'
}

/** Python → host: one bridged binding call (`await tools.name(args)` inside the program). */
interface CallMessage {
  type: 'call'
  /** Python-issued correlation id; the host answers each id at most once and ignores duplicates. */
  id: number
  /** The namespace global the call targets. */
  global: string
  /** The function name within the namespace. */
  name: string
  /** The JSON-safe argument the model program passed. */
  args: unknown
}

/**
 * Python → host: captured text, streamed eagerly so output survives a
 * mid-run termination (RLIMIT_CPU, SIGTERM/SIGKILL, host wall-timeout).
 */
interface LogMessage {
  type: 'log'
  text: string
  /**
   * Set when this frame IS the child ledger's truncation marker rather than
   * program output. The two ledgers can exhaust at different points — one
   * child entry larger than `maxLogBytes` sends only the marker while the host
   * ledger is still nearly empty — so the host cannot infer the child's state
   * from its own budget, and comparing the text against the marker string
   * would also honour a program that printed that string itself. Carrying it
   * as a field lets the host stop capturing at the same point the child did
   * and keeps exactly one marker in `logs`.
   */
  truncated?: boolean
}

/** The failure carried on a {@link DoneMessage}: one of three kinds plus text. */
interface DoneErrorField {
  kind: 'exception' | 'invalid-output' | 'output-limit'
  message: string
}

/**
 * Python → host: the program settled. `error` carries a program exception
 * (traceback text), an `invalid-output` (completion value was not lossless
 * JSON), or an `output-limit` (serialized completion exceeded the configured
 * cap); wall/CPU budgets, aborts, and substrate death are observed host-side.
 * From the honest child `value` is present only on a clean completion that
 * produced one, and crosses as exact lossless JSON — never substituted or
 * truncated. A forged frame CAN carry both `value` and `error`;
 * {@link validateChildFrame} preserves both rather than guessing which to drop,
 * so a consumer MUST check `error` first and ignore `value` when it is set.
 */
interface DoneMessage {
  type: 'done'
  value?: unknown
  error?: DoneErrorField
}

/**
 * Every message the Python side sends. The member interfaces stay module-
 * private: consumers match on the union's discriminant; the host sends the
 * boot and run frames as inline literals.
 */
export type ChildToHost = BootAckMessage | CallMessage | LogMessage | DoneMessage

/** Host → Python: successful answer to one {@link CallMessage}. */
interface ReplyOk {
  type: 'reply'
  id: number
  ok: true
  value: unknown
}

/** Host → Python: failed answer to one {@link CallMessage}. */
interface ReplyErr {
  type: 'reply'
  id: number
  ok: false
  message: string
}

/** Host → Python: the answer to one {@link CallMessage}. */
export type ReplyMessage = ReplyOk | ReplyErr

/** The required (non-optional) keys of `T`, as string literals. */
type RequiredKeys<T> = { [K in keyof T]-?: object extends Pick<T, K> ? never : K }[keyof T] & string
/** The optional keys of `T`, as string literals. */
type OptionalKeys<T> = { [K in keyof T]-?: object extends Pick<T, K> ? K : never }[keyof T] & string

/**
 * Whether each key of frame `T` is a `'required'` or `'optional'` wire field.
 * Because it is `Record<keyof T, …>`, an entry MUST list every key — a field
 * added to the interface without a corresponding entry fails typecheck — and
 * `keyof T`-typed keys reject a name no frame declares. The `'required'` /
 * `'optional'` tag must match the field's actual optionality (checked by the
 * `satisfies FrameFieldRoles<…>` clause on {@link WIRE_FRAME_FIELD_ROLES}), so
 * an optionality flip is caught too. This is the exhaustive counterpart the
 * array form could not express (a subset array satisfied it silently).
 */
type FrameFieldRoles<T> = Record<RequiredKeys<T>, 'required'> & Record<OptionalKeys<T>, 'optional'>

interface WireFrameShapes {
  BootMessage: BootMessage
  Namespace: Namespace
  RunMessage: RunMessage
  BootAckMessage: BootAckMessage
  CallMessage: CallMessage
  LogMessage: LogMessage
  DoneErrorField: DoneErrorField
  DoneMessage: DoneMessage
  ErrorClass: ErrorClass
  ReplyOk: ReplyOk
  ReplyErr: ReplyErr
}

/**
 * The frames carried on a message union: everything the host and child send as
 * a top-level frame (`ChildToHost`, the two reply variants, and the host→child
 * boot/run frames). The nested shapes `Namespace`, `ErrorClass`, and
 * `DoneErrorField` are fields of other frames, not frames themselves, so they
 * are excluded here and covered only by the roles `satisfies` and the mirror e2e.
 */
type MessageFrames = ChildToHost | ReplyMessage | BootMessage | RunMessage
/** The roster's value types minus the three nested (non-frame) shapes. */
type RosterMessageFrames = Exclude<WireFrameShapes[keyof WireFrameShapes], Namespace | ErrorClass | DoneErrorField>

/**
 * Compile-time proof that {@link WireFrameShapes}'s message-frame entries are
 * EXACTLY the frames on the message unions — checked BOTH directions. Forward
 * (`MessageFrames extends RosterMessageFrames`) catches a frame added to a union
 * without a roster entry; reverse (`RosterMessageFrames extends MessageFrames`)
 * catches a frame removed from a union while the roster still lists it (e.g.
 * dropping `ReplyErr` from `ReplyMessage`). Either divergence makes an alias
 * `false`, failing the assignment below. Type-only; the `const`s emit nothing
 * meaningful at runtime.
 */
type UnionSubsetOfRoster = [MessageFrames] extends [RosterMessageFrames] ? true : false
type RosterSubsetOfUnion = [RosterMessageFrames] extends [MessageFrames] ? true : false
const _unionSubsetOfRoster: UnionSubsetOfRoster = true
const _rosterSubsetOfUnion: RosterSubsetOfUnion = true
void _unionSubsetOfRoster
void _rosterSubsetOfUnion

/**
 * Each frame's wire fields tagged by required/optional, keyed by field name so
 * the mapping is exhaustive over the frame interface (see {@link FrameFieldRoles})
 * across the whole {@link WireFrameShapes} roster. Bound to the interfaces by
 * `satisfies` below; {@link WIRE_FRAME_FIELDS} projects it to sorted
 * required/optional arrays for the cross-language mirror comparison. `global` is
 * the JSON key {@link CallMessage} and {@link Namespace} send (a reserved word
 * the Python side carries via a functional `TypedDict`).
 */
const WIRE_FRAME_FIELD_ROLES = {
  BootMessage: { type: 'required', cpuSeconds: 'required', addressSpaceBytes: 'required', maxLogBytes: 'required', maxValueBytes: 'required', namespaces: 'required' },
  Namespace: { global: 'required', names: 'required', errorClass: 'optional' },
  RunMessage: { type: 'required', program: 'required' },
  BootAckMessage: { type: 'required' },
  CallMessage: { type: 'required', id: 'required', global: 'required', name: 'required', args: 'required' },
  LogMessage: { type: 'required', text: 'required', truncated: 'optional' },
  DoneErrorField: { kind: 'required', message: 'required' },
  DoneMessage: { type: 'required', value: 'optional', error: 'optional' },
  ErrorClass: { name: 'required', memberNameProperty: 'required' },
  ReplyOk: { type: 'required', id: 'required', ok: 'required', value: 'required' },
  ReplyErr: { type: 'required', id: 'required', ok: 'required', message: 'required' },
} as const satisfies { [K in keyof WireFrameShapes]: FrameFieldRoles<WireFrameShapes[K]> }

/**
 * The wire field names of each frame, split into sorted required and optional
 * key arrays — the shape the cross-language mirror test compares against
 * `py/protocol.py`'s `TypedDict` `__required_keys__`/`__optional_keys__`.
 * Projected from {@link WIRE_FRAME_FIELD_ROLES}, so it inherits that mapping's
 * exhaustive, optionality-checked binding to the frame interfaces: a TS-side
 * field add, remove, rename, or optionality flip fails typecheck at the roles
 * map, and a Python-side divergence fails the mirror test at runtime.
 */
export const WIRE_FRAME_FIELDS =
  Object.fromEntries(
    Object.entries(WIRE_FRAME_FIELD_ROLES).map(([frame, roles]) => {
      const required = Object.keys(roles).filter(key => (roles as Record<string, string>)[key] === 'required').sort()
      const optional = Object.keys(roles).filter(key => (roles as Record<string, string>)[key] === 'optional').sort()
      return [frame, { required, optional }]
    }),
  ) as Record<keyof typeof WIRE_FRAME_FIELD_ROLES, { required: string[]; optional: string[] }>


/**
 * The in-band marker text announcing that log capture stopped at the byte
 * budget. Shared wire vocabulary: the Python-side LogBuffer emits it when ITS
 * ledger exhausts, and the host emits identical text when its own ledger drops
 * a frame first (forged fd-3 traffic, stray stdout bytes) — a truncated run
 * reads the same however the cap was hit.
 * @param maxBytes - the configured `maxLogBytes` the marker names.
 * @returns the marker line.
 */
export function logTruncationMarker(maxBytes: number): string {
  return `[dsh-code-runtime-python] log capture truncated at ${maxBytes} bytes`
}
