// scripts/verify-key-rotation-live.js
// The multi-key path has only ever been proven with scripted fake clients. This
// runs REAL Groq calls through the real pool and asserts on which key served
// each one — the one thing a unit test cannot check.
//
// Also drains a single key past its 8k TPM bucket on purpose, to prove a 429
// costs a key rather than a user's reply.
//
// Usage: node scripts/verify-key-rotation-live.js
require('dotenv').config();
const provider = require('../src/services/ai/providers/groqProvider');
const config = require('../src/config');

let pass = 0;
const failures = [];
const check = (name, cond, detail = '') => {
  if (cond) pass++; else failures.push(`${name}${detail ? ' — ' + detail : ''}`);
};

// Which key served a call is internal, so watch the cursor instead of guessing.
const served = [];
const origAcquire = provider._acquire.bind(provider);
provider._acquire = function () {
  const entry = origAcquire();
  if (entry) served.push(entry.tag);
  return entry;
};

(async () => {
  console.log(`pool: ${provider.pool.length} keys, model ${config.ai.groq.model}\n`);
  check('pool has more than one key', provider.pool.length > 1, `${provider.pool.length}`);
  if (provider.pool.length < 2) {
    console.log('Need at least 2 keys to verify rotation.');
    process.exit(1);
  }

  // ── 1. Consecutive real calls must land on different keys ─────────────────
  const N = Math.min(6, provider.pool.length);
  for (let i = 0; i < N; i++) {
    const r = await provider.generateCompletion(
      [{ role: 'user', content: `Reply with the single word OK. (${i})` }],
      { maxTokens: 8, temperature: 0 }
    );
    check(`call ${i + 1} returned content`, Boolean(r && r.trim()), JSON.stringify(r));
  }
  console.log(`keys used, in order: ${served.join(' ')}`);
  check('rotation used a distinct key per call',
    new Set(served.slice(0, N)).size === N, served.slice(0, N).join(','));

  // ── 2. Drain one key's TPM bucket and prove the turn still succeeds ────────
  // 8k tokens/minute per key, refilled continuously — so SEQUENTIAL big calls
  // never trip it (measured: ~5k each, and the bucket refills in the gap). The
  // limit only bites under concurrency. Park all but two keys, then fire six
  // ~5k-token calls at once: ~30k tokens against 16k/min of capacity, which
  // Groq must refuse. A real 429 with real reset headers is the only way to
  // prove the header parsing and the fall-through work against the live API.
  console.log('\ndraining a key past its 8k TPM bucket (6 concurrent ~5k-token calls, 2 live keys)…');
  const HOLD = Date.now() + 120000;
  const [keyA, keyB] = provider.pool;
  for (const e of provider.pool.slice(2)) e.cooldownUntil = HOLD;
  provider.cursor = 0;

  const filler = 'network security subnetting packet analysis firewall '.repeat(700);
  const before = served.length;

  const outcomes = await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      provider.generateCompletion(
        [{ role: 'user', content: `Summarize in one word (${i}): ${filler}` }],
        { maxTokens: 16, temperature: 0 }
      ).then(
        (r) => ({ ok: true, r }),
        (e) => ({ ok: false, e })
      )
    )
  );

  const answered = outcomes.filter(o => o.ok).length;
  const keysTried = served.slice(before);
  const parkedByGroq = [keyA, keyB].filter(e => e.cooldownUntil > Date.now());

  console.log(`answered: ${answered}/6`);
  console.log(`keys tried: ${keysTried.join(' ') || '(none)'}`);
  console.log(`parked by a real 429: ${parkedByGroq.length} ` +
    `(${parkedByGroq.map(e => `${e.tag}:${Math.round((e.cooldownUntil - Date.now()) / 1000)}s`).join(' ') || '—'})`);

  check('concurrent load did not hang the pool', outcomes.length === 6);
  check('most concurrent calls still got an answer', answered >= 4, `${answered}/6`);
  if (parkedByGroq.length) {
    check('a real 429 parked the spent key', true);
    check('TPM cooldown is seconds, not the daily bucket',
      parkedByGroq.every(e => e.cooldownUntil - Date.now() < 5 * 60000),
      parkedByGroq.map(e => Math.round((e.cooldownUntil - Date.now()) / 1000) + 's').join(','));
    check('rotation spread the load over both live keys',
      new Set(keysTried).size >= 2, keysTried.join(','));
  } else {
    console.log('(no 429 surfaced even under concurrency — Groq absorbed the burst)');
  }

  // Release the artificially parked keys before the next check.
  for (const e of provider.pool) if (e.cooldownUntil === HOLD) e.cooldownUntil = 0;

  // ── 3. A parked key is skipped, and the pool still serves ─────────────────
  provider.pool[0].cooldownUntil = Date.now() + 30000;
  const mark = served.length;
  const after = await provider.generateCompletion(
    [{ role: 'user', content: 'Reply with the single word OK.' }],
    { maxTokens: 8, temperature: 0 }
  );
  check('served while key #0 is parked', Boolean(after && after.trim()));
  check('parked key was skipped', !served.slice(mark).includes(provider.pool[0].tag),
    served.slice(mark).join(','));
  provider.pool[0].cooldownUntil = 0;

  console.log(`\nRotation (live): ${pass} passed, ${failures.length} failed`);
  if (failures.length) {
    failures.forEach(f => console.log('  ✗ ' + f));
    process.exit(1);
  }
  console.log('✅ Live multi-key rotation verified');
})();
