/* Keeps the local Print Bridge attached to a single, restartable Windows task. */
const { spawn } = require('child_process');
const path = require('path');

const bridgePath = path.join(__dirname, 'print-bridge.js');
let stopping = false;
let bridge = null;

function startBridge() {
  if (stopping) return;
  bridge = spawn(process.execPath, [bridgePath], {
    cwd: __dirname,
    detached: false,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, PRINT_BRIDGE_SUPERVISED: '1' },
  });
  bridge.on('error', () => {});
  bridge.on('exit', () => {
    bridge = null;
    // Keep the supervisor alive during the short restart gap. An unref'd timer
    // lets Node exit here, leaving the next Bridge child without a watchdog.
    if (!stopping) setTimeout(startBridge, 800);
  });
}

function stop() {
  stopping = true;
  bridge?.kill();
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
startBridge();
