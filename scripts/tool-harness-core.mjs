import { isDeepStrictEqual } from 'node:util';

export function structuralArgsEqual(actual, expected) {
  return isDeepStrictEqual(actual, expected);
}

export function parseToolArguments(raw) {
  try {
    return { valid: true, value: JSON.parse(raw || '{}'), error: '' };
  } catch (error) {
    return {
      valid: false,
      value: undefined,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function buildResultError({
  nameOk,
  schemaOk,
  argsOk,
  strictArgs,
  emittedName,
  schemaErrors,
}) {
  if (!nameOk) return `Wrong tool name: ${emittedName}`;
  if (!schemaOk) return `Arguments violate schema: ${schemaErrors.join('; ')}`;
  if (strictArgs && !argsOk) return 'Arguments differ from requested JSON';
  return '';
}

export function parseSseToolResult(raw) {
  const toolCalls = new Map();
  let content = '';
  let reasoning = '';
  let finishReason = null;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      continue;
    }
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta || {};
    if (typeof delta.content === 'string') content += delta.content;
    if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
    if (typeof delta.reasoning === 'string') reasoning += delta.reasoning;
    for (const part of delta.tool_calls || []) {
      const index = part.index ?? 0;
      const acc = toolCalls.get(index) || {
        id: '',
        type: 'function',
        function: { name: '', arguments: '' },
      };
      if (part.id) acc.id = part.id;
      if (part.type) acc.type = part.type;
      if (part.function?.name) acc.function.name += part.function.name;
      if (part.function?.arguments) acc.function.arguments += part.function.arguments;
      toolCalls.set(index, acc);
    }
  }
  return {
    toolCalls: [...toolCalls.entries()].sort(([a], [b]) => a - b).map(([, value]) => value),
    content,
    reasoning,
    finishReason,
  };
}

export function stripSource(definition) {
  return { type: definition.type, function: definition.function };
}

export function synthesizeArgs(parameters) {
  const properties = parameters?.properties || {};
  const required = Array.isArray(parameters?.required)
    ? parameters.required
    : Object.keys(properties);
  const args = {};
  for (const key of required) args[key] = synthesizeValue(properties[key], key);
  return args;
}

function synthesizeValue(schema, key) {
  const alternatives = schema?.anyOf ?? schema?.oneOf;
  if (Array.isArray(alternatives) && alternatives.length) {
    const preferred =
      alternatives.find((candidate) => candidate?.type !== 'null') ?? alternatives[0];
    return synthesizeValue(preferred, key);
  }
  if (schema?.enum?.length) return schema.enum[0];
  const type = Array.isArray(schema?.type)
    ? (schema.type.find((candidate) => candidate !== 'null') ?? schema.type[0])
    : schema?.type;
  if (type === 'integer' || type === 'number') return schema.minimum ?? 1;
  if (type === 'boolean') return false;
  if (type === 'array') return [synthesizeValue(schema.items, key)];
  if (type === 'object') return synthesizeArgs(schema);
  if (key.includes('url')) return 'https://example.com/';
  if (key.includes('path') || key.includes('file')) return 'package.json';
  if (key.includes('query')) return 'Forge tool-call test';
  if (key.includes('command')) return 'node';
  return `test_${key}`;
}

export function validateAgainstSchema(value, schema, pathName = 'arguments') {
  const errors = [];
  validateValue(value, schema, pathName, errors);
  return errors;
}

function validateValue(value, schema, pathName, errors) {
  if (!schema || typeof schema !== 'object') return;
  const alternatives = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(alternatives) && alternatives.length) {
    const valid = alternatives.some((candidate) => {
      const branchErrors = [];
      validateValue(value, candidate, pathName, branchErrors);
      return branchErrors.length === 0;
    });
    if (!valid) errors.push(`${pathName} does not match any allowed schema`);
    return;
  }
  if (Array.isArray(schema.allOf)) {
    for (const candidate of schema.allOf) validateValue(value, candidate, pathName, errors);
  }
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  const type = types.find((candidate) => candidate !== 'null') ?? types[0];
  if (value === null && types.includes('null')) return;
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${pathName} must be one of ${JSON.stringify(schema.enum)}`);
    return;
  }
  if (type === 'object') {
    if (!isPlainObject(value)) {
      errors.push(`${pathName} must be object`);
      return;
    }
    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    for (const key of schema.required || []) {
      if (!(key in value)) errors.push(`${pathName}.${key} is required`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) errors.push(`${pathName}.${key} is not allowed`);
      }
    }
    for (const [key, childSchema] of Object.entries(properties)) {
      if (key in value) validateValue(value[key], childSchema, `${pathName}.${key}`, errors);
    }
    return;
  }
  if (type === 'array') {
    if (!Array.isArray(value)) {
      errors.push(`${pathName} must be array`);
      return;
    }
    value.forEach((entry, index) =>
      validateValue(entry, schema.items, `${pathName}[${index}]`, errors),
    );
    return;
  }
  if (type === 'integer') {
    if (!Number.isInteger(value)) errors.push(`${pathName} must be integer`);
    return;
  }
  if (type === 'number') {
    if (typeof value !== 'number') errors.push(`${pathName} must be number`);
    return;
  }
  if (type === 'boolean') {
    if (typeof value !== 'boolean') errors.push(`${pathName} must be boolean`);
    return;
  }
  if (type === 'string' && typeof value !== 'string') errors.push(`${pathName} must be string`);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
