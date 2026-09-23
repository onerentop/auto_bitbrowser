/**
 * 设置页 handler 的参数校验工具
 *
 * 参数来自渲染层，一律视为不可信：类型不对 / 超长 / 越界都抛 INVALID_ARGUMENT。
 */
import { CodedError, ERROR_CODES } from "../../../shared/envelope.ts";

/** 普通字段的最大长度（邮箱、密码、URL、密钥等） */
export const MAX_FIELD_LENGTH = 4096;
/** 批量导入文本的最大长度 */
export const MAX_IMPORT_TEXT_LENGTH = 5 * 1024 * 1024;
/** 批量操作的最大条数 */
export const MAX_BATCH_ITEMS = 100_000;

export function invalid(message: string): never {
  throw new CodedError(ERROR_CODES.INVALID_ARGUMENT, message);
}

export function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(`${name} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

export function asString(value: unknown, name: string, maxLength = MAX_FIELD_LENGTH): string {
  if (typeof value !== "string") invalid(`${name} 必须是字符串`);
  if (value.length > maxLength) invalid(`${name} 过长（上限 ${maxLength} 字符）`);
  return value;
}

export function field(obj: Record<string, unknown>, key: string, name = key, maxLength = MAX_FIELD_LENGTH): string {
  return asString(obj[key], name, maxLength);
}

export function asInt(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) invalid(`${name} 必须是整数`);
  if (value < min || value > max) invalid(`${name} 必须在 ${min}-${max} 之间`);
  return value;
}

export function asOneOf<T extends string>(value: unknown, name: string, options: readonly T[]): T {
  if (typeof value !== "string" || !(options as readonly string[]).includes(value)) {
    invalid(`${name} 必须是 ${options.join(" / ")} 之一`);
  }
  return value as T;
}

export function asArray(value: unknown, name: string, maxItems = MAX_BATCH_ITEMS): unknown[] {
  if (!Array.isArray(value)) invalid(`${name} 必须是数组`);
  if (value.length > maxItems) invalid(`${name} 条数过多（上限 ${maxItems}）`);
  return value;
}
