// src/services/ai/conversationEngine.js
const aiOrchestrator = require('./aiOrchestrator');
const userQueries = require('../../database/queries/userQueries');
const taskQueries = require('../../database/queries/taskQueries');
const memoryService = require('../memory/memoryService');
const logger = require('../../utils/logger');
const { supabase } = require('../../config/supabase');

class ConversationEngine {
  // ─── Conversation History ───────────────────────────────────────────────────

  async getHistory(userId, limit = 10) {
    try {
      const { data, error } = await supabase
        .from('conversation_history')
        .select('role, content, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (error) throw error;
      return (data || []).reverse(); // chronological order
    } catch (error) {
      logger.error(`Failed to get conversation history for user ${userId}:`, error);
      return [];
    }
  }

  async appendHistory(userId, role, content) {
    const shouldSkipMemory = (content) => {
      if (!content) return true;

      const lower = content.toLowerCase();

      const garbagePatterns = [
        '📋',
        '✅ completed',
        '⏳',
        'generated tasks',
        'here are your tasks',
        'want me to generate',
        'great job',
        'keep going',
        'you got this',
        'inline_keyboard',
        'parse_mode',
        'use /today',
        'tasks for today',
        'mainmenu',
        'taskactions'
      ];

      return garbagePatterns.some(p => lower.includes(p.toLowerCase()));
    };

    if (shouldSkipMemory(content)) {
      return;
    }
    try {
      const { error } = await supabase
        .from('conversation_history')
        .insert({ user_id: userId, role, content });

      if (error) throw error;
    } catch (error) {
      logger.error(`Failed to append conversation history:`, error);
    }
  }

  async clearOldHistory(userId) {
    // Keep only last 50 messages per user to avoid DB bloat
    try {
      const { data } = await supabase
        .from('conversation_history')
        .select('id')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(100);

      if (data && data.length >= 50) {
        const idsToDelete = data.slice(50).map(r => r.id);
        await supabase
          .from('conversation_history')
          .delete()
          .in('id', idsToDelete);
      }
    } catch (error) {
      logger.error(`Failed to clear old history for user ${userId}:`, error);
    }
  }


  async generateTasksFromContext(structuredContext, user) {
  try {
    const effectiveTime = structuredContext.effective_time || user.available_time || '2 hours';

    const recentConvo = user._recent_messages
        ? `\nRECENT CONVERSATION (what the user said lately — use this to calibrate tasks):\n${user._recent_messages}\n`
        : '';

      const lifeContext = user.life_struggle
        ? `\n- Life obstacle: "${user.life_struggle}" — factor into pacing`
        : '';

      const roadmapContext = user.roadmap
        ? `\n- Roadmap phase: ${user._roadmap_phase || 'Month 1'}\n- Full roadmap:\n${user.roadmap}`
        : `\n- Roadmap phase: ${user._roadmap_phase || 'Month 1'}`;

const knowledgeLevelDirective = (() => {
  const level = user.domain_knowledge || 'beginner';
    if (level === 'beginner') return `
KNOWLEDGE LEVEL: COMPLETE BEGINNER — HIGHEST PRIORITY RULES:
- Reason about what prerequisite knowledge this specific goal requires before the user can even begin
- Do NOT start with the goal domain directly — identify the dependency chain first and start there
- Example logic: goal=SOC analyst → needs networking basics first. goal=iOS dev → needs Swift syntax first. goal=marathon → needs base fitness assessment first. Apply this reasoning to ANY goal
- Never assign tasks that name tools, platforms, or advanced concepts the user hasn't been introduced to yet
- Every task must teach one specific, named concept — never "explore resources", "watch videos about X", or "browse websites"
- Tasks must say WHAT to learn, not WHERE to find it
- No tool installation, lab setup, or configuration of any kind
- All tasks difficulty: easy`;
        if (level === 'basic') return `
KNOWLEDGE LEVEL: BASIC UNDERSTANDING:
- User knows core concepts but lacks hands-on experience
- Identify the most critical foundational gap and address it first
- Introduce tools with a one-line explanation before assigning tasks that use them
- One practical exercise per session is acceptable
- Avoid skipping prerequisite steps`;
        if (level === 'intermediate') return `
KNOWLEDGE LEVEL: INTERMEDIATE:
- User has real hands-on experience
- Skip definitions and basics entirely
- Assign practical, output-producing tasks from task 1
- Tools and implementation are expected`;
        if (level === 'advanced') return `
KNOWLEDGE LEVEL: ADVANCED:
- User has deep expertise
- Skip all fundamentals — go straight to mastery-level implementation
- Use technical terminology freely
- Focus on optimization, real-world application, and edge cases`;
        return '';
      })();

const systemPrompt = `You are ATLAS, a personal accountability assistant.

USER PROFILE:
- Goal: ${user.goal}
- Available time today: ${effectiveTime} — THIS IS A HARD LIMIT
- Domain knowledge: ${user.domain_knowledge || 'beginner'}
- Biggest struggle: ${user.biggest_struggle || 'staying consistent'}${lifeContext}
- Focus area: ${structuredContext.focus_area || 'general'}${roadmapContext}
${recentConvo}
${knowledgeLevelDirective}

EXISTING TASKS (do not duplicate):
${structuredContext.existing_task_titles?.length > 0 ? structuredContext.existing_task_titles.join('\n') : 'None'}

TASK GENERATION RULES:
1. Generate 3-5 tasks MAXIMUM
2. Total estimated_time across ALL tasks MUST NOT exceed ${effectiveTime}
3. Each task must have a realistic estimated_time in minutes or hours
4. Sum all task times before responding — if over limit, reduce task count or shorten tasks
5. Tasks must be specific, actionable, and directly tied to the user's goal
6. No journaling, reflection, or motivational writing tasks
7. Prefer real output-producing work
8. NEVER assign "watch videos", "explore resources", or "browse websites" as tasks

Return ONLY valid JSON array, no extra text:
[
  {
    "title": "",
    "description": "",
    "why_it_matters": "",
    "estimated_time": "",
    "difficulty_level": "easy|medium|hard"
  }
]`;

    const messages = [{ role: 'user', content: systemPrompt }];

    const result = await aiOrchestrator.executeJson(
      messages,
      { temperature: 0.7, maxTokens: 1200 },
      'groq'
    );

    // executeJson may return array directly or wrapped in {tasks:[]}
    const tasks = Array.isArray(result) ? result : (result?.tasks || []);
    return { tasks };

  } catch (error) {
    logger.error('generateTasksFromContext failed:', error);
    return { tasks: [] };
  }
}
  // ─── Goal Detection ─────────────────────────────────────────────────────────

  async detectGoalChange(userId, conversationHistory, currentGoal) {
    try {
      const recentMessages = conversationHistory
        .filter(m => m.role === 'user')
        .slice(-5)
        .map(m => m.content)
        .join('\n');

      if (!recentMessages) return null;

      const messages = [
        {
          role: 'system',
          content: `Analyze if the user is expressing a NEW goal or significantly different direction from their current goal.

Current goal: "${currentGoal}"

Recent messages:
${recentMessages}

Rules:
- Only return a new goal if the user is CLEARLY stating they want to pursue something different
- Casual mentions of topics are NOT goal changes
- Phrases like "I want to focus on X now", "my new goal is X", "I've decided to work on X instead", "prepare me for X" signal a goal change
- Return null if no clear goal change

Respond ONLY with JSON:
{"new_goal": "clearly stated new goal" | null, "confidence": 0.0-1.0}`
        }
      ];

      const result = await aiOrchestrator.executeJson(messages, { temperature: 0.1, maxTokens: 100 });
      const needsClarification =
        result.confidence < 0.75 ||
        result.context?.ambiguous === true;

      result.needs_clarification = needsClarification;
      if (result.new_goal && result.confidence > 0.85) {
        return result.new_goal;
      }
      return null;
    } catch (error) {
      logger.error(`Goal detection failed:`, error);
      return null;
    }
  }

  // ─── Dynamic Task Generation ────────────────────────────────────────────────

  async generateTasksFromConversation(userId, conversationHistory, user, overrideGoal = null) {
    try {
      const goalToUse = overrideGoal || user.goal;
      const recentUserMessages = conversationHistory
        .filter(m => m.role === 'user')
        .slice(-10)
        .map(m => m.content);

      const meaningfulMessages = recentUserMessages.filter(msg => {
        const lower = msg.toLowerCase();

        return (
          lower.includes('want') ||
          lower.includes('goal') ||
          lower.includes('learn') ||
          lower.includes('build') ||
          lower.includes('focus') ||
          lower.includes('become') ||
          lower.includes('improve')
        );
      });

      const structuredContext = {
        current_goal: goalToUse,
        meaningful_context: meaningfulMessages,
        available_time: user.available_time,
        personality: user.personality_type
      };


      const memory = await memoryService.getActiveMemory(userId);

      const messages = [
        {
          role: 'system',
          content: `You are ATLAS generating personalized tasks based on a real conversation.
Relevant User Intent:
${structuredContext.meaningful_context.join('\n')}

Goal:
${structuredContext.current_goal}

Available Time:
${structuredContext.available_time}
User profile:
- Goal: ${goalToUse}
- Available time per day: ${user.available_time}
- Skill level/background: ${user.domain_knowledge || 'Not specified'}
- Biggest struggle: ${user.biggest_struggle}
- Behavioral memory: ${memory?.summary || 'New user'}


Generate 3-5 tasks that are:

1. DIRECTLY based on the user's TRUE intent
2. Execution-focused and practical
3. Appropriate for TODAY given their available time
4. Specific and actionable — not generic
5. Avoid generic self-improvement filler
6. Avoid fake productivity tasks like:
   - journaling
   - brainstorming random ideas
   - reflection exercises
   - motivational writing
   - AI prompt generation
7. Prefer REAL output-producing tasks
8. Distinguish carefully between:
   - actual goals
   - side comments
   - environment/device mentions
9. If user mentions tools/devices casually, DO NOT make tasks about them unless explicitly requested
10. If the user wants to write a novel, generate actual novel-writing tasks, scene-building tasks, plot tasks, character tasks, drafting tasks, editing tasks, outlining tasks, etc.
If the conversation discussed a specific topic (e.g., "networking", "React hooks", "system design"), generate tasks ABOUT THAT SPECIFIC TOPIC.

Respond ONLY with valid JSON:
{
  "tasks": [
    {
      "title": "Specific actionable title",
      "description": "Exact step-by-step instructions referencing the discussed topic",
      "why_it_matters": "Connection to their goal: ${goalToUse}",
      "estimated_time": "X minutes",
      "difficulty_level": "easy|medium|hard"
    }
  ],
  "task_theme": "brief description of what these tasks focus on"
}`
        }
      ];

      const result = await aiOrchestrator.executeJson(messages, { temperature: 0.3, maxTokens: 2000 });
      return result;
    } catch (error) {
      logger.error(`Conversation-based task generation failed:`, error);
      return null;
    }
  }

  // ─── Adaptive Response ──────────────────────────────────────────────────────

  async generateAdaptiveResponse(userMessage, conversationHistory, user, actionContext = null) {
    try {
      const historyMessages = (Array.isArray(conversationHistory)
        ? conversationHistory
        : []
      ).slice(-4).map(m => ({
        role: m.role,
        content: m.content,
      }));

     const systemPrompt = `You are ATLAS, a warm and deeply empathetic accountability partner. You genuinely care about the person you're talking to — not just their goals, but how they're actually feeling right now.

User profile:
- Name: ${user.first_name || 'there'}
- Goal: ${user.goal}
- Personality: ${user.personality_type || 'friendly'}
- Streak: ${user.current_streak} days
- Struggle: ${user.biggest_struggle}
- Available time: ${user.available_time}

How you speak:
- Warm, gentle, and human — never robotic or transactional
- You notice emotional cues and respond to feelings FIRST, then tasks
- You validate struggles without being patronizing or preachy
- You celebrate wins genuinely, not with hollow phrases like "great job!"
- You NEVER ask a follow-up question when the user is venting, expressing burnout, stress, anxiety, exhaustion, overwhelm, or seeking comfort/motivation. Just respond with warmth and close the message.
- You ask ONE thoughtful question ONLY when the user's task-related request is genuinely ambiguous (e.g., missing a topic for task generation).
- Casual conversation, emotional support, motivation requests: ZERO questions. Respond and stop.
- 2-4 sentences is usually right — longer only when they genuinely need more
- Never use bullet points or numbered lists in chat responses
- Never sound like a productivity app — sound like someone who actually cares about them
- NEVER end a response with a question during emotional conversations — detect emotional tone first, if present: validate, support, close.


Emotional awareness rules:
- If the user seems stressed, tired, overwhelmed or discouraged — acknowledge the feeling before anything else
- If they share something personal, respond with empathy before pivoting to goals
- If they missed tasks or broke their streak, be gentle — never judgmental
- If they're excited or winning, match their energy genuinely
- Never dismiss emotions with toxic positivity like "you got this!" or "keep going!"

Hard rules:
- NEVER generate task lists inside chat responses
- NEVER say "here are your tasks" unless the task pipeline actually ran
- NEVER pretend actions happened that didn't
- NEVER ask for confirmation more than once
- NEVER be robotic, mechanical, or generic

${actionContext ? `Current action context: ${JSON.stringify(actionContext)}` : ''}`;

      const messages = [
        { role: 'system', content: systemPrompt },
        ...historyMessages,
        { role: 'user', content: userMessage },
      ];

      const response = await aiOrchestrator.execute(messages, { temperature: 0.8, maxTokens: 400 });
      return response;
    } catch (error) {
      logger.error(`Adaptive response failed:`, error);
      return "I'm here! Could you tell me more about what you need?";
    }
  }

  // ─── Goal Update ────────────────────────────────────────────────────────────

  async updateUserGoal(telegramId, newGoals, conversationHistory) {
    try {
      // Generate motivation from conversation context
      const context = conversationHistory
        .slice(-5)
        .map(m => m.content)
        .join(' ');

      const messages = [
        {
          role: 'system',
          content: `Extract a motivation statement for this new goal based on the conversation context.
New goal: "${newGoals[0]}"
Conversation context: "${context}"
Return ONLY JSON: {"motivation": "why they want this goal in 1-2 sentences"}`
        }
      ];

      let motivation = `Working toward: ${newGoals[0]}`;
      try {
        const result = await aiOrchestrator.executeJson(messages, { temperature: 0.5, maxTokens: 100 });
        if (result.motivation) motivation = result.motivation;
      } catch (e) { /* use default */ }

      const existingUser = await userQueries.getUserByTelegramId(telegramId);

      const existingGoals = existingUser.secondary_goals || [];

      const normalizedExisting = existingGoals.map(
        g => g.toLowerCase()
      );

      const filteredNewGoals = newGoals.filter(
        g => !normalizedExisting.includes(g.toLowerCase())
      );

      const updatedGoals = [
        ...existingGoals,
        ...filteredNewGoals
      ];

      await userQueries.updateOnboardingState(
        telegramId,
        'completed',
        {
          goal: existingUser.goal || newGoals[0],
          secondary_goals: updatedGoals,
          motivation,
        }
      );

      logger.info(`Goal updated for user ${telegramId}: ${newGoals[0]}`);
      return { success: true, motivation };
    } catch (error) {
      logger.error(`Goal update failed for ${telegramId}:`, error);
      return { success: false };
    }
  }

  async generateClarificationQuestion(userMessage, actionResult, user) {
    try {

      const messages = [
        {
          role: 'system',
          content: `
The user's request is ambiguous.

User profile:
- Goal: ${user.goal}
- Available time: ${user.available_time}

User message:
"${userMessage}"

Detected intent:
${JSON.stringify(actionResult)}

Generate ONE natural clarification question.

RULES:
- DO NOT assume what the user wants
- DO NOT generate tasks
- DO NOT make decisions yet
- Ask concise questions
- Give options if useful
- Sound conversational
- Maximum 2 sentences

GOOD:
"I noticed you mentioned two goals. Do you want me to:
1. Combine both goals
2. Prioritize one
3. Generate separate plans?"

BAD:
"Great! Here are your tasks..."
`
        }
      ];

      const response = await aiOrchestrator.execute(messages, {
        temperature: 0.4,
        maxTokens: 120
      });

      return response;

    } catch (error) {
      logger.error('Clarification generation failed:', error);

      return 'Can you clarify exactly what you want me to do?';
    }
  }

}

module.exports = new ConversationEngine();