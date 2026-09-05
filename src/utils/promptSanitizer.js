// src/utils/promptSanitizer.js
// ─── Prompt-injection hardening (M-1) ────────────────────────────────────────
// SINGLE SOURCE OF TRUTH for defanging untrusted text before it reaches an AI
// prompt. Every value derived from user input (goals, struggles, roadmap text,
// chat messages, task titles, detected-intent blobs) is UNTRUSTED. Before such a
// value goes near a prompt it is:
//   1. length-capped, so a pasted wall of text can't push our real instructions
//      out of the model's context window;
//   2. stripped of control characters that can hide smuggled instructions;
//   3. defanged of line-leading role markers ("system:", "assistant:", "atlas:")
//      and code/prompt fences, and of the <user_data> delimiter itself, so the
//      user can't "close" our data block and start issuing orders to the model.
// Where possible this runs on TOP of role separation: untrusted values are
// delivered in a separate user-role message inside a <user_data> block, never
// interpolated into the system/instruction text. Neither measure is trusted on
// its own. NOTE: some callers (e.g. actionPlanner's classifier) send a single
// user-role blob with no separate data block — there this is the ONLY defense,
// which is exactly why it must be applied consistently everywhere (BUG-008).
//
// Keep this the ONLY definition. A second, drifting copy is how the delimiter
// defang originally shipped bypassable in one file but not another.
//
// ASCII control chars C0 (\x00-\x1F) and DEL (\x7F), keeping only tab (\x09)
// and newline (\x0A). Kept as an escape-sequence literal so the source file
// stays plain ASCII (no raw control bytes embedded in the regex).
const CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

function sanitizeForPrompt(value, maxLength = 1500) {
  if (value == null) return '';
  let s = Array.isArray(value) ? value.join('\n') : String(value);
  if (s.length > maxLength) s = s.slice(0, maxLength) + ' …[truncated]';
  // Drop control chars EXCEPT tab (\x09) and newline (\x0A) that can smuggle
  // hidden content.
  s = s.replace(CONTROL_CHAR_RE, '');
  // Defang line-leading role markers so injected "system:"/"assistant:" lines
  // read as literal user text, not as a new turn.
  s = s.replace(/^[ \t]*(system|assistant|user|atlas)[ \t]*:/gim, '$1 -');
  // Defang code / prompt fences used to break out of the data block.
  s = s.replace(/`{3,}/g, "'''");
  // Defang the delimiter itself so it can't be spoofed to close the block early.
  // Matches whitespace and stray attributes too: "</ user_data>" and
  // "</user_data foo>" both slipped past the exact-tag version.
  s = s.replace(/<\s*\/?\s*user_data[^>]*>/gi, '');
  return s.trim();
}

module.exports = { sanitizeForPrompt };
