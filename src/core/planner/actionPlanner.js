// src/core/planner/actionPlanner.js
const aiOrchestrator = require('../../services/ai/aiOrchestrator');
const ACTIONS = require('../actions/actionTypes');
const logger = require('../../utils/logger');
const { sanitizeForPrompt } = require('../../utils/promptSanitizer');


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

// Conversational openers, social noise, and emotional statements. These carry no
// action, so routing them through the AI intent classifier only adds latency and
// a chance of being forced into a task intent by a prompt whose job is finding
// task intents. Matched here, they go straight to chat.
//
// Deliberately anchored and narrow: it must never swallow a real request. "hi"
// matches; "hi, delete task 3" does not — the trailing clause fails the anchor,
// so it falls through to the normal path.
const CONVERSATIONAL_PATTERNS = [
  // Greetings and openers, with optional filler ("hey man", "yo atlas", "hi!!")
  /^(hi|hii+|hey+|heyy+|hello+|helo|yo|sup|wassup|whatsup|oi|hola|namaste)\b[\s!.,]*(there|man|bro|dude|buddy|atlas|bot)?[\s!.,?]*$/i,
  /^(good\s*(morning|afternoon|evening|night)|gm|gn)\b[\s!.,]*(atlas|man|bro)?[\s!.,?]*$/i,

  // "what's up" and its many spellings
  /^(what'?s?\s*up|whats\s*up|wass?up|wyd|what\s*you\s*doing|how'?s?\s*it\s*going|how\s*are\s*(you|u|ya)|how\s*(you\s*)?doin[g']?|you\s*(there|up|around)|u\s*(there|up))\b[\s!.,?]*(man|bro|dude|atlas)?[\s!.,?]*$/i,

  // Explicit requests to converse — the exact case that used to get a canned
  // "tell me more about what you need" instead of "sure, go ahead".
  /^(can|could|may)\s*(we|i)\s*(talk|chat|discuss|speak)\b.{0,40}$/i,
  // "wanna"/"gonna" already contain the "to", so it must be optional here.
  /^(i\s*)?(want|wanna|need|would\s*like)\s*(to\s*)?(talk|chat|discuss|speak|vent|ask)\b.{0,40}$/i,
  /^(let'?s|lets)\s*(talk|chat|discuss)\b.{0,40}$/i,
  /^(you\s*)?(free|available|busy)\s*(to\s*(talk|chat))?[\s?!.]*$/i,
  /^(are\s*you|r\s*u)\s*(there|awake|alive|online|real)[\s?!.]*$/i,

  // Dropping the thread / brushing it off
  /^(never\s*mind|nevermind|nvm|forget\s*it|forget\s*that|no\s*worries|it'?s?\s*fine|leave\s*it|drop\s*it)\b[\s!.,]*(lol|lmao|haha|😂)?[\s!.,?]*$/i,

  // Pure social acknowledgement — no action to take
  /^(thanks+|thank\s*you|thx|ty|tysm|appreciate\s*(it|you))\b[\s!.,]*(man|bro|dude|atlas|a\s*lot|so\s*much)?[\s!.,?]*$/i,
  /^(ok|okay|okey|k|kk|cool|nice|great|awesome|sweet|alright|aight|got\s*it|gotcha|understood|sure|yep|yeah|yup|fine)\b[\s!.,]*$/i,
  /^(bye|goodbye|cya|see\s*(you|ya)|good\s*night|gn|later|ttyl|peace)\b[\s!.,]*(man|bro|atlas)?[\s!.,?]*$/i,
  /^(lol|lmao|lmfao|haha+|hehe+|hah|😂|🤣|😅|👍|❤️|🔥)[\s!.,]*$/i,

  // Asking about ATLAS itself, or about the conversation so far. These read as
  // "show me something" to a task classifier; they're conversation.
  /^(who|what)\s*(are|r)\s*(you|u)\b.{0,30}$/i,
  /^(do|d)\s*(you|u)\s*(remember|recall)\b.{0,80}$/i,
  /^(what|when)\s*(did|do)\s*we\s*(talk|discuss|speak|say)\b.{0,80}$/i,
  /^(what|when)\s*was\s*the\s*last\s*time\s*we\b.{0,60}$/i,
];

// Anything naming the user's task list, goal, or plan might be a real request
// dressed as conversation — "I'm frustrated with these tasks" means "give me
// easier ones", which is GENERATE_TASKS, not chat. The pattern groups below are
// only consulted when NONE of these words appear, so an ambiguous message keeps
// its trip through the AI classifier and its chance at an action intent.
const TASK_SURFACE = /\b(task|tasks|todo|to-?do|goal|goals|roadmap|plan|planner|streak|progress|deadline|schedule|resources?|easier|harder|simplify|beginner|delete|remove|generate|create|swap|replace|update|assign)\b/i;

// Venting and mood. These have no action in them, but a classifier whose job is
// finding task intents will reach for one anyway — "today was terrible" reads as
// a complaint about the task list if you are looking for complaints.
const EMOTIONAL_PATTERNS = [
  /^(i'?m?|i\s*am|im)\s*(so|really|kinda|kind\s*of|pretty|very|super|feeling|just)?\s*(tired|exhausted|drained|burnt?\s*out|stressed|anxious|sad|down|low|depressed|frustrated|overwhelmed|lost|stuck|bored|lonely|angry|upset|nervous|scared|worried|unmotivated|demotivated|lazy|fine|good|okay|ok|great)\b.{0,60}$/i,
  /^(today|yesterday|this\s*week|last\s*night|my\s*day|my\s*week)\s*(was|has\s*been|is)\b.{0,60}$/i,
  /^(my|the)\s*(day|week|mood|head|brain)\s*(was|is|has\s*been)\b.{0,50}$/i,
  /^(this|that|it|everything|life)\s*(is|was)\s*(so\s*|really\s*|kinda\s*)?(hard|tough|difficult|terrible|awful|bad|rough|sucks?|exhausting|frustrating|annoying|boring|confusing|great|good|awesome|amazing|fine)\b.{0,40}$/i,
  /^(i\s*)?(feel|felt|feeling)\b.{0,60}$/i,
  /^(that|this)\s*(sounds?|seems?|looks?|feels?)\b.{0,50}$/i,
];

// Bare follow-ups. They only mean anything against the previous turn, which is
// exactly what the chat path has and the classifier does not.
const FOLLOWUP_PATTERNS = [
  /^(why|how)\s*(come|so|then)?[\s?!.]*$/i,
  /^(why|how)\s*(does|do|would|will|is|are|did)\s*(that|this|it|those|these)\b.{0,40}$/i,
  /^(what|who|which)\s*(do|does|did)\s*(you|u)\s*mean\b.{0,40}$/i,
  /^(explain|elaborate|expand\s*on|clarify)\s*(that|it|this|more|further|please)?[\s?!.]*$/i,
  /^(go\s*on|and\s*then|then\s*what|and|so|really|seriously|for\s*real|no\s*way|makes\s*sense|i\s*see|ah+|oh+|hmm+|wait|huh)[\s?!.]*$/i,
  /^(the|that)\s*(thing|one|stuff|part|bit)\s*(from|we|i|you|u)\b.{0,50}$/i,
  /^(idk|i\s*dun+o|i\s*don'?t\s*know|not\s*sure|maybe|nah|dunno)\b[\s?!.,]*$/i,
];

// Real speech opens with filler: "man today was terrible", "ugh im so tired",
// "honestly idk". Stripping the vocative once here beats threading an optional
// prefix group through every pattern below. The `$` alternative lets the filler
// BE the whole message ("ugh", "well…") — those are chat too.
const LEADING_FILLER = /^(?:(?:man|bro|dude|buddy|atlas|hey|yo|ugh+|ah+|oh+|aw+|damn|honestly|tbh|ngl|frfr|lol|well|so|but|and|okay|ok|yeah|yep|nah|hmm+)(?:[\s,!.]+|$))+/i;

function isConversational(message) {
  const trimmed = message.trim();
  // Long messages are substantive by definition — let the real classifier read
  // them rather than pattern-matching a prefix.
  if (trimmed.length > 90) return false;
  if (CONVERSATIONAL_PATTERNS.some(re => re.test(trimmed))) return true;

  // Mood and bare follow-ups are chat only when the message says nothing about
  // their tasks or goal. "i'm frustrated" is chat; "i'm frustrated with these
  // tasks" is a request for different ones, so it keeps going to the classifier.
  if (TASK_SURFACE.test(trimmed)) return false;

  const stripped = trimmed.replace(LEADING_FILLER, '').trim();
  if (!stripped) return true; // the whole message was filler — "ugh", "well..."
  return (
    EMOTIONAL_PATTERNS.some(re => re.test(stripped)) ||
    FOLLOWUP_PATTERNS.some(re => re.test(stripped))
  );
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

  // Conversational openers, social noise, emotional statements, memory
  // questions. Checked AFTER every action pattern above, so a real request is
  // never mistaken for chatter.
  if (isConversational(message))
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

    // 2. Build context summary for AI — give it everything it needs.
    // task titles + history + the live message are all user-controlled and this
    // prompt is sent as a single user-role blob (no separate <user_data> block),
    // so sanitizeForPrompt is the ONLY injection defense on this path (BUG-008).
    const taskSummary = context.tasks && context.tasks.length > 0
      ? context.tasks.map((t, i) => `${i + 1}. ${sanitizeForPrompt(t.title, 200)} (${t.status})`).join('\n')
      : 'No tasks today';

    const recentHistory = context.history && context.history.length > 0
      ? context.history.slice(-4).map(h => `${h.role}: ${sanitizeForPrompt(h.content, 500)}`).join('\n')
      : 'No recent conversation';

    try {
      // Kept deliberately tight. This prompt runs on every message the local
      // classifier cannot resolve, so its size is a per-user-message tax: the
      // long version was 943 tokens — larger than the chat reply it precedes —
      // and most of that was worked examples for phrasings _localClassify now
      // matches for free. What has to stay is the intent list (the decision),
      // the task list and recent turns (needed to resolve "task 3" and "that
      // one"), and the JSON envelope the parser below expects.
      const prompt = `Classify the user's intent for ATLAS, a personal goal assistant bot.

TASKS TODAY (${context.taskCount}):
${taskSummary}

RECENT CONVERSATION:
${recentHistory}

MESSAGE: "${sanitizeForPrompt(message, 2000)}"

INTENTS — pick exactly one:
GENERATE_TASKS — wants new, different, easier, harder, beginner, or free-resource tasks, or tasks on a topic → focus_area
SHOW_TASKS — wants to see today's tasks
ADD_TASK — names one specific thing they intend to do → description
DELETE_TASK — one task by number → task_number
DELETE_TASKS — all or several tasks → task_number "1,2" or target "all"
UPDATE_TASK — replace or change task N with something else → task_number + new_title
UPDATE_GOALS — wants a different goal → goal
SHOW_GOAL — wants to see their current goal
SHOW_PROGRESS — stats, streak, completion rate, "how am i doing"
GENERAL_CHAT — conversation, questions, advice, venting, anything else

Read RECENT CONVERSATION to resolve references like "that one" or "the second one".
Any complaint about the current tasks that implies wanting different ones is
GENERATE_TASKS. When genuinely unsure, choose GENERAL_CHAT: replying costs
nothing, while a wrong action edits their real data.

Return ONLY this JSON, no other text:
{"intent":"<INTENT>","confidence":<0.0-1.0>,"requires_confirmation":false,"payload":{"description":null,"task_number":null,"new_title":null,"target":null,"goal":null,"focus_area":null},"clarification_question":null}`;

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