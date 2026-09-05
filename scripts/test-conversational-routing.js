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

  // Venting and mood — no action in them, but a classifier hunting for task
  // intents will reach for one anyway ("today was terrible" reads as a
  // complaint about the task list if you are looking for complaints).
  'today was terrible', 'man today was terrible', 'yesterday was rough',
  'my day was awful', 'this week has been rough',
  'i am tired', 'im exhausted', "i'm so drained", 'im stressed',
  'i feel stuck', 'i feel like giving up', 'im kinda overwhelmed',
  'this is so hard', 'that sounds hard tbh', 'it was terrible',
  'ugh im so tired', 'bro this is so hard',
  // Filler that is the entire message.
  'ugh', 'well', 'hmm', 'damn',

  // Bare follow-ups — they only mean something against the previous turn,
  // which the chat path has and the classifier does not.
  'why?', 'why does that help?', 'how so', 'why would that work',
  'what do you mean', 'explain that', 'elaborate', 'go on', 'then what',
  'makes sense', 'i see', 'oh', 'wait', 'huh',
  'the thing from before', 'that one we discussed',
  'idk', 'dunno', 'not sure', 'honestly idk',
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
  ['I am kinda frustrated with this project', ACTIONS.GENERAL_CHAT],
  ['explain what a subnet mask does', null],
  ['why did you give me that task', null],

  // The widened mood/follow-up patterns must NOT swallow a real request that
  // happens to be phrased as a feeling. Anything naming their tasks, goal, or
  // plan keeps its trip through the AI classifier.
  ['im frustrated with these tasks', null],
  ['ugh these tasks are too hard', null],
  ['this is too hard, give me easier tasks', null],
  ['i feel like my roadmap is wrong', null],
  ['explain task 2', null],
  ['why does that task help my goal', null],
  ['honestly my goal changed', null],
  ['i am tired of this streak', null],
  ['man delete all my tasks', ACTIONS.DELETE_TASKS],
  ['bro generate tasks', null],
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
