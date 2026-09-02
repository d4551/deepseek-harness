/**
 * Host-native command execution and path-opening utilities. This module owns
 * the two open gestures Host surfaces call; `./path-opener.ts` owns the
 * platform dispatch behind them and `./runner.ts` the shell-free runner.
 * @module @deepseek-ai/dsh-native-command
 */

import { openNativePathWithIntent } from './path-opener.ts'
import type { PathOpenerInternals } from './path-opener.ts'

export { runNativeCommand } from './runner.ts'
export type { NativeCommandRunner } from './runner.ts'
export { canOpenNativePath } from './path-opener.ts'
export type {
  PathOpenerInternals,
  PathOpenerRunner,
} from './path-opener.ts'

/**
 * Open a filesystem path with the operating system's default application, or
 * with the default browser when the path names a document a browser renders.
 * @param path - absolute or host-resolvable path (caller owns resolution).
 * @param signal - caller/connection lifetime; abort terminates the native command.
 * @param internals - Platform, environment, and runner hooks for deterministic tests.
 * @returns settlement of the native command.
 */
export function openNativePath(
  path: string,
  signal: AbortSignal,
  internals: PathOpenerInternals = {},
): Promise<void> {
  return openNativePathWithIntent(path, signal, 'default', internals)
}

/**
 * Open a text document for editing; macOS bypasses the file-type association
 * so a YAML association with a browser cannot consume the gesture.
 * @param path - absolute or host-resolvable text-document path.
 * @param signal - caller/connection lifetime; abort terminates the native command.
 * @param internals - Platform and runner hooks for deterministic tests.
 * @returns settlement of the native command.
 */
export function openNativeTextFile(
  path: string,
  signal: AbortSignal,
  internals: PathOpenerInternals = {},
): Promise<void> {
  return openNativePathWithIntent(path, signal, 'text-editor', internals)
}
