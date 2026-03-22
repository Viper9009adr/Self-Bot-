/**
 * src/mcp/schema-utils.ts
 * Convert a JSON Schema object (from MCP tool inputSchema) into a Zod schema.
 * Recursion is capped at depth 10 to prevent infinite loops on self-referential schemas.
 */
import { z } from 'zod';

type JsonSchemaNode = Record<string, unknown>;

/**
 * Build a Zod union from an array of schemas.
 * 0 members → z.unknown(), 1 member → the member itself, 2+ → z.union().
 */
function buildUnion(members: z.ZodTypeAny[]): z.ZodTypeAny {
  if (members.length === 0) return z.unknown();
  if (members.length === 1) return members[0]!;
  const [first, second, ...rest] = members as [
    z.ZodTypeAny,
    z.ZodTypeAny,
    ...z.ZodTypeAny[],
  ];
  return z.union([first, second, ...rest]);
}

/**
 * Recursively convert a JSON Schema node to a Zod schema.
 * Falls back to z.unknown() for unrecognised nodes or when depth exceeds 10.
 */
export function jsonSchemaToZod(
  schema: Record<string, unknown>,
  depth = 0,
): z.ZodTypeAny {
  if (depth > 10) return z.unknown();

  const node = schema as JsonSchemaNode;

  // ── anyOf / oneOf ──────────────────────────────────────────────────────────
  const anyOf = (node['anyOf'] ?? node['oneOf']) as JsonSchemaNode[] | undefined;
  if (Array.isArray(anyOf)) {
    const members = anyOf.map((s) => jsonSchemaToZod(s, depth + 1));
    return buildUnion(members);
  }

  // ── enum ──────────────────────────────────────────────────────────────────
  if (Array.isArray(node['enum'])) {
    const values = node['enum'] as unknown[];

    if (values.length === 0) return z.unknown();

    if (values.length === 1) {
      return z.literal(values[0] as z.Primitive);
    }

    // 2+ values — check if all are strings
    const allStrings = values.every((v) => typeof v === 'string');
    if (allStrings) {
      const [first, second, ...rest] = values as [string, string, ...string[]];
      return z.enum([first, second, ...rest]);
    }

    // Mixed types — build union of literals
    const literals = values.map((v) => z.literal(v as z.Primitive));
    return buildUnion(literals);
  }

  const type = node['type'] as string | undefined;

  // ── Primitive types ────────────────────────────────────────────────────────
  switch (type) {
    case 'string':
      return z.string();
    case 'number':
      return z.number();
    case 'integer':
      return z.number().int();
    case 'boolean':
      return z.boolean();
    case 'null':
      return z.null();

    // ── array ────────────────────────────────────────────────────────────────
    case 'array': {
      const items = node['items'] as JsonSchemaNode | undefined;
      const itemSchema = items ? jsonSchemaToZod(items, depth + 1) : z.unknown();
      return z.array(itemSchema);
    }

    // ── object ───────────────────────────────────────────────────────────────
    case 'object': {
      const properties = node['properties'] as Record<string, JsonSchemaNode> | undefined;
      const required = node['required'] as string[] | undefined;

      if (!properties || Object.keys(properties).length === 0) {
        return z.record(z.unknown());
      }

      const requiredSet = new Set(required ?? []);
      const shape: Record<string, z.ZodTypeAny> = {};
      for (const [key, propSchema] of Object.entries(properties)) {
        const fieldSchema = jsonSchemaToZod(propSchema, depth + 1);
        shape[key] = requiredSet.has(key) ? fieldSchema : fieldSchema.optional();
      }

      return z.object(shape);
    }

    default:
      return z.unknown();
  }
}
