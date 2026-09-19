/** Cross-platform native single-directory chooser behind the native backend's capability. */

import { runNativeCommand, type NativeCommandRunner } from '@deepseek-ai/dsh-native-command'
import { pickWin32Directory } from './win32-dialog.ts'

import type { Thrown } from '@deepseek-ai/dsh-thrown'

/** Testable command boundary; native implementations never invoke a shell. */
export type DirectoryPickerRunner = NativeCommandRunner

/** Injectable platform facts for deterministic adapter tests. */
export interface DirectoryPickerInternals {
  platform?: NodeJS.Platform
  run?: DirectoryPickerRunner
  /** Replaces the in-process Win32 dialog (`pickWin32Directory`) for deterministic tests. */
  pickWin32Dialog?: (signal: AbortSignal) => Promise<string | null>
}

function outputPath(stdout: string): string | null {
  const path = stdout.replace(/[\r\n]+$/, '')
  return path === '' ? null : path
}

function errorCode(error: Thrown): string | number | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const { code } = error
  return typeof code === 'string' || typeof code === 'number' ? code : undefined
}

function errorStderr(error: Thrown): string {
  if (typeof error !== 'object' || error === null || !('stderr' in error)) return ''
  const { stderr } = error
  return typeof stderr === 'string' ? stderr : ''
}

function isMissingCommand(error: Thrown): boolean {
  return errorCode(error) === 'ENOENT'
}

function rethrowIfAborted(signal: AbortSignal, error: Thrown): void {
  if (signal.aborted) throw error
}

/**
 * Open the platform directory picker.
 * @param signal - caller/connection lifetime; abort terminates the native command.
 * @param internals - Platform and runner hooks for deterministic tests.
 * @returns the selected path, or null when the user cancels.
 */
export async function pickNativeDirectory(
  signal: AbortSignal,
  internals: DirectoryPickerInternals = {},
): Promise<string | null> {
  const platform = internals.platform ?? process.platform
  const run = internals.run ?? runNativeCommand

  if (platform === 'darwin') {
    return run('osascript', [
      '-e', 'set selectedFolder to choose folder with prompt "Select Workspace Directory"',
      '-e', 'POSIX path of selectedFolder',
    ], signal).then(
      result => outputPath(result.stdout),
      (error: Thrown) => {
        if (!signal.aborted && errorCode(error) === 1
          && /(?:User canceled|-128)/i.test(errorStderr(error))) return null
        throw error
      },
    )
  }

  if (platform === 'win32') {
    // The koffi-backed IFileOpenDialog child process — the modern picker with
    // per-monitor-v2 DPI and abort support. koffi is a packaged dependency
    // whose availability the install guarantees, so there is no fallback
    // tier: any failure surfaces as-is (no PowerShell fallback tier; see
    // .agents/notes/implemented/simplification/2026-08-04-drop-windows-powershell-picker-fallback.md).
    const pickDialog = internals.pickWin32Dialog ?? pickWin32Directory
    return await pickDialog(signal)
  }

  if (platform === 'linux') {
    return run('zenity', [
      '--file-selection', '--directory', '--title=Select Workspace Directory',
    ], signal).then(
      result => outputPath(result.stdout),
      (error: Thrown) => {
        rethrowIfAborted(signal, error)
        if (errorCode(error) === 1) return null
        if (!isMissingCommand(error)) throw error
        return run('kdialog', [
          '--getexistingdirectory', '.', '--title', 'Select Workspace Directory',
        ], signal).then(
          result => outputPath(result.stdout),
          (error: Thrown) => {
            rethrowIfAborted(signal, error)
            if (errorCode(error) === 1) return null
            if (isMissingCommand(error)) {
              throw new Error('no supported native directory picker found (install zenity or kdialog)')
            }
            throw error
          },
        )
      },
    )
  }

  throw new Error(`native directory picker is unsupported on ${platform}`)
}
