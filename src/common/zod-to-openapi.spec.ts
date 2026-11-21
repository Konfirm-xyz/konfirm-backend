import { z } from 'zod';
import { zodToOpenApi } from './zod-to-openapi';

describe('zodToOpenApi', () => {
  it('unwraps optional', () => {
    const schema = zodToOpenApi(z.string().optional());
    expect(schema.type).toBe('string');
  });

  it('unwraps nullable', () => {
    const schema = zodToOpenApi(z.number().nullable());
    expect(schema.type).toBe('number');
  });

  it('unwraps default', () => {
    const schema = zodToOpenApi(z.boolean().default(false));
    expect(schema.default).toBe(false);
  });

  it('converts an enum to an array of values', () => {
    const schema = zodToOpenApi(z.enum(['a', 'b', 'c']));
    expect(schema.enum).toEqual(['a', 'b', 'c']);
  });

  it('converts a union to oneOf', () => {
    const schema = zodToOpenApi(z.union([z.string(), z.number()]));
    expect(schema.oneOf).toBeDefined();
    expect(schema.oneOf).toHaveLength(2);
  });

  it('converts a record to additionalProperties', () => {
    const schema = zodToOpenApi(z.record(z.string()));
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBeDefined();
  });

  it('converts a nested object with required fields', () => {
    const schema = zodToOpenApi(z.object({ id: z.number(), name: z.string().optional() }));
    expect(schema.type).toBe('object');
    expect(schema.required).toContain('id');
    expect(schema.required).not.toContain('name');
    expect(schema.properties?.['id']).toMatchObject({ type: 'number' });
  });

  it('converts an array', () => {
    const schema = zodToOpenApi(z.array(z.string()));
    expect(schema.type).toBe('array');
    expect(schema.items).toMatchObject({ type: 'string' });
  });

  it('falls back to {} for unsupported types', () => {
    const schema = zodToOpenApi(z.tuple([z.string(), z.number()]));
    expect(schema).toEqual({});
  });
});
