const http = require("node:http");
const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile, spawn } = require("node:child_process");
const { createBuildStore } = require("./backend/builds/store");
const { inspectRequiredTools, installTool } = require("./backend/builds/tools");
const { createQueue } = require("./backend/builds/queue");
const { runBuildJob } = require("./backend/builds/runner");
const { createCommunityStore } = require("./backend/community/store");
const projectUtils = require("./backend/core/project-utils");
const { loadEnvironmentFiles } = require("./backend/core/environment-loader");
const { installGracefulShutdown } = require("./backend/core/server-lifecycle");
const staticAssets = require("./backend/http/static-assets");
const { serveStatic } = require("./backend/http/static-response");
const systemTools = require("./backend/tools/system-tools");
const { createProjectHistory } = require("./backend/projects/history");
const { createSessionService } = require("./backend/auth/session-service");
const { createStudioAccess } = require("./backend/auth/studio-access");
const { isAdminPassword } = require("./backend/auth/admin-account");
const { createGameCatalog } = require("./backend/projects/game-catalog");
const {
  createMetadataService,
} = require("./backend/projects/metadata-service");
const aiProjectFilesService = require("./backend/ai/project-files");
const { createAgentMemory } = require("./backend/ai/agent-memory");
const { buildAgentContext } = require("./backend/ai/agent-context");
const { createAgentTools } = require("./backend/ai/agent-tools");
const { runAgent } = require("./backend/ai/agent-runner");
const { createAgentHandler } = require("./backend/ai/agent-handler");
const httpResponse = require("./backend/http/response");
const { applyTheiaCors } = require("./backend/http/theia-cors");

const ROOT = __dirname;
const GAMES = path.join(ROOT, "games");
const SKILLS = path.join(ROOT, "theia", "gv-extension", "skills");
const VAULT = path.join(ROOT, ".vault");
const USERS_FILE = path.join(VAULT, "users.json");
const ADMIN_PROFILE_FILE = path.join(VAULT, "admin-profile.json");
const COMMUNITY_FILE = path.join(VAULT, "community.json");
const BUILDS = path.join(ROOT, "builds");
const THEIA_DIR = path.join(ROOT, "theia");
const THEIA_PORT = 3010;
let theiaProcess = null;
const VSCODE_EXTENSIONS = [
  "dbaeumer.vscode-eslint",
  "esbenp.prettier-vscode",
  "ms-vscode.live-server",
  "redhat.vscode-json",
  "formulahendry.code-runner",
];
const PORT = Number(process.env.PORT || 8080);
const sessionService = createSessionService();
const studioAccess = createStudioAccess();
const community = createCommunityStore({ file: COMMUNITY_FILE });
const projectHistory = createProjectHistory({ vaultRoot: VAULT });
const agentMemory = createAgentMemory({
  root: path.join(VAULT, "agent-conversations"),
});
const agentActions = new Map();
const gameCatalog = createGameCatalog({
  gamesRoot: GAMES,
  readJson,
  validateMeta,
});
const metadataService = createMetadataService({
  readJson,
  validateMeta,
  readmeMarkdown,
});
loadEnvironmentFiles({
  root: ROOT,
  fs,
  enabled: process.env.GV_SKIP_ENV_FILE_LOADING !== "1",
});
const jsonHeaders = httpResponse.defaultJsonHeaders;
const handleAgentMessage = createAgentHandler({ agentMemory, projectRoot, buildAgentContext, createAgentTools, runAgent, saveAction: action => agentActions.set(action.id, action), apiKey: process.env.OPENROUTER_API_KEY, model: process.env.OPENROUTER_MODEL, port: PORT, skillsRoot: SKILLS });

async function ensure() {
  await Promise.all([
    fsp.mkdir(GAMES, { recursive: true }),
    fsp.mkdir(VAULT, { recursive: true }),
    fsp.mkdir(SKILLS, { recursive: true }),
    fsp.mkdir(BUILDS, { recursive: true }),
  ]);
}
async function synchronizeMetadataReadmes() {
  for (const entry of await fsp.readdir(GAMES, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const version of await versions(entry.name)) {
      if (version.root) continue;
      await metadataService.repair(projectRoot(entry.name, version.name), {
        game: entry.name,
        version: version.name,
        preserveReadme: true,
      });
    }
  }
}
function send(res, status, body, headers = jsonHeaders) {
  return httpResponse.send(res, status, body, headers);
}
function safePart(value) {
  return projectUtils.safePart(value);
}
function projectRoot(game, version) {
  if (!safePart(game) || !safePart(version))
    throw new Error("مسیر پروژه معتبر نیست");
  return path.join(GAMES, game, "versions", version);
}
const { workspaceFragment } = require('./backend/projects/workspace-url');
function safeFile(root, rel) {
  return projectUtils.safeFile(root, rel);
}
async function readJson(file, fallback) {
  return projectUtils.readJson(file, fallback);
}
async function walk(dir, base = dir) {
  return gameCatalog.walk(dir, base);
}
async function versions(game) {
  return gameCatalog.versions(game);
}
function validateMeta(meta) {
  return projectUtils.validateMeta(meta);
}
async function gamesList() {
  return gameCatalog.listGames();
}
function sessionUser(req) {
  return sessionService.user(req);
}
function auth(req) {
  return sessionService.isAuthenticated(req);
}
function admin(req) {
  return sessionService.isAdmin(req) || studioAccess.admin(req);
}
function newSession(user) {
  return sessionService.create(user);
}
function theiaHost(req) {
  return "127.0.0.1";
}
const buildStore = createBuildStore({ root: BUILDS, safePart });
const buildQueue = createQueue({
  next: async () => {
    const jobs = await buildStore.listBuildJobs();
    return jobs.find((job) => job.status === "queued") || null;
  },
  run: async (job) => {
    const started = await buildStore.updateBuildJob(job.id, {
      status: "running",
      startedAt: new Date().toISOString(),
      error: "",
    });
    const log = (line) => buildStore.appendBuildLog(job.id, line);
    try {
      await log("شروع ساخت " + started.game + " / " + started.version);
      const artifacts = await runBuildJob(started, {
        projectRoot: ROOT,
        gamesRoot: GAMES,
        buildsRoot: BUILDS,
        onLog: (line) => {
          log(line).catch(() => {});
        },
      });
      await buildStore.updateBuildJob(job.id, {
        status: "completed",
        finishedAt: new Date().toISOString(),
        artifacts: artifacts.map((item) => ({
          ...item,
          file: path.relative(BUILDS, item.file).replaceAll("\\", "/"),
          url:
            "/api/builds/" +
            job.id +
            "/download/" +
            encodeURIComponent(item.name),
        })),
      });
      await log("ساخت با موفقیت تمام شد");
    } catch (error) {
      await buildStore.updateBuildJob(job.id, {
        status: "failed",
        finishedAt: new Date().toISOString(),
        error: error.message,
      });
      await log("خطا: " + error.message);
    }
  },
});
async function users() {
  return await readJson(USERS_FILE, []);
}
async function saveUsers(list) {
  await fsp.mkdir(path.dirname(USERS_FILE), { recursive: true });
  await fsp.writeFile(USERS_FILE, JSON.stringify(list, null, 2));
}
function passwordRecord(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString("hex") };
}
function passwordMatches(password, record) {
  return crypto.timingSafeEqual(
    Buffer.from(record.hash, "hex"),
    crypto.scryptSync(password, record.salt, 64),
  );
}
function publicUser(user) {
  return sessionService.publicUser(user);
}
function communityUser(req) {
  const user = sessionUser(req);
  if (user) return { id: user.id, name: user.name || "ادمین" };
  return {
    id:
      "guest:" +
      crypto
        .createHash("sha256")
        .update(String(req.headers["user-agent"] || "guest"))
        .digest("hex")
        .slice(0, 16),
    name: "مهمان",
  };
}
function readmeMarkdown(meta) {
  return projectUtils.readmeMarkdown(meta);
}
async function body(req) {
  return httpResponse.readJsonBody(req);
}
function snapshotKey(game, version) {
  return projectHistory.fileFor(game, version);
}
async function addHistory(game, version, entry) {
  return projectHistory.add(game, version, entry);
}
async function projectSnapshot(root) {
  return projectHistory.snapshot(root);
}
const AI_TEXT = aiProjectFilesService.textFilePattern;
function proposalKey(id) {
  return path.join(VAULT, "ai-proposals", id + ".json");
}
async function aiProjectFiles(root) {
  return aiProjectFilesService.collectProjectFiles(root);
}
function extractJson(content) {
  return aiProjectFilesService.extractJson(content);
}
function createUnifiedDiff(before, after) {
  const left = String(before || "").split("\n"), right = String(after || "").split("\n");
  const lines = ["--- before", "+++ after"], length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index++) {
    if (left[index] === right[index]) continue;
    if (left[index] !== undefined) lines.push("-" + left[index]);
    if (right[index] !== undefined) lines.push("+" + right[index]);
  }
  return lines.join("\n");
}
function run(command, args = [], options = {}) {
  return systemTools.run(command, args, options);
}
async function locateVSCode() {
  return systemTools.locateVSCode();
}
async function projectStats(root) {
  return systemTools.projectStats(root);
}
async function gitInfo(root) {
  return systemTools.gitInfo(root);
}
function theiaCommand() {
  const command = path.join(
    THEIA_DIR,
    "node_modules",
    "@theia",
    "cli",
    "bin",
    "theia.js",
  );
  return fs.existsSync(command) ? command : "";
}
async function startTheia() {
  const probe = () => new Promise(resolve => {
    const request = http.get(`http://127.0.0.1:${THEIA_PORT}/`, response => { response.resume(); resolve(response.statusCode === 200); });
    request.setTimeout(1000, () => request.destroy());
    request.on("error", () => resolve(false));
  });
  if (await probe()) return;
  const command = theiaCommand();
  if (!command) throw new Error("Theia هنوز نصب یا build نشده است.");
  if (!theiaProcess || theiaProcess.killed || theiaProcess.exitCode !== null) {
    theiaProcess = spawn(
    process.execPath,
    [command, "start", "--hostname=127.0.0.1", "--port=" + THEIA_PORT],
    {
      cwd: THEIA_DIR,
      windowsHide: true,
      stdio: "ignore",
    },
  );
    const child = theiaProcess;
    child.on("exit", () => { if (theiaProcess === child) theiaProcess = null; });
    child.on("error", () => { if (theiaProcess === child) theiaProcess = null; });
  }
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const ready = await probe();
    if (ready) return;
    if (!theiaProcess) throw new Error("راه‌اندازی Theia ناموفق بود؛ صفحه به سرویس خاموش منتقل نشد.");
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error("آماده‌سازی Studio طول کشید. چند لحظه دیگر دوباره باز کنید.");
}
async function api(req, res, url) {
  if (applyTheiaCors(req, res) && req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }
  if (req.method === "POST" && url.pathname === "/api/auth/register") {
    const data = await body(req),
      username = String(data.username || "").trim().toLowerCase(),
      name = String(data.name || "").trim().slice(0, 48),
      password = String(data.password || ""),
      avatar = String(data.avatar || "").trim().slice(0, 2);
    if (!/^[a-z0-9_.-]{3,32}$/.test(username) || username === "admin") return send(res, 400, { error: "نام کاربری باید ۳ تا ۳۲ حرف انگلیسی، عدد یا . _ - باشد" });
    if (name.length < 2) return send(res, 400, { error: "نام نمایشی باید حداقل ۲ حرف باشد" });
    if (password.length < 6) return send(res, 400, { error: "رمز عبور باید حداقل ۶ حرف باشد" });
    const list = await users();
    if (list.some(user => String(user.username || "").toLowerCase() === username)) return send(res, 409, { error: "این نام کاربری قبلاً استفاده شده است" });
    const account = { id: crypto.randomUUID(), username, name, avatar, role: "user", password: passwordRecord(password), createdAt: new Date().toISOString() };
    list.push(account); await saveUsers(list);
    const user = { id: account.id, username, name, avatar, role: "user" }, token = newSession(user);
    return send(res, 201, { ok: true, user: publicUser(user) }, { ...jsonHeaders, "set-cookie": `gv_session=${token}; HttpOnly; SameSite=Strict; Path=/` });
  }
  if (req.method === "POST" && url.pathname === "/api/auth/login") {
    const data = await body(req),
      username = String(data.username || "")
        .trim()
        .toLowerCase();
    if (username !== "admin") {
      const account = (await users()).find(user => String(user.username || "").toLowerCase() === username);
      if (!account?.password || !passwordMatches(String(data.password || ""), account.password)) return send(res, 401, { error: "نام کاربری یا رمز نادرست است" });
      const user = { id: account.id, username: account.username, name: account.name, avatar: account.avatar || "", role: "user" }, token = newSession(user);
      return send(res, 200, { ok: true, user: publicUser(user) }, { ...jsonHeaders, "set-cookie": `gv_session=${token}; HttpOnly; SameSite=Strict; Path=/` });
    }
    if (!isAdminPassword(data.password)) return send(res, 401, { error: "نام کاربری یا رمز نادرست است" });
    const profile = await readJson(ADMIN_PROFILE_FILE, {
        name: "ادمین",
        avatar: "A",
        image: "",
      }),
      user = {
        id: "admin-local",
        username: "admin",
        name: profile.name || "ادمین",
        avatar: profile.avatar || "A",
        image: profile.image || "",
        role: "admin",
      },
      token = newSession(user);
    return send(
      res,
      200,
      { ok: true, user: publicUser(user) },
      {
        ...jsonHeaders,
        "set-cookie": `gv_session=${token}; HttpOnly; SameSite=Strict; Path=/`,
      },
    );
  }
  if (req.method === "POST" && url.pathname === "/api/auth/logout") {
    sessionService.remove(sessionService.tokenFrom(req));
    return send(
      res,
      200,
      { ok: true },
      { ...jsonHeaders, "set-cookie": "gv_session=; Max-Age=0; Path=/" },
    );
  }
  if (req.method === "GET" && url.pathname === "/api/me")
    return send(res, 200, {
      guest: !auth(req),
      user: publicUser(sessionUser(req)),
    });
  if (req.method === "PUT" && url.pathname === "/api/profile") {
    const current = sessionUser(req);
    if (!current) return send(res, 401, { error: "ابتدا وارد حساب شوید" });
    const data = await body(req),
      name = String(data.name || "").trim(),
      avatar = String(data.avatar || "")
        .trim()
        .slice(0, 2);
    if (name.length < 2)
      return send(res, 400, { error: "نام نمایشی باید حداقل ۲ حرف باشد" });
    const next = { ...current, name, avatar };
    if (current.id === "admin-local")
      await fsp.writeFile(
        ADMIN_PROFILE_FILE,
        JSON.stringify({ name, avatar }, null, 2),
      );
    else {
      const list = await users(),
        index = list.findIndex((u) => u.id === current.id);
      if (index < 0) return send(res, 404, { error: "حساب پیدا نشد" });
      list[index] = { ...list[index], name, avatar };
      await saveUsers(list);
    }
    sessionService.replaceUser(current.id, { name, avatar });
    return send(res, 200, { ok: true, user: publicUser(next) });
  }
  if (req.method === "POST" && url.pathname === "/api/login") {
    const data = await body(req);
    if (!isAdminPassword(data.password))
      return send(res, 401, { error: "رمز عبور نادرست است" });
    const profile = await readJson(ADMIN_PROFILE_FILE, {
        name: "ادمین",
        avatar: "A",
        image: "",
      }),
      user = {
        id: "admin-local",
        username: "admin",
        name: profile.name || "ادمین",
        avatar: profile.avatar || "A",
        image: profile.image || "",
        role: "admin",
      },
      token = newSession(user);
    return send(
      res,
      200,
      { ok: true, user: publicUser(user) },
      {
        ...jsonHeaders,
        "set-cookie": `gv_session=${token}; HttpOnly; SameSite=Strict; Path=/`,
      },
    );
  }
  if (url.pathname === "/api/session")
    return send(res, 200, {
      authenticated: !!auth(req),
      user: publicUser(sessionUser(req)),
    });
  if (req.method === "GET" && url.pathname === "/api/community") {
    const game = String(url.searchParams.get("game") || "");
    if (!safePart(game)) return send(res, 400, { error: "بازی معتبر نیست" });
    return send(res, 200, {
      rating: await community.rating(game),
      comments: await community.comments(game),
      weekly: await community.weekly(),
    });
  }
  if (req.method === "GET" && url.pathname === "/api/activity/weekly")
    return send(res, 200, await community.weekly());
  if (req.method === "POST" && url.pathname === "/api/community/rating") {
    const data = await body(req),
      game = String(data.game || "");
    if (!safePart(game)) return send(res, 400, { error: "بازی معتبر نیست" });
    return send(res, 200, {
      rating: await community.rate(game, communityUser(req).id, data.value),
    });
  }
  if (req.method === "POST" && url.pathname === "/api/community/comment") {
    const data = await body(req),
      game = String(data.game || ""),
      identity = communityUser(req);
    if (!safePart(game)) return send(res, 400, { error: "بازی معتبر نیست" });
    return send(res, 201, {
      comment: await community.comment(game, {
        author: identity.name,
        userId: identity.id,
        text: data.text,
      }),
    });
  }
  if (req.method === "POST" && url.pathname === "/api/activity") {
    const data = await body(req),
      game = String(data.game || "");
    if (!safePart(game)) return send(res, 400, { error: "بازی معتبر نیست" });
    await community.event(game, data.type, data.version);
    return send(res, 200, { ok: true });
  }
  if (req.method === "GET" && url.pathname === "/api/game-detail") {
    const game = String(url.searchParams.get("game") || "");
    if (!safePart(game)) return send(res, 400, { error: "بازی معتبر نیست" });
    const detail = await gameCatalog.detail(game, url.searchParams.get("version") || undefined);
    if (!detail) return send(res, 404, { error: "جزئیات بازی پیدا نشد" });
    return send(res, 200, {
      ...detail,
      activity: await community.activity(game),
    });
  }
  if (
    url.pathname.startsWith("/api/") &&
    !["/api/games", "/api/skills", "/api/me", "/api/game-detail"].includes(
      url.pathname,
    ) &&
    !url.pathname.startsWith("/api/skills/") &&
    !admin(req)
  )
    return send(res, 401, { error: "نیاز به ورود مدیر است" });
  if (
    req.method === "POST" &&
    /^\/api\/community\/[^/]+\/reply$/.test(url.pathname)
  ) {
    const data = await body(req),
      id = url.pathname.split("/")[3],
      user = sessionUser(req);
    return send(res, 200, {
      comment: await community.reply(id, {
        author: user.name,
        text: data.text,
      }),
    });
  }
  if (
    req.method === "DELETE" &&
    /^\/api\/community\/[^/]+$/.test(url.pathname)
  ) {
    await community.remove(url.pathname.split("/").at(-1));
    return send(res, 200, { ok: true });
  }
  if (req.method === "GET" && url.pathname === "/api/community/admin")
    return send(res, 200, { comments: await community.allComments() });
  if (req.method === "GET" && url.pathname === "/api/community/export")
    return send(res, 200, await community.exportData(), {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": 'attachment; filename="game-vault-community.json"',
    });
  if (req.method === "POST" && url.pathname === "/api/theia/open") {
    const data = await body(req);
    if (!data.version) data.version = (await versions(data.game)).filter(item => item.valid).sort((a, b) => b.updatedAt - a.updatedAt)[0]?.name;
    const
      root = projectRoot(data.game, data.version),
      gvToken = studioAccess.issue(sessionUser(req));
    await startTheia();
    return send(res, 200, {
      ok: true,
      url: `http://${theiaHost(req)}:${THEIA_PORT}/?workspace=${encodeURIComponent('file://' + root.replaceAll('\\', '/').replace(/^([A-Za-z]:)/, '/$1'))}&gvGame=${encodeURIComponent(data.game)}&gvVersion=${encodeURIComponent(data.version)}&gvApiPort=${encodeURIComponent(PORT)}&gvToken=${encodeURIComponent(gvToken)}#${workspaceFragment(root)}`,
    });
  }
  if (req.method === "POST" && url.pathname === "/api/theia/free") {
    const gvToken = studioAccess.issue(sessionUser(req));
    await startTheia();
    return send(res, 200, {
      ok: true,
      url: `http://${theiaHost(req)}:${THEIA_PORT}/?gvFree=1&gvApiPort=${encodeURIComponent(PORT)}&gvToken=${encodeURIComponent(gvToken)}`,
    });
  }
  if (req.method === "GET" && url.pathname === "/api/project-tools") {
    const root = projectRoot(
      url.searchParams.get("game"),
      url.searchParams.get("version"),
    );
    return send(res, 200, {
      path: root,
      vscode: await locateVSCode(),
      git: await gitInfo(root),
      resources: await projectStats(root),
      extensions: VSCODE_EXTENSIONS,
    });
  }
  if (req.method === "POST" && url.pathname === "/api/vscode/open") {
    const data = await body(req),
      root = projectRoot(data.game, data.version),
      vscode = await locateVSCode();
    if (!vscode.installed)
      return send(res, 404, {
        error: "شما VS Code ندارید یا نصب آن شناسایی نشد",
      });
    const result =
      process.platform === "win32"
        ? await run("cmd.exe", [
            "/d",
            "/s",
            "/c",
            `start "" "${vscode.command}" --reuse-window "${root}"`,
          ])
        : await run(vscode.command, ["--reuse-window", root]);
    if (!result.ok)
      return send(res, 502, {
        error: "VS Code باز نشد؛ مسیر پروژه را کپی و دستی باز کنید.",
      });
    return send(res, 200, {
      ok: true,
      path: root,
      protocol:
        "vscode://file/" + encodeURIComponent(root.replaceAll("\\", "/")),
    });
  }
  if (req.method === "POST" && url.pathname === "/api/vscode/extensions") {
    const data = await body(req),
      extensions = [
        ...new Set(
          (data.extensions || []).filter((x) => VSCODE_EXTENSIONS.includes(x)),
        ),
      ];
    if (data.confirmed !== true)
      return send(res, 400, {
        error: "برای نصب افزونه‌ها باید تأیید صریح انجام شود",
      });
    const vscode = await locateVSCode();
    if (!vscode.installed)
      return send(res, 404, {
        error: "شما VS Code ندارید یا نصب آن شناسایی نشد",
      });
    const results = [];
    for (const extension of extensions) {
      const result =
        process.platform === "win32"
          ? await run("cmd.exe", [
              "/d",
              "/s",
              "/c",
              `"${vscode.command}" --install-extension ${extension}`,
            ])
          : await run(vscode.command, ["--install-extension", extension]);
      results.push({
        extension,
        ok: result.ok,
        output: (result.stdout || result.stderr).trim(),
      });
    }
    return send(res, 200, { ok: true, results });
  }
  if (req.method === "GET" && url.pathname === "/api/build-tools") {
    const targets = String(url.searchParams.get("targets") || "")
      .split(",")
      .filter(Boolean);
    return send(res, 200, { tools: await inspectRequiredTools(targets) });
  }
  if (req.method === "POST" && url.pathname === "/api/build-tools/install") {
    const data = await body(req);
    if (data.confirmed !== true)
      return send(res, 400, {
        error: "برای نصب ابزار باید تأیید صریح انجام شود",
      });
    const result = await installTool(String(data.toolId || ""));
    return send(res, 200, { ok: true, result });
  }
  if (req.method === "POST" && url.pathname === "/api/builds") {
    const data = await body(req);
    const job = await buildStore.createBuildJob(data);
    buildQueue.runNext().catch(() => {});
    return send(res, 201, { job });
  }
  if (req.method === "GET" && url.pathname === "/api/builds") {
    return send(res, 200, {
      jobs: await buildStore.listBuildJobs(
        url.searchParams.get("game") || "",
        url.searchParams.get("version") || "",
      ),
    });
  }
  if (req.method === "GET" && /^\/api\/builds\/[^/]+$/.test(url.pathname)) {
    const job = await buildStore.getBuildJob(url.pathname.split("/").at(-1));
    if (!job) return send(res, 404, { error: "Job ساخت پیدا نشد" });
    return send(res, 200, { job });
  }
  if (
    req.method === "GET" &&
    /^\/api\/builds\/[^/]+\/download\/[^/]+$/.test(url.pathname)
  ) {
    const [, , , jobId, , artifactName] = url.pathname.split("/");
    const job = await buildStore.getBuildJob(jobId),
      artifact = job?.artifacts.find(
        (item) => item.name === decodeURIComponent(artifactName),
      );
    if (!artifact) return send(res, 404, { error: "فایل خروجی پیدا نشد" });
    const file = path.resolve(BUILDS, artifact.file);
    if (!file.startsWith(BUILDS + path.sep) || (await fsp.stat(file)).size <= 0)
      return send(res, 404, { error: "فایل خروجی معتبر نیست" });
    return send(res, 200, await fsp.readFile(file), {
      "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename="${artifact.name.replaceAll('"', "")}"`,
    });
  }
  if (req.method === "GET" && url.pathname === "/api/games") {
    const games = await gamesList();
    return send(res, 200, {
      games: await Promise.all(
        games.map(async (game) => {
          const rating = await community.rating(game.id);
          return {
            ...game,
            rating: rating.count ? rating.average : 0,
            ratingCount: rating.count,
          };
        }),
      ),
    });
  }
  if (req.method === "POST" && url.pathname === "/api/game") {
    const data = await body(req),
      slug = String(data.slug || "").trim();
    if (!safePart(slug))
      return send(res, 400, { error: "شناسه بازی معتبر نیست" });
    const root = path.join(GAMES, slug, "versions", "v1.0.0");
    if (fs.existsSync(root))
      return send(res, 400, { error: "بازی با این شناسه وجود دارد" });
    const meta = {
      id: slug,
      Order: String((await gamesList()).length + 1),
      name: String(data.name || slug),
      slug,
      description: String(data.description || "توضیحات بازی جدید"),
      ai: String(data.ai || "نامشخص"),
      category: String(data.category || "اکشن"),
      image: String(data.image || "cover.png"),
      playUrl: "game.html",
      downloadUrl: "game.html",
      version: "v1.0.0",
      status: String(data.status || "draft"),
    };
    await fsp.mkdir(root, { recursive: true });
    await fsp.writeFile(
      path.join(root, "game.json"),
      JSON.stringify(meta, null, 2),
    );
    await fsp.writeFile(path.join(root, "README.md"), readmeMarkdown(meta));
    await fsp.writeFile(
      path.join(root, "game.html"),
      "<!doctype html><title>" +
        meta.name +
        "</title><h1>" +
        meta.name +
        "</h1>",
    );
    return send(res, 201, { ok: true, game: meta });
  }
  if (req.method === "DELETE" && url.pathname === "/api/game") {
    const data = await body(req);
    if (!safePart(data.game))
      return send(res, 400, { error: "شناسه بازی نامعتبر است" });
    await fsp.rm(path.join(GAMES, data.game), { recursive: true, force: true });
    return send(res, 200, { ok: true });
  }
  if (req.method === "GET" && url.pathname === "/api/versions")
    return send(res, 200, {
      versions: await versions(url.searchParams.get("game")),
    });
  if (req.method === "GET" && url.pathname === "/api/metadata") {
    const root = projectRoot(
      url.searchParams.get("game"),
      url.searchParams.get("version"),
    );
    const meta = await readJson(path.join(root, "game.json"), null);
    if (!meta) return send(res, 404, { error: "game.json پیدا نشد" });
    return send(res, 200, {
      meta,
      markdown: await fsp
        .readFile(path.join(root, "README.md"), "utf8")
        .catch(() => readmeMarkdown(meta)),
    });
  }
  if (req.method === "POST" && url.pathname === "/api/metadata/repair") {
    const data = await body(req),
      root = projectRoot(data.game, data.version),
      before = await projectSnapshot(root),
      result = await metadataService.repair(root, {
        game: data.game,
        version: data.version,
      });
    await addHistory(data.game, data.version, {
      author: "user",
      message: "تصحیح یا ساخت فایل‌های اصلی پروژه",
      files: ["game.json", "README.md"],
      before,
    });
    return send(res, 200, { ok: true, ...result });
  }
  if (req.method === "PUT" && url.pathname === "/api/metadata") {
    const data = await body(req),
      root = projectRoot(data.game, data.version),
      current = await readJson(path.join(root, "game.json"), {}),
      meta = { ...current, ...data.meta, version: data.version };
    meta.Order = String(meta.Order);
    const error = validateMeta(meta);
    if (error) return send(res, 400, { error });
    const before = await projectSnapshot(root);
    await fsp.writeFile(
      path.join(root, "game.json"),
      JSON.stringify(meta, null, 2),
    );
    await fsp.writeFile(path.join(root, "README.md"), readmeMarkdown(meta));
    await addHistory(data.game, data.version, {
      author: "user",
      message: "ویرایش مشخصات بازی",
      files: ["game.json", "README.md"],
      before,
    });
    return send(res, 200, { ok: true, meta });
  }
  if (req.method === "GET" && url.pathname === "/api/tree") {
    const root = projectRoot(
      url.searchParams.get("game"),
      url.searchParams.get("version"),
    );
    return send(res, 200, { tree: await walk(root) });
  }
  if (req.method === "GET" && url.pathname === "/api/file") {
    const root = projectRoot(
      url.searchParams.get("game"),
      url.searchParams.get("version"),
    );
    const file = safeFile(root, url.searchParams.get("path"));
    return send(res, 200, {
      path: url.searchParams.get("path"),
      content: await fsp.readFile(file, "utf8"),
    });
  }
  if (req.method === "GET" && url.pathname === "/api/history") {
    return send(res, 200, {
      history: await readJson(
        snapshotKey(
          url.searchParams.get("game"),
          url.searchParams.get("version"),
        ),
        [],
      ),
    });
  }
  if (req.method === "POST" && url.pathname === "/api/history/restore") {
    const data = await body(req),
      root = projectRoot(data.game, data.version),
      history = await readJson(snapshotKey(data.game, data.version), []),
      item = history.find((x) => x.id === data.id);
    if (!item?.before)
      return send(res, 400, { error: "Snapshot قابل بازگشت نیست" });
    const before = await projectSnapshot(root);
    await fsp.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    await fsp.mkdir(root, { recursive: true });
    for (const [relative, content] of Object.entries(item.before)) {
      const target = safeFile(root, relative);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, content);
    }
    await addHistory(data.game, data.version, {
      author: "user",
      message: `بازگشت به ${item.message}`,
      files: Object.keys(item.before),
      before,
    });
    return send(res, 200, { ok: true });
  }
  if (req.method === "DELETE" && url.pathname === "/api/history") {
    const data = await body(req),
      file = snapshotKey(data.game, data.version),
      history = await readJson(file, []);
    await fsp.writeFile(
      file,
      JSON.stringify(
        history.filter((x) => x.id !== data.id),
        null,
        2,
      ),
    );
    return send(res, 200, { ok: true });
  }
  if (req.method === "GET" && url.pathname === "/api/search") {
    const root = projectRoot(
        url.searchParams.get("game"),
        url.searchParams.get("version"),
      ),
      query = String(url.searchParams.get("q") || "").toLowerCase(),
      results = [];
    async function scan(dir) {
      for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await scan(full);
        else if (
          (await fsp.stat(full)).size < 700000 &&
          /\.(html?|css|js|json|md|txt)$/i.test(e.name)
        ) {
          const lines = (await fsp.readFile(full, "utf8")).split(/\r?\n/);
          lines.forEach((line, index) => {
            if (query && line.toLowerCase().includes(query))
              results.push({
                path: path.relative(root, full).replaceAll("\\", "/"),
                line: index + 1,
                text: line.trim().slice(0, 180),
              });
          });
        }
      }
    }
    await scan(root);
    return send(res, 200, { results: results.slice(0, 250) });
  }
  if (req.method === "POST" && url.pathname === "/api/replace") {
    const data = await body(req),
      root = projectRoot(data.game, data.version),
      before = await projectSnapshot(root),
      query = String(data.query || ""),
      replacement = String(data.replacement || "");
    if (!query) return send(res, 400, { error: "متن جست‌وجو خالی است" });
    const changed = [];
    for (const rel of Object.keys(before)) {
      if (
        /\.(html?|css|js|json|md|txt)$/i.test(rel) &&
        before[rel].includes(query)
      ) {
        const file = safeFile(root, rel);
        await fsp.writeFile(file, before[rel].split(query).join(replacement));
        changed.push(rel);
      }
    }
    await addHistory(data.game, data.version, {
      author: "user",
      message: `جایگزینی ${query}`,
      files: changed,
      before,
    });
    return send(res, 200, { ok: true, changed });
  }
  if (req.method === "GET" && url.pathname === "/api/skills") {
    const list = [];
    for (const e of await fsp.readdir(SKILLS, { withFileTypes: true })) {
      if (e.isDirectory())
        list.push(
          await readJson(path.join(SKILLS, e.name, "skill.json"), {
            id: e.name,
            name: e.name,
          }),
        );
    }
    return send(res, 200, { skills: list });
  }
  const skillMatch = url.pathname.match(/^\/api\/skills\/([A-Za-z0-9._-]+)$/);
  if (req.method === "GET" && skillMatch) {
    const id = skillMatch[1];
    if (!safePart(id)) return send(res, 400, { error: "Skill معتبر نیست" });
    const directory = path.join(SKILLS, id);
    const metadata = await readJson(path.join(directory, "skill.json"), null);
    if (!metadata) return send(res, 404, { error: "Skill پیدا نشد" });
    let instructions = "";
    try { instructions = await fsp.readFile(path.join(directory, "instructions.md"), "utf8"); } catch {}
    return send(res, 200, { skill: { ...metadata, instructions, href: `/skills/${id}/instructions.md` } });
  }
  const skillInstructionsMatch = url.pathname.match(/^\/api\/skills\/([A-Za-z0-9._-]+)\/instructions$/);
  if (req.method === "GET" && skillInstructionsMatch) {
    const id = skillInstructionsMatch[1];
    if (!safePart(id)) return send(res, 400, { error: "Skill معتبر نیست" });
    try {
      const instructions = await fsp.readFile(path.join(SKILLS, id, "instructions.md"), "utf8");
      return send(res, 200, instructions, { "content-type": "text/markdown; charset=utf-8" });
    } catch (error) {
      if (error.code === "ENOENT") return send(res, 404, { error: "Skill پیدا نشد" });
      throw error;
    }
  }
  if (req.method === "GET" && url.pathname === "/api/download") {
    const root = projectRoot(
      url.searchParams.get("game"),
      url.searchParams.get("version"),
    );
    const file = path.join(root, "game.html");
    return send(res, 200, await fsp.readFile(file), {
      "content-type": "text/html; charset=utf-8",
      "content-disposition": `attachment; filename="${url.searchParams.get("game")}.html"`,
    });
  }
  if (req.method === "PUT" && url.pathname === "/api/file") {
    const data = await body(req),
      root = projectRoot(data.game, data.version),
      file = safeFile(root, data.path);
    const before = await projectSnapshot(root);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, String(data.content ?? ""));
    await addHistory(data.game, data.version, {
      author: data.author || "user",
      message: data.message || `ویرایش ${data.path}`,
      files: [data.path],
      before,
    });
    return send(res, 200, { ok: true });
  }
  if (req.method === "POST" && url.pathname === "/api/folder") {
    const data = await body(req),
      root = projectRoot(data.game, data.version),
      folder = safeFile(root, data.path);
    await fsp.mkdir(folder, { recursive: false });
    await addHistory(data.game, data.version, {
      author: "user",
      message: `ایجاد پوشه ${data.path}`,
      files: [data.path],
    });
    return send(res, 201, { ok: true });
  }
  if (req.method === "PATCH" && url.pathname === "/api/file") {
    const data = await body(req),
      root = projectRoot(data.game, data.version),
      from = safeFile(root, data.path),
      to = safeFile(root, data.newPath);
    if (["game.json", "README.md"].includes(path.basename(from)))
      return send(res, 400, { error: "تغییر نام فایل‌های اصلی مجاز نیست" });
    if (fs.existsSync(to))
      return send(res, 400, { error: "فایل یا پوشه‌ای با این نام وجود دارد" });
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.rename(from, to);
    await addHistory(data.game, data.version, {
      author: "user",
      message: `تغییر نام ${data.path}`,
      files: [data.path, data.newPath],
    });
    return send(res, 200, { ok: true });
  }
  if (req.method === "DELETE" && url.pathname === "/api/file") {
    const data = await body(req),
      root = projectRoot(data.game, data.version),
      file = safeFile(root, data.path);
    if (["game.json", "README.md"].includes(path.basename(file)))
      return send(res, 400, { error: "حذف فایل‌های اصلی مجاز نیست" });
    await fsp.rm(file, { recursive: true, force: true });
    await addHistory(data.game, data.version, {
      author: "user",
      message: `حذف ${data.path}`,
      files: [data.path],
    });
    return send(res, 200, { ok: true });
  }
  if (req.method === "POST" && url.pathname === "/api/version") {
    const data = await body(req);
    const dest = projectRoot(data.game, data.version);
    if (!safePart(data.game) || !safePart(data.version) || fs.existsSync(dest))
      return send(res, 400, { error: "نام نسخه نامعتبر یا تکراری است" });
    await fsp.mkdir(dest, { recursive: true });
    if (data.fromVersion) {
      await fsp.cp(projectRoot(data.game, data.fromVersion), dest, {
        recursive: true,
      });
      const meta = await readJson(path.join(dest, "game.json"), {});
      meta.version = data.version;
      delete meta.rating;
      await fsp.writeFile(
        path.join(dest, "game.json"),
        JSON.stringify(meta, null, 2),
      );
      await fsp.writeFile(path.join(dest, "README.md"), readmeMarkdown(meta));
    } else {
      const meta = {
        id: data.game,
        Order: "1",
        name: data.game,
        slug: data.game,
        description: "نسخه جدید بازی",
        ai: "",
        category: "اکشن",
        image: "",
        playUrl: "",
        downloadUrl: "",
        version: data.version,
        status: "draft",
      };
      await fsp.writeFile(
        path.join(dest, "game.json"),
        JSON.stringify(meta, null, 2),
      );
      await fsp.writeFile(
        path.join(dest, "README.md"),
        readmeMarkdown(meta),
      );
    }
    return send(res, 201, { ok: true });
  }
  if (req.method === "PATCH" && url.pathname === "/api/version") {
    const data = await body(req);
    const old = projectRoot(data.game, data.version),
      next = projectRoot(data.game, data.newVersion);
    if (fs.existsSync(next))
      return send(res, 400, { error: "نام نسخه تکراری است" });
    await fsp.rename(old, next);
    const meta = await readJson(path.join(next, "game.json"), {});
    meta.version = data.newVersion;
    delete meta.rating;
    await fsp.writeFile(
      path.join(next, "game.json"),
      JSON.stringify(meta, null, 2),
    );
    await fsp.writeFile(path.join(next, "README.md"), readmeMarkdown(meta));
    return send(res, 200, { ok: true });
  }
  if (req.method === "DELETE" && url.pathname === "/api/version") {
    const data = await body(req);
    const root = projectRoot(data.game, data.version);
    await fsp.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    return send(res, 200, { ok: true });
  }
  if (req.method === "POST" && url.pathname === "/api/upload") {
    const data = await body(req),
      root = projectRoot(data.game, data.version);
    await fsp.mkdir(root, { recursive: true });
    if (data.zipBase64) {
      const tmp = path.join(VAULT, `${crypto.randomUUID()}.zip`);
      await fsp.writeFile(tmp, Buffer.from(data.zipBase64, "base64"));
      const result = await new Promise((resolve) =>
        execFile(
          "powershell.exe",
          [
            "-NoProfile",
            "-Command",
            `Expand-Archive -LiteralPath '${tmp.replaceAll("'", "''")}' -DestinationPath '${root.replaceAll("'", "''")}' -Force`,
          ],
          (error) => resolve(error),
        ),
      );
      await fsp.rm(tmp, { force: true });
      if (result) return send(res, 400, { error: "باز کردن ZIP انجام نشد" });
    } else if (data.file) {
      const file = safeFile(root, data.file.name);
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, Buffer.from(data.file.base64, "base64"));
    }
    const meta = await readJson(path.join(root, "game.json"), null);
    if (!meta)
      return send(res, 400, { error: "game.json برای این نسخه الزامی است" });
    const error = validateMeta(meta);
    if (error) return send(res, 400, { error });
    await addHistory(data.game, data.version, {
      author: "user",
      message: "آپلود فایل یا ZIP",
      files: ["upload"],
    });
    return send(res, 200, { ok: true });
  }
  if (req.method === "GET" && url.pathname === "/api/openrouter/status")
    return send(res, 200, {
      configured: Boolean(process.env.OPENROUTER_API_KEY),
      model: process.env.OPENROUTER_MODEL || "openrouter/free",
      message: process.env.OPENROUTER_API_KEY
        ? "کلید در حافظهٔ سرور شناسایی شد."
        : "کلید در حافظهٔ سرور شناسایی نشد؛ پس از ذخیرهٔ .env سرور را دوباره اجرا کن.",
    });
  if (req.method === "POST" && url.pathname === "/api/ai/rewrite") {
    const data = await body(req),
      root = projectRoot(data.game, data.version);
    if (!process.env.OPENROUTER_API_KEY)
      return send(res, 400, {
        error: "کلید OpenRouter در حافظهٔ سرور شناسایی نشد.",
      });
    const files = await aiProjectFiles(root);
    if (!Object.keys(files).length)
      return send(res, 400, {
        error: "فایل متنی قابل بازنویسی در پروژه وجود ندارد.",
      });
    const prompt = `یک پروژه بازی وب را فقط با هدف رفع خطا و حفظ قابلیت‌ها بازبینی کن. پاسخ فقط JSON معتبر با قالب {"files":{"مسیر/فایل":"محتوای کامل جدید"},"summary":"..."} باشد. فقط فایل‌هایی را که تغییر لازم دارند در files قرار بده. game.json و README.md فایل‌های اصلی و محافظت‌شده‌اند؛ آن‌ها را تغییر نده. کد کامل فایل را بنویس، هیچ markdown یا توضیح خارج JSON نده. پروژه: ${JSON.stringify(files)}`;
    let response, result;
    try {
      response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "http://localhost:" + PORT,
          "X-Title": "Game Vault",
        },
        body: JSON.stringify({
          model:
            data.model || process.env.OPENROUTER_MODEL || "openrouter/free",
          messages: [
            {
              role: "system",
              content: "تو یک مهندس ارشد وب هستی. پاسخ ساخت‌یافته و معتبر بده.",
            },
            { role: "user", content: prompt },
          ],
          temperature: 0.1,
        }),
      });
      result = await response.json();
    } catch (error) {
      return send(res, 502, {
        error: "اتصال به OpenRouter برقرار نشد: " + error.message,
      });
    }
    if (!response.ok)
      return send(res, 502, {
        error: result.error?.message || "OpenRouter پاسخ ناموفق داد",
      });
    let proposal;
    try {
      proposal = extractJson(result.choices?.[0]?.message?.content);
    } catch {
      return send(res, 502, {
        error: "پاسخ AI ساختار JSON معتبر نداشت؛ دوباره تلاش کن.",
      });
    }
    const changed = {};
    for (const [relative, content] of Object.entries(proposal.files || {})) {
      if (
        !AI_TEXT.test(relative) ||
        ["game.json", "README.md"].includes(path.basename(relative)) ||
        typeof content !== "string" ||
        !Object.hasOwn(files, relative) ||
        content === files[relative]
      )
        continue;
      changed[relative] = content;
    }
    if (!Object.keys(changed).length)
      return send(res, 200, {
        proposal: null,
        message: proposal.summary || "تغییر ضروری پیدا نشد.",
      });
    const id = crypto.randomUUID(),
      item = {
        id,
        game: data.game,
        version: data.version,
        createdAt: new Date().toISOString(),
        summary: String(proposal.summary || "پیشنهاد بازنویسی AI"),
        files: changed,
      };
    await fsp.mkdir(path.dirname(proposalKey(id)), { recursive: true });
    await fsp.writeFile(proposalKey(id), JSON.stringify(item));
    return send(res, 200, {
      proposal: {
        id,
        summary: item.summary,
        files: Object.entries(changed).map(([path, content]) => ({
          path,
          added: content.split("\n").length,
          preview: content.slice(0, 500),
          diff: createUnifiedDiff(files[path], content),
        })),
      },
    });
  }
  if (req.method === "POST" && url.pathname === "/api/ai/rewrite/apply") {
    const data = await body(req),
      item = await readJson(proposalKey(data.id), null);
    if (!item || item.game !== data.game || item.version !== data.version)
      return send(res, 404, {
        error: "پیشنهاد AI پیدا نشد یا متعلق به این پروژه نیست",
      });
    const root = projectRoot(item.game, item.version),
      before = await projectSnapshot(root);
    for (const [relative, content] of Object.entries(item.files)) {
      const file = safeFile(root, relative);
      await fsp.writeFile(file, content);
    }
    await addHistory(item.game, item.version, {
      author: "AI",
      message: "اعمال پیشنهاد بازنویسی AI: " + item.summary,
      files: Object.keys(item.files),
      before,
    });
    await fsp.rm(proposalKey(item.id), { force: true });
    return send(res, 200, { ok: true, files: Object.keys(item.files) });
  }
  if (url.pathname === '/api/agent/sessions') {
    const data = req.method === 'GET' ? Object.fromEntries(url.searchParams) : await body(req);
    projectRoot(data.game, data.version);
    if (req.method === 'GET') return send(res, 200, { sessions: await agentMemory.listSessions(data.game, data.version) });
    if (req.method === 'POST') return send(res, 201, await agentMemory.createSession(data.game, data.version));
    if (req.method === 'PATCH') {
      const changes = {};
      for (const key of ['title', 'pinned', 'archived']) if (Object.hasOwn(data, key)) changes[key] = data[key];
      return send(res, 200, await agentMemory.updateSession(data.game, data.version, data.sessionId, changes));
    }
    if (req.method === 'DELETE') {
      await agentMemory.clear(data.game, data.version, data.sessionId);
      return send(res, 200, { ok: true });
    }
    return send(res, 405, { error: 'Method not allowed' });
  }
  if (req.method === "GET" && url.pathname === "/api/agent/conversation") {
    const game = String(url.searchParams.get("game") || ""),
      version = String(url.searchParams.get("version") || "");
    projectRoot(game, version);
    return send(res, 200, { messages: await agentMemory.read(game, version, url.searchParams.get('sessionId') || 'default') });
  }
  if (req.method === "DELETE" && url.pathname === "/api/agent/conversation") {
    const data = await body(req);
    projectRoot(data.game, data.version);
    await agentMemory.clear(data.game, data.version, data.sessionId);
    return send(res, 200, { ok: true });
  }
  if (req.method === "DELETE" && url.pathname === "/api/agent/message") {
    const data = await body(req);
    projectRoot(data.game, data.version);
    const messages = await agentMemory.remove(data.game, data.version, data.id, data.sessionId);
    if (!messages) return send(res, 404, { error: "پیام پیدا نشد" });
    return send(res, 200, { ok: true, messages });
  }
  if (req.method === "POST" && url.pathname === "/api/agent/action/apply") {
    const data = await body(req),
      action = agentActions.get(data.id);
    if (!action || action.game !== data.game || action.version !== data.version)
      return send(res, 404, { error: "اقدام پیشنهادی پیدا نشد" });
    const root = projectRoot(action.game, action.version),
      before = await projectSnapshot(root);
    if (action.type === "write") {
      const file = safeFile(root, action.path);
      if (["game.json", "README.md"].includes(path.basename(file)))
        return send(res, 400, { error: "فایل اصلی محافظت‌شده است" });
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, action.content || "");
    } else if (action.type === "delete") {
      const file = safeFile(root, action.path);
      if (["game.json", "README.md"].includes(path.basename(file)))
        return send(res, 400, { error: "فایل اصلی محافظت‌شده است" });
      await fsp.rm(file, { force: true });
    } else if (action.type === "command") {
      const shell = process.platform === "win32" ? "powershell.exe" : "/bin/sh",
        args =
          process.platform === "win32"
            ? ["-NoProfile", "-Command", action.command]
            : ["-lc", action.command];
      const result = await new Promise((resolve) =>
        execFile(
          shell,
          args,
          {
            cwd: root,
            timeout: 60000,
            maxBuffer: 1024 * 1024,
            windowsHide: true,
          },
          (error, stdout, stderr) =>
            resolve({
              ok: !error,
              stdout,
              stderr,
              error: error?.message || "",
            }),
        ),
      );
      agentActions.delete(data.id);
      return send(res, 200, { ok: true, result });
    }
    await addHistory(action.game, action.version, {
      author: "AI",
      message: "اعمال اقدام Agent",
      files: [action.path],
      before,
    });
    agentActions.delete(data.id);
    return send(res, 200, { ok: true });
  }
  if (req.method === "POST" && url.pathname === "/api/agent/message") {
    const data = await body(req);
    if (data.stream) {
      const controller = new AbortController();
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
      res.flushHeaders();
      const emit = (event, value) => { if (!res.destroyed) res.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`); };
      res.on('close', () => { if (!res.writableEnded) controller.abort(); });
      const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': keepalive\n\n'); }, 15000);
      try {
        const result = await handleAgentMessage(data, { onToken: token => emit('token', { token }), onEvent: event => emit('activity', event), signal: controller.signal });
        emit('result', result);
      } catch (error) { emit('error', { error: error.message }); }
      finally { clearInterval(heartbeat); res.end(); }
      return;
    }
    try {
      return send(res, 200, await handleAgentMessage(data));
    } catch (error) {
      return send(res, 502, { error: error.message });
    }
  }
  if (req.method === "POST" && url.pathname === "/api/chat") {
    const data = await body(req);
    if (!process.env.OPENROUTER_API_KEY)
      return send(res, 200, {
        message:
          "کلید OpenRouter در حافظهٔ سرور شناسایی نشد. پس از ذخیرهٔ .env سرور را دوباره اجرا کنید.",
        configured: false,
      });
    const userContent = data.attachmentData
      ? [
          { type: "text", text: String(data.message || "تصویر را بررسی کن") },
          {
            type: "image_url",
            image_url: {
              url: `data:${data.attachmentType || "image/png"};base64,${data.attachmentData}`,
            },
          },
        ]
      : String(data.message || "");
    let response, result;
    try {
      response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "http://localhost:" + PORT,
          "X-Title": "Game Vault",
        },
        body: JSON.stringify({
          model:
            data.model || process.env.OPENROUTER_MODEL || "openrouter/free",
          messages: [
            {
              role: "system",
              content: `تو Agent ادیتور Game Vault هستی. بازی=${data.game} نسخه=${data.version} فایل فعال=${data.file || "none"} Skill=${data.skill || "general"}. وضعیت کار را کوتاه و شفاف بنویس. برای تغییر فایل فقط Diff پیشنهاد بده و بدون تأیید اقدام نکن.`,
            },
            { role: "user", content: userContent },
          ],
          temperature: 0.2,
        }),
      });
      result = await response.json();
    } catch (error) {
      return send(res, 502, {
        message: "اتصال به OpenRouter برقرار نشد: " + error.message,
        configured: true,
      });
    }
    return send(res, response.ok ? 200 : 502, {
      message:
        result.choices?.[0]?.message?.content ||
        result.error?.message ||
        "پاسخی دریافت نشد",
      configured: true,
      model: data.model || process.env.OPENROUTER_MODEL || "openrouter/free",
    });
  }
  if (req.method === "POST" && url.pathname === "/api/terminal") {
    const data = await body(req);
    let cwd = data.cwd ? path.resolve(data.cwd) : ROOT;
    if (data.game && data.version) {
      const root = projectRoot(data.game, data.version);
      cwd = data.path ? path.dirname(safeFile(root, data.path)) : root;
    }
    if (!fs.existsSync(cwd) || (await fsp.stat(cwd)).isDirectory() === false)
      return send(res, 400, { error: "مسیر اجرای ترمینال معتبر نیست" });
    const command = String(data.command || "").trim();
    if (!command) return send(res, 400, { error: "دستور خالی است" });
    const shell = process.platform === "win32" ? "powershell.exe" : "/bin/sh",
      args =
        process.platform === "win32"
          ? ["-NoProfile", "-Command", command]
          : ["-lc", command];
    const result = await new Promise((resolve) =>
      execFile(
        shell,
        args,
        { cwd, timeout: 60000, maxBuffer: 1024 * 1024, windowsHide: true },
        (error, stdout, stderr) =>
          resolve({
            code: error?.code ?? 0,
            stdout,
            stderr,
            error: error?.message || "",
          }),
      ),
    );
    return send(res, 200, { cwd, platform: process.platform, result });
  }
  return send(res, 404, { error: "API پیدا نشد" });
}
async function main() {
  await ensure();
  await synchronizeMetadataReadmes();
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      if (url.pathname.startsWith("/api/")) return await api(req, res, url);
      return await serveStatic(ROOT, req, res, url.pathname);
    } catch (error) {
      send(res, 500, { error: "Internal server error" });
    }
  });
  server.listen(PORT, () =>
    console.log(`Game Vault running at http://localhost:${PORT}`),
  );
  installGracefulShutdown({ server, children: () => [theiaProcess] });
}
main().catch(() => {
  console.error("Game Vault failed to start");
  process.exitCode = 1;
});
