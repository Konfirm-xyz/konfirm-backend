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
export function zodToOpenApi(schema: z.ZodType): SchemaObject {
  return convert(schema);
}

// eslint-disable-next-line complexity
function convert(schema: z.ZodType): SchemaObject {
  if (!schema) return {};

  // Unwrap optional/nullable/default wrappers first so the inner type
  // drives the schema shape, and we only add nullable/required hints on top.
  if (schema instanceof z.ZodOptional) {
    return convert(schema.unwrap() as z.ZodType);
  }
  if (schema instanceof z.ZodNullable) {
    return { ...convert(schema.unwrap() as z.ZodType), nullable: true };
  }
  if (schema instanceof z.ZodDefault) {
    const inner = convert(schema._zod.def.innerType as z.ZodType);
    const defaultValue = schema._zod.def.defaultValue;
    return {
      ...inner,
      default: typeof defaultValue === 'function' ? defaultValue() : defaultValue,
    };
  }
  if (schema instanceof z.ZodPipe) {
    // .transform() / .pipe() — surface the input schema's shape
    return convert(schema._zod.def.in as z.ZodType);
  }
  if (schema instanceof z.ZodCustom) {
    // .refine() / .superRefine() — surface the inner schema shape
    return convert(schema._zod.def.innerType as z.ZodType);
  }
  if (schema instanceof z.ZodString) {    return buildStringSchema(schema);
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
  if (schema instanceof z.ZodLiteral) {
    return { type: typeof schema.value as 'string' | 'number' | 'boolean', enum: [schema.value] };
  }
  if (schema instanceof z.ZodArray) {
    return { type: 'array', items: convert(schema.element as z.ZodType) };
  }
  if (schema instanceof z.ZodObject) {
    return buildObjectSchema(schema);
  }
  if (schema instanceof z.ZodRecord) {
    return {
      type: 'object',
      additionalProperties: convert(schema.valueType as z.ZodType),
    };
  }
  if (schema instanceof z.ZodUnion) {
    return { oneOf: (schema.options as z.ZodType[]).map(convert) };
  }
  if (schema instanceof z.ZodIntersection) {
    return {
      allOf: [
        convert(schema._zod.def.left as z.ZodType),
        convert(schema._zod.def.right as z.ZodType),
      ],
    };
  }
  if (schema instanceof z.ZodAny || schema instanceof z.ZodUnknown) {
    return {};
  }

  // Unknown type — return permissive schema
  return {};
}

function buildStringSchema(schema: z.ZodString): SchemaObject {
  const checks = schema._zod.def.checks ?? [];
  const result: SchemaObject = { type: 'string' };

  for (const check of checks) {
    const def = check._zod.def as {
      check?: string;
      minimum?: number;
      maximum?: number;
      pattern?: RegExp;
      format?: string;
    };
    if (def.check === 'min_length') result.minLength = def.minimum as number;
    if (def.check === 'max_length') result.maxLength = def.maximum as number;
    if (def.check === 'regex') result.pattern = (def.pattern as RegExp).source;
    if (def.check === 'string_format') {
      if (def.format === 'email') result.format = 'email';
      if (def.format === 'url') result.format = 'uri';
      if (def.format === 'uuid') result.format = 'uuid';
      if (def.format === 'datetime') result.format = 'date-time';
    }
  }

  return result;
}

function buildNumberSchema(schema: z.ZodNumber): SchemaObject {
  const checks = schema._zod.def.checks ?? [];
  const result: SchemaObject = { type: 'number' };

  for (const check of checks) {
    const def = check._zod.def as {
      check?: string;
      minimum?: number;
      maximum?: number;
      inclusive?: boolean;
    };
    if (def.check === 'greater_than') {
      result.minimum = def.minimum as number;
      // OAS 3.0's SchemaObject (what @nestjs/swagger types against) models
      // exclusive bounds as a boolean flag alongside `minimum`/`maximum`,
      // not as the OAS 3.1 style of the bound itself replacing the flag --
      // `minimum` above already carries the value either way.
      if (def.inclusive === false) result.exclusiveMinimum = true;
    }
    if (def.check === 'less_than') {
      result.maximum = def.maximum as number;
      if (def.inclusive === false) result.exclusiveMaximum = true;
    }
    if (def.check === 'number_format' && def.format === 'safeint') result.type = 'integer';
  }

  return result;
}

function buildObjectSchema(schema: z.ZodObject): SchemaObject {
  const shape = schema.shape as Record<string, z.ZodType>;
  const properties: Record<string, SchemaObject> = {};
  const required: string[] = [];

  for (const [key, value] of Object.entries(shape)) {
    properties[key] = convert(value);
    // A field is required unless it is ZodOptional or has a ZodDefault.
    if (!(value instanceof z.ZodOptional) && !(value instanceof z.ZodDefault)) {
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
  schema: z.ZodType,
  description?: string,
): { schema: SchemaObject; description?: string } {
  return { schema: zodToOpenApi(schema), ...(description ? { description } : {}) };
}
