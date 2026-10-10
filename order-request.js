(function attachReliableOrderRequests(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RedLanternOrderRequests = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  const retryableStatus = (status) =>
    [408, 425, 429].includes(Number(status)) || Number(status) >= 500;

  const cancellation = (signal) => signal?.reason || Object.assign(new Error('Order request cancelled.'), { name: 'AbortError' });
  const wait = (milliseconds, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(cancellation(signal));
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(cancellation(signal)); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, Math.max(0, Number(milliseconds) || 0));
    signal?.addEventListener('abort', abort, { once: true });
  });

  function retryDelay(response, attempt, delays, random = Math.random) {
    const header = response?.headers?.get?.('retry-after');
    const seconds = header == null || header === '' ? NaN : Number(header);
    const dateDelay = header && !Number.isFinite(seconds) ? Date.parse(header) - Date.now() : NaN;
    const configured = Array.isArray(delays) ? delays[attempt - 1] : null;
    const base = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000
      : Number.isFinite(dateDelay) ? Math.max(0, dateDelay)
      : Math.max(0, Number(configured ?? 250 * 3 ** (attempt - 1)) || 0);
    // Honor server backoff; jitter spreads device retries across a short window.
    return base + Math.floor(random() * Math.min(250, base * 0.25));
  }

  async function json(input, init = {}, options = {}) {
    const fetcher = options.fetcher || globalThis.fetch;
    if (typeof fetcher !== 'function') throw new Error('Order service is unavailable.');
    const attempts = Math.max(1, Math.min(4, Number(options.attempts) || 4));
    const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 8000);
    let lastError = null;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (init.signal?.aborted) throw cancellation(init.signal);
      const controller = new AbortController();
      const relay = () => controller.abort(cancellation(init.signal));
      init.signal?.addEventListener('abort', relay, { once: true });
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetcher(input, { ...init, signal: controller.signal });
        const data = await response.json().catch(() => ({}));
        if (response.ok || !retryableStatus(response.status) || attempt === attempts)
          return { response, data, attempt };
        const delayMs = retryDelay(response, attempt, options.delays, options.random);
        options.onRetry?.({ attempt, nextAttempt: attempt + 1, attempts, delayMs, response });
        clearTimeout(timeout);
        await wait(delayMs, init.signal);
      } catch (error) {
        if (init.signal?.aborted) throw cancellation(init.signal);
        lastError = error;
        if (error?.name === 'AbortError') {
          lastError = new Error('The order service did not respond in time.');
          lastError.name = 'OrderRequestTimeoutError';
        }
        lastError.transient = true;
        if (attempt === attempts) throw lastError;
        const delayMs = retryDelay(null, attempt, options.delays, options.random);
        options.onRetry?.({
          attempt,
          nextAttempt: attempt + 1,
          attempts,
          delayMs,
          error: lastError,
        });
        clearTimeout(timeout);
        await wait(delayMs, init.signal);
      } finally {
        clearTimeout(timeout);
        init.signal?.removeEventListener('abort', relay);
      }
    }
    throw lastError || new Error('Unable to confirm the order.');
  }

  return { json, retryableStatus };
});
