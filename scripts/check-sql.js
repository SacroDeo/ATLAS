// scripts/check-sql.js
// Offline structural check on the schema + migration SQL: balanced parens,
// balanced quotes, balanced dollar-quoting, no duplicate table definitions, and
// every CREATE guarded so the file is safe to re-run. Not a parser — it cannot
// prove the SQL is valid Postgres — but it catches the class of breakage the old
// migrations actually had (a stray `ADD CONSTRAINT IF NOT EXISTS`, a file that
// only works on an empty database).
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'src', 'database');
const files = [
  path.join(root, 'schema', 'schema.sql'),
  ...fs.readdirSync(path.join(root, 'migrations'))
    .filter(f => f.endsWith('.sql'))
    .sort()
    .map(f => path.join(root, 'migrations', f)),
];

let bad = 0;
const rel = f => path.relative(path.join(__dirname, '..'), f);

for (const f of files) {
  const sql = fs.readFileSync(f, 'utf8');
  const noComments = sql.replace(/--[^\n]*/g, '');
  const dollarCount = (noComments.match(/\$\$/g) || []).length;
  const noDollar = noComments.replace(/\$\$[\s\S]*?\$\$/g, 'BODY');
  const open = (noDollar.match(/\(/g) || []).length;
  const close = (noDollar.match(/\)/g) || []).length;
  const quotes = (noDollar.match(/'/g) || []).length;

  const problems = [];
  if (open !== close) problems.push(`parens ${open}/${close}`);
  if (quotes % 2 !== 0) problems.push(`odd single quotes (${quotes})`);
  if (dollarCount % 2 !== 0) problems.push(`unbalanced $$ (${dollarCount})`);
  // The exact syntax error that made add_webhook_idempotency.sql fail silently.
  if (/ADD CONSTRAINT IF NOT EXISTS/i.test(noComments)) {
    problems.push('ADD CONSTRAINT IF NOT EXISTS is not valid Postgres');
  }
  if (problems.length) bad++;
  console.log(`${problems.length ? 'BAD ' : 'ok  '}${rel(f)}${problems.length ? '  — ' + problems.join('; ') : ''}`);
}

const all = files.map(f => fs.readFileSync(f, 'utf8')).join('\n').replace(/--[^\n]*/g, '');

const tables = [...all.matchAll(/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+(\w+)/gi)].map(m => m[1]);
const dupes = [...new Set(tables.filter((t, i) => tables.indexOf(t) !== i))];
const unguardedTables = [...all.matchAll(/CREATE TABLE\s+(?!IF NOT EXISTS)(\w+)/gi)].map(m => m[1]);
const unguardedIdx = [...all.matchAll(/CREATE INDEX\s+(?!IF NOT EXISTS)(\w+)/gi)].map(m => m[1]);

console.log(`\ntables defined: ${[...new Set(tables)].sort().join(', ')}`);
if (dupes.length) { console.log(`DUPLICATE table definitions: ${dupes.join(', ')}`); bad++; }
if (unguardedTables.length) { console.log(`UNGUARDED CREATE TABLE: ${unguardedTables.join(', ')}`); bad++; }
if (unguardedIdx.length) { console.log(`UNGUARDED CREATE INDEX: ${unguardedIdx.join(', ')}`); bad++; }

// Every table the code reads or writes must exist in the SQL. This is the check
// that would have caught the five hand-made tables.
const srcDir = path.join(__dirname, '..', 'src');
const jsFiles = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js')) jsFiles.push(p);
  }
})(srcDir);

const used = new Set();
for (const p of jsFiles) {
  for (const m of fs.readFileSync(p, 'utf8').matchAll(/\.from\('([a-z_]+)'\)/g)) used.add(m[1]);
}
const defined = new Set(tables.concat(
  [...all.matchAll(/CREATE (?:OR REPLACE )?VIEW\s+(\w+)/gi)].map(m => m[1])
));
// applied_migrations is created by the runner itself, not by a .sql file.
defined.add('applied_migrations');
const missing = [...used].filter(t => !defined.has(t)).sort();
console.log(`\ntables used by src/: ${[...used].sort().join(', ')}`);
if (missing.length) { console.log(`MISSING from SQL: ${missing.join(', ')}`); bad++; }
else console.log('every table used by src/ is defined in SQL ✅');

process.exit(bad ? 1 : 0);
