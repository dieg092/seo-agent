// scripts/seo-scope-check.ts
// Job seo-pr de wedding-invite-2: ¿cabe el diff del PR en el alcance de su operación?
//   git diff --numstat BASE...HEAD | tsx scripts/seo-scope-check.ts <operation>
// Sin base de datos ni secretos. Sale con 1 si algo queda fuera.
import { readFileSync } from "node:fs";
import { checkScope, parseNumstat } from "../src/bridge/scopeCheck";

const operation = process.argv[2] ?? "";
const r = checkScope(operation, parseNumstat(readFileSync(0, "utf8")));
if (r.ok) console.log(`alcance OK (${operation})`);
else for (const e of r.errors) console.error(`::error::${e}`);
process.exit(r.ok ? 0 : 1);
