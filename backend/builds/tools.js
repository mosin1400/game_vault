const fs = require('node:fs');
const path = require('node:path');
const { run } = require('../tools/system-tools');

const definitions = {
  node: {
    label: 'Node.js',
    sizeLabel: 'از قبل همراه پروژه',
    requiredFor: ['windows-exe', 'windows-zip', 'linux-appimage', 'linux-targz', 'android-apk'],
    command: process.execPath,
    args: ['--version'],
  },
  tar: {
    label: 'TAR / archive tools',
    sizeLabel: 'ابزار داخلی سیستم',
    requiredFor: ['windows-zip', 'linux-targz'],
    command: process.platform === 'win32' ? 'tar.exe' : 'tar',
    args: ['--version'],
  },
};

const targetRequirements = {
  'windows-exe': ['node'],
  'windows-zip': ['node', 'tar'],
  'linux-appimage': ['node'],
  'linux-targz': ['node', 'tar'],
  'android-apk': ['node'],
};

async function check(definition) {
  if (path.isAbsolute(definition.command) && !fs.existsSync(definition.command)) {
    return { installed: false, output: '', error: 'فایل ابزار پیدا نشد' };
  }
  return run(definition.command, definition.args);
}

async function inspectRequiredTools(targets = []) {
  const selected = [...new Set((Array.isArray(targets) ? targets : []).map(String))];
  const ids = [...new Set(selected.flatMap(target => targetRequirements[target] || []))];
  return Promise.all(ids.map(async id => {
    const definition = definitions[id];
    const result = await check(definition);
    return {
      id,
      label: definition.label,
      sizeLabel: definition.sizeLabel,
      requiredFor: selected.filter(target => (targetRequirements[target] || []).includes(id)),
      installed: result.ok,
      output: (result.stdout || result.stderr || result.error || '').trim(),
    };
  }));
}

async function installTool(toolId) {
  const definition = definitions[String(toolId || '')];
  if (!definition) throw new Error('ابزار درخواستی شناخته‌شده نیست');
  const result = await check(definition);
  if (!result.ok) {
    throw new Error(`ابزار ${definition.label} نصب نیست و نصب خودکار آن پشتیبانی نمی‌شود`);
  }
  return {
    toolId,
    installed: true,
    output: (result.stdout || result.stderr || 'ابزار آماده است').trim(),
  };
}

module.exports = { inspectRequiredTools, installTool };
