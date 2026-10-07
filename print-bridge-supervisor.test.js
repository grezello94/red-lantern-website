/** @jest-environment node */
const { EventEmitter } = require('events');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSupervisor } = require('./print-bridge-supervisor');

let supervisor;
let directory;
let savedDataDir;
beforeEach(() => {
  jest.useFakeTimers();
  savedDataDir = process.env.PRINT_BRIDGE_DATA_DIR;
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-watchdog-'));
  process.env.PRINT_BRIDGE_DATA_DIR = directory;
});
afterEach(() => {
  supervisor?.stop();
  jest.restoreAllMocks();
  jest.useRealTimers();
  if (savedDataDir === undefined) delete process.env.PRINT_BRIDGE_DATA_DIR;
  else process.env.PRINT_BRIDGE_DATA_DIR = savedDataDir;
  fs.rmSync(directory, { recursive: true, force: true });
});
function child() {
  const process = new EventEmitter();
  process.pid = 123;
  process.stdout = new EventEmitter();
  process.stderr = new EventEmitter();
  process.kill = jest.fn();
  return process;
}

test('spawn errors restart the Bridge and remain attached to the watchdog', () => {
  const failed = child();
  const next = child();
  const spawn = jest.fn().mockReturnValueOnce(failed).mockReturnValue(next);
  supervisor = createSupervisor({ spawn });
  supervisor.start();
  failed.emit('error', new Error('Temporary runtime failure'));
  failed.emit('exit', 1);
  jest.advanceTimersByTime(1600);
  expect(spawn).toHaveBeenCalledTimes(2);
  expect(spawn.mock.calls[1][2]).toMatchObject({ detached: false, windowsHide: true });
  expect(fs.readFileSync(path.join(directory, 'supervisor.log'), 'utf8')).toContain(
    'Temporary runtime failure'
  );
});

test('three failed bounded health checks recover a stalled child; one failure does not', () => {
  const running = child();
  const requests = [];
  jest.spyOn(http, 'get').mockImplementation(() => {
    const request = new EventEmitter();
    request.destroy = jest.fn();
    requests.push(request);
    return request;
  });
  supervisor = createSupervisor({ spawn: jest.fn(() => running) });
  supervisor.start();
  supervisor.probe();
  requests[0].emit('timeout');
  expect(requests[0].destroy).toHaveBeenCalledTimes(1);
  expect(running.kill).not.toHaveBeenCalled();
  supervisor.probe();
  requests[1].emit('error', new Error('Connection refused'));
  supervisor.probe();
  requests[2].emit('error', new Error('Connection refused'));
  expect(running.kill).toHaveBeenCalledTimes(1);
});

test('a healthy response resets transient watchdog failures and verifies child identity', () => {
  const running = child();
  let responseCallback;
  let request;
  jest.spyOn(http, 'get').mockImplementation((options, callback) => {
    responseCallback = callback;
    request = new EventEmitter();
    request.destroy = jest.fn();
    return request;
  });
  supervisor = createSupervisor({ spawn: jest.fn(() => running) });
  supervisor.start();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    supervisor.probe();
    request.emit('error', new Error('Waking from sleep'));
  }
  supervisor.probe();
  const response = new EventEmitter();
  response.statusCode = 200;
  responseCallback(response);
  response.emit('data', JSON.stringify({ ok: true, pid: running.pid }));
  response.emit('end');
  supervisor.probe();
  request.emit('error', new Error('Transient busy connection'));
  expect(running.kill).not.toHaveBeenCalled();
});
