<div align="center">

# 🧭 ATLAS

### Your AI personal goal assistant, on Telegram

**Tell ATLAS your goal. It builds the roadmap, generates your daily tasks, and walks the whole journey with you.**

[**▶ Try it live: @AtlasGrowbot**](https://t.me/AtlasGrowbot)

`Node.js` · `Groq (Llama)` · `Gemini` · `Together AI` · `Supabase` · `Telegram Bot API`

</div>

---

## What it does

ATLAS turns a vague ambition ("crack my SQL interview", "get fit", "learn backend") into a structured plan you actually follow:

- 🗺️ **AI roadmap** — your goal becomes a phased learning/action roadmap (or import your own)
- ✅ **Daily tasks, every morning** — AI-generated from your roadmap, delivered at *your* local time, as tappable buttons
- 🔥 **Streaks & progress** — daily completion, weekly stats, and check-ins through the day
- 🧠 **It remembers you** — persistent memory of your goals, history, and conversations across weeks
- 📈 **Weekly AI reviews** — a real retrospective on your week, not just numbers
- 💬 **Talk to it like a person** — natural-language chat with an empathetic coach personality; no command memorization needed
- 📊 **Web dashboard** — charts and stats in the browser, synced with Telegram

## Under the hood

The interesting engineering, briefly:

**AI orchestration pipeline.** Every message runs through intent classification → action planning → validation → one of 17 typed action executors. AI output is never trusted blindly — tasks, roadmaps, and reviews each pass dedicated validators before reaching the user.

**Multi-provider LLM layer.** Groq, Gemini, and Together AI sit behind a single swappable interface with rate limiting — providers can be switched or added without touching business logic.

**Memory with compression.** Long-term user memory is summarized by LLM as it grows, so months of context keep fitting inside prompt budgets.

**Adaptive coaching.** A behavior profile builder and engagement analyzer track how each user actually works; task difficulty and tone adapt to it.

**Timezone-aware scheduling.** Cron checks per-user local time every minute — everyone gets their tasks in *their* morning, not the server's.

**Dual-auth dashboard.** Telegram Login Widget + Google Sign-In, session cookies, per-user data scoping, rate-limited API.

```
src/
├── bot/            # Telegram handlers, onboarding, callbacks, keyboards
├── core/           # intent → planner → validators → action executors
│   └── memory/     # memory manager + LLM compression
├── services/
│   ├── ai/         # orchestrator, providers (Groq/Gemini/Together), generators, validators
│   ├── accountability/  # check-in engine, engagement analyzer
│   └── personality/     # coach voice & tone
├── cron/           # daily / check-in / weekly schedulers (timezone-aware)
├── dashboard/      # web dashboard: Telegram + Google auth, scoped API
└── database/       # Supabase (Postgres) query layer
```

## Stack

| Layer | Tech |
|---|---|
| Runtime | Node.js + Express (webhook architecture) |
| AI | Groq (Llama), Gemini, Together AI — swappable provider layer |
| Data | Supabase (Postgres) |
| Bot | Telegram Bot API (inline keyboards, MarkdownV2) |
| Scheduling | node-cron, per-user timezone resolution |
| Web | Dashboard with Telegram Login + Google OAuth |

## Status

🟢 **Deployed and live** — actively developed. Feedback welcome: open an issue or message the bot.

---

<div align="center">

Built by **[Vijay Chandra Kumar B](https://iridescent-swan-eb0922.netlify.app/)** · [LinkedIn](https://www.linkedin.com/in/vijay-chandra-kumar-b-352513343/) · [GitHub](https://github.com/SacroDeo)

</div>
