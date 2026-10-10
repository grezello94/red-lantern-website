'use strict';

// A deployment must stop admitting new operations before it tears down the
// database transport. Response completion alone is insufficient: an aborted
// browser or a fire-and-forget audit can still have work in progress.
function installGracefulShutdown(server, options = {}) {
  const {
    loadControl,
    closeStreams = () => {},
    backgroundTasks = new Set(),
    databaseTransport,
    log = (message, error) => console.warn(message, error?.message || ''),
  } = options;
  const configuredTimeout = Number(options.timeoutMs ?? 30000);
  const timeoutMs =
    Number.isFinite(configuredTimeout) && configuredTimeout > 0
      ? Math.min(300000, configuredTimeout)
      : 30000;
  let shutdownPromise;

  function report(message, error) {
    try {
      log(message, error);
    } catch (_) {
      /* Logging must not interrupt shutdown. */
    }
  }

  function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = new Promise((resolve) => {
      let settled = false;
      let forced = false;
      let timer;

      function finish(graceful) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ graceful });
      }

      function force(error) {
        if (settled) return;
        forced = true;
        if (error)
          report('Graceful shutdown could not finish; closing remaining connections.', error);
        try {
          server.closeAllConnections?.();
        } catch (closeError) {
          report('Unable to force-close HTTP connections.', closeError);
        }
        // Some small test/custom transports return undefined from destroy().
        // Treat either shape safely and consume any cleanup rejection.
        try {
          Promise.resolve(databaseTransport?.destroy?.()).catch((destroyError) =>
            report('Unable to force-close database transport.', destroyError)
          );
        } catch (destroyError) {
          report('Unable to force-close database transport.', destroyError);
        }
        finish(false);
      }

      timer = setTimeout(() => force(new Error(`Shutdown exceeded ${timeoutMs} ms.`)), timeoutMs);

      async function drain() {
        loadControl?.beginDrain();
        let streamClosure;
        try {
          streamClosure = Promise.resolve(closeStreams());
        } catch (error) {
          streamClosure = Promise.reject(error);
        }
        // Start refusing new connections immediately. Existing requests keep
        // running until their responses and tracked handlers finish.
        const httpClosed = new Promise((complete, reject) => {
          try {
            server.close((error) => {
              if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
              else complete();
            });
            server.closeIdleConnections?.();
          } catch (error) {
            if (error.code === 'ERR_SERVER_NOT_RUNNING') complete();
            else reject(error);
          }
        });
        const handlersIdle = (async () => {
          await streamClosure;
          if (loadControl && !(await loadControl.awaitIdle(timeoutMs)))
            throw new Error('Tracked requests did not finish before shutdown.');
          if (!forced) server.closeIdleConnections?.();
        })();
        // A request active at the first closeIdleConnections() call can turn
        // into an idle keep-alive socket after its response finishes. Close
        // those newly idle sockets once tracked work settles, before waiting
        // for the HTTP server's close callback.
        await Promise.all([handlersIdle, httpClosed]);
        if (forced) return;

        // A finishing request can enqueue an audit/push operation after the
        // signal. Re-read the Set after each group settles instead of taking
        // just one snapshot at the beginning of deployment.
        while (!forced) {
          const tasks = [...backgroundTasks];
          if (!tasks.length) {
            await new Promise((complete) => setImmediate(complete));
            if (!backgroundTasks.size) break;
            continue;
          }
          const results = await Promise.allSettled(tasks);
          tasks.forEach((task) => backgroundTasks.delete(task));
          results.forEach((result) => {
            if (result.status === 'rejected')
              report('Background operation failed during shutdown.', result.reason);
          });
        }
        if (forced) return;
        await databaseTransport?.close?.();
        if (!forced) finish(true);
      }

      // A timeout can win while a remote request is still outstanding. This
      // catch consumes the eventual drain rejection after forced cleanup too.
      drain().catch(force);
    });
    return shutdownPromise;
  }

  return { shutdown };
}

module.exports = { installGracefulShutdown };
