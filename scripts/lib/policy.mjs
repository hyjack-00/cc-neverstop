export const RETRY_WINDOW_HOURS = 6;
const BACKOFF_CAP_MINUTES = 30;

export function computeRetryWindowMs() {
  return RETRY_WINDOW_HOURS * 60 * 60 * 1000;
}

export function computeRetryDelayMs(attempt) {
  if (!Number.isFinite(attempt) || attempt <= 0) {
    return 0;
  }
  if (attempt <= 5) {
    return Math.pow(2, attempt - 1) * 60 * 1000;
  }
  return BACKOFF_CAP_MINUTES * 60 * 1000;
}
