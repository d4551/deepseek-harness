/**
 * Atomic file replacement and writer coordination.
 * `writeFileAtomic` writes a random-suffix sibling with exclusive create and
 * the caller's permission bits, fsyncs it, and commits it over the target
 * durably — POSIX renames and then fsyncs the parent directory, Windows uses
 * the write-through move in `./win32.ts` — so readers observe either the old
 * or the new complete content, a replaced file ends up with exactly the stated
 * mode, and a crash after the call resolves leaves the committed name durable
 * on disk.
 * `withFileLock` serializes cross-process writers of one file through a
 * `wx`-created `<file>.lock` sibling, so a read-modify-write cycle can never
 * resurrect a state another writer just replaced; readers stay lock-free
 * because the rename commit is atomic.
 * @module @deepseek-ai/dsh-atomic-write
 */

import { randomBytes } from 'node:crypto'
import { close, fsync, lstat, mkdir, open, rename, rm, rmSync, writeFile } from 'node:fs'
import { dirname } from 'node:path'
import { replaceFileDurablyWin32 } from './win32.ts'

/**
 * Filesystem options for {@link writeFileAtomic}; `mode` is required so the
 * permission decision stays visible at every call site.
 */
export interface WriteFileAtomicOptions {
  /**
   * Permission bits stamped on the fresh temp inode and carried through the
   * rename (subject to the process umask, like every fresh inode).
   */
  mode: number
  /**
   * Permission bits for parent directories this call creates (subject to the
   * umask; existing directories keep their mode). Omission uses the mkdir
   * default — pass `0o700` when the tree holds user-private data.
   */
  dirMode?: number
}

/**
 * Run one callback-style filesystem call and report the errno it produced.
 * Node hands the completion callback a typed `NodeJS.ErrnoException`, so the
 * failure stays a value the caller inspects rather than a thrown one.
 * @param call - filesystem call, invoked with the completion callback.
 * @returns the errno the call reported, or `null` when it succeeded.
 */
function attempt(
  call: (done: (error: NodeJS.ErrnoException | null) => void) => void,
): Promise<NodeJS.ErrnoException | null> {
  return new Promise((resolve) => { call(resolve) })
}

/** One opened descriptor, or the errno the open produced. */
interface OpenedFile {
  readonly error: NodeJS.ErrnoException | null
  readonly fd: number
}

/**
 * Open one path for the fsync that follows.
 * @param path - file or directory to open.
 * @returns the descriptor, or the errno the open reported.
 */
function attemptOpen(path: string): Promise<OpenedFile> {
  return new Promise((resolve) => {
    open(path, 'r', (error, fd) => { resolve({ error, fd }) })
  })
}

/**
 * fsync one already-written path and release its descriptor.
 * @param path - file or directory to sync.
 * @returns the first errno the sync or the close reported, otherwise `null`.
 */
async function syncPath(path: string): Promise<NodeJS.ErrnoException | null> {
  const opened = await attemptOpen(path)
  if (opened.error !== null) return opened.error
  const synced = await attempt((done) => { fsync(opened.fd, done) })
  const closed = await attempt((done) => { close(opened.fd, done) })
  return synced ?? closed
}

/**
 * Replace `filename` with `content` in one atomic step, creating parent
 * directories. The content is first written to a random-suffix sibling opened
 * with exclusive create (`wx`): the open refuses to follow a symlink planted
 * at the temp path, and the fresh inode carries `options.mode` through the
 * rename, so replacing a wider-permission file narrows it without a chmod
 * race. The rename also replaces a symlinked target itself instead of writing
 * through to its referent, and the same-directory sibling keeps the rename on
 * one filesystem. The temp file is fsynced before the rename and the parent
 * directory after it, so the committed name survives a crash; Windows offers
 * no directory fsync, so only the file sync runs there. On any failure the
 * temp file is removed and the original failure rethrown.
 * @param filename - final path receiving the content.
 * @param content - complete next file content.
 * @param options - permission bits for the replacement inode.
 */
export async function writeFileAtomic(filename: string, content: string, options: WriteFileAtomicOptions): Promise<void> {
  const prepared = await attempt((done) => {
    mkdir(
      dirname(filename),
      options.dirMode === undefined
        ? { recursive: true }
        : { recursive: true, mode: options.dirMode },
      done,
    )
  })
  if (prepared !== null) throw prepared
  const temp = `${filename}.${randomBytes(6).toString('hex')}.tmp`
  // Cleanup runs before the rethrow, so the caller observes exactly the write
  // error; cleanup cannot mask it.
  const failure = await writeTempAndCommit(temp, filename, content, options.mode)
  if (failure === null) return
  await attempt((done) => { rm(temp, { force: true }, done) })
  throw failure
}

/**
 * Write `content` to `temp`, fsync it, rename over `filename`, fsync the parent.
 * @param temp - random-suffix sibling receiving the content first.
 * @param filename - final path the rename commits to.
 * @param content - complete next file content.
 * @param mode - permission bits stamped on the fresh temp inode.
 * @returns the first errno a step reported, otherwise `null`.
 */
async function writeTempAndCommit(
  temp: string,
  filename: string,
  content: string,
  mode: number,
): Promise<NodeJS.ErrnoException | null> {
  const written = await attempt((done) => { writeFile(temp, content, { mode, flag: 'wx' }, done) })
  if (written !== null) return written
  const synced = await syncPath(temp)
  if (synced !== null) return synced
  return commitDurably(temp, filename)
}

/**
 * Publish the staged content at `filename` so the new directory entry survives
 * a crash. POSIX renames and fsyncs the parent directory. Windows offers no
 * directory fsync, so the rename ITSELF must carry the durability: the
 * write-through move both replaces the target and flushes the namespace change
 * before it returns.
 * @param temp - the synced staging file.
 * @param filename - the committed path.
 * @returns the errno a step reported, otherwise `null`.
 */
async function commitDurably(temp: string, filename: string): Promise<NodeJS.ErrnoException | null> {
  if (process.platform === 'win32') {
    try {
      await replaceFileDurablyWin32(temp, filename)
      return null
    } catch (error) {
      return error as NodeJS.ErrnoException
    }
  }
  const renamed = await attempt((done) => { rename(temp, filename, done) })
  if (renamed !== null) return renamed
  return syncPath(dirname(filename))
}

/** Whether an exclusive create found an existing lock. */
async function isLockContention(error: NodeJS.ErrnoException, lockPath: string): Promise<boolean> {
  if (error.code === 'EEXIST') return true
  if (error.code !== 'EPERM') return false
  // A failing lstat proves nothing about the lock, and the original EPERM
  // stays authoritative.
  return attempt((done) => { lstat(lockPath, done) }).then(failure => failure === null)
}

/**
 * Retry cadence for a contended lock. These stay robustness invariants of the
 * cross-process write protocol rather than deployment tunables: they govern how
 * often a contender asks, which no caller has a reason to vary.
 */
const LOCK_RETRY_INITIAL_MS = 20
const LOCK_RETRY_MAX_MS = 200

/**
 * How long a contender waits when the caller states no limit — sized for the
 * render-and-rename cycle every call site had when this package was written.
 * Expiry fails the contender rather than guessing whether the existing lock
 * still has an owner. How long is *worth* waiting is a property of the
 * operation the lock holder runs, which is why {@link FileLockOptions.waitMs}
 * exists; the value here is the floor for an operation that does file work
 * alone.
 */
const DEFAULT_LOCK_WAIT_MS = 2_000

/** Options for one {@link withFileLock} acquisition. */
export interface FileLockOptions {
  /**
   * Maximum time to wait for the lock, in milliseconds. State one when the
   * holder's operation legitimately runs longer than file work — a credential
   * mutation that refreshes a token performs a network round trip while
   * holding the lock, and leaving the default in place would fail every other
   * writer of the same file for the duration. Waiting is productive: a
   * contender that acquires the lock afterwards re-reads the committed state.
   */
  waitMs?: number
}

/**
 * Hold the cross-process writer lock for `filename` around one operation. The
 * lock is a `wx`-created sibling (`<filename>.lock`); paired with the
 * rename-based commit of {@link writeFileAtomic}, readers stay lock-free and
 * only writers contend. `EEXIST` is contention directly; an `EPERM` is
 * contention only when a fresh `lstat` confirms the lock path exists, covering
 * Windows exclusive-create behavior without hiding an unrelated permission
 * failure. Contention backs off exponentially and fails with a timed-out error
 * after the deadline. The contender never removes an existing lock because
 * file age cannot prove that its owner stopped; orphan recovery is an operator
 * action. The parent directory must exist. The lock releases on both outcomes
 * of the operation.
 * @param filename - the file whose writers this lock serializes.
 * @param operation - the read-render-commit cycle to run while holding the lock.
 * @param options - acquisition options; omitted waits {@link DEFAULT_LOCK_WAIT_MS}.
 * @returns the operation's result.
 */
export async function withFileLock<T>(
  filename: string,
  operation: () => Promise<T>,
  options?: FileLockOptions,
): Promise<T> {
  const lockPath = `${filename}.lock`
  const deadline = Date.now() + (options?.waitMs ?? DEFAULT_LOCK_WAIT_MS)
  let delay = LOCK_RETRY_INITIAL_MS
  for (;;) {
    // A non-contention failure rethrows the original error after the EPERM
    // existence check rules contention out.
    const created = await attempt((done) => {
      writeFile(lockPath, `${process.pid}\n`, { mode: 0o600, flag: 'wx' }, done)
    })
    if (created === null) break
    if (!await isLockContention(created, lockPath)) throw created
    if (Date.now() >= deadline) {
      throw new Error(`atomic-write: timed out waiting for the writer lock at ${lockPath}`)
    }
    await new Promise(resolve => setTimeout(resolve, delay))
    delay = Math.min(delay * 2, LOCK_RETRY_MAX_MS)
  }
  // Synchronous release: the lock must be gone on both outcomes, and a
  // completion callback here would observe an outcome this function forwards.
  return operation().finally(() => { rmSync(lockPath, { force: true }) })
}
