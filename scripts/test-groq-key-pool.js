// scripts/test-groq-key-pool.js
// Unit test: the Groq multi-key pool. Round-robin order, per-key cooldown from
// real header formats, dead-key eviction, and single-key behaviour preserved.
// No network — a fake client stands in for the SDK.
require('dotenv').config();

const provider = require('../src/services/ai/providers/groqProvider');
const parseReset = provider._parseResetHeader;
const GroqProvider = provider._GroqProvider;

let pass = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) pass++;
  else failures.push(`${name}${detail ? ' — ' + detail : ''}`);
}

// ── 1. Header parsing: the formats Groq actually returns ────────────────────
{
  check('reset "1.5s" → 1500ms', parseReset('1.5s') === 1500, String(parseReset('1.5s')));
  check('reset "443ms" → ~443ms', parseReset('443ms') === 443, String(parseReset('443ms')));
  check('reset "44m38.4s" → 2678400ms',
    parseReset('44m38.4s') === 2678400, String(parseReset('44m38.4s')));
  check('reset "5m45.6s" → 345600ms',
    parseReset('5m45.6s') === 345600, String(parseReset('5m45.6s')));
  check('reset "2h1m" → 7260000ms', parseReset('2h1m') === 7260000, String(parseReset('2h1m')));
  check('reset undefined → null', parseReset(undefined) === null);
  check('reset "" → null', parseReset('') === null);
  check('reset garbage → null', parseReset('nonsense') === null, String(parseReset('nonsense')));
}

// ── Test harness: a provider whose clients are scripted, not real ───────────
// Each fake key is handed a queue of outcomes: 'ok', or an error with a status.
function buildProvider(keys, scripts) {
  const p = Object.create(GroqProvider.prototype);
  p.model = 'test-model';
  p.maxRetries = 3;
  p.retryDelay = 0;
  p.cursor = 0;
  p.calls = [];
  p.pool = keys.map((key, i) => ({
    key,
    tag: `#${i}…${key.slice(-4)}`,
    cooldownUntil: 0,
    client: {
      chat: {
        completions: {
          create: async () => {
            p.calls.push(key);
            const outcome = (scripts[key] || []).shift() || 'ok';
            if (outcome === 'ok') {
              return {
                choices: [{ message: { content: `reply from ${key}` }, finish_reason: 'stop' }],
                usage: { total_tokens: 10 },
              };
            }
            throw outcome;
          },
        },
      },
    },
  }));
  p.client = p.pool[0]?.client || null;
  return p;
}

const rateLimit = (headers) => Object.assign(new Error('rate_limit_exceeded'), { status: 429, headers });
const authFail = () => Object.assign(new Error('invalid api key'), { status: 401 });

// ── 2. Round-robin: consecutive calls must not reuse the same key ───────────
(async () => {
  {
    const p = buildProvider(['key-aaaa', 'key-bbbb', 'key-cccc'], {});
    await p.generateCompletion([{ role: 'user', content: 'x' }]);
    await p.generateCompletion([{ role: 'user', content: 'x' }]);
    await p.generateCompletion([{ role: 'user', content: 'x' }]);
    check('round-robin: spreads across all 3 keys',
      new Set(p.calls).size === 3, p.calls.join(','));
    check('round-robin: in order', p.calls.join(',') === 'key-aaaa,key-bbbb,key-cccc', p.calls.join(','));
  }

  // ── 3. A 429 moves to the next key instead of sleeping ────────────────────
  {
    const p = buildProvider(['key-aaaa', 'key-bbbb'], {
      'key-aaaa': [rateLimit({ 'x-ratelimit-reset-tokens': '3s', 'x-ratelimit-remaining-requests': '900' })],
    });
    const t0 = Date.now();
    const r = await p.generateCompletion([{ role: 'user', content: 'x' }]);
    const elapsed = Date.now() - t0;
    check('429: falls through to second key', r === 'reply from key-bbbb', r);
    check('429: did not sleep waiting for the first', elapsed < 500, `${elapsed}ms`);
    check('429: limited key is parked', p.pool[0].cooldownUntil > Date.now());
    const parkedFor = p.pool[0].cooldownUntil - Date.now();
    check('429: TPM cooldown is seconds, not hours', parkedFor <= 3100, `${parkedFor}ms`);
  }

  // ── 3b. Two TPM signals disagree → take the smaller ───────────────────────
  // Measured on a live 429: reset-tokens 37.147s (bucket full again) vs
  // retry-after 15s (this request would fit). Parking for the larger idles a
  // usable key for ~22s every time.
  {
    const p = buildProvider(['key-aaaa', 'key-bbbb'], {
      'key-aaaa': [rateLimit({
        'x-ratelimit-reset-tokens': '37.147s',
        'retry-after': '15',
        'x-ratelimit-remaining-requests': '991',
      })],
    });
    await p.generateCompletion([{ role: 'user', content: 'x' }]);
    const parkedFor = p.pool[0].cooldownUntil - Date.now();
    check('429: takes retry-after over the longer reset-tokens',
      parkedFor > 13000 && parkedFor <= 15100, `${parkedFor}ms`);
  }

  // ── 4. Daily exhaustion parks the key for the long bucket ─────────────────
  {
    const p = buildProvider(['key-aaaa', 'key-bbbb'], {
      'key-aaaa': [rateLimit({
        'x-ratelimit-reset-requests': '44m38.4s',
        'x-ratelimit-remaining-requests': '0',
      })],
    });
    await p.generateCompletion([{ role: 'user', content: 'x' }]);
    const parkedFor = p.pool[0].cooldownUntil - Date.now();
    check('daily quota: parked for ~44m', parkedFor > 40 * 60000, `${Math.round(parkedFor / 60000)}min`);
  }

  // ── 5. A dead key is evicted, not fatal, when others remain ───────────────
  {
    const p = buildProvider(['key-dead', 'key-good'], { 'key-dead': [authFail()] });
    const r = await p.generateCompletion([{ role: 'user', content: 'x' }]);
    check('auth fail: pool survives one bad key', r === 'reply from key-good', r);
    check('auth fail: bad key parked long', p.pool[0].cooldownUntil - Date.now() > 60000);
  }

  // ── 6. Single key: auth failure must still be fatal (old behaviour) ───────
  {
    const p = buildProvider(['key-only'], { 'key-only': [authFail(), authFail(), authFail()] });
    let threw = null;
    try { await p.generateCompletion([{ role: 'user', content: 'x' }]); }
    catch (e) { threw = e; }
    check('single key: auth failure throws', threw !== null && /authentication failed/i.test(threw.message),
      threw ? threw.message : 'did not throw');
  }

  // ── 7. Every key limited → the call still fails cleanly, no hang ──────────
  {
    const many = { };
    const keys = ['k-aaaa', 'k-bbbb'];
    for (const k of keys) {
      many[k] = Array.from({ length: 6 }, () =>
        rateLimit({ 'x-ratelimit-reset-tokens': '1s', 'x-ratelimit-remaining-requests': '5' }));
    }
    const p = buildProvider(keys, many);
    let threw = null;
    const t0 = Date.now();
    try { await p.generateCompletion([{ role: 'user', content: 'x' }]); }
    catch (e) { threw = e; }
    check('all limited: throws rather than hanging', threw !== null, 'no throw');
    check('all limited: bounded time', Date.now() - t0 < 20000, `${Date.now() - t0}ms`);
  }

  // ── 8. Config parses a comma-separated list and dedupes ──────────────────
  {
    const config = require('../src/config');
    check('config: exposes apiKeys array', Array.isArray(config.ai.groq.apiKeys));
    check('config: apiKey is the first of the pool',
      !config.ai.groq.apiKeys.length || config.ai.groq.apiKey === config.ai.groq.apiKeys[0]);
    check('config: gemini thinkingBudget defaults to 0', config.ai.gemini.thinkingBudget === 0,
      String(config.ai.gemini.thinkingBudget));
  }

  // ── 9. Real provider instance reflects whatever is in .env ───────────────
  {
    check('live provider: pool matches config length',
      provider.pool.length === (require('../src/config').ai.groq.apiKeys.length || 0),
      `pool=${provider.pool.length}`);
    check('live provider: isConfigured tracks the pool',
      provider.isConfigured() === (provider.pool.length > 0));
    check('live provider: no full key in any tag',
      provider.pool.every(e => !e.tag.includes(e.key)),
      provider.pool.map(e => e.tag).join(','));
  }

  console.log(`\nKey pool: ${pass} passed, ${failures.length} failed`);
  if (failures.length) {
    failures.forEach(f => console.log('  ✗ ' + f));
    process.exit(1);
  }
  console.log('✅ All key-pool assertions passed');
})();
