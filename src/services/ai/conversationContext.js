// src/services/ai/conversationContext.js
//
// Turns raw conversation_history rows into the two things a chat prompt needs:
//
//   1. real role-separated turns, so the model sees a conversation instead of a
//      transcript pasted into one blob;
//   2. an honest statement of HOW MUCH the model can actually recall, and how
//      long ago it happened.
//
// (2) exists because the model has no clock and no memory of its own. Asked "do
// you remember when we last spoke?", a model given only bare turns will invent a
// plausible answer. Given "the previous exchange was about 3 hours ago; these 10
// turns are everything you can recall", it can answer truthfully — or admit the
// limit — without guessing.

/** Turns a millisecond gap into the way a person would say it out loud. */
function humanizeGap(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;

  // Under ~45s reads as "just now" to a person, so check before rounding to
  // minutes (Math.round would turn 30s into "a minute ago").
  if (ms < 45000) return 'seconds ago';

  const minutes = Math.round(ms / 60000);
  if (minutes === 1) return 'a minute ago';
  if (minutes < 50) return `about ${minutes} minutes ago`;

  const hours = Math.round(ms / 3600000);
  if (hours === 1) return 'about an hour ago';
  if (hours < 22) return `about ${hours} hours ago`;

  const days = Math.round(ms / 86400000);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 14) return 'about a week ago';
  if (days < 60) return `about ${Math.round(days / 7)} weeks ago`;
  return `about ${Math.round(days / 30)} months ago`;
}

/**
 * Builds prompt-ready conversation context.
 *
 * @param {Array}    history       conversation_history rows ({role, content, created_at})
 * @param {Function} sanitize      per-value sanitizer from the calling engine
 * @param {Object}   opts
 * @param {number}   opts.maxTurns    how many trailing turns to include
 * @param {string}   opts.liveMessage the message being answered right now; if the
 *                                    caller already persisted it, the duplicate
 *                                    trailing row is dropped so the model doesn't
 *                                    see the same message twice
 * @param {Date}     opts.now         injectable clock (tests)
 * @returns {{turns: Array, recall: string}}
 */
function build(history, sanitize, opts = {}) {
  const maxTurns = opts.maxTurns || 12;
  const now = opts.now || new Date();

  let rows = (Array.isArray(history) ? history : [])
    .filter(m => m && typeof m.content === 'string' && m.content.trim() !== '');

  // Callers persist the incoming message BEFORE building context, so the live
  // message is usually already the last row. Left in, the model sees it twice —
  // once as history, once as the turn it must answer — which reads like the user
  // repeated themselves.
  const live = (opts.liveMessage || '').trim();
  if (live) {
    const last = rows[rows.length - 1];
    if (last && last.role !== 'assistant' && last.content.trim() === live) {
      rows = rows.slice(0, -1);
    }
  }

  rows = rows.slice(-maxTurns);

  // Only known roles survive; content is sanitized because a stored turn may
  // echo text the user chose, and must not read as instructions to the model.
  const turns = rows.map(m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: sanitize(m.content, 2000),
  }));

  if (turns.length === 0) {
    return {
      turns,
      recall:
        'This is the first thing this person has ever said to you — you have no ' +
        'earlier conversation with them. If they refer to a previous chat, say ' +
        'plainly that you have no record of one. Never invent a shared past.',
    };
  }

  // Gap to the most recent stored turn = how long since they last spoke.
  const lastStamp = rows[rows.length - 1].created_at;
  const lastAt = lastStamp ? new Date(lastStamp) : null;
  const gap =
    lastAt && !Number.isNaN(lastAt.getTime())
      ? humanizeGap(now.getTime() - lastAt.getTime())
      : null;

  const when = gap
    ? `The most recent of those was ${gap}, so that is what "earlier" refers to.`
    : 'You do not know exactly when those happened.';

  // Affirmative first, limit second. Written limit-first, the model reads the
  // whole line as "you don't remember" and denies having a past even while the
  // turns sit in front of it — which is the same dishonesty as inventing one,
  // pointed the other way.
  return {
    turns,
    recall:
      `The last ${turns.length} turn${turns.length === 1 ? '' : 's'} of this conversation ` +
      `${turns.length === 1 ? 'is' : 'are'} shown below as real turns, and they ARE your ` +
      `memory of it — when they ask what you talked about earlier, answer from them ` +
      `specifically rather than saying you don't recall. ${when} ` +
      'Anything before those turns is genuinely gone; if they ask about something ' +
      'outside that window, say you cannot recall it rather than guessing.',
  };
}

module.exports = { build, humanizeGap };
