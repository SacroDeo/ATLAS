// src/services/ai/roadmapGenerator.js
// Standalone roadmap generator — produces BOTH roadmap_text AND roadmap_json.
// Now uses AI-driven intent reasoning instead of keyword templates.

const aiOrchestrator = require('./aiOrchestrator');
const userQueries = require('../../database/queries/userQueries');
const logger = require('../../utils/logger');
const roadmapValidator = require('./validators/roadmapValidator');

// ─── domain_knowledge → human-readable label ─────────────────────────────────
const KNOWLEDGE_LABELS = {
  beginner:     'Complete beginner — no prior knowledge assumed',
  basic:        'Basic understanding — familiar with core concepts but limited hands-on',
  intermediate: 'Intermediate — has hands-on experience, ready for practical projects',
  advanced:     'Advanced — deep expertise, skip fundamentals entirely',
};

// ─── domain_knowledge → roadmap safety directive ─────────────────────────────
const KNOWLEDGE_DIRECTIVES = {
  beginner: `KNOWLEDGE LEVEL IS BEGINNER. YOU MUST:
- Start from absolute fundamentals
- Explain every tool before assigning it
- Avoid jargon without definition
- Never assume prior knowledge
- Phase 1 must be foundational concepts only
- No advanced tooling or setup in first 40% of roadmap`,

  basic: `KNOWLEDGE LEVEL IS BASIC. YOU MUST:
- Apply this to ANY field or goal — never assume a technical field
- Start from core concepts with light reinforcement
- Phase 1 must reinforce fundamentals through small practical exercises — NO tool installation or environment setup in Phase 1
- Introduce tools with brief context, only after the concepts they depend on
- Avoid skipping prerequisite topics
- Assume basic awareness but not hands-on skill`,

  intermediate: `KNOWLEDGE LEVEL IS INTERMEDIATE. YOU MAY:
- Skip basic definitions
- Assign hands-on projects from Phase 1
- Introduce advanced tools in middle phases
- Assume working knowledge of fundamentals`,

  advanced: `KNOWLEDGE LEVEL IS ADVANCED. YOU MUST:
- Skip all fundamentals
- Start with implementation-heavy tasks immediately
- Use technical terminology without explanation
- Focus on mastery, optimization, and real-world application`,
};

const roadmapGenerator = {
  async generate(user) {
    const telegramId = user.telegram_id;
    const goalText   = user.goal || '';
    const domainKnowledge = user.domain_knowledge || 'beginner';

    logger.info(`[RoadmapGenerator] Generating for user ${telegramId}, knowledge=${domainKnowledge}, goal="${goalText}"`);

    // ── Build behavior profile for pacing + difficulty constraints ───────────
    const behaviorProfileBuilder = require('./behaviorProfileBuilder');
    const behaviorProfile = behaviorProfileBuilder.build(user);

    // ── Timeframe parsing ────────────────────────────────────────────────────
    const timeframeMatch = goalText.match(
      /(\d+)\s*(day|days|week|weeks|month|months|year|years)/i
    );
    const timeframe = timeframeMatch
      ? `${timeframeMatch[1]} ${timeframeMatch[2].toLowerCase()}`
      : '3 months';

    let phaseCount = 3;
    let phaseLabel = 'Month';

    if (timeframeMatch) {
      const num  = parseInt(timeframeMatch[1]);
      const unit = timeframeMatch[2].toLowerCase();
      if (unit.startsWith('week'))       { phaseCount = Math.min(num, 12);             phaseLabel = 'Week';    }
      else if (unit.startsWith('month')) { phaseCount = Math.min(num, 12);             phaseLabel = 'Month';   }
      else if (unit.startsWith('year'))  { phaseCount = Math.min(num * 4, 12);         phaseLabel = 'Quarter'; }
      else if (unit.startsWith('day'))   { phaseCount = Math.min(Math.ceil(num / 7), 12); phaseLabel = 'Week'; }
    }

    // ── Knowledge directive ──────────────────────────────────────────────────
    const knowledgeDirective = KNOWLEDGE_DIRECTIVES[domainKnowledge] || KNOWLEDGE_DIRECTIVES.beginner;
    const knowledgeLabel     = KNOWLEDGE_LABELS[domainKnowledge]     || KNOWLEDGE_LABELS.beginner;

    // ── AI-powered intent reasoning + roadmap generation prompt ──────────────
    const systemContent = `You are ATLAS, an elite career and skills coach. You deeply analyze user goals and generate intelligent, outcome-aware roadmaps.

═══════════════════════════════════
STEP 1 — INTENT REASONING (do this internally, do NOT output):
═══════════════════════════════════
Before generating the roadmap, analyze the user's ENTIRE goal sentence.

Infer the REAL desired outcome behind the user's goal.

Determine:
- what success actually means
- what real-world capability they want
- what practical outcome they expect
- what hidden requirements exist
- what would realistically be required to achieve this outcome

The roadmap must prepare them for the REAL outcome, not just the surface topic.

Examples:
- A "job-ready" goal implies employability, portfolio work, interview readiness, practical experience, and real-world simulation
- A "build an app" goal implies architecture, implementation, deployment, debugging, and project completion
- A certification goal implies exam preparation and test readiness
- A "get fit" goal implies progressive overload, measurable milestones, and lifestyle change

Do NOT blindly keyword-match.
Reason about the actual intent behind the goal.

═══════════════════════════════════
STEP 2 — ROADMAP GENERATION:
═══════════════════════════════════

USER GOAL: "${goalText}"
AVAILABLE TIME PER DAY: "${user.available_time || '1 hour'}"
TIMEFRAME: ${timeframe}
PHASES TO GENERATE: ${phaseCount} ${phaseLabel}s
USER KNOWLEDGE LEVEL: ${knowledgeLabel}
USER STRUGGLE: "${user.biggest_struggle || 'staying consistent'}"

═══════════════════════════════════
BEHAVIORAL PACING (OVERRIDES ALL ELSE):
═══════════════════════════════════
- Pacing: ${behaviorProfile.pacing}
- Difficulty cap: ${behaviorProfile.difficultyCap}
- ${behaviorProfile.preferQuickWins ? 'Include quick wins in early phases to build confidence' : ''}
- ${behaviorProfile.avoidAdvancedTopics ? 'STRICTLY avoid advanced topics in all phases — user is not ready' : ''}
- ${behaviorProfile.directives.join('\n- ')}

═══════════════════════════════════
KNOWLEDGE DIRECTIVE:
═══════════════════════════════════
${knowledgeDirective}

═══════════════════════════════════
ROADMAP RULES:
═══════════════════════════════════
- The roadmap MUST reflect the user's ENTIRE goal sentence, not just the topic keyword
- NEVER use generic phrases like "learn basics" or "practice skills" — every phase must name specific tools, technologies, or concrete actions
- Keep the EXACT user goal in the title — never shorten it
- Keep each phase concise but concrete. Maximum 20-35 words per phase.
- Phase 1 difficulty must be "${behaviorProfile.difficultyCap}"
- BLOCKED TOPICS: ${behaviorProfile.blockedTopics.join(', ') || 'none'} — NEVER include these in any phase
- Each phase must be a logical stepping stone toward the FINAL OUTCOME, not just a topic list
- The final phase should prepare the user for what comes AFTER the roadmap (job, certification, real-world application, etc.)

OUTPUT — Respond with ONLY this JSON (no other text):
{
  "roadmap_text": "🗺️ *Your Roadmap — ${goalText.trim()}:*\n*${phaseLabel} 1: [Specific Phase Name]* — [2 sentences with concrete tools/skills/actions and how they connect to the outcome]\n...",
  "roadmap_json": {
    "phases": [
      {
        "phase_index": 1,
        "phase_name": "Specific Phase Name",
        "difficulty": "easy | medium | hard",
        "allowed_topics": ["specific topic 1", "specific tool 1"],
        "blocked_topics": ${JSON.stringify(behaviorProfile.blockedTopics)},
        "completion_requirements": ["concrete deliverable 1", "concrete deliverable 2"]
      }
    ]
  }
}`;

    // ── AI call ──────────────────────────────────────────────────────────────
    let result;
    try {
      const raw = await aiOrchestrator.execute(
        [{ role: 'system', content: systemContent }],
        { temperature: 0.3, maxTokens: 1500 }
      );
      logger.info(`[RoadmapGenerator] AI response received for user ${telegramId}`);
      result = this._parseAIResponse(raw);
    } catch (err) {
      logger.error(`[RoadmapGenerator] AI call failed for user ${telegramId}:`, err);
      result = this._buildFallback(goalText, phaseCount, phaseLabel, behaviorProfile);
    }

    if (
      !result ||
      !result.roadmap_text ||
      !result.roadmap_json ||
      !Array.isArray(result.roadmap_json.phases) ||
      result.roadmap_json.phases.length === 0
    ) {
      logger.warn(`[RoadmapGenerator] Invalid AI response, using fallback for user ${telegramId}`);
      result = this._buildFallback(goalText, phaseCount, phaseLabel, behaviorProfile);
    }

    result.roadmap_json.current_phase_index = 1;

    // Save roadmap text directly to the roadmap column via updateOnboardingState
    await userQueries.updateOnboardingState(telegramId, 'completed', {
      roadmap: result.roadmap_text.trim(),
    });
    await userQueries.saveRoadmapJson(telegramId, result.roadmap_json);
    logger.info(`[RoadmapGenerator] Roadmap text + JSON saved for user ${telegramId}`);

    return result.roadmap_text.trim();
  },

  _parseAIResponse(raw) {
    if (!raw || typeof raw !== 'string') return null;

    try {
      return JSON.parse(raw.trim());
    } catch {}

    try {
      const cleaned = raw
        .replace(/```json/g, '')
        .replace(/```/g, '')
        .trim();

      const first = cleaned.indexOf('{');
      const last = cleaned.lastIndexOf('}');

      if (first === -1 || last === -1) return null;

            let jsonString = cleaned.slice(first, last + 1);

      // Remove trailing commas before } or ]
      jsonString = jsonString.replace(/,\s*}/g, '}');
      jsonString = jsonString.replace(/,\s*]/g, ']');

      // Escape raw newlines/tabs inside JSON strings (Groq sometimes returns these)
      jsonString = jsonString.replace(/\n/g, '\\n');
      jsonString = jsonString.replace(/\r/g, '\\r');
      jsonString = jsonString.replace(/\t/g, '\\t');

      return JSON.parse(jsonString);
    } catch (err) {
      logger.error('[RoadmapGenerator] Failed parsing AI JSON:', err);
      return null;
    }
  },

  _buildFallback(goalText, phaseCount, phaseLabel, behaviorProfile) {
    const cap = behaviorProfile?.difficultyCap || 'medium';

    // Infer domain from goal text for better fallback quality
    const inferredDomain = goalText
      .replace(/become|learn|master|get|job ready|in \d+ months?/gi, '')
      .trim();

    // Detect if goal implies career/job readiness for better fallback
    const lowerGoal = goalText.toLowerCase();
    const isCareerGoal = /job\s*ready|get hired|become a|certif|career|freelance|internship|interview|resume|portfolio|salary|role|position/i.test(lowerGoal);

    const fallbackNames = [
      'Foundations & Core Concepts',
      'Building Practical Skills',
      'Applied Projects & Practice',
      'Advanced Techniques',
      'Portfolio & Real-World Application',
      'Mastery & Review'
    ];

    const phases = [];

    for (let i = 0; i < phaseCount; i++) {
      const isLast = i === phaseCount - 1;

      let phaseName = fallbackNames[i] || `Phase ${i + 1}`;

      let requirements = [
        `Complete phase ${i + 1} exercises`,
        'Demonstrate understanding through practice'
      ];

      // If career goal and last phase, include career-prep deliverables
      if (isCareerGoal && isLast) {
        phaseName = 'Career Preparation & Portfolio';
        requirements = [
          'Build a portfolio project showcasing your skills',
          'Prepare resume and LinkedIn profile',
          'Complete 3 mock interviews or practical assessments',
          'Apply to at least 5 target positions or submit 3 proposals'
        ];
      }

      // FIX: Difficulty scaling that respects the user's difficulty cap
      let phaseDifficulty = cap;

      if (cap === 'easy' || cap === 'beginner') {
        phaseDifficulty = i < phaseCount * 0.7 ? 'easy' : 'medium';
      } else if (cap === 'medium' || cap === 'basic') {
        phaseDifficulty = i < phaseCount * 0.5 ? 'medium' : 'hard';
      } else {
        phaseDifficulty = 'hard';
      }

      phases.push({
        phase_index: i + 1,
        phase_name: phaseName,
        difficulty: phaseDifficulty,
        allowed_topics: [], // empty = task AI reasons about real prerequisites instead of a meaningless label
        blocked_topics: behaviorProfile?.blockedTopics || [],
        completion_requirements: requirements,
      });
    }

    const roadmapText = `🗺️ *Your Roadmap — ${goalText.trim()}:*\n` +
      phases.map(p => `*${phaseLabel} ${p.phase_index}: ${p.phase_name}* — Focus on building core skills through structured practice and hands-on exercises${isCareerGoal && p.phase_index === phaseCount ? '. Includes interview prep and portfolio building for job readiness' : ''}.`)
        .join('\n');

    return {
      roadmap_text: roadmapText,
      roadmap_json: { phases, current_phase_index: 1 },
    };
  },
};

module.exports = roadmapGenerator;