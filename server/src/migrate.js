// migrate.js — apply migrations/*.sql in filename order, tracked in a
// schema_migrations table so each runs exactly once. Run via `npm run migrate`
// (also invoked automatically on server boot).
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pool } from "./db.js";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "migrations");

export async function runMigrations() {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const applied = new Set((await pool.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      await client.query("COMMIT");
      console.log(`[migrate] applied ${file}`);
    } catch (e) {
      await client.query("ROLLBACK");
      throw new Error(`Migration ${file} failed: ${e.message}`);
    } finally {
      client.release();
    }
  }
}

// Allow running standalone: `node src/migrate.js`
if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations().then(() => { console.log("[migrate] done"); process.exit(0); })
    .catch((e) => { console.error(e); process.exit(1); });
}
