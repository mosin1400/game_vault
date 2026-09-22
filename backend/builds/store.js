const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

function createBuildStore({ root, safePart = value => /^[\w.-]+$/.test(value) }) {
  const jobsRoot = path.join(root, 'jobs');

  async function ensureRoot() {
    await fs.mkdir(jobsRoot, { recursive: true });
  }

  function validatePart(value, label) {
    const normalized = String(value || '').trim();
    if (!normalized || !safePart(normalized)) {
      throw new Error(`${label} معتبر نیست`);
    }
    return normalized;
  }

  function validateBuildInput(input = {}) {
    const game = validatePart(input.game, 'نام بازی');
    const version = validatePart(input.version, 'نسخه');
    const targets = Array.isArray(input.targets)
      ? input.targets.map(target => validatePart(target, 'هدف ساخت'))
      : [];
    if (!targets.length) throw new Error('حداقل یک هدف ساخت لازم است');
    return { game, version, targets };
  }

  async function readJob(id) {
    const safeId = validatePart(id, 'شناسه ساخت');
    try {
      return JSON.parse(await fs.readFile(path.join(jobsRoot, `${safeId}.json`), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async function writeJob(job) {
    await ensureRoot();
    const file = path.join(jobsRoot, `${job.id}.json`);
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(job, null, 2), 'utf8');
    await fs.rename(temporary, file);
    return job;
  }

  return {
    validateBuildInput,

    async createBuildJob(input) {
      const data = validateBuildInput(input);
      const now = new Date().toISOString();
      const job = {
        id: `${Date.now().toString(36)}-${crypto.randomBytes(5).toString('hex')}`,
        ...data,
        status: 'queued',
        createdAt: now,
        updatedAt: now,
        startedAt: '',
        finishedAt: '',
        error: '',
        logs: [],
        artifacts: [],
      };
      return writeJob(job);
    },

    getBuildJob(id) {
      return readJob(id);
    },

    async listBuildJobs(game = '', version = '') {
      await ensureRoot();
      const files = (await fs.readdir(jobsRoot)).filter(file => file.endsWith('.json'));
      const jobs = (await Promise.all(files.map(file => readJob(path.basename(file, '.json')))))
        .filter(Boolean)
        .filter(job => (!game || job.game === game) && (!version || job.version === version));
      return jobs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    },

    async updateBuildJob(id, changes = {}) {
      const current = await readJob(id);
      if (!current) return null;
      const next = {
        ...current,
        ...changes,
        id: current.id,
        updatedAt: new Date().toISOString(),
      };
      return writeJob(next);
    },

    async appendBuildLog(id, line) {
      const current = await readJob(id);
      if (!current) return null;
      const logs = Array.isArray(current.logs) ? current.logs : [];
      return writeJob({
        ...current,
        logs: [...logs, { at: new Date().toISOString(), line: String(line) }],
        updatedAt: new Date().toISOString(),
      });
    },
  };
}

module.exports = { createBuildStore };
