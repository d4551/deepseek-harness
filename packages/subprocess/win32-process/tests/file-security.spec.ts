/**
 * The Windows file-confidentiality audit. Descriptors are assembled here byte
 * for byte, so the SID formatting, ACE walk, and exposure verdict are pinned on
 * every host; only the `GetFileSecurityW` call itself is Windows-bound, and it
 * is driven through an injected binding table.
 */

import koffi from 'koffi'
import { describe, expect, it, vi } from 'vitest'
import {
  DIRECTORY_WRITE_ACCESS,
  FILE_READ_ACCESS,
  OWNER_AND_DACL_INFORMATION,
  auditFileAccess,
  describeWin32Exposure,
  formatSid,
  readFileSecurity,
} from '../src/file-security.ts'
import type { Win32FileSecurityBindings } from '../src/file-security.ts'
import type { NativePtr } from '../src/ffi.ts'

const ACCESS_ALLOWED_ACE_TYPE = 0x00
const ACCESS_DENIED_ACE_TYPE = 0x01
const ACCESS_ALLOWED_OBJECT_ACE_TYPE = 0x05
const INHERIT_ONLY_ACE = 0x08
const SE_DACL_PRESENT = 0x0004
const FILE_READ_DATA = 0x00000001
const GENERIC_READ = 0x80000000
const FILE_WRITE_DATA = 0x00000002

const OWNER = 'S-1-5-21-1-2-3-1001'
const OTHER_USER = 'S-1-5-21-1-2-3-1002'
const EVERYONE = 'S-1-1-0'
const SYSTEM = 'S-1-5-18'
const ADMINISTRATORS = 'S-1-5-32-544'

/** Encode a string SID into its binary form. */
function sid(value: string): Buffer {
  const [, revision, authority, ...subAuthorities] = value.split('-')
  const bytes = Buffer.alloc(8 + subAuthorities.length * 4)
  bytes.writeUInt8(Number(revision), 0)
  bytes.writeUInt8(subAuthorities.length, 1)
  bytes.writeUIntBE(Number(authority), 2, 6)
  subAuthorities.forEach((part, index) => { bytes.writeUInt32LE(Number(part), 8 + index * 4) })
  return bytes
}

/** One access-control entry to assemble into a DACL. */
interface AceInput {
  type: number
  flags?: number
  mask: number
  trustee: string
  /** Object-ACE flags word, present only for object ACE types. */
  objectFlags?: number
}

function ace(input: AceInput): Buffer {
  const trustee = sid(input.trustee)
  const objectPrefix = input.objectFlags === undefined
    ? Buffer.alloc(0)
    : Buffer.concat([
      Buffer.alloc(4),
      Buffer.alloc(((input.objectFlags & 0x1) === 0 ? 0 : 16) + ((input.objectFlags & 0x2) === 0 ? 0 : 16)),
    ])
  if (input.objectFlags !== undefined) objectPrefix.writeUInt32LE(input.objectFlags, 0)
  const size = 8 + objectPrefix.length + trustee.length
  const header = Buffer.alloc(8)
  header.writeUInt8(input.type, 0)
  header.writeUInt8(input.flags ?? 0, 1)
  header.writeUInt16LE(size, 2)
  header.writeUInt32LE(input.mask, 4)
  return Buffer.concat([header, objectPrefix, trustee])
}

/** Assemble a self-relative security descriptor with an optional DACL. */
function descriptor(options: { owner?: string; aces?: AceInput[] | 'absent' }): Buffer {
  const header = Buffer.alloc(20)
  header.writeUInt8(1, 0)
  const ownerBytes = options.owner === undefined ? Buffer.alloc(0) : sid(options.owner)
  const parts = [header, ownerBytes]
  let offset = header.length + ownerBytes.length
  header.writeUInt32LE(options.owner === undefined ? 0 : header.length, 4)
  if (options.aces !== undefined && options.aces !== 'absent') {
    const entries = options.aces.map(ace)
    const aclHeader = Buffer.alloc(8)
    const aclSize = 8 + entries.reduce((total, entry) => total + entry.length, 0)
    aclHeader.writeUInt8(2, 0)
    aclHeader.writeUInt16LE(aclSize, 2)
    aclHeader.writeUInt16LE(entries.length, 4)
    header.writeUInt16LE(0x8000 | SE_DACL_PRESENT, 2)
    header.writeUInt32LE(offset, 16)
    parts.push(aclHeader, ...entries)
    offset += aclSize
  } else {
    header.writeUInt16LE(0x8000, 2)
  }
  return Buffer.concat(parts)
}

describe('formatSid', () => {
  it('renders the big-endian authority and little-endian sub-authorities', () => {
    expect(formatSid(sid(ADMINISTRATORS), 0)).toBe(ADMINISTRATORS)
    expect(formatSid(sid(EVERYONE), 0)).toBe(EVERYONE)
    expect(formatSid(sid(OWNER), 0)).toBe(OWNER)
  })

  it('refuses a SID the buffer cannot hold instead of reading past it', () => {
    expect(formatSid(Buffer.alloc(4), 0)).toBeUndefined()
    expect(formatSid(sid(OWNER).subarray(0, 12), 0)).toBeUndefined()
  })
})

describe('auditFileAccess', () => {
  it('accepts a descriptor whose only readers are the owner and the administrative accounts', () => {
    const audit = auditFileAccess(descriptor({
      owner: OWNER,
      aces: [
        { type: ACCESS_ALLOWED_ACE_TYPE, mask: GENERIC_READ, trustee: OWNER },
        { type: ACCESS_ALLOWED_ACE_TYPE, mask: GENERIC_READ, trustee: SYSTEM },
        { type: ACCESS_ALLOWED_ACE_TYPE, mask: GENERIC_READ, trustee: ADMINISTRATORS },
        { type: ACCESS_ALLOWED_ACE_TYPE, mask: GENERIC_READ, trustee: 'S-1-3-0' },
      ],
    }), FILE_READ_ACCESS)
    expect(audit).toEqual({ owner: OWNER, unprotected: false, exposedTo: [] })
  })

  it('reports every other trustee the requested access reaches', () => {
    const audit = auditFileAccess(descriptor({
      owner: OWNER,
      aces: [
        { type: ACCESS_ALLOWED_ACE_TYPE, mask: GENERIC_READ, trustee: OWNER },
        { type: ACCESS_ALLOWED_ACE_TYPE, mask: FILE_READ_DATA, trustee: EVERYONE },
        { type: ACCESS_ALLOWED_ACE_TYPE, mask: GENERIC_READ, trustee: OTHER_USER },
      ],
    }), FILE_READ_ACCESS)
    expect(audit.exposedTo).toEqual([
      { sid: EVERYONE, mask: FILE_READ_DATA },
      { sid: OTHER_USER, mask: GENERIC_READ },
    ])
  })

  it('separates read exposure from write exposure by the requested mask', () => {
    const writeOnly = descriptor({
      owner: OWNER,
      aces: [{ type: ACCESS_ALLOWED_ACE_TYPE, mask: FILE_WRITE_DATA, trustee: EVERYONE }],
    })
    expect(auditFileAccess(writeOnly, FILE_READ_ACCESS).exposedTo).toEqual([])
    expect(auditFileAccess(writeOnly, DIRECTORY_WRITE_ACCESS).exposedTo)
      .toEqual([{ sid: EVERYONE, mask: FILE_WRITE_DATA }])
  })

  it('treats a missing DACL as unprotected, because Windows grants everyone full access', () => {
    expect(auditFileAccess(descriptor({ owner: OWNER, aces: 'absent' }), FILE_READ_ACCESS))
      .toEqual({ owner: OWNER, unprotected: true, exposedTo: [] })
  })

  it('reports no owner when the descriptor carries none', () => {
    expect(auditFileAccess(descriptor({ aces: 'absent' }), FILE_READ_ACCESS).owner).toBeUndefined()
  })

  it('ignores deny entries rather than letting one hide a following grant', () => {
    const audit = auditFileAccess(descriptor({
      owner: OWNER,
      aces: [
        { type: ACCESS_DENIED_ACE_TYPE, mask: GENERIC_READ, trustee: EVERYONE },
        { type: ACCESS_ALLOWED_ACE_TYPE, mask: GENERIC_READ, trustee: EVERYONE },
      ],
    }), FILE_READ_ACCESS)
    expect(audit.exposedTo).toEqual([{ sid: EVERYONE, mask: GENERIC_READ }])
  })

  it('skips inherit-only entries, which govern new children and not this object', () => {
    const audit = auditFileAccess(descriptor({
      owner: OWNER,
      aces: [{ type: ACCESS_ALLOWED_ACE_TYPE, flags: INHERIT_ONLY_ACE, mask: GENERIC_READ, trustee: EVERYONE }],
    }), FILE_READ_ACCESS)
    expect(audit.exposedTo).toEqual([])
  })

  it('reads an object ACE trustee from behind its optional GUID fields', () => {
    for (const objectFlags of [0x0, 0x1, 0x2, 0x3]) {
      const audit = auditFileAccess(descriptor({
        owner: OWNER,
        aces: [{ type: ACCESS_ALLOWED_OBJECT_ACE_TYPE, objectFlags, mask: GENERIC_READ, trustee: EVERYONE }],
      }), FILE_READ_ACCESS)
      expect(audit.exposedTo).toEqual([{ sid: EVERYONE, mask: GENERIC_READ }])
    }
  })

  it('stops the walk at a malformed entry instead of reading past the ACL', () => {
    const truncated = descriptor({
      owner: OWNER,
      aces: [{ type: ACCESS_ALLOWED_ACE_TYPE, mask: GENERIC_READ, trustee: EVERYONE }],
    })
    // Claim two entries where one is stored: the second read runs off the end.
    truncated.writeUInt16LE(2, truncated.readUInt32LE(16) + 4)
    expect(auditFileAccess(truncated, FILE_READ_ACCESS).exposedTo)
      .toEqual([{ sid: EVERYONE, mask: GENERIC_READ }])

    const impossibleAce = descriptor({
      owner: OWNER,
      aces: [{ type: ACCESS_ALLOWED_ACE_TYPE, mask: GENERIC_READ, trustee: EVERYONE }],
    })
    impossibleAce.writeUInt16LE(4, impossibleAce.readUInt32LE(16) + 8 + 2)
    expect(auditFileAccess(impossibleAce, FILE_READ_ACCESS).exposedTo).toEqual([])

    const emptyAcl = descriptor({ owner: OWNER, aces: [] })
    emptyAcl.writeUInt32LE(emptyAcl.length, 16)
    expect(auditFileAccess(emptyAcl, FILE_READ_ACCESS).exposedTo).toEqual([])

    const shortSid = descriptor({
      owner: OWNER,
      aces: [{ type: ACCESS_ALLOWED_ACE_TYPE, mask: GENERIC_READ, trustee: EVERYONE }],
    })
    // Grow the declared sub-authority count past the bytes the ACE carries.
    shortSid.writeUInt8(8, shortSid.readUInt32LE(16) + 8 + 8 + 1)
    expect(auditFileAccess(shortSid, FILE_READ_ACCESS).exposedTo).toEqual([])
  })

  it('refuses a buffer too short to be a descriptor at all', () => {
    expect(() => auditFileAccess(Buffer.alloc(8), FILE_READ_ACCESS)).toThrow('too short to parse')
  })
})

describe('describeWin32Exposure', () => {
  it('stays silent for a descriptor only the owner and the administrative accounts reach', () => {
    expect(describeWin32Exposure({ owner: OWNER, unprotected: false, exposedTo: [] })).toBeUndefined()
  })

  it('names the exposed trustees', () => {
    expect(describeWin32Exposure({
      owner: OWNER,
      unprotected: false,
      exposedTo: [{ sid: EVERYONE, mask: GENERIC_READ }, { sid: OTHER_USER, mask: GENERIC_READ }],
    })).toBe(`grants access beyond its owner to ${EVERYONE}, ${OTHER_USER}`)
  })

  it('names a missing DACL as the whole-machine exposure it is', () => {
    expect(describeWin32Exposure({ owner: OWNER, unprotected: true, exposedTo: [] }))
      .toBe('carries no DACL, so every account on this machine can reach it')
  })
})

describe('readFileSecurity', () => {
  function bindings(impl: Win32FileSecurityBindings['getFileSecurityW'], lastError = 5): Win32FileSecurityBindings {
    return {
      getFileSecurityW: vi.fn(impl),
      getLastError: vi.fn(() => lastError),
    } as unknown as Win32FileSecurityBindings
  }

  it('sizes the descriptor first and then copies exactly that many bytes', () => {
    const payload = descriptor({ owner: OWNER, aces: [{ type: ACCESS_ALLOWED_ACE_TYPE, mask: GENERIC_READ, trustee: OWNER }] })
    const requested: number[] = []
    const api = bindings((_path, information, buffer, length, needed) => {
      requested.push(information)
      if (buffer === null) {
        koffi.encode(needed, 'uint32', payload.length)
        return 0
      }
      expect(length).toBe(payload.length)
      payload.copy(buffer)
      return 1
    })
    const needed = koffi.alloc('uint32', 1) as NativePtr

    const bytes = readFileSecurity(api, 'C:\\dsh\\credentials.yml', needed)

    expect(bytes).toEqual(payload)
    expect(requested).toEqual([OWNER_AND_DACL_INFORMATION, OWNER_AND_DACL_INFORMATION])
  })

  it('reports a failed size query with its Win32 status', () => {
    const api = bindings(() => 0, 5)
    const needed = koffi.alloc('uint32', 1) as NativePtr
    expect(() => readFileSecurity(api, 'C:\\dsh\\credentials.yml', needed))
      .toThrow('GetFileSecurityW size query failed (Win32 5)')
  })

  it('reports a failed copy with its Win32 status', () => {
    const api = bindings((_path, _information, buffer, _length, needed) => {
      if (buffer === null) {
        koffi.encode(needed, 'uint32', 64)
        return 0
      }
      return 0
    }, 87)
    const needed = koffi.alloc('uint32', 1) as NativePtr
    expect(() => readFileSecurity(api, 'C:\\dsh\\credentials.yml', needed))
      .toThrow('GetFileSecurityW failed (Win32 87)')
  })
})
