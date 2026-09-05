// scripts/verify-gemini-failover.js
// Plan verification step 5: force the failover path and prove the Gemini leg is
// the cheap one. Groq is disabled for this process only (env var, not config
// edits), so aiOrchestrator must skip it via isConfigured() and land on Gemini.
//
// Passes only if: Gemini answers, thinking tokens are 0, and the reply is prose.
// Usage: node scripts/verify-gemini-failover.js
delete process.env.GROQ_API_KEY;
delete process.env.GROQ_API_KEYS;
require('dotenv').config();
process.env.GROQ_API_KEY = '';
process.env.GROQ_API_KEYS = '';

// config caches env at require time, so the deletions above must happen first.
const config = require('../src/config');
const logger = require('../src/utils/logger');

let pass = 0;
const failures = [];
const check = (name, cond, detail = '') => {
  if (cond) pass++; else failures.push(`${name}${detail ? ' — ' + detail : ''}`);
};

// Capture what the provider logs, since thoughtsTokenCount is only visible there.
let thinkingSeen = null;
let geminiLogged = false;
const origInfo = logger.info.bind(logger);
logger.info = (msg, ...rest) => {
  const s = String(msg);
  if (/Gemini completion successful/.test(s)) {
    geminiLogged = true;
    const m = s.match(/thinking: (\d+)/);
    thinkingSeen = m ? Number(m[1]) : 0;
  }
  return origInfo(msg, ...rest);
};

const groq = require('../src/services/ai/providers/groqProvider');
const gemini = require('../src/services/ai/providers/geminiProvider');
const engine = require('../src/services/ai/conversationEngine');

const USER = {
  id: 'failover', telegram_id: '000000', first_name: 'Vijay',
  goal: 'Land a cybersecurity internship', personality_type: 'friendly',
  current_streak: 4, biggest_struggle: 'staying consistent', available_time: '2 hours',
};

const MIN = 60000;
const ago = (ms) => new Date(Date.now() - ms).toISOString();

(async () => {
  console.log(`groq pool size: ${groq.pool.length} (must be 0 to force failover)`);
  console.log(`gemini model: ${config.ai.gemini.model}, thinkingBudget: ${config.ai.gemini.thinkingBudget}\n`);

  check('groq is disabled for this run', groq.isConfigured() === false, `pool=${groq.pool.length}`);
  check('gemini is configured', gemini.isConfigured() === true);
  if (!gemini.isConfigured()) {
    console.log('\nGEMINI_API_KEY not set — cannot verify the failover leg.');
    process.exit(1);
  }

  // 1. Plain chat over the failover path.
  const t0 = Date.now();
  const reply = await engine.generateAdaptiveResponse(
    'why does that help?',
    [
      { role: 'user', content: 'i want to get better at subnetting', created_at: ago(6 * MIN) },
      { role: 'assistant', content: 'Subnetting clicks once you count bits instead of memorizing tables. Want to start with /24 splits?', created_at: ago(5 * MIN) },
    ],
    USER
  );
  const ms = Date.now() - t0;

  console.log(`\nreply (${ms}ms):\n${reply}\n`);
  check('gemini actually served the reply', geminiLogged);
  check('thinking tokens are 0', thinkingSeen === 0, `thinking=${thinkingSeen}`);
  check('reply is non-empty', Boolean(reply && reply.trim().length > 10));
  check('reply is prose, not a document',
    !/^\s*[-*•]\s/m.test(reply) && !/^\s*\d+[.)]\s/m.test(reply));
  check('reply stayed on topic', /subnet|bit|mask|ip|network|address|host/i.test(reply));
  check('no canned fallback', !/could you tell me more about what you need/i.test(reply));
  check('failover is fast (<8s)', ms < 8000, `${ms}ms`);

  // 2. The JSON path matters just as much — the classifier uses it.
  const parsed = await gemini.generateJsonCompletion(
    [{ role: 'user', content: 'Return {"intent":"SHOW_TASKS"} and nothing else.' }],
    { maxTokens: 200 }
  );
  console.log(`json path: ${JSON.stringify(parsed)}`);
  check('json path returns an object', parsed && typeof parsed === 'object');

  console.log(`\nFailover: ${pass} passed, ${failures.length} failed`);
  if (failures.length) {
    failures.forEach(f => console.log('  ✗ ' + f));
    process.exit(1);
  }
  console.log('✅ Gemini failover verified: thinkingBudget 0, prose, on-topic');
})();
