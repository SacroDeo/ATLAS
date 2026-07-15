// src/utils/messageFormatter.js
const messageFormatter = {
  formatTaskMessage(task) {
    if (!task) return { template: '', values: {} };
    return {
      template: '📋 *{{title}}*\n📝 {{description}}\n💡 *Why it matters:* {{why}}\n⏱️ {{time}} | 🎯 {{difficulty}}',
      values: {
        title: task.title || 'Untitled Task',
        description: task.description || '',
        why: task.why_it_matters || '',
        time: task.estimated_time || '',
        difficulty: task.difficulty_level || 'medium',
      },
    };
  },

  formatUserGoal(user) {
    if (!user) return { template: '', values: {} };
    return {
      template: '🎯 *Your Goal*\n\n*What:* {{goal}}\n*By when:* {{deadline}}\n*Daily time:* {{time}}\n\n*Why it matters:*\n{{motivation}}\n\n*Current challenge:*\n{{struggle}}\n\n*Personality:* {{personality}}\n*Streak:* {{streak}} days',
      values: {
        goal: user.goal || 'Not set',
        deadline: user.deadline || 'Not set',
        time: user.available_time || 'Not set',
        motivation: user.motivation || '',
        struggle: user.biggest_struggle || '',
        personality: user.personality_type || '',
        streak: user.current_streak || 0,
      },
    };
  },

  formatStats(user, weekStats) {
    if (!user) return { template: '', values: {} };
    return {
      template: '📈 *Your Stats*\n\n🎯 Goal: {{goal}}\n📅 Deadline: {{deadline}}\n⏰ Daily Time: {{time}}\n\n🔥 Current Streak: {{currentStreak}} days\n👑 Best Streak: {{bestStreak}} days\n\n📊 This Week:\n• Completed: {{completed}}/{{total}}\n• Rate: {{rate}}%\n\n🧠 Style: {{personality}}',
      values: {
        goal: user.goal || '',
        deadline: user.deadline || '',
        time: user.available_time || '',
        currentStreak: user.current_streak || 0,
        bestStreak: user.longest_streak || 0,
        completed: weekStats.completed || 0,
        total: weekStats.total || 0,
        rate: weekStats.completion_rate || 0,
        personality: user.personality_type || '',
      },
    };
  },

  formatProgress(progress, user) {
    const progressBar = '🟩'.repeat(Math.round((progress.percentage || 0) / 10)) +
      '⬜'.repeat(10 - Math.round((progress.percentage || 0) / 10));
    return {
      template: `📊 *Today's Progress*\n\n${progressBar} {{percentage}}%\n\n✅ Completed: {{completed}}/{{total}}\n⏰ Remaining: {{remaining}}\n🔥 Streak: {{streak}} days`,
      values: {
        percentage: progress.percentage || 0,
        completed: progress.completed || 0,
        total: progress.total || 0,
        remaining: progress.remaining || 0,
        streak: user.current_streak || 0,
      },
    };
  },

  formatHelpMessage() {
    return {
      template: '🤖 *ATLAS - Your Personal Goal Assistant*\n\n*/start* - View today\'s tasks\n*/today* - Check missions\n*/progress* - Daily progress\n*/stats* - Statistics\n*/review* - Weekly review\n*/goal* - Your goal\n*/help* - This message\n*/reset* - Reset profile\n\n*Chat Features:*\n• "add task \\[description\\]" - Add custom task\n• "show tomorrow\'s tasks" - See & edit tomorrow\n• "change task 1 to..." - Modify a task\n• "delete task 2" - Remove a task\n• "start now" - Get tasks immediately\n• "change time" - Update delivery time\n• Just chat - I\'ll respond conversationally\n\nStay consistent. Build momentum. 🚀',
      values: {},
    };
  },

  formatReviewMessage(review) {
    if (!review) return { template: 'No review available yet.', values: {} };
    return {
      template: '📊 *Weekly Review*\n\n━━━━━━━━━━━━━━━\n\n📈 *Stats*\n• Tasks Assigned: {{tasksAssigned}}\n• Completed: {{tasksCompleted}}\n• Skipped: {{tasksSkipped}}\n• Completion Rate: {{completionRate}}%\n\n━━━━━━━━━━━━━━━\n\n📝 *Analysis*\n{{reviewText}}\n\n━━━━━━━━━━━━━━━\n\n💡 *Recommendations*\n{{recommendations}}\n\n━━━━━━━━━━━━━━━\n\nKeep pushing forward! Every task completed is progress toward your goal. 🚀',
      values: {
        tasksAssigned: review.tasks_assigned || 0,
        tasksCompleted: review.tasks_completed || 0,
        tasksSkipped: review.tasks_skipped || 0,
        completionRate: review.completion_rate || '0',
        reviewText: review.review_text || '',
        recommendations: Array.isArray(review.recommendations) 
          ? review.recommendations.join('\n') 
          : (review.recommendations || ''),
      },
    };
  },

  formatChangeTimeMessage(user) {
    const currentTime = user.preferred_time || '08:00';
    const tzDisplay = user.timezone || 'UTC';
    return {
      template: '⏰ Your tasks currently arrive at *{{currentTime}}* ({{timezone}})\n\nSelect a new time:',
      values: {
        currentTime: currentTime,
        timezone: tzDisplay,
      },
    };
  },

  formatChangeTimezoneMessage(user) {
    const tzDisplay = user.timezone || 'UTC';
    return {
      template: '🌍 Your current timezone is *{{timezone}}*\n\nReply with your city or timezone (e.g., "New York", "London", "IST", "UTC+5:30") to change it.',
      values: {
        timezone: tzDisplay,
      },
    };
  },

  formatSocraticQuestion(question) {
    return {
      template: '🤔 *Understanding Check*\n\n{{question}}\n\nReply with your answer below:',
      values: {
        question: question || '',
      },
    };
  },

  formatTaskDeleted(title) {
    return {
      template: '✅ Task "{{title}}" has been removed from tomorrow\'s schedule.',
      values: {
        title: title || '',
      },
    };
  },

  formatDeleteConfirmation(title) {
    return {
      template: 'Are you sure you want to delete *{{title}}*?',
      values: {
        title: title || '',
      },
    };
  },

  formatTasksList(tasks) {
    if (!tasks || tasks.length === 0) return { template: 'No tasks to display.', values: {} };
    const taskItems = tasks.map((t, i) => `${i + 1}\\. {{title${i}}}`).join('\n');
    const taskValues = {};
    tasks.forEach((t, i) => {
      taskValues[`title${i}`] = t.title || 'Untitled';
    });
    return {
      template: `📅 *Tomorrow's Tasks*\n\nWhich task to delete? Reply "delete task 1" etc.\n\n${taskItems}`,
      values: taskValues,
    };
  },
};

module.exports = messageFormatter;
