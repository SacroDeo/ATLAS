require('dotenv').config();

const config = {
telegram: {
token: process.env.TELEGRAM_BOT_TOKEN,
botUsername: process.env.TELEGRAM_BOT_USERNAME,
adminId: process.env.ADMIN_TELEGRAM_ID,
},
dashboard: {
jwtSecret: process.env.JWT_SECRET,
url: process.env.DASHBOARD_URL || 'http://localhost:3000',
},
supabase: {
url: process.env.SUPABASE_URL,
serviceKey: process.env.SUPABASE_SERVICE_KEY,
},
ai: {
groq: {
apiKey: process.env.GROQ_API_KEY,
model: 'llama-3.3-70b-versatile',
},
gemini: {
apiKey: process.env.GEMINI_API_KEY,
model: 'gemini-2.0-flash'
,
},
together: {
apiKey: process.env.TOGETHER_API_KEY,
model: 'meta-llama/Llama-3-70b-chat-hf',
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