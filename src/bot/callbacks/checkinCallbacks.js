module.exports = {

  async handle({
    callbackQuery,
    ctx,
    action,
    id,
  }) {

    switch (action) {

      case 'stuck':
        return ctx.handleStuckResponse(
          callbackQuery,
          id
        );

      default:
        throw new Error(
          `Unknown checkin action: ${action}`
        );
    }
  }
};
