import fs from "node:fs";
import { parseAccountLine, buildAccountLine } from "./data-parser.ts";
const file = process.argv[2] as string;
const lines = fs.readFileSync(file, "utf8").split("\n");
const out = lines.map((l) => {
  const r = parseAccountLine(l);
  return { in: l, ...r, built: buildAccountLine({ email: r.email, password: r.password, recovery: r.recovery, secret: r.secret, link: r.link }) };
});
process.stdout.write(JSON.stringify(out, null, 0));