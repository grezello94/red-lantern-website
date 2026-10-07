/* Keeps Print Bridge available across child crashes and stalled local requests. */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

function createSupervisor(options = {}) {
  const launch = options.spawn || spawn;
  const bridgePath = options.bridgePath || path.join(__dirname, 'print-bridge.js');
  const dataDir =
    process.env.PRINT_BRIDGE_DATA_DIR || path.join(os.homedir(), '.red-lantern-print-bridge');
  const logPath = path.join(dataDir, 'supervisor.log');
  const healthPort = Number(process.env.PRINT_BRIDGE_PORT || 9124);
  const probeTimeout = options.probeTimeout || 3000;
  const probeInterval = options.probeInterval || 15000;
  let stopping = false;
  let bridge = null;
  let restartTimer = null;
  let watchdog = null;
  let checking = false;
  let failedChecks = 0;
  let fastFailures = 0;

  function log(message) {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      if (fs.existsSync(logPath) && fs.statSync(logPath).size > 256000) {
        fs.rmSync(`${logPath}.1`, { force: true });
        fs.renameSync(logPath, `${logPath}.1`);
      }
      fs.appendFileSync(logPath, `${new Date().toISOString()} ${String(message).slice(0, 4000)}\n`);
    } catch (_) {}
  }

  function probe(child) {
    if (stopping || checking || child !== bridge) return;
    checking = true;
    let done = false;
    let deadline = null;
    const finish = (healthy) => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      checking = false;
      if (child !== bridge || stopping) return;
      if (healthy) {
        failedChecks = 0;
        return;
      }
      failedChecks += 1;
      // A transient busy OS queue should not kill an active print. A stuck
      // Bridge must miss three bounded probes before its watchdog restarts it.
      if (failedChecks >= 3) {
        log(`Bridge PID ${child.pid || 'unknown'} stopped answering health checks; restarting.`);
        failedChecks = 0;
        child.kill();
      }
    };
    const request = http.get(
      { host: '127.0.0.1', port: healthPort, path: '/health', timeout: probeTimeout },
      (response) => {
        let body = '';
        response.on('data', (chunk) => {
          body += chunk;
          if (body.length > 16000) {
            request.destroy();
            finish(false);
          }
        });
        response.on('end', () => {
          try {
            const data = JSON.parse(body);
            finish(
              response.statusCode === 200 &&
                data.ok === true &&
                (!data.pid || data.pid === child.pid)
            );
          } catch (_) {
            finish(false);
          }
        });
        response.on('error', () => finish(false));
      }
    );
    request.on('timeout', () => {
      request.destroy();
      finish(false);
    });
    request.on('error', () => finish(false));
    // Socket timeouts measure inactivity. Keep a hard deadline too, so a
    // partially written response can never disable the watchdog indefinitely.
    deadline = setTimeout(() => {
      request.destroy();
      finish(false);
    }, probeTimeout);
  }

  function startBridge() {
    if (stopping) return;
    const startedAt = Date.now();
    let settled = false;
    const child = launch(process.execPath, [bridgePath], {
      cwd: path.dirname(bridgePath),
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, PRINT_BRIDGE_SUPERVISED: '1' },
    });
    bridge = child;
    failedChecks = 0;
    child.stdout?.on('data', (chunk) => log(chunk.toString().trim()));
    child.stderr?.on('data', (chunk) => log(chunk.toString().trim()));
    const ended = (error) => {
      if (settled) return;
      settled = true;
      clearInterval(watchdog);
      watchdog = null;
      checking = false;
      if (bridge === child) bridge = null;
      if (error) log(`Bridge could not start: ${error.message}`);
      if (stopping) return;
      fastFailures = Date.now() - startedAt < 10000 ? Math.min(fastFailures + 1, 5) : 0;
      const delay = Math.min(15000, 800 * Math.pow(2, fastFailures));
      // Keep the timer referenced so a spawn error cannot leave recovery idle.
      restartTimer = setTimeout(startBridge, delay);
    };
    child.once('error', ended);
    child.once('exit', (code, signal) => {
      log(`Bridge stopped: code=${code}, signal=${signal || ''}`);
      ended();
    });
    watchdog = setInterval(() => probe(child), probeInterval);
  }

  function stop() {
    stopping = true;
    clearTimeout(restartTimer);
    clearInterval(watchdog);
    bridge?.kill();
    bridge = null;
  }
  return { start: startBridge, stop, probe: () => bridge && probe(bridge) };
}

if (require.main === module) {
  const supervisor = createSupervisor();
  process.on('SIGINT', () => {
    supervisor.stop();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    supervisor.stop();
    process.exit(0);
  });
  supervisor.start();
}
module.exports = { createSupervisor };
