(function (global) {
  /** @type {{ capture?: (payload: Record<string, any>) => void, enabled?: boolean }} */
  const state = {
    enabled: true,
  };

  /**
   * @param {unknown} value
   * @returns {string}
   */
  function safeSerialize(value) {
    try {
      if (typeof value === 'string') return value.slice(0, 4000);
      return JSON.stringify(value);
    } catch {
      return String(value || '').slice(0, 4000);
    }
  }

  /**
   * @param {Record<string, any>} payload
   */
  function capture(payload) {
    if (!state.enabled) return;
    const event = {
      timestamp: new Date().toISOString(),
      url: global.location ? global.location.href : '',
      userAgent: global.navigator ? global.navigator.userAgent : '',
      ...payload,
    };

    fetch('/api/client-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
      keepalive: true,
    }).catch(() => {});
  }

  /**
   * @param {Error | unknown} error
   * @param {Record<string, any>} [context]
   */
  function reportError(error, context = {}) {
    const typedError = error instanceof Error ? error : new Error(String(error || 'Unknown error'));
    capture({
      category: 'client-error',
      level: 'error',
      message: typedError.message,
      stack: typedError.stack ? typedError.stack.slice(0, 2000) : '',
      context: safeSerialize(context),
    });
  }

  /** @type {Window & { RedLanternTelemetry?: { capture: typeof capture, reportError: typeof reportError, setEnabled: (value: boolean) => void } }} */
  const runtimeWindow = /** @type {any} */ (global);
  runtimeWindow.RedLanternTelemetry = {
    capture,
    reportError,
    setEnabled(value) {
      state.enabled = Boolean(value);
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
