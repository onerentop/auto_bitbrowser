/**
 * TOTP 生成（RFC 6238）
 *
 * 为什么不用 otplib：13.x 的导出结构与 12.x 完全不同（TOTP 类与 functional API 并存），
 * 该库已有跨版本破坏的先例。TOTP 是标准算法，自己实现约 40 行即可，
 * 且不受依赖升级影响。
 *
 * 默认参数采用通行约定：30 秒周期、6 位、HMAC-SHA1。
 */
import { createHmac } from "node:crypto";

const PERIOD_SECONDS = 30;
const DIGITS = 6;
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * Base32 解码。
 * base32 解码：转大写、补齐 padding、非法字符抛错。
 * 注意不能用 Buffer.from(s, "base64")——base32 与 base64 是不同编码。
 */
export function base32Decode(input: string): Buffer {
  const cleaned = input.toUpperCase().replace(/=+$/, "");
  const out: number[] = [];
  let buffer = 0;
  let bitsLeft = 0;

  for (const ch of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) {
      throw new Error(`非法的 base32 字符: ${ch}`);
    }
    buffer = (buffer << 5) | idx;
    bitsLeft += 5;
    if (bitsLeft >= 8) {
      bitsLeft -= 8;
      out.push((buffer >>> bitsLeft) & 0xff);
    }
  }

  return Buffer.from(out);
}

/**
 * 生成指定时间点的 TOTP 码。
 *
 * 有意偏差（真机测试发现）：Google 设置页显示的密钥是「每 4 位一组、用空格分隔」的小写形式，
 * 用户照抄进账号数据后，直接解码会因空白字符而抛错，导致登录直接失败。
 * 这里先去掉所有空白字符再解码，其余行为（大小写不敏感、补齐 padding、非法字符抛错）不变。
 */
export function generateTotp(secret: string, atMs: number = Date.now()): string {
  secret = secret.replace(/\s+/g, "");
  const counter = Math.floor(atMs / 1000 / PERIOD_SECONDS);

  // 计数器转 8 字节大端（超过 2^32 的时间点也要正确）
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x1_0000_0000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);

  const hmac = createHmac("sha1", base32Decode(secret)).update(buf).digest();

  // 动态截断（RFC 4226 §5.3）
  const offset = (hmac[hmac.length - 1] as number) & 0x0f;
  const code =
    (((hmac[offset] as number) & 0x7f) << 24) |
    (((hmac[offset + 1] as number) & 0xff) << 16) |
    (((hmac[offset + 2] as number) & 0xff) << 8) |
    ((hmac[offset + 3] as number) & 0xff);

  return String(code % 10 ** DIGITS).padStart(DIGITS, "0");
}