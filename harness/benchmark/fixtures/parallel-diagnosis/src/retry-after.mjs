/** Return a retry delay in milliseconds from an HTTP Retry-After value. */
export function retryAfterMs(value, now = Date.now()) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : 0;
}
