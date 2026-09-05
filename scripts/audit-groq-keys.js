// scripts/audit-groq-keys.js
// Answers two questions about the configured key pool that only the live API can:
//   1. Does each key authenticate, and can it reach the configured model?
//   2. Do the keys draw on SEPARATE quota buckets, or the same one?
//
// (2) is the one that decides whether the pool is worth anything. Groq meters per
// organization, so keys from one account share a bucket and rotation buys nothing.
// The give-away is in the headers: keys on a shared bucket report near-identical
// x-ratelimit-remaining-tokens, and spending on one visibly drains the others.
//
// Usage: node scripts/audit-groq-keys.js
require('dotenv').config();
const https = require('https');
const config = require('../src/config');

const KEYS = config.ai.groq.apiKeys;
const MODEL = config.ai.groq.model;
const tag = (k, i) => `#${String(i).padStart(2)}…${k.slice(-4)}`;

if (!KEYS.length) {
  console.error('No Groq keys configured.');
  process.exit(1);
}

function request(path, key, body) {
  const payload = body ? JSON.stringify(body) : null;
  return new Promise((resolve) => {
    const req = https.request(
      {
        method: body ? 'POST' : 'GET',
        host: 'api.groq.com',
        path,
        headers: {
          Authorization: `Bearer ${key}`,
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
        timeout: 20000,
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(raw); } catch { /* leave null */ }
          resolve({ status: res.statusCode, headers: res.headers, json, raw });
        });
      }
    );
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', (e) => resolve({ status: 0, headers: {}, json: null, raw: e.message }));
    req.end(payload);
  });
}

const num = (v) => (v === undefined ? null : Number(v));

(async () => {
  console.log(`auditing ${KEYS.length} keys against ${MODEL}\n`);

  const rows = [];
  for (let i = 0; i < KEYS.length; i++) {
    const key = KEYS[i];

    // A minimal chat call: proves the key can reach THIS model (a key can be
    // valid yet lack access), and returns the rate-limit headers we need.
    const r = await request('/openai/v1/chat/completions', key, {
      model: MODEL,
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 1,
      stream: false,
    });

    const h = r.headers;
    const row = {
      tag: tag(key, i),
      status: r.status,
      error: r.status >= 400 ? (r.json?.error?.message || r.raw.slice(0, 90)) : null,
      limitTokens: num(h['x-ratelimit-limit-tokens']),
      remainTokens: num(h['x-ratelimit-remaining-tokens']),
      limitReqs: num(h['x-ratelimit-limit-requests']),
      remainReqs: num(h['x-ratelimit-remaining-requests']),
      org: h['x-groq-organization'] || h['x-organization-id'] || null,
    };
    rows.push(row);

    const state = r.status === 200 ? 'OK  ' : r.status === 401 ? 'AUTH' : r.status === 429 ? 'LIMT' : `${r.status} `;
    console.log(
      `${row.tag}  ${state}  ` +
      `reqs ${row.remainReqs ?? '?'}/${row.limitReqs ?? '?'}  ` +
      `tokens ${row.remainTokens ?? '?'}/${row.limitTokens ?? '?'}` +
      (row.error ? `  → ${row.error}` : '')
    );
  }

  // ── Verdict on capacity ───────────────────────────────────────────────────
  const live = rows.filter(r => r.status === 200 || r.status === 429);
  const dead = rows.filter(r => r.status === 401 || r.status === 403);
  const other = rows.filter(r => !live.includes(r) && !dead.includes(r));

  console.log(`\n${'─'.repeat(70)}`);
  console.log(`usable: ${live.length}   dead (401/403): ${dead.length}   other: ${other.length}`);
  if (dead.length) console.log(`dead keys: ${dead.map(d => d.tag.trim()).join(', ')}`);
  if (other.length) console.log(`unclear:   ${other.map(d => `${d.tag.trim()} (${d.status})`).join(', ')}`);

  // Shared-bucket detection. Every key was just charged one identical request, so
  // on SEPARATE accounts each should report essentially the same high remaining
  // count (its own fresh bucket, minus one). On a SHARED bucket the counts step
  // down monotonically across the run, because each call drains the same pool.
  const seq = live.filter(r => r.remainReqs !== null).map(r => r.remainReqs);
  if (seq.length >= 3) {
    let descending = 0;
    for (let i = 1; i < seq.length; i++) if (seq[i] < seq[i - 1]) descending++;
    const spread = Math.max(...seq) - Math.min(...seq);
    const stepwise = descending >= seq.length - 2 && spread >= seq.length - 2;

    console.log(`\nremaining-requests across the run: ${seq.join(' → ')}`);
    if (stepwise) {
      console.log('VERDICT: counts step down key by key → the keys SHARE one quota bucket.');
      console.log('         Rotation adds no capacity here; the pool only helps with retries.');
    } else {
      console.log('VERDICT: each key reports its own near-full bucket → SEPARATE quotas.');
      console.log(`         Effective daily capacity ≈ ${live.length}× a single key.`);
    }
  }

  const orgs = new Set(rows.map(r => r.org).filter(Boolean));
  if (orgs.size) console.log(`\norganizations seen in headers: ${orgs.size} (${[...orgs].join(', ')})`);

  // Capacity, using the measured per-message cost from measure-token-cost.js.
  const TPD_PER_KEY = live[0]?.limitTokens ? null : 200000;
  const perMessage = 1452;
  const perUser = 8;
  const tpd = (TPD_PER_KEY || 200000) * live.length;
  console.log(`\nat ${perMessage} tokens/message and ${perUser} msgs/user/day:`);
  console.log(`  ${live.length} separate keys × 200k TPD = ${(tpd / 1e6).toFixed(1)}M tokens/day`);
  console.log(`  ≈ ${Math.floor(tpd / perMessage)} messages/day ≈ ${Math.floor(tpd / perMessage / perUser)} users`);
  console.log(`  (RPD also binds: 1,000 requests/key/day = ${live.length * 1000} requests, ` +
    `≈ ${Math.floor((live.length * 1000) / (perUser * 1.1))} users at ~1.1 API calls per message)`);
})();
