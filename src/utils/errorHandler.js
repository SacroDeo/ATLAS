const logger = require('./logger');

class AppError extends Error {
  constructor(message, statusCode = 500, isOperational = true) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    Error.captureStackTrace(this, this.constructor);
  }
}

const handleError = (error, context = '') => {
  logger.error(`Error in ${context}: ${error.message}`, {
    stack: error.stack,
    isOperational: error.isOperational,
  });

  if (error.isOperational) {
    return {
      message: error.message,
      shouldNotify: true,
    };
  }

  return {
    message: 'An unexpected error occurred. Please try again later.',
    shouldNotify: true,
  };
};

const asyncHandler = (fn) => {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

const telegramErrorHandler = (bot, chatId, error) => {
  const errorResponse = handleError(error, 'Telegram Handler');
  
  if (errorResponse.shouldNotify && chatId) {
    telegramClient.sendMessage(
  bot,
      chatId,
      `⚠️ ${errorResponse.message}`
    ).catch(err => logger.error('Failed to send error message:', err));
  }
};

module.exports = {
  AppError,
  handleError,
  asyncHandler,
  telegramErrorHandler,
};