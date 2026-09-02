/**
 * Windows file-confidentiality inspection: read one path's self-relative
 * security descriptor and decide which trustees the descriptor lets reach it
 * beyond its owner.
 *
 * POSIX expresses "only the owner may read this" as mode bits, which Windows
 * does not have; `stat().mode` there is a synthesized value that no security
 * decision may rest on. The equivalent Windows fact lives in the object's
 * DACL, so a caller that guards a secret asks this module instead of the mode.
 *
 * The descriptor arrives as bytes and every decision below it is pure, so the
 * ACE walk is exercised on every host. Only {@link readFileSecurity} touches
 * Win32, through the shared process binding table.
 * @module @deepseek-ai/dsh-win32-process/file-security
 */

import koffi from 'koffi'
import { toNamespacedPath } from 'node:path'
import { extendWin32ProcessBindings, isNullPtr } from './ffi.ts'
import type { NativePtr, Win32ProcessBindings } from './ffi.ts'

/**
 * `advapi32!GetFileSecurityW`: copy a path's security descriptor into a buffer.
 * @param path - namespaced path to read.
 * @param requestedInformation - security-information bits to copy.
 * @param descriptor - receiving buffer, or `null` to size the descriptor.
 * @param length - byte capacity of `descriptor`.
 * @param needed - single-element out parameter receiving the required size.
 * @returns non-zero on success.
 */
export type GetFileSecurityW = (
  path: string,
  requestedInformation: number,
  descriptor: Buffer | null,
  length: number,
  needed: NativePtr,
) => number

/** The shared process table plus the one security call this module adds to it. */
export interface Win32FileSecurityBindings extends Win32ProcessBindings {
  getFileSecurityW: GetFileSecurityW
}

/** `OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION`: who owns it and who may reach it. */
export const OWNER_AND_DACL_INFORMATION = 0x00000001 | 0x00000004

/** `SE_DACL_PRESENT`: the descriptor carries a DACL (absent means "everyone, everything"). */
const SE_DACL_PRESENT = 0x0004

/** `ACCESS_ALLOWED_ACE_TYPE`. */
const ACCESS_ALLOWED_ACE_TYPE = 0x00
/** `ACCESS_ALLOWED_OBJECT_ACE_TYPE`: an allow ACE whose SID sits behind optional GUID fields. */
const ACCESS_ALLOWED_OBJECT_ACE_TYPE = 0x05
/** `INHERIT_ONLY_ACE`: the entry governs new children only, never this object. */
const INHERIT_ONLY_ACE = 0x08

/**
 * Access bits that let a trustee read file content: `FILE_READ_DATA`,
 * `GENERIC_READ`, `GENERIC_ALL`, and the `MAXIMUM_ALLOWED` request that
 * resolves to whatever the object permits.
 */
export const FILE_READ_ACCESS = 0x00000001 | 0x80000000 | 0x10000000 | 0x02000000

/**
 * Access bits that let a trustee replace a directory's children:
 * `FILE_WRITE_DATA`/`FILE_ADD_FILE`, `FILE_APPEND_DATA`/`FILE_ADD_SUBDIRECTORY`,
 * `DELETE`, `WRITE_DAC`, `WRITE_OWNER`, `GENERIC_WRITE`, `GENERIC_ALL`, and
 * `MAXIMUM_ALLOWED`.
 */
export const DIRECTORY_WRITE_ACCESS =
  0x00000002 | 0x00000004 | 0x00010000 | 0x00040000 | 0x00080000 | 0x40000000 | 0x10000000 | 0x02000000

/**
 * Access bits that let a trustee REPLACE an entry that already exists under a
 * directory: `DELETE`, `FILE_DELETE_CHILD`, `WRITE_DAC`, `WRITE_OWNER`,
 * `GENERIC_ALL`, and `MAXIMUM_ALLOWED`. Creation rights are deliberately
 * absent: the Windows volume root grants every user "create folders / append
 * data" while refusing deletion of another user's entry, which is the same
 * guarantee the POSIX sticky bit gives `/tmp`.
 */
export const DIRECTORY_REPLACE_ACCESS =
  0x00010000 | 0x00000040 | 0x00040000 | 0x00080000 | 0x10000000 | 0x02000000

/**
 * Trustees whose access never counts as exposure: the local system account and
 * the built-in administrators group already hold whole-machine authority, and
 * `CREATOR OWNER` is the inheritance placeholder that resolves to the owner
 * itself. Refusing these would reject every ordinary Windows profile directory.
 */
const ADMINISTRATIVE_SIDS: ReadonlySet<string> = new Set(['S-1-5-18', 'S-1-5-32-544', 'S-1-3-0'])

/** One allow entry the walk kept, reduced to what a confidentiality decision needs. */
export interface AllowedTrustee {
  /** Trustee SID in the standard `S-R-I-S…` string form. */
  sid: string
  /** The entry's access mask. */
  mask: number
}

/** What a descriptor says about who can reach the object it protects. */
export interface FileAccessAudit {
  /** Owner SID in string form; absent when the descriptor carries no owner. */
  owner: string | undefined
  /**
   * True when the object carries NO DACL. Windows grants every caller full
   * access to such an object, so this is the strongest possible exposure.
   */
  unprotected: boolean
  /**
   * Allow entries reaching the requested access whose trustee is neither the
   * owner nor an administrative account. Deny entries are ignored, so a
   * trustee that a preceding deny would have stopped is still reported: this
   * audit errs toward reporting exposure, never toward missing it.
   */
  exposedTo: AllowedTrustee[]
}

/**
 * Render a binary SID as its canonical string form (`S-1-5-32-544`).
 * @param bytes - buffer holding the SID.
 * @param offset - byte offset of the SID's revision field.
 * @returns the string SID, or `undefined` when the buffer cannot hold it.
 */
export function formatSid(bytes: Buffer, offset: number): string | undefined {
  if (offset + 8 > bytes.length) return undefined
  const revision = bytes.readUInt8(offset)
  const subAuthorityCount = bytes.readUInt8(offset + 1)
  const end = offset + 8 + subAuthorityCount * 4
  if (end > bytes.length) return undefined
  // IdentifierAuthority is a 6-byte BIG-endian value, unlike every other field.
  const authority = bytes.readUIntBE(offset + 2, 6)
  const parts = [`S-${String(revision)}-${String(authority)}`]
  for (let index = 0; index < subAuthorityCount; index++) {
    parts.push(String(bytes.readUInt32LE(offset + 8 + index * 4)))
  }
  return parts.join('-')
}

/** Byte length a SID occupies, or `undefined` when the buffer cannot hold it. */
function sidLength(bytes: Buffer, offset: number): number | undefined {
  if (offset + 8 > bytes.length) return undefined
  const total = 8 + bytes.readUInt8(offset + 1) * 4
  return offset + total > bytes.length ? undefined : total
}

/**
 * Walk one ACL's entries and keep the allow entries that apply to the object
 * itself. A malformed header ends the walk: the entries already read stay,
 * because dropping them would understate exposure.
 * @param bytes - the descriptor buffer.
 * @param aclOffset - byte offset of the ACL header.
 * @returns the allow entries, in ACL order.
 */
function readAllowEntries(bytes: Buffer, aclOffset: number): AllowedTrustee[] {
  const entries: AllowedTrustee[] = []
  if (aclOffset + 8 > bytes.length) return entries
  const aclSize = bytes.readUInt16LE(aclOffset + 2)
  const aceCount = bytes.readUInt16LE(aclOffset + 4)
  const aclEnd = Math.min(aclOffset + aclSize, bytes.length)
  let offset = aclOffset + 8
  for (let index = 0; index < aceCount; index++) {
    if (offset + 8 > aclEnd) return entries
    const type = bytes.readUInt8(offset)
    const flags = bytes.readUInt8(offset + 1)
    const aceSize = bytes.readUInt16LE(offset + 2)
    if (aceSize < 8 || offset + aceSize > aclEnd) return entries
    const applies = (flags & INHERIT_ONLY_ACE) === 0
    // Object ACEs carry Flags plus up to two GUIDs between the mask and the
    // SID; the flags word says which are present.
    let sidOffset = offset + 8
    if (type === ACCESS_ALLOWED_OBJECT_ACE_TYPE) {
      const objectFlags = bytes.readUInt32LE(offset + 8)
      sidOffset = offset + 12 + ((objectFlags & 0x1) === 0 ? 0 : 16) + ((objectFlags & 0x2) === 0 ? 0 : 16)
    }
    if (applies && (type === ACCESS_ALLOWED_ACE_TYPE || type === ACCESS_ALLOWED_OBJECT_ACE_TYPE)) {
      const sid = sidLength(bytes, sidOffset) === undefined ? undefined : formatSid(bytes, sidOffset)
      if (sid !== undefined) entries.push({ sid, mask: bytes.readUInt32LE(offset + 4) })
    }
    offset += aceSize
  }
  return entries
}

/**
 * Decide who a self-relative security descriptor lets reach its object with
 * the requested access, beyond the object's own owner.
 * @param descriptor - bytes produced by {@link readFileSecurity}.
 * @param accessMask - the access bits the caller cares about ({@link FILE_READ_ACCESS}, {@link DIRECTORY_WRITE_ACCESS}).
 * @returns the owner, whether the object is unprotected, and the exposed trustees.
 */
export function auditFileAccess(descriptor: Buffer, accessMask: number): FileAccessAudit {
  if (descriptor.length < 20) {
    throw new Error(`security descriptor is too short to parse (${String(descriptor.length)} bytes)`)
  }
  const control = descriptor.readUInt16LE(2)
  const ownerOffset = descriptor.readUInt32LE(4)
  const daclOffset = descriptor.readUInt32LE(16)
  const owner = ownerOffset === 0 ? undefined : formatSid(descriptor, ownerOffset)
  if ((control & SE_DACL_PRESENT) === 0 || daclOffset === 0) {
    return { owner, unprotected: true, exposedTo: [] }
  }
  const exposedTo = readAllowEntries(descriptor, daclOffset).filter(entry =>
    (entry.mask & accessMask) !== 0
    && entry.sid !== owner
    && !ADMINISTRATIVE_SIDS.has(entry.sid))
  return { owner, unprotected: false, exposedTo }
}

/**
 * Describe what an audit found, for a caller that refuses an exposed object.
 * @param audit - the verdict from {@link auditFileAccess}.
 * @returns a message fragment naming the exposure, or `undefined` when only the owner and the administrative accounts reach it.
 */
export function describeWin32Exposure(audit: FileAccessAudit): string | undefined {
  if (audit.unprotected) return 'carries no DACL, so every account on this machine can reach it'
  if (audit.exposedTo.length === 0) return undefined
  const trustees = audit.exposedTo.map(entry => entry.sid).join(', ')
  return `grants access beyond its owner to ${trustees}`
}

let cached: Win32FileSecurityBindings | undefined

/* v8 ignore start -- loads Win32 libraries; every decision above it takes an injected table. */
/**
 * Bind `GetFileSecurityW` onto the shared process table.
 * @returns the process bindings extended with the security call.
 */
export function fileSecurityBindings(): Win32FileSecurityBindings {
  cached ??= extendWin32ProcessBindings(({ advapi32, bind }) => ({
    getFileSecurityW: bind(
      advapi32,
      'GetFileSecurityW',
      'int',
      ['str16', 'uint32', koffi.pointer('void'), 'uint32', koffi.pointer('uint32')],
    ) as GetFileSecurityW,
  }))
  return cached
}
/* v8 ignore stop */

/**
 * Read one path's owner and DACL as a self-relative security descriptor.
 * @param api - the binding table (production callers pass {@link fileSecurityBindings}).
 * @param path - the existing file or directory to inspect.
 * @param needed - a uint32 out-parameter slot the size query fills.
 * @returns the descriptor bytes.
 * @throws Error naming the Win32 status when either call fails.
 */
export function readFileSecurity(api: Win32FileSecurityBindings, path: string, needed: NativePtr): Buffer {
  const nativePath = toNamespacedPath(path)
  api.getFileSecurityW(nativePath, OWNER_AND_DACL_INFORMATION, null, 0, needed)
  const size = koffi.decode(needed, 'uint32') as number
  if (size === 0) {
    throw new Error(`GetFileSecurityW size query failed (Win32 ${String(api.getLastError())}): ${path}`)
  }
  const descriptor = Buffer.alloc(size)
  if (api.getFileSecurityW(nativePath, OWNER_AND_DACL_INFORMATION, descriptor, size, needed) === 0) {
    throw new Error(`GetFileSecurityW failed (Win32 ${String(api.getLastError())}): ${path}`)
  }
  return descriptor
}

/* v8 ignore start -- runs only on win32 (it loads advapi32); the win32-only
   suite proves it end-to-end there, and every decision it composes is covered
   through the injected-table entry points above. */
/**
 * Audit one existing path against the requested access, loading Win32 lazily.
 * @param path - the existing file or directory to inspect.
 * @param accessMask - the access bits that would constitute exposure.
 * @returns the descriptor's verdict for that access.
 */
export function auditPathAccessWin32(path: string, accessMask: number): FileAccessAudit {
  const api = fileSecurityBindings()
  const needed = koffi.alloc('uint32', 1) as NativePtr
  if (isNullPtr(needed)) throw new Error('koffi.alloc returned no memory for the descriptor size slot')
  return auditFileAccess(readFileSecurity(api, path, needed), accessMask)
}
/* v8 ignore stop */
