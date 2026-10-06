import { getDatabase } from "../src/core/database.ts";

const db = getDatabase();

const cols = db.prepare("PRAGMA table_info(account_health)").all();
console.log("account_health columns:", cols.map((c: any) => c.name));

const accounts = db.prepare("SELECT id, email, disabled FROM accounts").all();
console.log("Accounts:", accounts.map((a: any) => ({ id: a.id.slice(0, 8), email: a.email, disabled: a.disabled })));

const sessions = db.prepare("SELECT account_id, token_expires_at FROM qwen_auth_sessions LIMIT 5").all();
console.log("Sessions:", sessions);
