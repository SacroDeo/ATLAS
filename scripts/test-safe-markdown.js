// scripts/test-safe-markdown.js
// Unit test for BUG-009: escapeMarkdown must escape EVERY MarkdownV2 reserved
// character. The old char-by-char version tried to spare URLs (via a test that
// only fired after the literal prefix "tth") and emoji (via a whitelist emoji
// can never reach, since emoji aren't reserved), and it under-escaped as a
// result — a stray reserved char slipped through and Telegram rejected the whole
// message with "can't parse entities", so the user saw nothing. Pure functions.

const { escapeMarkdown, sanitizeTelegramText } = require('../src/utils/telegram/safeMarkdown');
const ai = require('../src/services/ai/aiOrchestrator');

let pass = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) pass++;
  else failures.push(`${name}${detail ? ' — ' + detail : ''}`);
}

// The full MarkdownV2 reserved set Telegram documents.
const RESERVED = "_*[]()~`>#+-=|{}.!";

// ── 1. Every reserved char is backslash-escaped ─────────────────────────────
{
  for (const c of RESERVED.split('')) {
    check(`escapes ${JSON.stringify(c)}`, escapeMarkdown(c) === '\\' + c, JSON.stringify(escapeMarkdown(c)));
  }
}

// ── 2. THE regression: a goal with _ or * no longer 400s ────────────────────
{
  // Under the old code these reserved chars slipped through and Telegram
  // rejected the message. Now they are escaped, so the send succeeds.
  check('"Build my *startup*" → stars escaped', escapeMarkdown('Build my *startup*') === 'Build my \\*startup\\*');
  check('"learn_python fast" → underscore escaped', escapeMarkdown('learn_python fast') === 'learn\\_python fast');
  // General invariant: no reserved char in the OUTPUT is left un-preceded by a backslash.
  const goal = 'C++ (v2.0): finish [phase-1] 100% | ~2h/day!';
  const esc = escapeMarkdown(goal);
  let unescaped = false;
  for (let i = 0; i < esc.length; i++) {
    if (RESERVED.includes(esc[i]) && esc[i - 1] !== '\\') { unescaped = true; break; }
  }
  check('no reserved char left unescaped in a realistic goal', !unescaped, esc);
}

// ── 3. URLs are NOT specially spared (that was the under-escaping bug) ───────
{
  const url = 'https://ex.com/a?b=1';
  const esc = escapeMarkdown(url);
  check('URL dot is escaped', esc.includes('\\.'), esc);
  check('URL equals is escaped', esc.includes('\\='), esc);
}

// ── 4. Emoji are not reserved, so they pass through untouched ───────────────
{
  check('bare emoji unchanged', escapeMarkdown('🚀') === '🚀');
  check('emoji + reserved: only reserved escaped', escapeMarkdown('🚀!') === '🚀\\!');
  check('emoji within text preserved', escapeMarkdown('done ✅ today') === 'done ✅ today');
}

// ── 5. Non-string / empty input → '' (never throws) ─────────────────────────
{
  check('null → ""', escapeMarkdown(null) === '');
  check('undefined → ""', escapeMarkdown(undefined) === '');
  check('number → ""', escapeMarkdown(42) === '');
  check('empty string → ""', escapeMarkdown('') === '');
}

// ── 6. sanitizeTelegramText cleans without escaping ─────────────────────────
{
  check('null → ""', sanitizeTelegramText(null) === '');
  check('control chars stripped, newline kept', sanitizeTelegramText('a\x00b\nc') === 'ab\nc');
  check('literal \\n is PRESERVED, not rewritten (BUG-010)',
        sanitizeTelegramText('line1\\nline2') === 'line1\\nline2');
  check('user text about the escape survives intact (BUG-010)',
        sanitizeTelegramText('what does \\n do in Python') === 'what does \\n do in Python');
  check('3+ newlines collapse to 2', sanitizeTelegramText('a\n\n\n\nb') === 'a\n\nb');
  check('trailing spaces per line trimmed', sanitizeTelegramText('a   \nb  ') === 'a\nb');
  check('does NOT escape reserved chars', sanitizeTelegramText('a*b_c') === 'a*b_c');
}

// ── 7. BUG-010: the backslash-n repair moved to the AI boundary ─────────────
// Models emit backslash-n as two characters and double-escape it inside JSON,
// so the repair still has to happen — just on AI-authored text only, never on
// the general send path. execute() results go through _unescapeWhitespace,
// executeJSON() results through _unescapeDeep (every string, at any depth).
{
  check('_unescapeWhitespace turns literal \\n into a newline',
        ai._unescapeWhitespace('line1\\nline2') === 'line1\nline2');
  check('_unescapeWhitespace turns literal \\t into two spaces',
        ai._unescapeWhitespace('a\\tb') === 'a  b');
  check('_unescapeWhitespace passes non-strings through untouched',
        ai._unescapeWhitespace(42) === 42 && ai._unescapeWhitespace(null) === null);
  check('_unescapeDeep repairs a nested string',
        ai._unescapeDeep({ reply: 'a\\nb' }).reply === 'a\nb');
  check('_unescapeDeep repairs strings inside arrays',
        ai._unescapeDeep({ tasks: [{ title: 'x\\ny' }] }).tasks[0].title === 'x\ny');
  check('_unescapeDeep leaves non-strings alone',
        (() => {
          const out = ai._unescapeDeep({ n: 7, b: true, z: null, s: 'ok' });
          return out.n === 7 && out.b === true && out.z === null && out.s === 'ok';
        })());
  check('AI text still reaches Telegram with real newlines end to end',
        sanitizeTelegramText(ai._unescapeWhitespace('one\\ntwo')) === 'one\ntwo');
}

// ── Report ───────────────────────────────────────────────────────────────────
console.log(`\ntest-safe-markdown: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  FAIL  ${f}`);
  process.exit(1);
}
console.log('  all safe-markdown assertions passed');
process.exit(0);
