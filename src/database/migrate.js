// src/database/migrate.js
// The migration runner. `npm run db:setup` applies schema.sql, then every file
// in src/database/migrations/ in numeric order, and records what it applied in
// an applied_migrations table so a second run is a no-op.
//
// Why a direct Postgres connection instead of the Supabase client: the
// supabase-js client speaks PostgREST, which cannot execute DDL at all. There
// was previously no runner — `npm run db:setup` pointed at a file that did not
// exist, migrations lived in two unordered directories, and nothing recorded
// what had been applied. The live schema was therefore only ever in one place:
// somebody's memory of what they typed into the Supabase SQL editor.
//
// Set DATABASE_URL to the project's Postgres connection string
// (Supabase → Project Settings → Database → Connection string → URI).
// Without it this script prints the SQL to run by hand and exits non-zero,
// rather than silently reporting success like the old script did.
require('dotenv').config();

const fs = require('fs');
const path = require('path');

const SCHEMA_FILE = path.join(__dirname, 'schema', 'schema.sql');
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

/** Migration files in deterministic numeric order (001_, 002_, …). */
function migrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort((a, b) => {
      const na = parseInt(a, 10);
      const nb = parseInt(b, 10);
      // Numeric prefix decides order; anything unnumbered sorts last by name so
      // a stray file can never silently jump ahead of a numbered migration.
      if (Number.isNaN(na) && Number.isNaN(nb)) return a.localeCompare(b);
      if (Number.isNaN(na)) return 1;
      if (Number.isNaN(nb)) return -1;
      return na - nb;
    });
}

/** Everything that will be applied, schema first. */
function plan() {
  const items = [];
  if (fs.existsSync(SCHEMA_FILE)) {
    items.push({ name: '000_schema.sql', file: SCHEMA_FILE });
  }
  for (const f of migrationFiles()) {
    items.push({ name: f, file: path.join(MIGRATIONS_DIR, f) });
  }
  return items;
}

function printManualInstructions(items) {
  console.log('\nDATABASE_URL is not set, so nothing was applied.\n');
  console.log('Either set it and re-run:');
  console.log('  Supabase → Project Settings → Database → Connection string → URI');
  console.log('  DATABASE_URL=postgresql://postgres:PASSWORD@db.PROJECT.supabase.co:5432/postgres\n');
  console.log('…or paste these files into the Supabase SQL Editor, in this order:');
  for (const item of items) {
    console.log(`  ${item.name.padEnd(32)} ${path.relative(process.cwd(), item.file)}`);
  }
  console.log('\nEvery statement is idempotent, so re-running any of them is safe.');
}

async function migrate() {
  const items = plan();
  if (items.length === 0) {
    console.error('No schema or migration files found — nothing to do.');
    process.exit(1);
  }

  const url = process.env.DATABASE_URL;
  if (!url) {
    printManualInstructions(items);
    process.exit(1);
  }

  const { Client } = require('pg');
  const client = new Client({
    connectionString: url,
    // Supabase terminates TLS with a cert this client has no CA for; the
    // connection is still encrypted, it just is not chain-verified.
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  console.log(`Connected. ${items.length} file(s) to consider.\n`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS applied_migrations (
      name        TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const { rows } = await client.query('SELECT name FROM applied_migrations');
  const already = new Set(rows.map(r => r.name));

  let applied = 0;
  let skipped = 0;

  for (const item of items) {
    if (already.has(item.name)) {
      console.log(`  skip    ${item.name} (already applied)`);
      skipped++;
      continue;
    }

    const sql = fs.readFileSync(item.file, 'utf8');

    // One transaction per file: a migration that fails halfway leaves the
    // database exactly as it was, and is not recorded as applied. The old
    // script split on ';' and fired statements independently, which breaks any
    // DO $$ … $$ block and can leave a file half-applied.
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO applied_migrations (name) VALUES ($1)', [item.name]);
      await client.query('COMMIT');
      console.log(`  applied ${item.name}`);
      applied++;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(`\n  FAILED  ${item.name}`);
      console.error(`  ${err.message}\n`);
      await client.end();
      process.exit(1);
    }
  }

  await client.end();
  console.log(`\nDone: ${applied} applied, ${skipped} already present.`);
}

migrate().catch(err => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
