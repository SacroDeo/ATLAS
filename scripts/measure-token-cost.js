// scripts/measure-token-cost.js
// Measures what one user message actually costs, end to end, and compares the
// current code against the committed baseline. Prices are EXACT, not estimated:
// each prompt is sent to Groq once and the reported prompt_tokens is used.
//
// Two costs make up a message:
//   1. the chat reply (every conversational message pays this)
//   2. the AI intent classifier (only messages _localClassify cannot resolve)
//
// Usage: node scripts/measure-token-cost.js
require('dotenv').config();

const { execSync } = require('child_process');
const Groq = require('groq-sdk');
const config = require('../src/config');
const planner = require('../src/core/planner/actionPlanner');
const aiOrchestrator = require('../src/services/ai/aiOrchestrator');
const engine = require('../src/services/ai/conversationEngine');
const ACTIONS = require('../src/core/actions/actionTypes');

const key = config.ai.groq.apiKeys[0];
if (!key) {
  console.error('No GROQ key configured — cannot price prompts exactly.');
  process.exit(1);
}
const groq = new Groq({ apiKey: key });
const MODEL = config.ai.groq.model;

const MIN = 60000;
const ago = (ms) => new Date(Date.now() - ms).toISOString();

const USER = {
  id: 'measure', telegram_id: '000000', first_name: 'Vijay',
  goal: 'Land a cybersecurity internship', personality_type: 'friendly',
  current_streak: 4, biggest_struggle: 'staying consistent', available_time: '2 hours',
};

const HISTORY = [
  { role: 'user', content: 'i want to get better at subnetting', created_at: ago(9 * MIN) },
  { role: 'assistant', content: 'Subnetting clicks once you count bits instead of memorizing tables. Want to start with /24 splits?', created_at: ago(8 * MIN) },
  { role: 'user', content: 'yeah that sounds good', created_at: ago(7 * MIN) },
  { role: 'assistant', content: "Good. Take one /24, split it in half, and write out both ranges — that single exercise teaches the pattern.", created_at: ago(6 * MIN) },
];

const TASKS = [
  { title: 'Read the OSI model overview', status: 'pending' },
  { title: 'Wireshark capture: HTTP vs HTTPS', status: 'pending' },
  { title: 'Practice three subnetting problems', status: 'completed' },
];

/** One real call, so prompt_tokens comes from Groq's own tokenizer. */
async function price(messages, maxTokens) {
  const r = await groq.chat.completions.create({
    model: MODEL, messages, temperature: 0.1, max_tokens: maxTokens, stream: false,
  });
  return {
    prompt: r.usage.prompt_tokens,
    completion: r.usage.completion_tokens,
    total: r.usage.total_tokens,
  };
}

/** Capture the message array a code path builds, without spending a call on it. */
async function captureMessages(run) {
  const real = aiOrchestrator.execute;
  let captured = null;
  aiOrchestrator.execute = async (messages) => {
    captured = messages;
    // Return something shaped like a valid answer so the caller does not throw.
    return '{"intent":"GENERAL_CHAT","confidence":0.9,"requires_confirmation":false,"payload":{},"clarification_question":null}';
  };
  try { await run(); } catch { /* the stub reply may not satisfy every caller */ }
  aiOrchestrator.execute = real;
  return captured;
}

/** The classifier prompt as it stood in the last commit, for a true before/after. */
function baselineClassifierPrompt() {
  const src = execSync('git show HEAD:src/core/planner/actionPlanner.js', {
    cwd: require('path').join(__dirname, '..'), encoding: 'utf8', maxBuffer: 4 << 20,
  });
  const start = src.indexOf('const prompt = `');
  if (start === -1) return null;
  const from = start + 'const prompt = `'.length;
  const end = src.indexOf('`;', from);
  if (end === -1) return null;
  // Fill the template holes with the same fixture the new prompt gets.
  return src.slice(from, end)
    .replace(/\$\{context\.taskCount\}/g, String(TASKS.length))
    .replace(/\$\{taskSummary\}/g, TASKS.map((t, i) => `${i + 1}. ${t.title} (${t.status})`).join('\n'))
    .replace(/\$\{recentHistory\}/g, HISTORY.slice(-4).map(h => `${h.role}: ${h.content}`).join('\n'))
    .replace(/\$\{message\}/g, 'ugh these are too hard, give me easier ones')
    .replace(/\$\{[^}]+\}/g, '');
}

// Local-resolution rate over the routing corpus. Not production traffic — it is
// the reproducible corpus the routing test asserts on — so read it as the rate
// for THAT mix, and the direction of the change rather than an absolute.
const CORPUS = (() => {
  const src = require('fs').readFileSync(require('path').join(__dirname, 'test-conversational-routing.js'), 'utf8');
  // Strip line comments first: the arrays are documented with quoted examples
  // ("today was terrible" appears in a comment as well as in the list), and
  // counting those would inflate the corpus with phrases nobody sent.
  const decomment = (s) => s.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  const grab = (name) => {
    const i = src.indexOf(`const ${name} = [`);
    const j = src.indexOf('\n];', i);
    return decomment(src.slice(i, j));
  };
  const chat = [...grab('CHAT').matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g)]
    .map(m => (m[1] ?? m[2]).replace(/\\'/g, "'"))
    .filter(Boolean);
  const action = [...grab('ACTION').matchAll(/\[\s*'((?:[^'\\]|\\.)*)'/g)]
    .map(m => m[1].replace(/\\'/g, "'"));
  return { chat, action };
})();

(async () => {
  console.log(`model: ${MODEL}\n`);

  // ── 1. What the chat reply costs ─────────────────────────────────────────
  const chatMessages = await captureMessages(() =>
    engine.generateAdaptiveResponse('why does that help?', HISTORY, USER));
  const chat = await price(chatMessages, 400);
  console.log(`chat reply:        prompt ${chat.prompt}  completion ${chat.completion}  total ${chat.total}`);

  // This session added three lines to the chat system prompt (give the FIRST step
  // only when someone commits). Price the same payload without them so the
  // before/after below is not quietly crediting or charging that change.
  const COMMIT_RULE = /\n- When they agree to start[\s\S]*?turns back into a no\./;
  const withoutRule = chatMessages.map(m =>
    m.role === 'system' ? { ...m, content: m.content.replace(COMMIT_RULE, '') } : m);
  const chatBefore = withoutRule[0].content === chatMessages[0].content
    ? chat
    : await price(withoutRule, 400);
  if (chatBefore !== chat) {
    console.log(`  (the commitment rule added this session costs ${chat.prompt - chatBefore.prompt} prompt tokens)`);
  }

  // ── 2. What the classifier costs, now and before ─────────────────────────
  const clsMessages = await captureMessages(() =>
    planner.plan({
      messageText: 'ugh these are too hard, give me easier ones',
      tasks: TASKS, taskCount: TASKS.length, history: HISTORY, user: USER,
    }));
  const cls = await price(clsMessages, 300);
  console.log(`classifier (new):  prompt ${cls.prompt}  completion ${cls.completion}  total ${cls.total}`);

  let clsOld = null;
  const oldPrompt = baselineClassifierPrompt();
  if (oldPrompt) {
    clsOld = await price([{ role: 'user', content: oldPrompt }], 300);
    console.log(`classifier (HEAD): prompt ${clsOld.prompt}  completion ${clsOld.completion}  total ${clsOld.total}`);
  } else {
    console.log('classifier (HEAD): could not extract from git — skipping before/after');
  }

  // ── 3. How often the AI classifier fires at all ──────────────────────────
  const all = [...CORPUS.chat, ...CORPUS.action];
  const resolvedLocally = all.filter(m => planner._localClassify(m) !== null).length;
  const localRate = resolvedLocally / all.length;
  const aiRate = 1 - localRate;
  console.log(`\ncorpus: ${all.length} messages (${CORPUS.chat.length} chat, ${CORPUS.action.length} action)`);
  console.log(`resolved locally: ${resolvedLocally}/${all.length} = ${(localRate * 100).toFixed(0)}%`);
  console.log(`reaches AI classifier: ${(aiRate * 100).toFixed(0)}%`);

  // ── 4. Tokens per message ────────────────────────────────────────────────
  // Same formula both sides: every message pays for a reply, and the fraction
  // the local classifier cannot resolve also pays for a classifier call.
  const now = chat.total + aiRate * cls.total;
  console.log(`\ntokens/message now:  ${Math.round(now)}`);
  if (clsOld) {
    // Baseline: same reply cost (minus this session's rule), but its own weaker
    // local classifier sent 31% of messages to the AI.
    const before = chatBefore.total + 0.31 * clsOld.total;
    console.log(`tokens/message HEAD: ${Math.round(before)}  (at the 31% AI rate measured before)`);
    console.log(`change: ${Math.round(before)} → ${Math.round(now)} = ${(100 * (1 - now / before)).toFixed(0)}% cut, ` +
      `${Math.round(before - now)} tokens saved per message`);
    console.log(`\nthe reply itself is now ${(100 * chat.total / now).toFixed(0)}% of the cost — ` +
      `the classifier is no longer the lever, the chat prompt is`);
  }

  // ── 5. What that buys on the free tier ───────────────────────────────────
  const TPD = 200000;
  const perUser = 8;
  const msgs = Math.floor(TPD / now);
  console.log(`\nfree tier (200k TPD, 1 key): ${msgs} messages/day ≈ ${Math.floor(msgs / perUser)} users at ${perUser} msgs each`);
  const pool = config.ai.groq.apiKeys.length || 1;
  if (pool > 1) {
    console.log(`with the configured ${pool}-key pool: ≈ ${Math.floor((msgs * pool) / perUser)} users (only if the keys are separate accounts)`);
  }
  console.log(`\nnote: this payload carries a 4-turn history and a 3-task list, which is what a`);
  console.log(`real conversation looks like. A first message with empty history costs far less,`);
  console.log(`so treat this as the pessimistic end of the range.`);

  // ── 6. The cheap end of the range, and where the tokens actually sit ─────
  // The plan's 763-token baseline was measured on a FIRST message (no history),
  // which is why it looks nothing like the number above. Price both so the
  // capacity math is honest about which end of the range it assumes.
  const coldMessages = await captureMessages(() =>
    engine.generateAdaptiveResponse('hi', [], USER));
  const cold = await price(coldMessages, 400);
  console.log(`\nfirst message, no history: total ${cold.total} (prompt ${cold.prompt})`);
  console.log(`so one message costs ${cold.total}–${Math.round(now)} tokens depending on how deep the thread is`);

  // Breakdown of the expensive end: system prompt vs profile vs history.
  const sys = coldMessages.find(m => m.role === 'system').content;
  const sysOnly = await price([{ role: 'system', content: sys }, { role: 'user', content: 'hi' }], 16);
  const bare = await price([{ role: 'user', content: 'hi' }], 16);
  console.log(`\nwhere the prompt goes:`);
  console.log(`  chat system prompt: ~${sysOnly.prompt - bare.prompt} tokens (paid on EVERY message)`);
  console.log(`  profile + history:  ~${chat.prompt - sysOnly.prompt} tokens on this 4-turn payload`);
  console.log(`  next lever is the system prompt, not the classifier`);
})();
