/**
 * Prototype-safe primitives shared by the worker closure's JSON modules.
 *
 * Model code runs in the worker's own realm and may replace `Array.prototype`,
 * `Object.prototype`, and their accessors before the harness serializes a
 * result. Everything here reads the intrinsics once at module load and then
 * builds values through null-prototype descriptors, so later mutation cannot
 * reach the serializer. This module belongs to the dependency-free source
 * closure (`worker.ts`, `bootstrap.ts`, `protocol.ts`, `worker-json.ts`,
 * `output-json.ts`): it imports nothing but the other closure members.
 *
 * @module @deepseek-ai/dsh-code-runtime-worker-thread/intrinsics
 */

/** Signature of an intrinsic method invoked through {@link intrinsicReflectApply}. */
export type IntrinsicCallable = (this: unknown, ...args: unknown[]) => unknown

/** `Reflect.apply`, captured before model code can replace it. */
export const intrinsicReflectApply = Reflect.apply as (
  target: IntrinsicCallable,
  thisArgument: unknown,
  argumentsList: readonly unknown[],
) => unknown

const intrinsicObjectCreate = Object.create
const intrinsicObjectDefineProperty = Object.defineProperty

/**
 * Build a data descriptor that cannot inherit model-defined accessor fields.
 * @param value - the value the descriptor carries.
 * @returns a null-prototype descriptor holding `value`.
 */
function dataDescriptor(value: unknown): PropertyDescriptor {
  const descriptor = intrinsicObjectCreate(null) as PropertyDescriptor
  descriptor.value = value
  return descriptor
}

/**
 * Define an ordinary enumerable data slot without a prototype-bearing descriptor.
 * @param target - the object receiving the slot.
 * @param key - the property key to define.
 * @param value - the value stored in the slot.
 */
export function defineEnumerableDataProperty(target: object, key: PropertyKey, value: unknown): void {
  const descriptor = dataDescriptor(value)
  descriptor.enumerable = true
  descriptor.configurable = true
  descriptor.writable = true
  intrinsicObjectDefineProperty(target, key, descriptor)
}

/**
 * Append without consulting a model-mutated `Array.prototype`.
 * @param target - the array to extend.
 * @param value - the value appended at the current length.
 */
export function append<T>(target: T[], value: T): void {
  defineEnumerableDataProperty(target, target.length, value)
}

/**
 * Pop without consulting a model-mutated `Array.prototype`.
 * @param target - the array to shorten.
 * @returns the removed last element, or `undefined` when the array is empty.
 */
export function takeLast<T>(target: T[]): T | undefined {
  if (target.length === 0) return undefined
  const index = target.length - 1
  const value = target[index]
  intrinsicObjectDefineProperty(target, 'length', dataDescriptor(index))
  return value
}
