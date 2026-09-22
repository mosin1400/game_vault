function createQueue({ next, run }) {
  let running = false;

  async function runNext() {
    if (running) return false;
    running = true;
    try {
      let ran = false;
      let job;
      while ((job = await next())) {
        ran = true;
        await run(job);
      }
      return ran;
    } finally {
      running = false;
    }
  }

  return { runNext, isRunning: () => running };
}

module.exports = { createQueue };
