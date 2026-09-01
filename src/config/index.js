require('dotenv').config();

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
apiKey: process.env.GROQ_API_KEY,
// llama-3.3-70b-versatile was decommissioned by Groq — every call 404'd,
// which is what made ATLAS fall back to canned replies. Verified live
// against GET /openai/v1/models before changing.
model: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
},
gemini: {
apiKey: process.env.GEMINI_API_KEY,
// gemini-2.0-flash is retired; the API itself points to 3.6-flash.
model: process.env.GEMINI_MODEL || 'gemini-3.6-flash',
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