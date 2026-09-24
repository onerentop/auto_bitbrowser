/**
 * 生成强随机密码（F1「修改密码」用）
 *
 * 自己写而不是引库：只是「字符集 + crypto 随机」几行的事，少一个依赖少一份升级风险。
 * 形态要求（用户确认）：长度 ≥ 16、含大写 / 小写 / 数字 / 符号。
 *
 * 两个细节：
 *   1. 先按类别各取一个字符（保证四类都出现），再用同一字符集补足长度，最后洗牌 ——
 *      直接拼接会退化成「前四位永远是类别顺序」，降低不可预测性。
 *   2. 字符集刻意去掉易混淆字符（I O l 0 1）与可能被站点拒绝的符号（空格、引号、反斜杠）——
 *      这个密码要人工抄进别的工具，也会经过 HTTP 表单，少一类麻烦。
 */
import { randomInt } from "node:crypto";

/** 默认长度：≥ 16 且留余量 */
export const PASSWORD_LENGTH = 20;
/** 允许的最短长度（四类各一个的最小长度是 4，但业务上不要比 16 短） */
export const PASSWORD_MIN_LENGTH = 16;

/** 去掉 I / O（易与 1 / 0 混淆） */
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
/** 去掉 l（易与 1 混淆） */
const LOWER = "abcdefghijkmnopqrstuvwxyz";
/** 去掉 0 / 1 */
const DIGITS = "23456789";
/** 只保留常见站点都接受的符号 */
const SYMBOLS = "!@#$%^&*-_=+";
const ALL = UPPER + LOWER + DIGITS + SYMBOLS;

/** 注入用：返回 [0, max) 的整数（默认 crypto.randomInt，测试可替换成可控序列） */
export type RandomInt = (max: number) => number;

function pick(chars: string, random: RandomInt): string {
  return chars[random(chars.length)] as string;
}

/** 生成一个强随机密码；length 至少 16，否则抛错（避免调用方传错却悄悄生成弱密码） */
export function generateStrongPassword(length: number = PASSWORD_LENGTH, random: RandomInt = randomInt): string {
  if (!Number.isInteger(length) || length < PASSWORD_MIN_LENGTH) {
    throw new Error(`密码长度至少 ${PASSWORD_MIN_LENGTH} 位，收到: ${String(length)}`);
  }

  // 四类各一个，保证类别齐全
  const chars = [pick(UPPER, random), pick(LOWER, random), pick(DIGITS, random), pick(SYMBOLS, random)];
  while (chars.length < length) chars.push(pick(ALL, random));

  // Fisher–Yates 洗牌（不引入额外随机源，避免打乱可注入性）
  for (let i = chars.length - 1; i > 0; i--) {
    const j = random(i + 1);
    [chars[i], chars[j]] = [chars[j] as string, chars[i] as string];
  }
  return chars.join("");
}
