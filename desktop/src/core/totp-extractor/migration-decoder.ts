/**
 * Google Authenticator Migration Payload 解码器
 *
 * 逐字移植 core/totp_extractor/migration_decoder.py:21-275：
 * 手写 varint / length-delimited 解析、字段编号、枚举映射、Base32 编码 secret、
 * 错误处理与返回结构（字段名保留 Python 的 snake_case：otp_type）。
 *
 * 注意保留的 Python 行为（均有对拍夹具覆盖）：
 *   - varint 被截断时不报错，按已读到的部分返回（:76 的 while 以 offset < len 结束）
 *   - length-delimited 长度越界时按切片截断（:94）
 *   - wire type 3/4（group）及 6/7 不前进 offset，下一轮把后续字节当作 tag 继续读
 *   - data 参数先经 parse_qs（'+' 变空格）再 unquote 一次，未编码的 '+' 会被 b64decode 丢弃
 */
import { b32EncodeNoPad, decodeUtf8Replace, pyB64Decode, pyParseQs, pyUnquote, pyUrlSplit } from "./py-compat.ts";

/** OTP 账号信息（migration_decoder.py:21-30） */
export interface OTPAccount {
  /** Base32 编码的密钥 */
  secret: string;
  /** 账号名称（通常是邮箱） */
  name: string;
  /** 发行方（如 Google） */
  issuer: string;
  /** 算法（SHA1, SHA256, SHA512） */
  algorithm: string;
  /** 验证码位数（通常是 6） */
  digits: number;
  /** 类型（totp, hotp） */
  otp_type: string;
  /** HOTP 计数器（仅 HOTP 使用） */
  counter: number;
}

/**
 * 从账号名称中提取邮箱地址（OTPAccount.get_email，:32-57）
 *   - "user@gmail.com" / "Google:user@gmail.com" / "user@gmail.com (Google)"
 * 不像邮箱时返回 null。
 */
export function getOtpEmail(account: Pick<OTPAccount, "name">): string | null {
  let name = account.name;
  // 处理 "Issuer:email" 格式
  if (name.includes(":")) {
    const idx = name.indexOf(":");
    name = name.slice(idx + 1).trim();
  }
  // 处理 "email (Issuer)" 格式
  if (name.includes("(")) {
    name = (name.split("(")[0] ?? "").trim();
  }
  // 验证是否像邮箱
  if (name.includes("@") && name.includes(".")) return name.toLowerCase();
  return null;
}

// Protobuf Wire Types（:60-64）
export const WIRE_TYPE_VARINT = 0;
export const WIRE_TYPE_64BIT = 1;
export const WIRE_TYPE_LENGTH_DELIMITED = 2;
export const WIRE_TYPE_32BIT = 5;

/**
 * 读取 Protobuf varint（:67-83），返回 [value, newOffset]。
 * Python 是任意精度整数；这里用乘法累加，2^53 以内精确（计数器 / 枚举 / 长度都远小于此）。
 */
export function readVarint(data: Uint8Array, offset: number): [number, number] {
  let result = 0;
  let shift = 0;
  while (offset < data.length) {
    const byte = data[offset] as number;
    offset += 1;
    result += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return [result, offset];
}

/** 读取 length-delimited 字段（:86-95），返回 [content, newOffset]；越界时 content 被截断 */
export function readLengthDelimited(data: Uint8Array, offset: number): [Uint8Array, number] {
  const [length, next] = readVarint(data, offset);
  const content = data.subarray(next, next + length);
  return [content, next + length];
}

const ALGORITHM_MAP: Readonly<Record<number, string>> = {
  0: "UNSPECIFIED",
  1: "SHA1",
  2: "SHA256",
  3: "SHA512",
  4: "MD5",
};

const DIGITS_MAP: Readonly<Record<number, number>> = {
  0: 6, // UNSPECIFIED defaults to 6
  1: 6,
  2: 8,
};

const TYPE_MAP: Readonly<Record<number, string>> = {
  0: "unspecified",
  1: "hotp",
  2: "totp",
};

/**
 * 解析单个 OTP 参数（_parse_otp_parameters，:98-185）
 * field 1 secret / 2 name / 3 issuer / 4 algorithm / 5 digits / 6 type / 7 counter
 */
export function parseOtpParameters(data: Uint8Array): OTPAccount {
  let secretRaw: Uint8Array = new Uint8Array(0);
  let name = "";
  let issuer = "";
  let algorithm = 1; // SHA1
  let digits = 1; // 6 digits
  let otpType = 2; // TOTP
  let counter = 0;

  let offset = 0;
  while (offset < data.length) {
    let tag: number;
    [tag, offset] = readVarint(data, offset);
    const fieldNumber = Math.floor(tag / 8);
    const wireType = tag % 8;

    if (wireType === WIRE_TYPE_VARINT) {
      let value: number;
      [value, offset] = readVarint(data, offset);
      if (fieldNumber === 4) algorithm = value;
      else if (fieldNumber === 5) digits = value;
      else if (fieldNumber === 6) otpType = value;
      else if (fieldNumber === 7) counter = value;
    } else if (wireType === WIRE_TYPE_LENGTH_DELIMITED) {
      let content: Uint8Array;
      [content, offset] = readLengthDelimited(data, offset);
      if (fieldNumber === 1) secretRaw = content;
      else if (fieldNumber === 2) name = decodeUtf8Replace(content);
      else if (fieldNumber === 3) issuer = decodeUtf8Replace(content);
    } else if (wireType === WIRE_TYPE_64BIT) {
      offset += 8;
    } else if (wireType === WIRE_TYPE_32BIT) {
      offset += 4;
    }
  }

  return {
    secret: b32EncodeNoPad(secretRaw),
    name,
    issuer,
    algorithm: ALGORITHM_MAP[algorithm] ?? "SHA1",
    digits: DIGITS_MAP[digits] ?? 6,
    otp_type: TYPE_MAP[otpType] ?? "totp",
    counter,
  };
}

/**
 * 解码 Google Authenticator 迁移数据（decode_migration_payload，:188-244）
 * MigrationPayload: field 1 otp_parameters (repeated) / 2 version / 3 batch_size / 4 batch_index / 5 batch_id
 */
export function decodeMigrationPayload(dataBase64: string): OTPAccount[] {
  // 处理 URL 编码
  let s = pyUnquote(dataBase64);

  // 添加 Base64 padding（按含非法字符在内的原始长度计算，与 Python 一致）
  const padding = 4 - (s.length % 4);
  if (padding !== 4) s += "=".repeat(padding);

  let data: Uint8Array;
  try {
    data = pyB64Decode(s);
  } catch (e) {
    throw new Error(`无效的 Base64 数据: ${e instanceof Error ? e.message : String(e)}`);
  }

  const accounts: OTPAccount[] = [];
  let offset = 0;
  while (offset < data.length) {
    let tag: number;
    [tag, offset] = readVarint(data, offset);
    const fieldNumber = Math.floor(tag / 8);
    const wireType = tag % 8;

    if (wireType === WIRE_TYPE_LENGTH_DELIMITED) {
      let content: Uint8Array;
      [content, offset] = readLengthDelimited(data, offset);
      if (fieldNumber === 1) {
        try {
          accounts.push(parseOtpParameters(content));
        } catch (e) {
          // Python: print(f"[Warning] 解析 OTP 参数失败: {e}")
          console.warn(`[Warning] 解析 OTP 参数失败: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } else if (wireType === WIRE_TYPE_VARINT) {
      [, offset] = readVarint(data, offset);
    } else if (wireType === WIRE_TYPE_64BIT) {
      offset += 8;
    } else if (wireType === WIRE_TYPE_32BIT) {
      offset += 4;
    }
  }
  return accounts;
}

/** 解析 otpauth-migration:// URI（parse_otpauth_migration_uri，:247-275）；格式无效抛错 */
export function parseOtpauthMigrationUri(uri: string): OTPAccount[] {
  const parsed = pyUrlSplit(uri);
  if (parsed.scheme !== "otpauth-migration") {
    throw new Error(`无效的 URI scheme: ${parsed.scheme}，期望 otpauth-migration`);
  }
  const params = pyParseQs(parsed.query);
  const data = params.get("data");
  if (!data) throw new Error("URI 中缺少 data 参数");
  return decodeMigrationPayload(data[0] as string);
}
