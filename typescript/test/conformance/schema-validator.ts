/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

export interface SchemaIssue {
  readonly instancePath: string;
  readonly schemaPath: string;
  readonly message: string;
}

type JsonSchema = boolean | { readonly [key: string]: unknown };

function pointerSegment(value: string): string {
  return value.replace(/~/g, '~0').replace(/\//g, '~1');
}

function valueType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function matchesType(value: unknown, expected: string): boolean {
  switch (expected) {
    case 'null':
      return value === null;
    case 'array':
      return Array.isArray(value);
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'string':
    case 'boolean':
      return typeof value === expected;
    default:
      throw new Error(`The schema uses unsupported type ${expected}.`);
  }
}

function equalJson(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => equalJson(item, right[index]))
    );
  }
  if (
    typeof left !== 'object' ||
    left === null ||
    typeof right !== 'object' ||
    right === null
  ) {
    return false;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.hasOwn(rightRecord, key) && equalJson(leftRecord[key], rightRecord[key]),
    )
  );
}

function resolveReference(root: JsonSchema, reference: string): JsonSchema {
  if (!reference.startsWith('#/')) {
    throw new Error(`Only local JSON Schema references are supported: ${reference}`);
  }
  let current: unknown = root;
  for (const encoded of reference.slice(2).split('/')) {
    const key = encoded.replace(/~1/g, '/').replace(/~0/g, '~');
    if (
      typeof current !== 'object' ||
      current === null ||
      !Object.hasOwn(current, key)
    ) {
      throw new Error(`JSON Schema reference does not resolve: ${reference}`);
    }
    current = (current as Record<string, unknown>)[key];
  }
  if (
    typeof current !== 'boolean' &&
    (typeof current !== 'object' || current === null)
  ) {
    throw new Error(`JSON Schema reference is not a schema: ${reference}`);
  }
  return current as JsonSchema;
}

function schemaRecord(schema: JsonSchema, path: string): Record<string, unknown> {
  if (typeof schema === 'boolean') {
    throw new Error(`Expected an object schema at ${path}.`);
  }
  return schema;
}

function validateNode(
  value: unknown,
  schema: JsonSchema,
  root: JsonSchema,
  instancePath: string,
  schemaPath: string,
): SchemaIssue[] {
  if (schema === true) return [];
  if (schema === false) return [{ instancePath, schemaPath, message: 'is forbidden' }];

  const issues: SchemaIssue[] = [];
  if (typeof schema.$ref === 'string') {
    issues.push(
      ...validateNode(
        value,
        resolveReference(root, schema.$ref),
        root,
        instancePath,
        `${schemaPath}/$ref`,
      ),
    );
  }

  if (Array.isArray(schema.oneOf)) {
    const attempts = schema.oneOf.map((candidate, index) =>
      validateNode(
        value,
        candidate as JsonSchema,
        root,
        instancePath,
        `${schemaPath}/oneOf/${index}`,
      ),
    );
    const matches = attempts.filter((issues) => issues.length === 0);
    if (matches.length !== 1) {
      const discriminator =
        typeof value === 'object' && value !== null && !Array.isArray(value)
          ? (value as Record<string, unknown>).type
          : undefined;
      return [
        {
          instancePath:
            typeof discriminator === 'string' ? `${instancePath}/type` : instancePath,
          schemaPath: `${schemaPath}/oneOf`,
          message:
            matches.length === 0
              ? typeof discriminator === 'string'
                ? `uses unsupported variant ${JSON.stringify(discriminator)}`
                : 'must match exactly one variant'
              : 'matches more than one variant',
        },
      ];
    }
  }

  if (Array.isArray(schema.allOf)) {
    const issues = schema.allOf.flatMap((candidate, index) =>
      validateNode(
        value,
        candidate as JsonSchema,
        root,
        instancePath,
        `${schemaPath}/allOf/${index}`,
      ),
    );
    if (issues.length > 0) return issues;
  }

  if ('const' in schema && !equalJson(value, schema.const)) {
    return [
      {
        instancePath,
        schemaPath: `${schemaPath}/const`,
        message: `must equal ${JSON.stringify(schema.const)}`,
      },
    ];
  }
  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((item) => equalJson(value, item))
  ) {
    return [
      {
        instancePath,
        schemaPath: `${schemaPath}/enum`,
        message: `must be one of ${schema.enum.map((item) => JSON.stringify(item)).join(', ')}`,
      },
    ];
  }

  const expectedTypes =
    typeof schema.type === 'string'
      ? [schema.type]
      : Array.isArray(schema.type) &&
          schema.type.every((item) => typeof item === 'string')
        ? schema.type
        : undefined;
  if (
    expectedTypes !== undefined &&
    !expectedTypes.some((expected) => matchesType(value, expected))
  ) {
    return [
      {
        instancePath,
        schemaPath: `${schemaPath}/type`,
        message: `must have type ${expectedTypes.join(' or ')}, received ${valueType(value)}`,
      },
    ];
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      issues.push({
        instancePath,
        schemaPath: `${schemaPath}/minLength`,
        message: `must contain at least ${schema.minLength} characters`,
      });
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      issues.push({
        instancePath,
        schemaPath: `${schemaPath}/maxLength`,
        message: `must contain at most ${schema.maxLength} characters`,
      });
    }
    if (
      typeof schema.pattern === 'string' &&
      !new RegExp(schema.pattern, 'u').test(value)
    ) {
      issues.push({
        instancePath,
        schemaPath: `${schemaPath}/pattern`,
        message: `must match ${schema.pattern}`,
      });
    }
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      issues.push({
        instancePath,
        schemaPath: `${schemaPath}/minimum`,
        message: `must be at least ${schema.minimum}`,
      });
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      issues.push({
        instancePath,
        schemaPath: `${schemaPath}/maximum`,
        message: `must be at most ${schema.maximum}`,
      });
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      issues.push({
        instancePath,
        schemaPath: `${schemaPath}/minItems`,
        message: `must contain at least ${schema.minItems} items`,
      });
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      issues.push({
        instancePath,
        schemaPath: `${schemaPath}/maxItems`,
        message: `must contain at most ${schema.maxItems} items`,
      });
    }
    if (schema.uniqueItems === true) {
      const duplicate = value.some((item, index) =>
        value.slice(0, index).some((prior) => equalJson(prior, item)),
      );
      if (duplicate) {
        issues.push({
          instancePath,
          schemaPath: `${schemaPath}/uniqueItems`,
          message: 'must contain unique items',
        });
      }
    }
    const prefixLength = Array.isArray(schema.prefixItems)
      ? schema.prefixItems.length
      : 0;
    if (Array.isArray(schema.prefixItems)) {
      for (let index = 0; index < Math.min(value.length, prefixLength); index += 1) {
        issues.push(
          ...validateNode(
            value[index],
            schema.prefixItems[index] as JsonSchema,
            root,
            `${instancePath}/${index}`,
            `${schemaPath}/prefixItems/${index}`,
          ),
        );
      }
    }
    if (
      typeof schema.items === 'boolean' ||
      (typeof schema.items === 'object' && schema.items !== null)
    ) {
      if (schema.items === false && value.length > prefixLength) {
        issues.push({
          instancePath,
          schemaPath: `${schemaPath}/items`,
          message: `must contain at most ${prefixLength} items`,
        });
      } else if (schema.items !== false && schema.items !== true) {
        for (let index = prefixLength; index < value.length; index += 1) {
          issues.push(
            ...validateNode(
              value[index],
              schema.items as JsonSchema,
              root,
              `${instancePath}/${index}`,
              `${schemaPath}/items`,
            ),
          );
        }
      }
    }
  }

  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (Array.isArray(schema.required)) {
      for (const required of schema.required) {
        if (typeof required !== 'string') {
          throw new Error(`The schema has a non-string required key at ${schemaPath}.`);
        }
        if (!Object.hasOwn(record, required)) {
          issues.push({
            instancePath,
            schemaPath: `${schemaPath}/required`,
            message: `must define ${required}`,
          });
        }
      }
    }
    const properties =
      schema.properties === undefined
        ? {}
        : schemaRecord(schema.properties as JsonSchema, `${schemaPath}/properties`);
    for (const [key, propertyValue] of Object.entries(record)) {
      if (Object.hasOwn(properties, key)) {
        const propertySchema = properties[key];
        issues.push(
          ...validateNode(
            propertyValue,
            propertySchema as JsonSchema,
            root,
            `${instancePath}/${pointerSegment(key)}`,
            `${schemaPath}/properties/${pointerSegment(key)}`,
          ),
        );
      } else if (schema.additionalProperties === false) {
        issues.push({
          instancePath: `${instancePath}/${pointerSegment(key)}`,
          schemaPath: `${schemaPath}/additionalProperties`,
          message: 'is not an allowed property',
        });
      } else if (
        typeof schema.additionalProperties === 'object' &&
        schema.additionalProperties !== null
      ) {
        issues.push(
          ...validateNode(
            propertyValue,
            schema.additionalProperties as JsonSchema,
            root,
            `${instancePath}/${pointerSegment(key)}`,
            `${schemaPath}/additionalProperties`,
          ),
        );
      }
    }
  }

  return issues;
}

const supportedKeywords = new Set([
  '$schema',
  '$id',
  '$ref',
  '$defs',
  'title',
  'description',
  'type',
  'const',
  'enum',
  'oneOf',
  'allOf',
  'required',
  'properties',
  'additionalProperties',
  'items',
  'prefixItems',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minLength',
  'maxLength',
  'pattern',
  'minimum',
  'maximum',
]);

function assertSupportedSchema(
  schema: JsonSchema,
  root: JsonSchema,
  schemaPath = '#',
): void {
  if (typeof schema === 'boolean') return;
  for (const key of Object.keys(schema)) {
    if (!supportedKeywords.has(key)) {
      throw new Error(`Unsupported JSON Schema keyword ${key} at ${schemaPath}.`);
    }
  }
  if (typeof schema.$ref === 'string') resolveReference(root, schema.$ref);
  for (const keyword of ['$defs', 'properties'] as const) {
    if (schema[keyword] === undefined) continue;
    const entries = schemaRecord(
      schema[keyword] as JsonSchema,
      `${schemaPath}/${keyword}`,
    );
    for (const [key, child] of Object.entries(entries)) {
      assertSupportedSchema(
        child as JsonSchema,
        root,
        `${schemaPath}/${keyword}/${pointerSegment(key)}`,
      );
    }
  }
  for (const keyword of ['oneOf', 'allOf', 'prefixItems'] as const) {
    if (schema[keyword] === undefined) continue;
    if (!Array.isArray(schema[keyword])) {
      throw new Error(`JSON Schema ${keyword} must be an array at ${schemaPath}.`);
    }
    schema[keyword].forEach((child, index) =>
      assertSupportedSchema(
        child as JsonSchema,
        root,
        `${schemaPath}/${keyword}/${index}`,
      ),
    );
  }
  for (const keyword of ['items', 'additionalProperties'] as const) {
    const child = schema[keyword];
    if (child === undefined) continue;
    if (typeof child !== 'boolean' && (typeof child !== 'object' || child === null)) {
      throw new Error(`JSON Schema ${keyword} must be a schema at ${schemaPath}.`);
    }
    assertSupportedSchema(child as JsonSchema, root, `${schemaPath}/${keyword}`);
  }
  if (typeof schema.pattern === 'string') new RegExp(schema.pattern, 'u');
}

export function validateAgainstSchema(
  value: unknown,
  schema: JsonSchema,
): SchemaIssue[] {
  assertSupportedSchema(schema, schema);
  return validateNode(value, schema, schema, '', '#');
}
