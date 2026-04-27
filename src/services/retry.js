// Retry wrapper for transient external-API failures.
// Retries on 5xx, 429, and common network errors with exponential backoff + jitter.

const DEFAULT_MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 8000;

const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ENETUNREACH',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'EPIPE',
]);

function statusOf(err) {
  return (
    err?.statusCode ??
    err?.status ??
    err?.response?.status ??
    err?.result?.statusCode ??
    null
  );
}

function shouldRetry(err) {
  if (err?.code && RETRYABLE_NETWORK_CODES.has(err.code)) return true;

  const status = statusOf(err);
  if (status === 429) return true;
  if (typeof status === 'number' && status >= 500 && status < 600) return true;

  // Square SDK errors and Shopify errors stringify the status into the message.
  // Catch the common transient ones if statusCode wasn't surfaced as a property.
  const msg = typeof err?.message === 'string' ? err.message : '';
  if (/\b(429|500|502|503|504)\b/.test(msg)) return true;
  if (/ETIMEDOUT|ECONNRESET|socket hang up|fetch failed/i.test(msg)) return true;

  return false;
}

function delayMs(attempt) {
  const base = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS);
  const jitter = base * 0.25 * Math.random();
  return Math.round(base + jitter);
}

async function withRetry(fn, { name = 'op', maxAttempts = DEFAULT_MAX_ATTEMPTS } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === maxAttempts || !shouldRetry(err)) throw err;
      const wait = delayMs(attempt);
      console.warn(
        `[Retry] ${name} attempt ${attempt}/${maxAttempts} failed (${err.message}); retrying in ${wait}ms`
      );
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

module.exports = { withRetry };
