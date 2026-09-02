/**
 * Windows durable-publication primitive, shared by every backend here that
 * makes a file visible through a rename.
 *
 * POSIX publishes a new name by creating the directory entry and then fsyncing
 * the parent directory. Windows exposes no parent-directory fsync through
 * Node — `open()` on a directory fails with `EISDIR` — so a file sync alone
 * leaves the entry that names it un-flushed. `MoveFileExW` with
 * `MOVEFILE_WRITE_THROUGH` does not return until the namespace change has
 * reached storage, which is the Windows peer of that fsync.
 *
 * Koffi loads lazily so non-Windows processes never open Win32 libraries.
 * @module @deepseek-ai/dsh-atomic-write/win32
 */

import { mkdtemp, rm, stat } from 'node:fs/promises'
import { join, parse, resolve, toNamespacedPath } from 'node:path'

/** `kernel32!MoveFileExW`: rename or move a path under the given flags. */
type MoveFileExW = (existing: string, replacement: string, flags: number) => number

/** `kernel32!GetLastError`: the calling thread's last Win32 error code. */
type GetLastError = () => number

/** The two kernel32 entry points this module binds through Koffi. */
interface Win32Bindings {
  moveFileExW: MoveFileExW
  getLastError: GetLastError
}

/** An `Error` carrying both the mapped errno name and the raw Win32 code. */
export interface Win32MoveError extends NodeJS.ErrnoException {
  /** Raw Win32 status from `GetLastError`. */
  win32Code: number
  /** The destination path the move targeted. */
  dest: string
}

/** Replace an existing destination instead of failing with `ERROR_ALREADY_EXISTS`. */
export const MOVEFILE_REPLACE_EXISTING = 0x00000001
/** Do not return until the namespace change has been flushed to storage. */
export const MOVEFILE_WRITE_THROUGH = 0x00000008

const ERROR_FILE_NOT_FOUND = 2
const ERROR_PATH_NOT_FOUND = 3
const ERROR_ACCESS_DENIED = 5
const ERROR_NOT_SAME_DEVICE = 17
const ERROR_FILE_EXISTS = 80
const ERROR_INVALID_NAME = 123
const ERROR_ALREADY_EXISTS = 183

let bindings: Win32Bindings | undefined

/** Load the small Win32 API lazily so non-Windows processes never load Koffi. */
async function win32(): Promise<Win32Bindings> {
  if (bindings !== undefined) return bindings
  const koffi = (await import('koffi')).default
  const kernel32 = koffi.load('kernel32.dll')
  bindings = {
    moveFileExW: kernel32.func('__stdcall', 'MoveFileExW', 'int', ['str16', 'str16', 'uint']) as MoveFileExW,
    getLastError: kernel32.func('__stdcall', 'GetLastError', 'uint', []) as GetLastError,
  }
  return bindings
}

function errnoCode(win32Code: number): string {
  switch (win32Code) {
    case ERROR_FILE_NOT_FOUND:
    case ERROR_PATH_NOT_FOUND:
      return 'ENOENT'
    case ERROR_ACCESS_DENIED:
      return 'EACCES'
    case ERROR_NOT_SAME_DEVICE:
      return 'EXDEV'
    case ERROR_FILE_EXISTS:
    case ERROR_ALREADY_EXISTS:
      return 'EEXIST'
    case ERROR_INVALID_NAME:
      return 'EINVAL'
    default:
      return 'EIO'
  }
}

/**
 * Build the error a failed move reports: the errno name callers already switch
 * on, plus the raw Win32 status and both paths for diagnosis.
 * @param syscall - the Win32 entry point that failed.
 * @param win32Code - the status `GetLastError` returned.
 * @param path - the source path.
 * @param dest - the destination path.
 * @returns the error to throw.
 */
function win32Error(syscall: string, win32Code: number, path: string, dest: string): Win32MoveError {
  const code = errnoCode(win32Code)
  const error = new Error(`${syscall} ${code} (Win32 ${win32Code}): ${path} -> ${dest}`) as Win32MoveError
  error.code = code
  error.errno = win32Code
  error.syscall = syscall
  error.path = path
  error.dest = dest
  error.win32Code = win32Code
  return error
}

/**
 * Move `existing` to `replacement` under explicit `MoveFileExW` flags. No copy
 * fallback flag is ever set, so a cross-volume request fails with `EXDEV`
 * rather than silently degrading to a non-atomic copy.
 * @param existing - the synced source path to move.
 * @param replacement - the destination path.
 * @param flags - the `MOVEFILE_*` flags to apply.
 * @throws {@link Win32MoveError} when the move fails.
 */
export async function moveFileWin32(existing: string, replacement: string, flags: number): Promise<void> {
  const api = await win32()
  const ok = api.moveFileExW(toNamespacedPath(existing), toNamespacedPath(replacement), flags)
  if (ok === 0) throw win32Error('MoveFileExW', api.getLastError(), existing, replacement)
}

/**
 * Publish `existing` at a destination that must not already exist, with
 * Windows write-through namespace semantics.
 * @param existing - the synced staging path to move.
 * @param replacement - the final path, which must not already exist.
 * @throws {@link Win32MoveError} with code `EEXIST` when the destination is taken.
 */
export function publishNewFileWin32(existing: string, replacement: string): Promise<void> {
  return moveFileWin32(existing, replacement, MOVEFILE_WRITE_THROUGH)
}

/**
 * Replace `replacement` with `existing` atomically and durably: the directory
 * entry swap is flushed before the call returns, so a crash immediately after
 * it cannot resurrect the previous content.
 * @param existing - the synced staging path to move.
 * @param replacement - the final path, replaced when it already exists.
 * @throws {@link Win32MoveError} when the replacement fails.
 */
export function replaceFileDurablyWin32(existing: string, replacement: string): Promise<void> {
  return moveFileWin32(existing, replacement, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)
}

function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

function isEEXIST(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'EEXIST'
}

async function assertDirectory(path: string): Promise<boolean> {
  try {
    // A bare drive root is already short, and Node rejects its extended-length
    // spelling as EISDIR. Descendants retain the namespace for long-path probes.
    const probe = path === parse(path).root ? path : toNamespacedPath(path)
    const info = await stat(probe)
    if (info.isDirectory()) return true
    const error = new Error(`path exists but is not a directory: ${path}`) as NodeJS.ErrnoException
    error.code = 'ENOTDIR'
    error.path = path
    throw error
  } catch (error) {
    if (isENOENT(error)) return false
    throw error
  }
}

/**
 * Create `target` and its missing ancestors with durable Windows namespace
 * publication. Each missing directory is first created as a random staging
 * sibling, then moved to its final name with `MOVEFILE_WRITE_THROUGH`; races
 * with another creator are accepted only after verifying the winner is a
 * directory.
 * @param target - the absolute directory path to create durably when absent.
 */
export async function ensureDurableDirectoryWin32(target: string): Promise<void> {
  const absolute = resolve(target)
  const root = parse(absolute).root
  await assertDirectory(root)

  const segments = absolute.slice(root.length).split(/[\\/]+/).filter(part => part.length > 0)
  let current = root
  for (const segment of segments) {
    const next = join(current, segment)
    if (!await assertDirectory(next)) await createLeafDirectoryWin32(current, next)
    current = next
  }
}

async function createLeafDirectoryWin32(parent: string, target: string): Promise<void> {
  // Keep the staging component independent of the target basename so a legal
  // 255-byte target component does not make mkdtemp's sibling name too long.
  const staging = await mkdtemp(toNamespacedPath(join(parent, '.dsh-mkdir-')))
  try {
    await publishNewFileWin32(staging, target)
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    if (isEEXIST(error) && await assertDirectory(target)) return
    throw error
  }
}
