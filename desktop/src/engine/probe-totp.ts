import { generateTotp } from "./totp.ts";
const secrets = [
  "WB4BHRMWLT6XIGAAFV2P4IQCVKDWVHTW",
  "JBSWY3DPEHPK3PXP",
  "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
  "abcdefghijklmnop",
  "MZXW6YTBOI======",
  "   wb4bhrmwlt6xigaafv2p4iqcvkdwvhtw   ",
];
// 统一用 Unix 秒作为 key（generateTotp 收毫秒，故乘以 1000）
const seconds = [0, 1000000000, 1700000000, 1790139600];
const out: Record<string, string> = {};
for (const s of secrets) {
  for (const sec of seconds) {
    try {
      out[`${s.trim()}|${sec}`] = generateTotp(s, sec * 1000);
    } catch (e) {
      out[`${s.trim()}|${sec}`] = `ERROR:${e instanceof Error ? e.message : e}`;
    }
  }
}
process.stdout.write(JSON.stringify(out));