const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const required = [
  'backend/builds/store.js',
  'backend/builds/tools.js',
  'backend/builds/queue.js',
  'backend/builds/runner.js',
];

const missing = required.filter(file => !fs.existsSync(path.join(root, file)));
if (missing.length) {
  console.error(`Build modules are missing:\n${missing.map(file => `- ${file}`).join('\n')}`);
  process.exit(1);
}
console.log('Build modules ready.');
