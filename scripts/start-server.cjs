const { spawn } = require('node:child_process');
const path = require('node:path');

const child = spawn(process.execPath, [path.resolve(__dirname, '..', 'server.js')], {
  stdio: 'inherit',
  env: process.env,
});
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
child.on('error', error => { console.error(error); process.exit(1); });
