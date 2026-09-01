// scripts/test-conversational-routing.js
// Unit test: does _localClassify send conversation to chat and keep real
// requests on their action paths? Pure logic — no network, no DB.
require('dotenv').config();
const planner = require('../src/core/planner/actionPlanner');
const ACTIONS = require('../src/core/actions/actionTypes');

// Messages that MUST reach GENERAL_CHAT.
const CHAT = [
  'hi', 'hii', 'hey', 'heyy', 'hello', 'yo', 'sup', 'hey man', 'yo atlas',
  'hi!!', 'good morning', 'gm', 'good night atlas',
  'whats up', "what's up", 'whats up man', 'wassup', 'wyd',
  'how are you', 'how are u', 'how you doing', 'hows it going',
  'you there', 'u there?', 'are you there', 'r u there',
  'can we discuss something?', 'can we talk?', 'could we chat',
  'i want to discuss something', 'i wanna talk', 'i need to vent',
  "let's talk", 'lets chat',
  'never mind', 'nevermind', 'nvm', 'forget it', 'forget it lol',
  'thanks', 'thanks man', 'thank you so much', 'thx', 'ty',
  'ok', 'okay', 'cool', 'nice', 'great', 'awesome', 'got it', 'gotcha',
  'bye', 'see you', 'cya', 'later', 'ttyl',
  'lol', 'lmao', 'haha', 'hehe', '😂',
  'who are you', 'what are you',
  'do you remember', 'do you remember what we talked about',
  'do u remember when we last spoke',
  'what did we talk about', 'what did we discuss yesterday',
  'when was the last time we spoke',
];

// Messages that must NOT be captured as chatter — each with its required intent
// (null = must fall through to the AI classifier rather than match locally).
const ACTION = [
  ['/today', ACTIONS.SHOW_TASKS],
  ['/progress', ACTIONS.SHOW_PROGRESS],
  ['/goal', ACTIONS.SHOW_GOAL],
  ['my tasks', ACTIONS.SHOW_TASKS],
  ['show my goal', ACTIONS.SHOW_GOAL],
  ['generate tasks', ACTIONS.GENERATE_TASKS],
  ['delete 3', ACTIONS.DELETE_TASK],
  ['delete task 3', ACTIONS.DELETE_TASK],
  ['delete all', ACTIONS.DELETE_TASKS],
  ['add task write the README', ACTIONS.ADD_TASK],
  ['replace task 2 with study DNS', ACTIONS.UPDATE_TASK],
  ['my progress', ACTIONS.SHOW_PROGRESS],
  ['how am i doing', ACTIONS.SHOW_PROGRESS],
  // Greeting glued to a real request: the anchor must fail so it falls through.
  ['hi, delete task 3', null],
  ['hey can you generate tasks about networking', null],
  ['thanks, now show my tasks', null],
  // Substantive messages that are neither greeting nor command.
  ['I am kinda frustrated with this project', null],
  ['man today was terrible', null],
  ['explain what a subnet mask does', null],
  ['why did you give me that task', null],
];

let pass = 0;
const failures = [];

for (const msg of CHAT) {
  const r = planner._localClassify(msg);
  if (r && r.intent === ACTIONS.GENERAL_CHAT) pass++;
  else failures.push(`CHAT  "${msg}" → ${r ? r.intent : 'null (fell through to AI)'}`);
}

for (const [msg, expected] of ACTION) {
  const r = planner._localClassify(msg);
  const got = r ? r.intent : null;
  if (got === expected) pass++;
  else failures.push(`ACTION "${msg}" → expected ${expected || 'null'}, got ${got || 'null'}`);
}

const total = CHAT.length + ACTION.length;
console.log(`\nRouting: ${pass}/${total} passed`);
if (failures.length) {
  console.log('\nFailures:');
  failures.forEach(f => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('✅ All routing assertions passed');
