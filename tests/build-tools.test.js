const assert = require('node:assert/strict');
const { inspectRequiredTools, installTool } = require('../backend/builds/tools');

(async () => {
  const tools = await inspectRequiredTools(['windows-zip', 'unknown-target']);
  assert.ok(tools.some(tool => tool.id === 'node'));
  assert.ok(tools.every(tool => tool.requiredFor.includes('windows-zip')) || tools.length === 0);
  await assert.rejects(() => installTool('unknown-tool'), /شناخته/);
  console.log('build tools contract passed');
})().catch(error => { console.error(error); process.exit(1); });
