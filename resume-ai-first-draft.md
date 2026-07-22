# ATLAS → AI-First Resume Rewrite (draft v1 — 2026-07-19)

Replace sections of vijayckresume4.pdf with the below. Placeholders in [BRACKETS] — fill before sending.

---

## HEADER

**VIJAY CHANDRA KUMAR B**
AI Application Developer · Final-Year B.Tech IT Student
vijaychandrakumar111@gmail.com | github.com/SacroDeo | [LinkedIn] | [Portfolio] | Bengaluru, India

---

## ABOUT ME

Final-year B.Tech IT student who builds and ships AI-powered products end to end. Creator of ATLAS — a deployed Telegram AI accountability bot (LLM-generated daily tasks, streaks, empathetic chat) built on Groq and Gemini — and a published VS Code extension for AI-assisted development workflows. I work AI-first: I use LLM tooling to ship fast, and I can walk through every design decision in my code.

---

## PROJECTS

### ATLAS — AI Accountability Bot (Telegram · deployed & live)
*Node.js · Groq (Llama) · Gemini · Supabase (Postgres) · Telegram Bot API · Webhooks*

- Production Telegram bot that turns a user's goal into AI-generated daily tasks, with streak tracking, scheduled check-ins, weekly reviews, and an empathetic chat mode.
- Multi-provider LLM client (Groq + Gemini) behind a single swappable interface; separate prompt pipelines for roadmap generation, daily task creation, and conversational support.
- Webhook-based architecture with scheduled jobs; Supabase persistence for users, goals, tasks, and streaks; runs in production at near-zero infra cost.
- [IF TRUE: "In active use by early testers" — only if friends are actually using it]

### AI Context Copier — VS Code Extension (published on Marketplace)
*TypeScript · VS Code Extension API*

- Published extension (publisher: `sacro`) that copies multiple files/folders as clean markdown for AI assistant workflows (ChatGPT, Claude, Gemini, DeepSeek).
- Handles folder + relative/absolute paths, auto-skips node_modules/.git/dist; fully offline, zero telemetry, zero network requests.
- [ADD IF AVAILABLE: install/download count from Marketplace]

### Music Player — Build + Security Audit
*Node.js · Express · YouTube Data API*

- Built a streaming platform on the YouTube Data API, then performed a post-build security review: header hardening, rate limiting, CORS enforcement, dependency pinning — documented with CVSS severity ratings.

*(Crossword project: REMOVED — redundant with the above.)*

---

## SKILLS (reordered, AI-first)

LLM API Integration (Gemini, Groq/Llama) · Prompt Engineering · Node.js / Express · Python · REST APIs & Webhooks · Supabase / PostgreSQL · TypeScript / JavaScript · Git & GitHub · Linux CLI · AI-Assisted Development Workflows

*(Removed from headline skills: Penetration Testing, Burp Suite, Nmap/Wireshark — security literacy now lives in the line below.)*

---

## CERTIFICATIONS & ADDITIONAL

- **Cisco Networking Academy** — Introduction to Cybersecurity
- **TryHackMe SOC Level 1 path** (in progress) — log analysis, phishing triage, SIEM basics. *Security-aware development: I audit what I ship.*

---
---

# FOUNDER OUTREACH KIT (for tomorrow — AFTER GitHub README is done)

## LinkedIn DM (~80 words, founders skim)

> Hi [Name] — final-year IT student in Bengaluru. I build and ship AI products: ATLAS, a deployed Telegram accountability bot (Groq/Gemini LLM pipelines, Supabase, webhooks) — [bot link] — and a published VS Code extension. Looking for an AI/backend internship where I ship real features, not fetch coffee. Repo: [github link]. Open to a quick chat this week?

## Cold email (subject line matters most)

**Subject:** Final-year student who ships AI products — internship at [Company]?

> Hi [Name],
>
> I'm a final-year B.Tech IT student in Bengaluru. Two things I've shipped:
>
> - **ATLAS** — a live Telegram AI accountability bot: LLM task generation (Groq + Gemini), webhook architecture, Supabase, scheduled jobs. Try it: [link]
> - **AI Context Copier** — a published VS Code extension for AI-assisted dev workflows.
>
> I saw [Company] is building [ONE SPECIFIC THING — read their site for 2 min]. I'd love to intern on exactly that kind of work. GitHub: [link] · Resume attached.
>
> Even 15 minutes of advice would be valuable if you're not hiring right now.
>
> — Vijay

## Rules
- Personalize ONE line per founder ([ONE SPECIFIC THING]) — 2 minutes each, doubles reply rate.
- 10/day max, tracked in a sheet: company · founder · date · channel · reply?
- Follow up ONCE after 5–7 days, then move on.
- Target list: Bengaluru AI startups on Wellfound/Cutshort with 2–20 employees; YC India batch lists; "GenAI" filter on Instahyre.
