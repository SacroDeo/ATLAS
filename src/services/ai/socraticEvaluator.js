const aiOrchestrator = require('./aiOrchestrator');
const socraticQueries = require('../../database/queries/socraticQueries');
const taskQueries = require('../../database/queries/taskQueries');
const logger = require('../../utils/logger');

class SocraticEvaluator {
  async generateQuestion(taskId, userId) {
    try {
      const task = await taskQueries.getTaskById(taskId);
      
      const messages = [
        {
          role: 'system',
          content: `Task Title:
${task.title}

Task Description:
${task.description}

Generate ONE short practical understanding-check question.

STRICT RULES:
- Question MUST directly relate to the completed task
- Keep it simple and grounded
- DO NOT sound philosophical
- DO NOT sound like a literature professor
- DO NOT ask abstract interpretation questions
- DO NOT ask multi-part questions
- DO NOT ask huge paragraph questions
- Maximum 1 sentence
- Maximum 25 words
- Question should feel conversational

GOOD EXAMPLES:
- "What did you learn from using Splunk today?"
- "Why is XSS dangerous in web apps?"
- "What was hardest about today's coding task?"

BAD EXAMPLES:
- "How does this reshape your perception of reality?"
- "How might existential uncertainty influence..."
- Long hypothetical storytelling questions

Respond with JSON:
{
  "question": "question here",
  "expected_concepts": ["concept1", "concept2"]
}`
        }
      ];

      const result = await aiOrchestrator.executeJson(messages, { temperature: 0.8 });

      return result.question;
      
    } catch (error) {
      logger.error('Failed to generate Socratic question:', error);
      return null;
    }
  }
   
  async isDisengaged(text) {
  const lower = text.toLowerCase().trim();
  // Fast path for obvious short dismissals (saves an API call)
  if (lower.length <= 6 && ['no','nah','ok','okay','fine','sure','skip','idk','stop'].includes(lower)) {
    return true;
  }

  const messages = [
    {
      role: 'system',
      content: `You determine if a student is disengaged from a question.
Disengaged = they don't want to answer, are dismissing, confused, or giving a non-answer.
Engaged = they are genuinely attempting to answer even if wrong.
Reply ONLY with: true or false`
    },
    { role: 'user', content: text }
  ];

  try {
    const result = await aiOrchestrator.execute(messages, { temperature: 0, maxTokens: 5 });
    return result.trim().toLowerCase().startsWith('true');
  } catch {
    return false; // fail open — don't block the flow
  }
}

  async evaluateResponse(userId, question, userResponse, taskContext) {
  try {

    const lower = userResponse.toLowerCase().trim();

    const disengaged =
      lower === 'idk' ||
      lower === "i don't know" ||
      lower === "dont know" ||
      lower === 'no' ||
      lower === 'nah' ||
      lower === 'not sure' ||
      lower === 'skip' ||
      lower.includes("don't know");

    // HARD STOP
    if (disengaged) {
      return {
        understanding_level: 'none',
        evaluation: 'User disengaged or unsure.',
        follow_up_required: false,
        follow_up_question: null,
        recommendation: 'Review later with simpler explanations.',
      };
    }

    const evaluation = await aiOrchestrator.evaluateUnderstanding(
      question,
      userResponse,
      taskContext
    );

    return evaluation;

  } catch (error) {
    logger.error('Failed to evaluate Socratic response:', error);

    return {
      understanding_level: 'moderate',
      evaluation: 'Unable to evaluate response at this time.',
      follow_up_required: false,
      follow_up_question: null,
      recommendation: 'Continue with current approach.',
    };
  }
}

  async generateFollowUpQuestion(originalQuestion, userResponse, evaluation) {
    try {
      const messages = [
        {
          role: 'system',
          content: `Original question: "${originalQuestion}"

Student response: "${userResponse}"

Evaluation:
${JSON.stringify(evaluation)}

IMPORTANT RULES:

- NEVER create infinite follow-up chains
- NEVER ask more than ONE follow-up
- If the user seems disengaged, confused, or says:
  "idk"
  "i don't know"
  "dont know"
  "no"
  "not sure"
  "skip"

THEN RETURN:
{
  "question": null
}

- Follow-up questions MUST stay directly connected to the ORIGINAL task
- NEVER invent random hypothetical examples
- NEVER drift into unrelated creative storytelling
- Keep the same learning objective
- Keep the question short and natural
- If understanding is extremely weak, prefer returning null instead of forcing another question

Generate ONLY ONE grounded follow-up question.

Respond ONLY with JSON:
{
  "question": "Follow-up question here or null"
}`
        }
      ];

      const result = await aiOrchestrator.executeJson(messages);
      return result.question;
    } catch (error) {
      logger.error('Failed to generate follow-up question:', error);
      return null;
    }
  }

  async shouldAskSocratic(userId) {
    // Ask Socratic question for every 3rd completed task
    const recentLogs = await socraticQueries.getRecentLogs(userId, 5);
    const completedTasks = await taskQueries.getWeeklyTasks(
      userId,
      new Date(new Date().setDate(new Date().getDate() - 7)).toISOString().split('T')[0],
      new Date().toISOString().split('T')[0]
    );

    const completedCount = completedTasks.filter(t => t.status === 'completed').length;
    const socraticCount = recentLogs.length;

    // Ask if completed tasks are 3x more than socratic questions
    return completedCount >= (socraticCount + 1) * 3;
  }
}

module.exports = new SocraticEvaluator();