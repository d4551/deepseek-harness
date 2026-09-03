/**
 * Host entry for the shared Typert runtime registry. This module owns
 * {@link TypertRegistryOperations}, the reflection and schema operation set the
 * host face adds to `TypertRegistryContract`; `./service.ts` implements it.
 */

import type { z } from 'zod'
import type { TypertDisposer } from '@deepseek-ai/dsh-typert-protocol'
import type {
  TypertContribution,
  TypertFace,
  TypertPackageFilter,
  TypertPackageRecord,
  TypertSchemaFilter,
  TypertSchemaRecord,
} from './types.ts'

export { default, TypertRegistry, typertEndpoint, typertKey, typertPackageKey } from './service.ts'
export type { TypertContribution, TypertDocTag, TypertDocumentation, TypertEventModel, TypertFace, TypertMemberModel, TypertObjectModel, TypertPackageFilter, TypertPackageModel, TypertPackageRecord, TypertSchema, TypertSchemaFilter, TypertSchemaRecord, TypertServiceModel, TypertTypeModel } from './types.ts'

/** Reflection and schema operations the runtime registry adds to `TypertRegistryContract`. */
export interface TypertRegistryOperations {
  /**
   * Register one generated contribution atomically for the calling fiber.
   * Duplicate package-face identities, schemas, invocation ids, or endpoints
   * reject the whole batch.
   * @param contribution - generated schemas, reflection, and Host invocations.
   * @returns the exact effect disposer that removes this contribution.
   */
  register(contribution: TypertContribution): TypertDisposer
  /**
   * Look up one schema by `<package>#<name>`.
   * @param key - global schema key.
   * @returns the live schema record, or `undefined` when absent.
   */
  get(key: string): TypertSchemaRecord | undefined
  /**
   * Resolve one required schema.
   * @param key - global schema key.
   * @returns the live schema record.
   * @throws when the key is malformed, the package face is absent, or the schema is not contributed.
   */
  resolve(key: string): TypertSchemaRecord
  /**
   * Enumerate live schemas in registration order.
   * @param filter - optional package and face restriction.
   * @returns matching schema records.
   */
  list(filter?: TypertSchemaFilter): TypertSchemaRecord[]
  /**
   * Look up generated reflection for one package face.
   * @param packageName - exact npm package name.
   * @param face - face to query; defaults to the host runtime.
   * @returns the live package record, or `undefined` when absent.
   */
  getPackage(packageName: string, face?: TypertFace): TypertPackageRecord | undefined
  /**
   * Enumerate generated package reflection in registration order.
   * @param filter - optional package and face restriction.
   * @returns matching package records.
   */
  listPackages(filter?: TypertPackageFilter): TypertPackageRecord[]
  /**
   * Project a live Zod schema to JSON Schema without caching the result.
   * @param key - global schema key.
   * @param params - Zod projection parameters.
   * @returns a fresh JSON Schema document.
   */
  toJSONSchema(key: string, params?: z.core.ToJSONSchemaParams): z.core.JSONSchema.BaseSchema
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRegistryContract extends TypertRegistryOperations {}
}
