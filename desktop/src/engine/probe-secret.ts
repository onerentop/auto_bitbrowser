import { parseSecret, isValidBase32 } from "./operations/modify-auth.ts";
const cases = [
  "ABCD EFGH IJKL MNOP",
  "ABCDEFGHIJKLMNOP",
  "Setup key: JBSWY3DPEHPK3PXP",
  "Secret key: WB4BHRMWLT6XIGAAFV2P4IQCVKDWVHTW",
  "密钥: GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
  "  mzxw6ytboi   234567  ",
  "too short AB",
  "invalid chars !!!@#$%^&*()1234",
  "MZXW6YTBOI234567MZXW6YTBOI234567MZXW6YTBOI",
  "your code is 123456 and key is JBSWY3DPEHPK3PXP",
  "",
  "no key here at all",
];
const out: Record<string, unknown> = {};
for (const c of cases) {
  out[c] = { parsed: parseSecret(c), valid_16: isValidBase32("JBSWY3DPEHPK3PXP"), valid_15: isValidBase32("JBSWY3DPEHPK3PX"), valid_33: isValidBase32("JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP") };
}
process.stdout.write(JSON.stringify(out));