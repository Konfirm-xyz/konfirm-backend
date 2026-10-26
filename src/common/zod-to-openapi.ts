/**
 * Lightweight Zod → OpenAPI schema converter.
 *
 * Keeps Zod as the single source of truth for request validation while
 * making schemas legible in the Swagger UI without a heavyweight bridge
 * package (no zod-to-openapi runtime dependency, no DTO duplication).
 *
 * Supports the subset of Zod types actually used in this codebase.  Any
 * type it doesn't recognise falls back to `{}` (no constraint) — the
 * request will still be validated at runtime by the ZodValidationPipe; the
 * OpenAPI description just won't be as precise for that field.
 */

import { z } from 'zod';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';

// Re-export for convenience so callers don't have to import two things.
export type { SchemaObject };

/** Convert a Zod schema to an OpenAPI SchemaObject. */
export function zodToOpenApi(schema: z.ZodTypeAny): SchemaObject {
  return convert(schema);
}

// eslint-disable-next-line complexity
function convert(schema: z.ZodTypeAny): SchemaObject {
  if (!schema) return {};

  // Unwrap optional/nullable/default wrappers first so the inner type
  // drives the schema shape, and we only add nullable/required hints on top.
  if (schema instanceof z.ZodOptional) {
    return convert(schema.unwrap());
  }
  if (schema instanceof z.ZodNullable) {
    return { ...convert(schema.unwrap()), nullable: true };
  }
  if (schema instanceof z.ZodDefault) {
    const inner = convert(schema._def.innerType);
    const defaultValue = schema._def.defaultValue();
    return { ...inner, default: defaultValue };
  }
  if (schema instanceof z.ZodEffects) {
    // .refine() / .transform() — surface the inner schema shape
    return convert(schema._def.schema);
  }

  if (schema instanceof z.ZodString) {
    return buildStringSchema(schema);
  }
  if (schema instanceof z.ZodNumber) {
    return buildNumberSchema(schema);
  }
  if (schema instanceof z.ZodBoolean) {
    return { type: 'boolean' };
  }
  if (schema instanceof z.ZodEnum) {
    return { type: 'string', enum: schema.options as string[] };
  }
  if (schema instanceof z.ZodNativeEnum) {
    return { type: 'string', enum: Object.values(schema.enum) as string[] };
  }
  if (schema instanceof z.ZodLiteral) {
    return { type: typeof schema.value as 'string' | 'number' | 'boolean', enum: [schema.value] };
  }
  if (schema instanceof z.ZodArray) {
    return { type: 'array', items: convert(schema.element) };
  }
  if (schema instanceof z.ZodObject) {
    return buildObjectSchema(schema);
  }
  if (schema instanceof z.ZodRecord) {
    return {
      type: 'object',
      additionalProperties: convert(schema.valueSchema),
    };
  }
  if (schema instanceof z.ZodUnion) {
    return { oneOf: (schema.options as z.ZodTypeAny[]).map(convert) };
  }
  if (schema instanceof z.ZodIntersection) {
    return { allOf: [convert(schema._def.left), convert(schema._def.right)] };
  }
  if (schema instanceof z.ZodAny || schema instanceof z.ZodUnknown) {
    return {};
  }

  // Unknown type — return permissive schema
  return {};
}

function buildStringSchema(schema: z.ZodString): SchemaObject {
  const checks = schema._def.checks ?? [];
  const result: SchemaObject = { type: 'string' };

  for (const check of checks) {
    if (check.kind === 'min') result.minLength = check.value as number;
    if (check.kind === 'max') result.maxLength = check.value as number;
    if (check.kind === 'regex') result.pattern = (check.regex as RegExp).source;
    if (check.kind === 'email') result.format = 'email';
    if (check.kind === 'url') result.format = 'uri';
    if (check.kind === 'uuid') result.format = 'uuid';
    if (check.kind === 'datetime') result.format = 'date-time';
  }

  return result;
}

function buildNumberSchema(schema: z.ZodNumber): SchemaObject {
  const checks = schema._def.checks ?? [];
  const result: SchemaObject = { type: 'number' };

  for (const check of checks) {
    if (check.kind === 'min') {
      result.minimum = check.value as number;
      // OAS 3.0's SchemaObject (what @nestjs/swagger types against) models
      // exclusive bounds as a boolean flag alongside `minimum`/`maximum`,
      // not as the OAS 3.1 style of the bound itself replacing the flag --
      // `minimum` above already carries the value either way.
      if (check.inclusive === false) result.exclusiveMinimum = true;
    }
    if (check.kind === 'max') {
      result.maximum = check.value as number;
      if (check.inclusive === false) result.exclusiveMaximum = true;
    }
    if (check.kind === 'int') result.type = 'integer';
  }

  return result;
}

function buildObjectSchema(schema: z.ZodObject<z.ZodRawShape>): SchemaObject {
  const shape = schema.shape as z.ZodRawShape;
  const properties: Record<string, SchemaObject> = {};
  const required: string[] = [];

  for (const [key, value] of Object.entries(shape)) {
    properties[key] = convert(value as z.ZodTypeAny);
    // A field is required unless it is ZodOptional or has a ZodDefault.
    const unwrapped = value as z.ZodTypeAny;
    if (
      !(unwrapped instanceof z.ZodOptional) &&
      !(unwrapped instanceof z.ZodDefault)
    ) {
      required.push(key);
    }
  }

  const result: SchemaObject = { type: 'object', properties };
  if (required.length > 0) result.required = required;
  return result;
}

/**
 * Build an `ApiBody` options object from a Zod schema.
 *
 * Usage:
 *   @ApiBody(zodBody(mySchema, 'MyRequest'))
 */
export function zodBody(
  schema: z.ZodTypeAny,
  description?: string,
): { schema: SchemaObject; description?: string } {
  return { schema: zodToOpenApi(schema), ...(description ? { description } : {}) };
}
