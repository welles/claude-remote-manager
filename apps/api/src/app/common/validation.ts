import { BadRequestException } from '@nestjs/common';

/**
 * Small validators for request bodies and WebSocket frames. They throw
 * BadRequestException (400) with a message naming the field, so malformed
 * input never reaches the services as a TypeError.
 */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export function requireObject(
  value: unknown,
  name = 'body',
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BadRequestException(`${name} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

export function requireString(
  object: Record<string, unknown>,
  field: string,
  options: { maxLength?: number; notBlank?: boolean } = {},
): string {
  const value = object[field];
  if (typeof value !== 'string') {
    throw new BadRequestException(`${field} must be a string`);
  }
  return checkString(value, field, options);
}

export function optionalString(
  object: Record<string, unknown>,
  field: string,
  options: { maxLength?: number } = {},
): string | undefined {
  const value = object[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new BadRequestException(`${field} must be a string`);
  }
  return checkString(value, field, options);
}

export function requireUuid(
  object: Record<string, unknown>,
  field: string,
): string {
  const value = object[field];
  if (!isUuid(value)) {
    throw new BadRequestException(`${field} must be a UUID`);
  }
  return value;
}

export function optionalUuid(
  object: Record<string, unknown>,
  field: string,
): string | undefined {
  return object[field] === undefined || object[field] === null
    ? undefined
    : requireUuid(object, field);
}

export function optionalEnum<T extends string>(
  object: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
): T | undefined {
  const value = object[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new BadRequestException(
      `${field} must be one of ${allowed.join(', ')}`,
    );
  }
  return value as T;
}

export function optionalInteger(
  object: Record<string, unknown>,
  field: string,
  min = 0,
): number | undefined {
  const value = object[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    throw new BadRequestException(`${field} must be an integer >= ${min}`);
  }
  return value;
}

function checkString(
  value: string,
  field: string,
  { maxLength, notBlank }: { maxLength?: number; notBlank?: boolean },
): string {
  if (notBlank && !value.trim()) {
    throw new BadRequestException(`${field} must not be empty`);
  }
  if (maxLength !== undefined && value.length > maxLength) {
    throw new BadRequestException(
      `${field} is longer than ${maxLength} characters`,
    );
  }
  return value;
}
