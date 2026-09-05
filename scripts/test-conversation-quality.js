// scripts/test-conversation-quality.js
// Live behavioral test: real AI providers, stubbed DB. Runs the 15 required
// conversational categories through generateAdaptiveResponse and asserts on the
// actual replies. Prints every response for human reading.
//
// Usage: node scripts/test-conversation-quality.js
require('dotenv').config();

const engine = require('../src/services/ai/conversationEngine');
const planner = require('../src/core/planner/actionPlanner');
const ACTIONS = require('../src/core/actions/actionTypes');

const USER = {
  id: 'test-user',
  telegram_id: '000000',
  first_name: 'Vijay',
  goal: 'Land a cybersecurity internship',
  personality_type: 'friendly',
  current_streak: 4,
  biggest_struggle: 'staying consistent',
  available_time: '2 hours',
};

const MIN = 60000, HOUR = 3600000;
const ago = (ms) => new Date(Date.now() - ms).toISOString();

// The exact canned strings this work exists to eliminate.
const BANNED = [
  /could you tell me more about what you need/i,
  /i'?m here! could you/i,
  /could you provide more details about your query/i,
];

// Claims ATLAS must never make about itself.
const FAKE_HUMANITY = [
  /i was thinking about you/i,
  /i had a (busy|long|rough) day/i,
  /my day was/i,
  /i (feel|felt) (tired|exhausted|sleepy)/i,
  /i remember seeing you (yesterday|earlier)/i,
];

const results = [];
let failures = 0;

// gpt-oss-120b writes typographic punctuation — "don’t", "I’m", "beginner‑friendly"
// — so an assertion written with an ASCII apostrophe silently never matches and a
// perfectly honest reply gets scored as a failure. Fold the curly forms before
// testing so these checks measure what ATLAS SAID, not which codepoint it picked.
const normalize = (s) => String(s)
  .replace(/[‘’ʼ]/g, "'")
  .replace(/[“”]/g, '"')
  .replace(/‑/g, '-');

async function turn(label, message, history, assertions) {
  // Groq's free tier is 8k tokens/minute and each of these calls costs ~1k, so
  // back-to-back turns trip the limiter and spend the run on retry backoff.
  await new Promise(r => setTimeout(r, 6000));

  let reply;
  try {
    reply = await engine.generateAdaptiveResponse(message, history, USER);
  } catch (err) {
    failures++;
    results.push({ label, message, reply: `[THREW: ${err.message}]`, problems: ['threw'] });
    return null;
  }

  // Content assertions read the normalized text; the shape checks below read the
  // raw reply, since that is exactly what Telegram will render.
  const text = normalize(reply);

  const problems = [];
  for (const re of BANNED) if (re.test(text)) problems.push(`canned fallback: ${re}`);
  for (const re of FAKE_HUMANITY) if (re.test(text)) problems.push(`fake humanity: ${re}`);
  // Chat is prose. Catch bullets AND numbered steps AND bold headings — the
  // "here is a document" register, not just one marker style.
  if (/^\s*[-*•]\s/m.test(reply)) problems.push('used a bullet list');
  if (/^\s*\d+[.)]\s/m.test(reply)) problems.push('used a numbered list');
  if (/^\s*\*\*[^*\n]+\*\*\s*[-–:]/m.test(reply)) problems.push('used bold headings');
  if (!reply || reply.trim().length < 2) problems.push('empty reply');

  for (const [name, fn] of Object.entries(assertions || {})) {
    let ok = false;
    try { ok = fn(text); } catch { ok = false; }
    if (!ok) problems.push(name);
  }

  if (problems.length) failures++;
  results.push({ label, message, reply, problems });
  return reply;
}

const words = (s) => s.trim().split(/\s+/).length;
const hasQ = (s) => /\?/.test(s);

(async () => {
  // 1. Greeting — the original bug.
  await turn('1. Greeting', 'hi', [], {
    'should be short (<40 words)': r => words(r) < 40,
  });

  // 2. Casual conversation + memory question (the verbatim reported failure).
  await turn(
    '2. Casual + memory (no history)',
    'hi whats up man, do u remember when was the last time we spoke?',
    [],
    {
      'must admit no prior conversation': r =>
        /(don'?t|do not|no)\b.{0,40}(record|memory|history|recollection|previous|prior|earlier)|first (time|thing|message)|haven'?t (spoken|talked|chatted)|this is our first/i.test(r),
    }
  );

  // 3. Small talk.
  await turn('3. Small talk', 'whats up man', [], {
    'should be brief': r => words(r) < 45,
  });

  // 4. Emotional statement — warmth, no interrogation, no toxic positivity.
  await turn('4. Emotional', 'Man, today was terrible.', [], {
    'no toxic positivity': r => !/you got this|keep going|stay positive|chin up/i.test(r),
    'not a lecture': r => words(r) < 80,
  });

  // 5. Explicit request to converse — must invite, not deflect.
  await turn('5. Request to discuss', 'can we discuss something?', [], {
    'must be an invitation': r =>
      /(of course|sure|yeah|yes|absolutely|go ahead|what'?s on your mind|shoot|i'?m listening|go for it|definitely)/i.test(r),
    'must stay short': r => words(r) < 35,
  });

  // 6. Follow-up that only makes sense with history.
  const followHistory = [
    { role: 'user', content: 'I want to get better at subnetting', created_at: ago(6 * MIN) },
    { role: 'assistant', content: 'Subnetting clicks once you stop memorizing and start counting bits. Want to start with /24 splits?', created_at: ago(5 * MIN) },
  ];
  await turn('6. Follow-up ("why?")', 'why does that help?', followHistory, {
    'must reference the actual topic': r => /subnet|bit|mask|ip|network|address|host/i.test(r),
  });

  // 7. Context-dependent memory question WITH history — must use the real gap.
  const recallHistory = [
    { role: 'user', content: 'I finished the Wireshark lab', created_at: ago(3 * HOUR) },
    { role: 'assistant', content: 'Nice — capturing your own traffic is the fastest way to make packets feel real.', created_at: ago(3 * HOUR + 1000) },
  ];
  await turn('7. Context memory question', 'do you remember what we talked about earlier?', recallHistory, {
    'must recall the real topic': r => /wireshark|packet|capture|traffic|lab/i.test(r),
    'must not invent a different past': r => !/yesterday|last week|last month/i.test(r),
  });

  // 8. Technical question — technical register.
  await turn('8. Technical', 'explain what a subnet mask actually does at the bit level', [], {
    'must be technical': r => /bit|binary|network|host|mask|octet|prefix|1s|0s|and/i.test(r),
  });

  // 9. Ambiguous — one interpretation or ONE question, never a canned deflect.
  await turn('9. Ambiguous', 'the thing from before', [], {
    'at most one question': r => (r.match(/\?/g) || []).length <= 1,
  });

  // 10. Slang and typos.
  await turn('10. Slang/typos', 'yo atlas i wanna gt betr at ths netwrking stuf but idk whre 2 strt', [], {
    'must engage the topic': r => /network|start|begin|basic|first|foundation/i.test(r),
  });

  // 11. Topic change mid-conversation.
  const topicHistory = [
    { role: 'user', content: 'lets talk about subnetting', created_at: ago(10 * MIN) },
    { role: 'assistant', content: 'Sure — where do you want to start?', created_at: ago(9 * MIN) },
  ];
  await turn('11. Topic change', 'actually forget that, how do i stay consistent?', topicHistory, {
    'must move to consistency': r => /consisten|habit|routine|daily|small|streak|show up/i.test(r),
    // A passing callback ("celebrate nailing a subnet mask") is good continuity,
    // not a failure to follow. What must not happen is continuing to TEACH the
    // dropped topic.
    'must not keep teaching subnetting': r => !/subnet\w*\s+(is|works|means)|\/24|bits?\b.{0,20}mask/i.test(r),
  });

  // 12. User corrects ATLAS.
  const correctHistory = [
    { role: 'user', content: 'my goal is cybersecurity', created_at: ago(8 * MIN) },
    { role: 'assistant', content: 'Got it — so we are aiming at a data science internship.', created_at: ago(7 * MIN) },
  ];
  await turn('12. Correction', "no thats wrong, i said cybersecurity not data science", correctHistory, {
    'must accept the correction': r => /cyber|security|right|sorry|my mistake|correct|got it|noted/i.test(r),
    'must not defend the error': r => !/data science is/i.test(r),
  });

  // 13. "Never mind" — let it go without friction.
  const nvmHistory = [
    { role: 'user', content: 'can you help me with something weird', created_at: ago(4 * MIN) },
    { role: 'assistant', content: 'Of course. What is it?', created_at: ago(3 * MIN) },
  ];
  await turn('13. Never mind', 'forget it lol', nvmHistory, {
    'must let it go gracefully': r => words(r) < 40,
    'must not interrogate': r => (r.match(/\?/g) || []).length <= 1,
  });

  // 14. Asking ATLAS to explain itself.
  await turn('14. Explain yourself', 'what do you actually do?', [], {
    'must describe its real role': r => /goal|task|track|plan|help|day|progress/i.test(r),
    'must not claim to be human': r => !/i am (a )?(human|person)/i.test(r),
  });

  // 15. Multi-turn continuity — four sequential turns sharing one thread.
  console.log('\n--- 15. Multi-turn continuity ---');
  const thread = [];
  const push = (role, content) => thread.push({ role, content, created_at: new Date().toISOString() });

  push('user', 'i think i want to focus on network security');
  let r15 = await turn('15a. Opening', 'i think i want to focus on network security', thread.slice(0, -1), {});
  if (r15) push('assistant', r15);

  push('user', 'whats the first thing i should learn?');
  r15 = await turn('15b. Question in thread', 'whats the first thing i should learn?', thread.slice(0, -1), {
    'must stay on networking': r => /tcp|ip|packet|protocol|osi|subnet|dns|network|port|firewall|model|layer/i.test(r),
  });
  if (r15) push('assistant', r15);

  push('user', 'that sounds hard tbh');
  r15 = await turn('15c. Emotional turn in thread', 'that sounds hard tbh', thread.slice(0, -1), {
    'must acknowledge the feeling': r => words(r) < 90,
    'no toxic positivity': r => !/you got this|keep going/i.test(r),
  });
  if (r15) push('assistant', r15);

  push('user', 'ok fine lets do it');
  r15 = await turn('15d. Commitment in thread', 'ok fine lets do it', thread.slice(0, -1), {
    'must still be on the same topic': r => /network|tcp|ip|packet|protocol|start|first|begin|layer|osi/i.test(r),
  });

  // ── Routing check on the same messages (no AI) ────────────────────────────
  console.log('\n--- Routing sanity (local classifier) ---');
  const routed = [
    ['hi', ACTIONS.GENERAL_CHAT],
    ['can we discuss something?', ACTIONS.GENERAL_CHAT],
    ['do u remember when we last spoke', ACTIONS.GENERAL_CHAT],
    ['forget it lol', ACTIONS.GENERAL_CHAT],
  ];
  for (const [m, want] of routed) {
    const got = planner._localClassify(m)?.intent || null;
    const ok = got === want;
    if (!ok) failures++;
    console.log(`${ok ? '✅' : '❌'} "${m}" → ${got}`);
  }

  // ── Report ────────────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(72));
  for (const r of results) {
    console.log(`\n${r.problems.length ? '❌' : '✅'} ${r.label}`);
    console.log(`   USER:  ${r.message}`);
    console.log(`   ATLAS: ${String(r.reply).replace(/\n/g, '\n          ')}`);
    if (r.problems.length) r.problems.forEach(p => console.log(`   ⚠️  ${p}`));
  }
  console.log('\n' + '='.repeat(72));
  console.log(`${results.length - results.filter(r => r.problems.length).length}/${results.length} conversational cases clean`);
  process.exit(failures ? 1 : 0);
})();
