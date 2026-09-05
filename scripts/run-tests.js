// scripts/run-tests.js
// `npm test`. Runs every offline suite in sequence and fails the run if any
// suite fails. Live suites (real API keys, real Telegram) are excluded by
// default because they cost quota and need credentials; pass --live to include
// them.
//
// There was previously no `npm test` at all, so "do the tests pass" had no
// answer that did not involve remembering five script names.
const { spawnSync } = require('child_process');
const path = require('path');

const OFFLINE = [
  'check-sql.js',
  'test-conversation-context.js',
  'test-conversational-routing.js',
  'test-groq-key-pool.js',
  'test-safe-markdown.js',
  'test-task-numbering.js',
  'test-entitlements.js',
  'test-sanitizer.js',
  'test-date-handling.js',
];

const LIVE = [
  'test-conversation-quality.js',
  'verify-gemini-failover.js',
  'verify-key-rotation-live.js',
];

const fs = require('fs');
const dir = __dirname;
const wantLive = process.argv.includes('--live');
const suites = [...OFFLINE, ...(wantLive ? LIVE : [])]
  .filter(f => fs.existsSync(path.join(dir, f)));

const results = [];
for (const suite of suites) {
  console.log(`\n${'='.repeat(72)}\n${suite}\n${'='.repeat(72)}`);
  const r = spawnSync(process.execPath, [path.join(dir, suite)], { stdio: 'inherit' });
  results.push({ suite, ok: r.status === 0 });
}

console.log(`\n${'='.repeat(72)}`);
for (const r of results) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.suite}`);
const failed = results.filter(r => !r.ok);
console.log(`${'='.repeat(72)}`);
console.log(`${results.length - failed.length}/${results.length} suites passed`);
if (!wantLive) console.log('(live suites skipped — run `npm test -- --live` to include them)');
process.exit(failed.length ? 1 : 0);
