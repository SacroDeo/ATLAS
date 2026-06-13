module.exports = {
  async handle({
    callbackQuery,
    ctx,
    action,
  }) {

    switch (action) {

      case 'menu':
        return ctx.handleRoadmapMenu(callbackQuery);

      case 'weekly':
        return ctx.handleRoadmapWeekly(callbackQuery);

      case 'full':
        return ctx.handleRoadmapFull(callbackQuery);

      case 'phase':
        return ctx.handleRoadmapPhase(callbackQuery);

      default:
        throw new Error(
          `Unknown roadmap action: ${action}`
        );
    }
  }
};