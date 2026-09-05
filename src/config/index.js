require('dotenv').config();

// Groq enforces rate limits per ORGANIZATION, not per key — every key issued by
// one account draws on the same TPM/TPD bucket, so rotating keys within an
// account buys exactly nothing. Rotation only adds capacity when the keys belong
// to genuinely separate accounts. Accept every shape a key list arrives in, and
// keep single-key GROQ_API_KEY working untouched so existing deploys need no
// change. Order is preserved: the pool is tried round-robin from key 0.
//
// Three forms are read, in this order:
//   GROQ_API_KEYS  — one comma-separated string
//   GROQ_KEY_1..N  — one variable per key, which is the only practical shape in
//                    Render's env UI (a 1,300-character comma string in a single
//                    row cannot be edited without retyping the whole thing)
//   GROQ_API_KEY   — the original single key
function parseKeyList(...sources) {
  const seen = new Set();
  for (const raw of sources) {
    if (!raw) continue;
    for (const k of String(raw).split(',')) {
      const key = k.trim();
      if (key) seen.add(key);
    }
  }
  return [...seen];
}

/** GROQ_KEY_1, GROQ_KEY_2, … in numeric order — gaps in the numbering are fine. */
function numberedGroqKeys() {
  return Object.keys(process.env)
    .map(name => ({ name, m: /^GROQ_KEY_(\d+)$/.exec(name) }))
    .filter(x => x.m)
    .sort((a, b) => Number(a.m[1]) - Number(b.m[1]))
    .map(x => process.env[x.name]);
}

const groqKeys = parseKeyList(
  process.env.GROQ_API_KEYS,
  ...numberedGroqKeys(),
  process.env.GROQ_API_KEY
);

const config = {
telegram: {
token: process.env.TELEGRAM_BOT_TOKEN,
botUsername: process.env.TELEGRAM_BOT_USERNAME,
adminId: process.env.ADMIN_TELEGRAM_ID,
// Numeric chat id of the beta Telegram group (negative, e.g. -1001234567890).
// When set, joining the group auto-grants beta + 1 month free Pro; leaving
// revokes the group-granted premium. Leave unset to disable group integration.
betaGroupId: process.env.BETA_GROUP_ID,
},
dashboard: {
jwtSecret: process.env.JWT_SECRET,
url: process.env.DASHBOARD_URL || 'http://localhost:3000',
google: {
clientId: process.env.GOOGLE_CLIENT_ID,
clientSecret: process.env.GOOGLE_CLIENT_SECRET,
},
},
supabase: {
url: process.env.SUPABASE_URL,
serviceKey: process.env.SUPABASE_SERVICE_KEY,
},
ai: {
groq: {
// First key stays exposed as apiKey so nothing that reads it has to change.
apiKey: groqKeys[0],
apiKeys: groqKeys,
// llama-3.3-70b-versatile was decommissioned by Groq — every call 404'd,
// which is what made ATLAS fall back to canned replies. Verified live
// against GET /openai/v1/models before changing.
model: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
},
gemini: {
apiKey: process.env.GEMINI_API_KEY,
// 3.6-flash spends ~380 thinking tokens per reply and cannot disable them
// (thinkingConfig is rejected on that model), which made the FAILBACK the
// most expensive and slowest option: 640 tokens at 5.9s vs 274 at 1.4s for
// 3.5-flash with thinkingBudget 0. Measured on an identical chat payload.
model: process.env.GEMINI_MODEL || 'gemini-3.5-flash',
// thinkingConfig only exists on v1beta, so geminiProvider calls the REST
// endpoint directly rather than through the v1-targeting SDK.
thinkingBudget: process.env.GEMINI_THINKING_BUDGET !== undefined
  ? Number(process.env.GEMINI_THINKING_BUDGET)
  : 0,
},
together: {
apiKey: process.env.TOGETHER_API_KEY,
// Old Llama-3-70b-chat-hf endpoint is retired on Together
model: process.env.TOGETHER_MODEL || 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
enabled: Boolean(process.env.TOGETHER_API_KEY),
},
defaultProvider: 'groq',
},
server: {
port: process.env.PORT || 3000,
env: process.env.NODE_ENV || 'development',
},
cron: {
dailyTaskTime: process.env.DAILY_TASK_TIME || 8,
weeklyReviewDay: process.env.WEEKLY_REVIEW_DAY || 0,
},
};

module.exports = config;