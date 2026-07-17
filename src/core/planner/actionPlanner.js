// src/core/planner/actionPlanner.js
const aiOrchestrator = require('../../services/ai/aiOrchestrator');
const ACTIONS = require('../actions/actionTypes');
const logger = require('../../utils/logger');


function extractTimeConstraint(text = '') {
  const lower = text.toLowerCase();

  const patterns = [
    /(\d+)\s*(hour|hours|hr|hrs)/,
    /(\d+)\s*(minute|minutes|min|mins)/
  ];

  for (const pattern of patterns) {
    const match = lower.match(pattern);

    if (match) {
      return {
        value: parseInt(match[1]),
        unit:
          match[2].startsWith('h')
            ? 'hours'
            : 'minutes'
      };
    }
  }

  return null;
}

class ActionPlanner {

  // Fast local pre-classifier — handles obvious intents without AI call
 // REPLACE the _localClassify method in src/core/planner/actionPlanner.js
// Everything else in the file stays identical.

_localClassify(message) {
  const lower = message.toLowerCase().trim();

  // ─── SLASH COMMANDS (highest priority) ────────────────────────────────────
  if (lower === '/today' || lower === '/start')
    return { intent: ACTIONS.SHOW_TASKS, confidence: 1.0, payload: {} };

  if (lower === '/progress')
    return { intent: ACTIONS.SHOW_PROGRESS, confidence: 1.0, payload: {} };

  if (lower === '/stats')
    return { intent: ACTIONS.SHOW_PROGRESS, confidence: 1.0, payload: {} };

  if (lower === '/review')
    return { intent: ACTIONS.SHOW_PROGRESS, confidence: 1.0, payload: {} };

  if (lower === '/goal')
    return { intent: ACTIONS.SHOW_GOAL, confidence: 1.0, payload: {} };

  if (lower === '/help')
    return { intent: ACTIONS.GENERAL_CHAT, confidence: 1.0, payload: {} };

  // Progress intent
  if (
    /\b(my progress|show progress|show my progress|how am i doing|how have i been doing|my stats|completion rate|how many tasks|did i finish)\b/i.test(lower) ||
    lower === 'progress'
  ) {
    return { intent: ACTIONS.SHOW_PROGRESS, confidence: 1.0, payload: {} };
  }

  // Exact command shortcuts
  if (/^(show|show tasks|show my tasks|my tasks|list tasks|what are my tasks|show all tasks)$/i.test(lower))
    return { intent: ACTIONS.SHOW_TASKS, confidence: 1.0, payload: {} };

  if (/^(show my goal|what('s| is) my goal|show goal|my goal|current goal)$/i.test(lower))
    return { intent: ACTIONS.SHOW_GOAL, confidence: 1.0, payload: {} };

  if (/^(generate tasks?|make tasks?|create tasks?|new tasks?)$/i.test(lower))
    return { intent: ACTIONS.GENERATE_TASKS, confidence: 1.0, payload: {} };

  if (/^(hello|hi|hey|what's up|sup)$/i.test(lower))
    return { intent: ACTIONS.GENERAL_CHAT, confidence: 1.0, payload: {} };

  // Time constraint
  const timeConstraint = lower.match(
    /(?:only|just|i have|have only|got only)?\s*(\d+(?:\.\d+)?)\s*(hour|hr|minute|min)s?\b/
  );
  if (timeConstraint && /\b(only|just|limit|available|left|today|free|spare)\b/.test(lower)) {
    const value = parseFloat(timeConstraint[1]);
    const unit = timeConstraint[2].startsWith('min') ? 'minutes' : 'hours';
    return {
      intent: ACTIONS.GENERATE_TASKS,
      confidence: 0.9,
      payload: { focus_area: null, time_constraint: { value, unit } }
    };
  }

  // Delete multi
  const deleteMulti = lower.match(
    /^(?:delete|remove)\s+(?:tasks?\s+)?((?:\d+[\s,and]*){2,})\s*(?:tasks?)?$/i
  );
  if (deleteMulti) {
    const nums = deleteMulti[1].split(/[\s,and]+/).map(n => parseInt(n)).filter(n => !isNaN(n));
    if (nums.length > 1) {
      return {
        intent: ACTIONS.DELETE_TASKS,
        confidence: 1.0,
        payload: { task_number: nums.join(','), target: null }
      };
    }
  }

  // Delete single
  const deleteSingle = lower.match(/^(?:delete|remove)\s+(?:tasks?\s*#?)?(\d+)$/i);
  if (deleteSingle)
    return {
      intent: ACTIONS.DELETE_TASK,
      confidence: 1.0,
      payload: { task_number: parseInt(deleteSingle[1]), target: null }
    };

  // Delete all
  if (/delete all|remove all|clear all|clear my tasks|delete everything/i.test(lower))
    return {
      intent: ACTIONS.DELETE_TASKS,
      confidence: 1.0,
      payload: { task_number: null, target: 'all' }
    };

  // Replace/update task
  const replaceTask = message.trim().match(
    /(?:replace|swap|change|update)\s+(?:the\s+)?task\s+(?:number\s+)?(\d+)\s+(?:with|to)\s+(.+)/i
  );
  if (replaceTask) {
    logger.info(`_localClassify matched UPDATE_TASK: task ${replaceTask[1]} → ${replaceTask[2]}`);
    return {
      intent: ACTIONS.UPDATE_TASK,
      confidence: 1.0,
      payload: {
        task_number: parseInt(replaceTask[1]),
        new_title: replaceTask[2].trim(),
      }
    };
  }

  // Add task inline
  const addTaskInline = lower.match(/^add\s+tasks?\s+(.+)$/is);
  if (addTaskInline) {
    return {
      intent: ACTIONS.ADD_TASK,
      confidence: 1.0,
      payload: { description: addTaskInline[1].trim() }
    };
  }

  // Add task multiline
  if (/^add\s+tasks?$/im.test(lower) || /^add\s+tasks?\s*\n/im.test(lower)) {
    const withoutPrefix = message.replace(/^add\s+tasks?\s*/im, '').trim();
    return {
      intent: ACTIONS.ADD_TASK,
      confidence: 1.0,
      payload: { description: withoutPrefix }
    };
  }

  return null;
}

  async plan(context) {
    const message = context.messageText;

    logger.info(`Planner.plan() received messageText: "${message}"`);

    if (!message || message.trim() === '') {
      return this._fallback();
    }
    // 1. Try local classifier first — zero latency for obvious intents
    const localResult = this._localClassify(message);
    if (localResult) {
      logger.info(`Planner: local classify → ${localResult.intent}`);
      return {
        ...localResult,
        requires_confirmation: false,
        clarification_question: null
      };
    }

    // 2. Build context summary for AI — give it everything it needs
    const taskSummary = context.tasks && context.tasks.length > 0
      ? context.tasks.map((t, i) => `${i + 1}. ${t.title} (${t.status})`).join('\n')
      : 'No tasks today';

    const recentHistory = context.history && context.history.length > 0
      ? context.history.slice(-4).map(h => `${h.role}: ${h.content}`).join('\n')
      : 'No recent conversation';

    try {
      const prompt = `You are an intent classifier for ATLAS, a personal goal assistant bot.

USER PROFILE:
- Name: ${context.user.first_name}
- Goal: ${context.user.goal}
- Streak: ${context.user.current_streak} days
- Personality: ${context.user.personality_type}

TODAY'S TASKS (${context.taskCount} total):
${taskSummary}

RECENT CONVERSATION:
${recentHistory}

CURRENT MESSAGE: "${message}"

AVAILABLE INTENTS:
- GENERATE_TASKS: User wants to create/generate new tasks
- SHOW_TASKS: User wants to see/view their tasks
- ADD_TASK: User wants to add one specific task (extract description)
- DELETE_TASK: User wants to delete one specific task (extract task_number)
- DELETE_TASKS: User wants to delete all/multiple tasks
- UPDATE_GOALS: User wants to change their goal
- SHOW_GOAL: User wants to see their current goal
- UPDATE_TASK: User wants to replace or change a specific task number with something new
- SHOW_PROGRESS: User wants to see their progress stats, completion rate, streak, or how they're doing today
- GENERAL_CHAT: Conversation, questions, advice, anything else


CLASSIFICATION RULES:
- Read the full conversation history — context matters more than the single message
- "delete task 3" → DELETE_TASK with task_number: 3
- "delete all" → DELETE_TASKS with target: "all"  
- "add task X" / "add X to my tasks" → ADD_TASK with description: X
- "generate tasks on X" / "give me X tasks" → GENERATE_TASKS with focus_area: X
- "change my goal to X" / "update goal" → UPDATE_GOALS with goal: X
- "show my goal" / "what is my goal" → SHOW_GOAL
- "replace task 3 with X" / "change task 2 to X" / "swap task 1 with X" → UPDATE_TASK with task_number: 3 and new_title: X
- "show progress" / "what is my progress" → SHOW_PROGRESS
- "show my progress" / "progress" / "how am i doing" / "my stats" → SHOW_PROGRESS
GENERATE_TASKS also applies when user says things like:
- "I want free resources" / "give me free stuff" / "these are expensive" → GENERATE_TASKS with focus_area: "free resources"
- "make easier tasks" / "too hard" / "simplify" → GENERATE_TASKS with focus_area: "easier tasks"  
- "give me beginner tasks" / "start from scratch" → GENERATE_TASKS with focus_area: "beginner level"
- "tasks for [specific topic]" / "focus on [X]" → GENERATE_TASKS with focus_area: X
- Any complaint about current tasks followed by wanting new ones → GENERATE_TASKS

ADD_TASK applies when:
- User describes ONE specific thing they want to do today
- "I need to call my client today" / "remind me to study chapter 3"
- Sounds like a personal to-do, not a request for AI to generate

GENERAL_CHAT applies when:
- User is asking questions, venting, having a conversation
- No clear action is implied
- Asking for advice without wanting tasks changed
- When genuinely ambiguous with no history context to resolve it

Return ONLY valid JSON, no extra text:
{
  "intent": "<INTENT>",
  "confidence": <0.0-1.0>,
  "requires_confirmation": false,
  "payload": {
    "description": null,
    "task_number": null,
    "new_title": null,
    "target": null,
    "goal": null,
    "focus_area": null
  },
  "clarification_question": null
}`;

      const response = await aiOrchestrator.execute(
        [{ role: 'user', content: prompt }],
        { temperature: 0.1, maxTokens: 300 },
        'groq'
      );

      const raw = typeof response === 'string'
        ? response
        : (response?.content?.[0]?.text || response?.content || JSON.stringify(response));

      const cleaned = raw.replace(/```json/g, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(cleaned);

      // Validate intent is known — fallback to GENERAL_CHAT if not
     const validIntents = [...Object.values(ACTIONS), 'UPDATE_TASK', 'SHOW_PROGRESS'];
      const intent = validIntents.includes(parsed.intent)
        ? parsed.intent
        : ACTIONS.GENERAL_CHAT;

      logger.info(`Planner: AI classify → ${intent} (confidence: ${parsed.confidence})`);

      return {
        intent,
        confidence: parsed.confidence || 0.5,
        requires_confirmation: false,
        payload: parsed.payload || {},
        clarification_question: parsed.clarification_question || null
      };

    } catch (error) {
      logger.error('Planner AI call failed:', error.message);
      return this._fallback();
    }
  }

  _fallback() {
    return {
      intent: ACTIONS.GENERAL_CHAT,
      confidence: 0.3,
      requires_confirmation: false,
      payload: {},
      clarification_question: null
    };
  }
}

module.exports = new ActionPlanner();