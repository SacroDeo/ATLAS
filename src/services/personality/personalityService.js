// src/services/personality/personalityService.js

const personalityService = {
  // src/services/personality/personalityService.js

getPersonalityTone(personalityType) {
  const tones = {
    competitive: {
      encouragement: 'Execute. No excuses. Streak stays alive.',
      completion: {
        positive: '✅ Done. One down, keep moving.'
      }
    },
    friendly: {
      encouragement: 'One step at a time. You\'re making progress.',
      completion: {
        positive: '✅ Good work. Keep going.'
      }
    },
    analytical: {
      encouragement: 'Consistency drives optimal output. Stay on track.',
      completion: {
        positive: '✅ Task logged. Next one.'
      }
    },
    gamified: {
      encouragement: 'Quest active. Push through and protect your streak.',
      completion: {
        positive: '✅ +XP. Next task.'
      }
    }
  };
  return tones[personalityType] || tones.friendly;
},

  getTaskIntro(personalityType) {
    const intros = {
      competitive: 'Today\'s targets are ready. Time to show what you can do.',
      friendly: 'Here are some gentle steps to move closer to your goal today:',
      analytical: 'Daily structured assignments calibrated for optimal progression:',
      gamified: 'Your daily quests have appeared! Prepare to conquer them:'
    };
    return intros[personalityType] || intros.friendly;
  },

  getEncouragementMessage(personalityType) {
    const messages = {
      competitive: 'Skipping is allowed, but don\'t let it become a habit. Back to business tomorrow!',
      friendly: 'It\'s totally okay to take a break when you need it. Be kind to yourself!',
      analytical: 'Task deferred. Analytics adjusted. Prioritize tomorrow\'s execution modules.',
      gamified: 'Quest skipped! Health points remain safe, but let\'s conquer the next monster room tomorrow.'
    };
    return messages[personalityType] || messages.friendly;
  },

  adaptDifficultyMessage(personalityType, isTooHard) {
    const messages = {
      competitive: 'Adjusting targets. We\'ll lower the bar slightly to let you catch your breath.',
      friendly: 'No worries at all! Let\'s break this down into something much simpler and gentler for you.',
      analytical: 'Complexity threshold exceeded. Reducing cognitive load parameters. Loading simplified module.',
      gamified: 'Difficulty customized! Boss monster level lowered. Easy-mode quest activated.'
    };
    return messages[personalityType] || messages.friendly;
  },

  getStuckMessage(personalityType, isTechnical) {
    if (isTechnical) {
      return {
        competitive: 'Encountered a technical wall? Find a way around it or break it down. You can do this.',
        friendly: 'Stuck on something technical? That is totally normal! Let\'s take a deep breath and break it down.',
        analytical: 'Technical bottleneck identified. Recommend granular modular decomposition.',
        gamified: 'Technical obstacle encountered! Time to use your special ability to chop it down.'
      }[personalityType] || 'Let\'s break down this issue.';
    } else {
      return {
        competitive: 'Motivation low? Discipline beats motivation. Just push through!',
        friendly: 'Feeling tired or unmotivated? Please go easy on yourself today, a tiny step still counts.',
        analytical: 'Anergia state detected. System override: execute microsegmentation strategy.',
        gamified: 'Stamina low? Take a quick potion break, then finish one small subquest.'
      }[personalityType] || 'Consistency beats motivation.';
    }
  }
};

module.exports = personalityService;