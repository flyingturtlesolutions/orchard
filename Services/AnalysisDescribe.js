/**
 * v2.67.0 (Pass 3b) — Natural-language descriptions of Analysis artifacts.
 *
 * When an Analysis's cache implementation fails its postcondition contract
 * and `autoRecover` is true, the engine constructs a frontier recovery
 * prompt from the Analysis's existing artifacts: operations, contract
 * (post-conditions), input data, and the cache output.
 *
 * The prompt-construction logic doesn't write prose; it composes prose from
 * machine descriptions of each artifact. This module provides those
 * descriptions, mirroring the `describeCondition` / `describeDataCondition`
 * pattern in Assertion.js / DataAssertion.js.
 *
 * The author never sees these strings — they're emitted only when recovery
 * fires. Strings are tuned for model consumption, not human reading.
 */

import { describeDataCondition } from './DataAssertion.js';

/**
 * Describe a single operation in natural language.
 *
 * Operations have already had params substituted by the time we describe
 * them (the engine substitutes before running and before describing for
 * recovery, so {{NAME}} placeholders are gone). The descriptions show the
 * concrete substituted values that cache attempted to use.
 */
export function describeOperation(op) {
  if (!op || typeof op !== 'object' || typeof op.op !== 'string') {
    return '(invalid operation)';
  }
  switch (op.op) {
    case 'filter':
      return `Filter to records where ${describeFilterAssertion(op.assertion)}`;
    case 'sort': {
      const dir = op.direction === 'desc' ? 'descending' : 'ascending';
      const coerce = op.coerceAs && op.coerceAs !== 'string' ? ` (as ${op.coerceAs})` : '';
      return `Sort by '${op.key ?? '?'}' ${dir}${coerce}`;
    }
    case 'take':
      return `Take the first ${op.count ?? '?'} records`;
    default:
      return `(unknown operation: ${op.op})`;
  }
}

/**
 * Describe a filter assertion in natural language.
 *
 * Filter assertions inside operations use the field-condition vocabulary
 * (field_starts_with, field_equals, field_contains, etc.) — same shape
 * used by record-level field conditions in Assertion.js.
 */
function describeFilterAssertion(p) {
  if (!p || typeof p !== 'object') return '(invalid assertion)';
  const field = p.field ?? '?';
  const value = p.value ?? '?';
  switch (p.type) {
    case 'field_equals':       return `field '${field}' equals '${value}'`;
    case 'field_present':      return `field '${field}' is present`;
    case 'field_starts_with':  return `field '${field}' starts with '${value}'`;
    case 'field_contains':     return `field '${field}' contains '${value}'`;
    case 'field_ends_with':    return `field '${field}' ends with '${value}'`;
    case 'field_gt':           return `field '${field}' is greater than '${value}'`;
    case 'field_gte':          return `field '${field}' is greater than or equal to '${value}'`;
    case 'field_lt':           return `field '${field}' is less than '${value}'`;
    case 'field_lte':          return `field '${field}' is less than or equal to '${value}'`;
    default:                   return `(${p.type ?? 'unknown'} ${field}=${value})`;
  }
}

/**
 * Describe an operations list as a numbered sequence.
 */
export function describeOperations(operations) {
  if (!Array.isArray(operations) || operations.length === 0) {
    return '(no operations)';
  }
  return operations.map((op, i) => `${i + 1}. ${describeOperation(op)}`).join('\n');
}

/**
 * Describe a postcondition list as a bulleted contract.
 *
 * Pre-conditions are not included; recovery is invoked only after pre
 * passed (pre is about input, not body, and a pre failure means no
 * implementation can help). This describes the OUTPUT contract that
 * recovery must satisfy.
 */
export function describeContract(postconditions) {
  if (!Array.isArray(postconditions) || postconditions.length === 0) {
    return '(no contract — any output is acceptable)';
  }
  return postconditions.map(c => `- ${describeDataCondition(c)}`).join('\n');
}

/**
 * v2.68.0 — Describe a precondition list as a bulleted set of input
 * facts. Used by frontier-primary invocation to inform the model what
 * the author guarantees about the input shape.
 *
 * Symmetrical to describeContract for postconditions. Returns the same
 * empty-marker idiom when no preconditions exist.
 */
export function describePreconditions(preconditions) {
  if (!Array.isArray(preconditions) || preconditions.length === 0) {
    return '(none specified)';
  }
  return preconditions.map(c => `- ${describeDataCondition(c)}`).join('\n');
}
