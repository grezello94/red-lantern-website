// Client-side runtime configuration. Override by setting window.RED_LANTERN_CONFIG
(function () {
  if (typeof window === 'undefined') return;
  /** @type {Window & { RED_LANTERN_CONFIG?: { printBridgeOrigin?: string } }} */
  const runtimeWindow = window;
  runtimeWindow.RED_LANTERN_CONFIG = runtimeWindow.RED_LANTERN_CONFIG || {};
  runtimeWindow.RED_LANTERN_CONFIG.printBridgeOrigin = runtimeWindow.RED_LANTERN_CONFIG.printBridgeOrigin || 'http://127.0.0.1:9124';
})();
