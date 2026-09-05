// src/services/ai/rateLimiter.js
// In-memory rate limiter — no Redis needed, resets on restart (acceptable for this scale)

class RateLimiter {
  constructor() {
    // Map<userId, { count: number, windowStart: number, warningsSent: number }>
    this.userWindows = new Map();

    this.LIMITS = {
      MESSAGES_PER_MINUTE: 8,       // max conversational messages per 60s
      TASK_GENERATIONS_PER_HOUR: 5, // max GENERATE_TASKS actions per hour
      WARN_AT: 6,                    // warn user at this count before hard block
      PAYMENT_CLAIMS_PER_HOUR: 3,   // max /paid commands per hour
      COUPON_ATTEMPTS_PER_HOUR: 10, // max /redeem attempts per hour
    };

    // Task generation has a separate hourly window
    // Map<userId, { count: number, windowStart: number }>
    this.taskGenWindows = new Map();

    // Payment claims rate limiting
    // Map<userId, { count: number, windowStart: number }>
    this.paymentClaimWindows = new Map();

    // Coupon redemption attempts rate limiting
    // Map<userId, { count: number, windowStart: number }>
    this.couponAttemptWindows = new Map();

    // Cleanup stale entries every 5 minutes
    // .unref() so this housekeeping timer never keeps the process alive on shutdown.
    setInterval(() => this._cleanup(), 5 * 60 * 1000).unref();
  }

  /**
   * Check if a user can send a message.
   * Returns { allowed: boolean, retryAfterSeconds: number, warn: boolean }
   */
  checkMessage(userId) {
    const now = Date.now();
    const WINDOW_MS = 60 * 1000;

    let entry = this.userWindows.get(userId);

    if (!entry || now - entry.windowStart >= WINDOW_MS) {
      entry = { count: 0, windowStart: now, warningsSent: 0 };
    }

    entry.count++;
    this.userWindows.set(userId, entry);

    if (entry.count > this.LIMITS.MESSAGES_PER_MINUTE) {
      const retryAfterSeconds = Math.ceil(
        (WINDOW_MS - (now - entry.windowStart)) / 1000
      );
      return { allowed: false, retryAfterSeconds, warn: false };
    }

    const warn = entry.count === this.LIMITS.WARN_AT && entry.warningsSent === 0;
    if (warn) entry.warningsSent++;

    return { allowed: true, retryAfterSeconds: 0, warn };
  }

  /**
   * Check if a user can trigger task generation.
   * Returns { allowed: boolean, retryAfterSeconds: number }
   */
  checkTaskGeneration(userId) {
    const now = Date.now();
    const WINDOW_MS = 60 * 60 * 1000; // 1 hour

    let entry = this.taskGenWindows.get(userId);

    if (!entry || now - entry.windowStart >= WINDOW_MS) {
      entry = { count: 0, windowStart: now };
    }

    entry.count++;
    this.taskGenWindows.set(userId, entry);

    if (entry.count > this.LIMITS.TASK_GENERATIONS_PER_HOUR) {
      const retryAfterSeconds = Math.ceil(
        (WINDOW_MS - (now - entry.windowStart)) / 1000
      );
      return { allowed: false, retryAfterSeconds };
    }

    return { allowed: true, retryAfterSeconds: 0 };
  }

  /**
   * Check if a user can submit a payment claim (/paid command).
   * Returns { allowed: boolean, retryAfterSeconds: number }
   */
  checkPaymentClaim(userId) {
    const now = Date.now();
    const WINDOW_MS = 60 * 60 * 1000; // 1 hour

    let entry = this.paymentClaimWindows.get(userId);

    if (!entry || now - entry.windowStart >= WINDOW_MS) {
      entry = { count: 0, windowStart: now };
    }

    entry.count++;
    this.paymentClaimWindows.set(userId, entry);

    if (entry.count > this.LIMITS.PAYMENT_CLAIMS_PER_HOUR) {
      const retryAfterSeconds = Math.ceil(
        (WINDOW_MS - (now - entry.windowStart)) / 1000
      );
      return { allowed: false, retryAfterSeconds };
    }

    return { allowed: true, retryAfterSeconds: 0 };
  }

  /**
   * Check if a user can attempt a coupon redemption (/redeem command).
   * Returns { allowed: boolean, retryAfterSeconds: number }
   */
  checkCouponAttempt(userId) {
    const now = Date.now();
    const WINDOW_MS = 60 * 60 * 1000; // 1 hour

    let entry = this.couponAttemptWindows.get(userId);

    if (!entry || now - entry.windowStart >= WINDOW_MS) {
      entry = { count: 0, windowStart: now };
    }

    entry.count++;
    this.couponAttemptWindows.set(userId, entry);

    if (entry.count > this.LIMITS.COUPON_ATTEMPTS_PER_HOUR) {
      const retryAfterSeconds = Math.ceil(
        (WINDOW_MS - (now - entry.windowStart)) / 1000
      );
      return { allowed: false, retryAfterSeconds };
    }

    return { allowed: true, retryAfterSeconds: 0 };
  }

  /**
   * Format retry time into a human-readable string.
   */
  formatRetryTime(seconds) {
    if (seconds < 60) return `${seconds} seconds`;
    return `${Math.ceil(seconds / 60)} minutes`;
  }

  _cleanup() {
    const now = Date.now();
    const MSG_WINDOW = 60 * 1000;
    const TASK_WINDOW = 60 * 60 * 1000;

    for (const [userId, entry] of this.userWindows.entries()) {
      if (now - entry.windowStart > MSG_WINDOW * 2) {
        this.userWindows.delete(userId);
      }
    }

    for (const [userId, entry] of this.taskGenWindows.entries()) {
      if (now - entry.windowStart > TASK_WINDOW * 2) {
        this.taskGenWindows.delete(userId);
      }
    }

    for (const [userId, entry] of this.paymentClaimWindows.entries()) {
      if (now - entry.windowStart > TASK_WINDOW * 2) {
        this.paymentClaimWindows.delete(userId);
      }
    }

    for (const [userId, entry] of this.couponAttemptWindows.entries()) {
      if (now - entry.windowStart > TASK_WINDOW * 2) {
        this.couponAttemptWindows.delete(userId);
      }
    }
  }
}

module.exports = new RateLimiter();