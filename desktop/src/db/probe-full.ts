import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { openDb, resolveDbPath } from "./connection.ts";
import { AccountIoRepository } from "./account-io-repository.ts";
import { RecoveryEmailRepository } from "./recovery-email-repository.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..", "..");
const db = openDb(resolveDbPath(root), { readonly: true });

const io = new AccountIoRepository(db);
const re = new RecoveryEmailRepository(db);

const out = {
  comprehensive: io.getComprehensiveAccountData(),
  pool: re.getPool(),
  bindings: re.getAllBindings(),
};
db.close();
fs.writeFileSync(process.argv[2] as string, JSON.stringify(out), "utf8");
console.log(`comprehensive=${out.comprehensive.length} pool=${out.pool.length} bindings=${Object.keys(out.bindings).length}`);