/**
 * Shared budget validation for retainer request fields.
 * @module @deepseek-ai/dsh-output-retention/budget
 */

/** Assert a budget field is a non-negative integer (the retainer request contract). */
export function assertBudget(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`)
  }
}
