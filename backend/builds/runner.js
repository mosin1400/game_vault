const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

function buildOutputDir(buildsRoot, job) {
  return path.join(buildsRoot, String(job.game), String(job.version), String(job.id));
}

function requireLinuxHost({ wsl = false, docker = false } = {}) {
  if (!wsl && !docker) throw new Error('برای خروجی Linux به WSL یا Docker نیاز است');
  return true;
}

function requireAndroidToolchain({ java = false, androidSdk = false } = {}) {
  if (!java || !androidSdk) throw new Error('برای خروجی Android به Java LTS و Android SDK نیاز است');
  return true;
}

function exec(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true, ...options }, (error, stdout = '', stderr = '') => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
  });
}

async function copyDirectory(source, destination) {
  await fs.mkdir(destination, { recursive: true });
  await fs.cp(source, destination, { recursive: true, force: true });
}

async function archive(source, output, format) {
  await fs.mkdir(path.dirname(output), { recursive: true });
  if (process.platform === 'win32') {
    await exec('tar.exe', ['-a', '-c', '-f', output, '-C', path.dirname(source), path.basename(source)]);
  } else if (format === 'zip') {
    await exec('zip', ['-rq', output, path.basename(source)], { cwd: path.dirname(source) });
  } else {
    await exec('tar', ['-czf', output, '-C', path.dirname(source), path.basename(source)]);
  }
}

async function runBuildJob(job, { gamesRoot, buildsRoot, onLog = () => {} }) {
  const source = path.resolve(gamesRoot, job.game, 'versions', job.version);
  const directSource = path.resolve(gamesRoot, job.game);
  const project = fsSync.existsSync(source) ? source : directSource;
  if (!fsSync.existsSync(project)) throw new Error('نسخه پروژه پیدا نشد');
  const outputDir = buildOutputDir(buildsRoot, job);
  const artifacts = [];
  for (const target of job.targets || []) {
    const format = target === 'linux-targz' ? 'tar.gz' : 'zip';
    const filename = `${job.game}-${job.version}-${target}.${format}`;
    const output = path.join(outputDir, filename);
    await onLog(`ساخت ${target}`);
    await archive(project, output, format === 'zip' ? 'zip' : 'tar');
    artifacts.push({ name: filename, platform: target, format, file: output });
  }
  return artifacts;
}

module.exports = { buildOutputDir, requireLinuxHost, requireAndroidToolchain, runBuildJob };
