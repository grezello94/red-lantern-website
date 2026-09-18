jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  execFile: jest.fn(),
}));

const { execFile } = require('child_process');
const { run } = require('./print-bridge');

test('printer PowerShell commands run hidden without interactive prompts or a shell', async () => {
  execFile.mockReset();
  execFile.mockImplementation((command, args, options, callback) => callback(null, 'printed'));
  await expect(run('powershell.exe', ['-NoProfile', '-Command', 'Get-Printer'])).resolves.toBe(
    'printed'
  );
  expect(execFile).toHaveBeenCalledWith(
    'powershell.exe',
    [
      '-NoLogo',
      '-NonInteractive',
      '-WindowStyle',
      'Hidden',
      '-NoProfile',
      '-Command',
      'Get-Printer',
    ],
    { windowsHide: true, shell: false, timeout: 5000 },
    expect.any(Function)
  );
});

test('native printer commands retain their arguments and report errors to the app', async () => {
  const failure = new Error('Printer unavailable');
  execFile.mockReset();
  execFile.mockImplementation((command, args, options, callback) => callback(failure));
  await expect(run('lp', ['-d', 'Kitchen', '/tmp/receipt.txt'], 10000)).rejects.toBe(failure);
  expect(execFile).toHaveBeenCalledWith(
    'lp',
    ['-d', 'Kitchen', '/tmp/receipt.txt'],
    { windowsHide: true, shell: false, timeout: 10000 },
    expect.any(Function)
  );
});
