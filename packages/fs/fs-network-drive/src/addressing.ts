/**
 * Drive addressing: the mappings between model-facing targets,
 * workspace-relative drive paths, absolute drive paths, and the local
 * materialization root, plus the placement and listing reads that consult
 * them.
 *
 * Every drive or filesystem failure settles into a {@link Landed} value whose
 * rejection side carries the failure as an `Error`, then translates through
 * `mapError`; no catch block ever widens a failure to a bare parameter.
 *
 * @module @deepseek-ai/dsh-fs-network-drive/addressing
 */

import { readdir } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { assertNever } from '@deepseek-ai/dsh-llm'
import { FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type { FsDirEntry, FsInfo, FsPathInfo, FsTarget } from '@deepseek-ai/dsh-fs'
import { driveChildPath, drivePath } from '@deepseek-ai/dsh-network-drive/identity'
import type { NetworkDrive } from '@deepseek-ai/dsh-network-drive'
import type { DriveDirEntry, DrivePath, DriveStat } from '@deepseek-ai/dsh-network-drive/types'
import { digestOfFile, drivePathOf, localInfo, localPathOf, materializeDirectory, STATE_DIRECTORY } from './materialization.ts'
import type { LocalPathInfo } from './materialization.ts'
import { assertNotAborted, driveToken, fsType, fsTypeOfLocal, landing, localToken, mapError, targetKeyFor, workspacePathOfKey } from './vocabulary.ts'
import type { Placement } from './vocabulary.ts'

/** The validated configuration every addressing read consults. */
export interface ResolvedConfig {
  materializationRoot: string
  remoteRoot: DrivePath
  maxFileBytes: number
}

/**
 * Project one resolved placement into the seam's metadata.
 *
 * `stat` and `lstat` answer from the same placement and differ only in how a
 * local entry's type is reported: `stat` follows a link and so never reports
 * one, while `lstat` reports the link itself.
 * @param placement - where the target currently lives.
 * @param localType - how to report a local entry's type.
 * @returns the metadata, or `undefined` when the target is absent.
 */
export function infoOfPlacement<T extends FsInfo['type'] | FsPathInfo['type']>(
  placement: Placement,
  localType: (type: LocalPathInfo['type']) => T,
): { version: FsVersion; type: T; size?: number } | undefined {
  switch (placement.kind) {
    case 'drive':
      return {
        version: driveToken(placement.remote.version),
        type: fsType(placement.remote.type) as T,
        ...placement.remote.size === undefined ? {} : { size: placement.remote.size },
      }
    case 'local':
      return {
        version: placement.version,
        type: localType(placement.info.type),
        ...placement.info.size === undefined ? {} : { size: placement.info.size },
      }
    case 'absent':
      return undefined
    default:
      return assertNever(placement, 'placement')
  }
}

/**
 * One drive-backed addressing: the target/path mappings and placement reads
 * shared by every seam operation. Holds no locks; the provider serializes
 * mutations.
 */
export class DriveAddressing {
  constructor(
    private readonly config: ResolvedConfig,
    private readonly drive: () => NetworkDrive,
  ) {}

  /**
   * The local process path a target materializes at.
   * @param target - a target this provider minted; the key encoding is private,
   * so one from another backend either fails the drive-path check or names an
   * unrelated file.
   * @returns the absolute path under the materialization root that ripgrep, a
   * shell, or a language server opens. Addressing only: the file need not exist,
   * and hydration is what puts bytes there.
   */
  processPath(target: FsTarget): string {
    return localPathOf(this.config.materializationRoot, this.workspacePath(target))
  }

  /**
   * Build the target for one model-supplied path, rejecting anything outside the drive-backed workspace.
   * @param path - the model-supplied path; an absolute one is taken as given, a
   * relative one is resolved against `cwd`.
   * @param cwd - the directory relative paths resolve against; `undefined` uses
   * the materialization root.
   * @param operation - the seam operation name the rejection message opens with.
   * @returns the target for the resolved path, which need not exist; this runs no I/O.
   * @throws FsError `FS_PERMISSION_DENIED` when the resolved path escapes the
   * materialization root or names the provider's private state directory. The
   * test is lexical on the resolved path and follows no symbolic link.
   */
  targetOf(path: string, cwd: string | undefined, operation: string): FsTarget {
    const base = cwd === undefined ? this.config.materializationRoot : resolve(cwd)
    const absolute = isAbsolute(path) ? resolve(path) : resolve(base, path)
    const within = drivePathOf(this.config.materializationRoot, absolute)
    if (within === undefined) {
      throw new FsError(
        `cannot ${operation} "${absolute}": the path is outside the network-drive workspace ${this.config.materializationRoot}`,
        'FS_PERMISSION_DENIED',
      )
    }
    return this.targetFor(drivePath(within))
  }

  /**
   * The stable target for one workspace-relative drive path.
   * @param workspacePath - the path below the workspace root; `''` is the root itself.
   * @returns the same target for the same path and materialization root, in this
   * process and the next. Its `displayPath` is the local absolute path, so
   * model-facing output names an ordinary file and never a drive address.
   */
  targetFor(workspacePath: DrivePath): FsTarget {
    return {
      targetKey: FsTargetKey(targetKeyFor(workspacePath)),
      displayPath: localPathOf(this.config.materializationRoot, workspacePath),
    }
  }

  /**
   * The workspace-relative drive path a target names; the provider owns its own key encoding.
   * @param target - a target this provider minted.
   * @returns the path below the workspace root, `''` for the root itself. The
   * configured `remoteRoot` is not applied here, so this is the path the local
   * materialization is keyed by, not the one the drive is asked about.
   */
  workspacePath(target: FsTarget): DrivePath {
    return drivePath(workspacePathOfKey(String(target.targetKey)))
  }

  /**
   * The absolute drive path a target names, below the configured remote root.
   * @param target - a target this provider minted.
   * @returns the path every `ctx.networkDrive` call receives: the workspace path
   * joined below `remoteRoot`, the workspace path alone when the provider mirrors
   * the drive root, and `remoteRoot` itself for the workspace root.
   */
  drivePathOfTarget(target: FsTarget): DrivePath {
    const workspacePath = this.workspacePath(target)
    if (this.config.remoteRoot.length === 0) return workspacePath
    if (workspacePath.length === 0) return this.config.remoteRoot
    return drivePath(`${this.config.remoteRoot}/${workspacePath}`)
  }

  /**
   * Where one target currently lives, consulting the drive first and the local workspace second.
   * @param target - the target to locate.
   * @param signal - the caller's signal, checked before the drive stat and again
   * after it, so an abort during the round trip is reported instead of the result.
   * @returns `drive` with the drive's metadata when the drive holds the path,
   * `local` with the working entry's metadata and version when only the workspace
   * does, and `absent` when neither does. Versioning a `local` file digests it,
   * so locating one streams its whole content.
   * @throws FsError translated from the drive failure by `mapError`, or
   * `FS_ABORTED` when the signal fired.
   */
  async placementOf(target: FsTarget, signal: AbortSignal | undefined): Promise<Placement> {
    assertNotAborted(signal, 'stat')
    const stat = await landing<DriveStat | undefined>(
      this.drive().stat(this.drivePathOfTarget(target), signal),
    )
    if (!stat.ok) throw mapError(stat.reason, 'stat', target.displayPath, signal)
    assertNotAborted(signal, 'stat')
    if (stat.value !== undefined) return { kind: 'drive', remote: stat.value }
    const info = await localInfo(this.processPath(target))
    if (info === undefined) return { kind: 'absent' }
    return { kind: 'local', info, version: await this.localVersion(target, info) }
  }

  /**
   * The seam version of one placement, which a guard compares against.
   * @param placement - the placement read for the operation being guarded.
   * @returns the `drive:` revision token, the `local:` working token, or
   * `undefined` for an absent target. `undefined` matches no version a caller can
   * hold, so a `replaceIfVersion` guard against an absent target rejects as stale.
   */
  versionOf(placement: Placement): FsVersion | undefined {
    switch (placement.kind) {
      case 'drive':
        return driveToken(placement.remote.version)
      case 'local':
        return placement.version
      case 'absent':
        return undefined
      default:
        return assertNever(placement, 'placement')
    }
  }

  /**
   * Direct children of one directory: drive children first, then any working files the local execution world created beside them.
   * @param target - the directory to list.
   * @param signal - the caller's signal, honored by the placement read and the drive listing.
   * @returns the children sorted by name. A drive child carries its revision
   * token and the drive's size; a local-only child carries no version, because
   * nothing has published it yet, and a name the drive already listed keeps the
   * drive's entry. Listing also creates the directory locally, so a process can
   * enter a directory that has only ever been listed.
   * @throws FsError `FS_NOT_FOUND` when the target is absent, `FS_NOT_DIRECTORY`
   * when it is not a directory, or the drive failure `mapError` translated.
   */
  async listEntries(target: FsTarget, signal: AbortSignal | undefined): Promise<FsDirEntry[]> {
    const placement = await this.placementOf(target, signal)
    if (placement.kind === 'absent') {
      throw new FsError(`cannot list "${target.displayPath}": not found`, 'FS_NOT_FOUND')
    }
    const type = placement.kind === 'drive' ? fsType(placement.remote.type) : fsTypeOfLocal(placement.info.type)
    if (type !== 'directory') {
      throw new FsError(`cannot list "${target.displayPath}": not a directory`, 'FS_NOT_DIRECTORY')
    }
    const workspacePath = this.workspacePath(target)
    const entries = new Map<string, FsDirEntry>()
    if (placement.kind === 'drive') {
      const listed = await landing<DriveDirEntry[]>(
        this.drive().list(this.drivePathOfTarget(target), signal),
      )
      if (!listed.ok) throw mapError(listed.reason, 'list', target.displayPath, signal)
      for (const entry of listed.value) {
        const child = driveChildPath(workspacePath, entry.name)
        entries.set(entry.name, {
          name: entry.name,
          type: fsType(entry.type),
          target: this.targetFor(child),
          version: driveToken(entry.version),
          ...entry.size === undefined ? {} : { size: entry.size },
        })
      }
    }
    // Working files the local execution world created are listed beside the
    // drive's own children, so a shell-created file is visible before any seam
    // write has published it.
    await materializeDirectory(this.config.materializationRoot, workspacePath)
    for (const name of await this.localChildren(workspacePath)) {
      if (entries.has(name)) continue
      const child = driveChildPath(workspacePath, name)
      const info = await localInfo(localPathOf(this.config.materializationRoot, child))
      if (info === undefined) continue
      entries.set(name, {
        name,
        type: fsTypeOfLocal(info.type),
        target: this.targetFor(child),
        ...info.size === undefined ? {} : { size: info.size },
      })
    }
    return [...entries.values()].sort((left, right) => left.name.localeCompare(right.name))
  }

  /**
   * Direct child names of one workspace directory, excluding the provider's private state.
   * @param workspacePath - the directory below the workspace root; `''` is the root itself.
   * @returns the basenames on local disk, with the private state directory
   * dropped at the workspace root, where it lives. Names only: nothing here says
   * whether the drive holds a child too.
   * @throws the raw `node:fs` failure, untranslated, when the local directory is
   * missing; a caller materializes the directory first.
   */
  async localChildren(workspacePath: DrivePath): Promise<string[]> {
    const local = localPathOf(this.config.materializationRoot, workspacePath)
    const names = await readdir(local)
    return workspacePath.length === 0 ? names.filter(name => name !== STATE_DIRECTORY) : names
  }

  /**
   * The version of a working entry the drive does not hold. A file's version is
   * the digest of its whole content, however large the file is: a token that
   * summarized an oversize file by its size would compare equal across a
   * replacement of the same length, and a guarded write holding it would
   * overwrite the replacing content. The digest is streamed, so the file's size
   * costs I/O but never memory. Anything that is not a file has no content to
   * digest and takes its kind as its version.
   * @param target - the entry to version.
   * @param info - the local metadata already read for it.
   * @returns the `local:` token for the entry.
   * @throws FsError translated from the failure that reading the file raised.
   */
  private async localVersion(target: FsTarget, info: LocalPathInfo): Promise<FsVersion> {
    if (info.type !== 'file') return localToken(info.type)
    const digest = await landing<string>(digestOfFile(this.processPath(target)))
    if (!digest.ok) throw mapError(digest.reason, 'stat', target.displayPath)
    return localToken(digest.value)
  }
}
