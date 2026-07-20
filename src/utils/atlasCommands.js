// src/utils/atlasCommands.js
// src/utils/atlasCommands.js
// Single source of truth for ATLAS's OWN commands (not generic Telegram ones).
// Used by /help, natural-language help detection, the morning delivery footer,
// and the after-generation footer — so the command copy never drifts apart.
//
// Descriptions are deliberately free of MarkdownV2 special characters
// (. ! - ( ) [ ] etc.) so the same strings render safely in both legacy
// Markdown and MarkdownV2 without per-mode escaping. Apostrophes and the em
// dash (—) are not special in either mode.

const COMMANDS = [
  { cmd: '/start',    desc: "View today's tasks as tappable buttons" },
  { cmd: '/today',    desc: 'See how many missions remain today' },
  { cmd: '/progress', desc: "Today's completion and streak" },
  { cmd: '/stats',    desc: "This week's statistics" },
  { cmd: '/review',   desc: 'Your weekly review' },
  { cmd: '/goal',     desc: 'See your goal' },
  { cmd: '/roadmap',  desc: 'Your learning roadmap' },
  { cmd: '/dashboard', desc: 'Open your web dashboard with charts and stats' },
  { cmd: '/linkweb',  desc: 'Get a code to link Google sign in on the web' },
  { cmd: '/feedback', desc: 'Send a thought or bug report to the builder' },
  { cmd: '/help',     desc: 'Show this command list anytime' },
  { cmd: '/reset',    desc: 'Reset your profile' },
];

// Compact command list, one line per command. Safe for legacy Markdown and V2.
function commandsList() {
  return COMMANDS.map(c => `${c.cmd} — ${c.desc}`).join('\n');
}

// Bold-command variant for the rich /help screen (works in both parse modes).
function commandsListBold() {
  return COMMANDS.map(c => `*${c.cmd}* — ${c.desc}`).join('\n');
}

// Footer shown after the morning delivery and after on-demand generation, so
// the user always has a way back to the commands (and knows /start makes buttons).
function commandsFooter() {
  return (
    `📋 *ATLAS Commands*\n${commandsList()}\n\n` +
    `💡 Tip: tap /start to turn today's tasks into ✅ buttons`
  );
}

// Detects a natural-language request for help / the command list, WITHOUT
// hijacking genuine help-with-a-topic messages ("help me understand recursion").
function isHelpRequest(text = '') {
  const t = text.toLowerCase().trim().replace(/[?!.]+$/, '');

  // Bare asks.
  if (['help', 'commands', 'command', 'menu', 'help me', 'help pls', 'help please'].includes(t)) {
    return true;
  }
  // "help" only counts when paired with a commands/usage word.
  if (/\bhelp\b/.test(t) && /\b(command|commands|use|using|menu|option|options|feature|features)\b/.test(t)) {
    return true;
  }
  // Common phrasings that clearly ask what the bot can do.
  if (/\b(what can you do|what do you do|how do i use|how to use|list of commands|show( me)? commands|available commands|what are the commands|what commands)\b/.test(t)) {
    return true;
  }
  return false;
}

module.exports = { COMMANDS, commandsList, commandsListBold, commandsFooter, isHelpRequest };

