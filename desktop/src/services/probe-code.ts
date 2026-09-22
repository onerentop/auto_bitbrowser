import fs from "node:fs";
import { extractCodeFromEmail } from "./email-code-reader.ts";
const lines = fs.readFileSync(process.argv[2] as string, "utf8").split("\n");
process.stdout.write(JSON.stringify(lines.map((l) => extractCodeFromEmail(l))));