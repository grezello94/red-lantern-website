(function attachReliableOrderRequests(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RedLanternOrderRequests = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  const retryableStatus = (status) =>
    [408, 425, 429].includes(Number(status)) || Number(status) >= 500;

  const wait = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(milliseconds) || 0)));

  function retryDelay(response, attempt, delays) {
    const header = response?.headers?.get?.('retry-after');
    const retryAfter = header == null || header === '' ? NaN : Number(header);
    if (Number.isFinite(retryAfter) && retryAfter >= 0) return Math.min(2000, retryAfter * 1000);
    const configured = Array.isArray(delays) ? delays[attempt - 1] : null;
    return Math.max(0, Number(configured ?? 250 * 3 ** (attempt - 1)) || 0);
  }

  async function json(input, init = {}, options = {}) {
    const fetcher = options.fetcher || globalThis.fetch;
    if (typeof fetcher !== 'function') throw new Error('Order service is unavailable.');
    const attempts = Math.max(1, Math.min(4, Number(options.attempts) || 3));
    const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 8000);
    let lastError = null;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetcher(input, { ...init, signal: controller.signal });
        const data = await response.json().catch(() => ({}));
        if (response.ok || !retryableStatus(response.status) || attempt === attempts)
          return { response, data, attempt };
        const delayMs = retryDelay(response, attempt, options.delays);
        options.onRetry?.({ attempt, nextAttempt: attempt + 1, attempts, delayMs, response });
        await wait(delayMs);
      } catch (error) {
        lastError = error;
        if (error?.name === 'AbortError') {
          lastError = new Error('The order service did not respond in time.');
          lastError.name = 'OrderRequestTimeoutError';
        }
        lastError.transient = true;
        if (attempt === attempts) throw lastError;
        const delayMs = retryDelay(null, attempt, options.delays);
        options.onRetry?.({
          attempt,
          nextAttempt: attempt + 1,
          attempts,
          delayMs,
          error: lastError,
        });
        await wait(delayMs);
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError || new Error('Unable to confirm the order.');
  }

  return { json, retryableStatus };
});
