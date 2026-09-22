const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function textAttachment(data) {
  if (!data.attachmentData || String(data.attachmentType || '').startsWith('image/')) return '';
  try { return Buffer.from(String(data.attachmentData), 'base64').toString('utf8').slice(0, 50000); }
  catch { return ''; }
}

function unifiedDiff(before, after) {
  const left = String(before || '').split('\n'), right = String(after || '').split('\n'), lines = ['--- before', '+++ after'];
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    if (left[index] === right[index]) continue;
    if (left[index] !== undefined) lines.push(`-${left[index]}`);
    if (right[index] !== undefined) lines.push(`+${right[index]}`);
  }
  return lines.join('\n');
}

function createAgentHandler({ agentMemory, projectRoot, buildAgentContext, createAgentTools, runAgent, saveAction, apiKey, model, port, skillsRoot }) {
  const executeAgent = runAgent;
  return async function handle(data, transport = {}) {
    const timeline = [];
    const live = { ...transport, onToken: transport.onToken ? token => {
      const previous = timeline.at(-1);
      if (previous?.type === 'text') previous.text += token; else timeline.push({ type: 'text', text: token });
      transport.onToken(token);
    } : undefined, onEvent: event => { timeline.push({ type: 'activity', event }); transport.onEvent?.(event); } };
    const runAgent = options => executeAgent({ ...options, ...live });
    const game = String(data.game || ''), version = String(data.version || ''), root = projectRoot(game, version);
    const sessionId = data.sessionId || 'default';
    let message = String(data.message || '').trim(), history = await agentMemory.read(game, version, sessionId);
    if (!apiKey) throw new Error('کلید OpenRouter در حافظهٔ سرور شناسایی نشد.');
    if (data.regenerateOf) {
      const index = history.findIndex(item => item.id === data.regenerateOf && item.role === 'assistant');
      const user = history.slice(0, index).reverse().find(item => item.role === 'user');
      if (index < 0 || !user) throw new Error('Message not found');
      message = user.content;
      await agentMemory.editAndTrim(game, version, user.id, message, sessionId);
      history = (await agentMemory.read(game, version, sessionId)).slice(0, -1);
    } else if (data.replaceMessageId) {
      const edited = await agentMemory.editAndTrim(game, version, data.replaceMessageId, message, sessionId);
      if (!edited) throw new Error('Message not found');
      history = edited.slice(0, -1);
    }
    if (!message) throw new Error('پیام خالی است');
    if (String(data.attachmentData || '').length > 2_800_000) throw new Error('Attachment exceeds the 2 MB limit');
    const attachment = data.attachmentData ? {
      name: String(data.attachmentName || 'attachment').slice(0, 180),
      type: String(data.attachmentType || 'application/octet-stream').slice(0, 120),
      size: Number(data.attachmentSize) || 0
    } : undefined;
    if (!data.regenerateOf && !data.replaceMessageId) await agentMemory.append(game, version, { role: 'user', content: message, attachment }, sessionId);
    const context = await buildAgentContext(root, { maximumFileBytes: 50000, maximumTotalBytes: 100000 });
    const tools = createAgentTools({ root }), pendingActions = [];
    const propose = (type, payload) => {
      const action = { id: crypto.randomUUID(), game, version, type, approvalMode: data.approvalMode || 'manual', ...payload };
      if (type === 'write' || type === 'delete') {
        const target = path.resolve(root, String(action.path || ''));
        if (!target.startsWith(path.resolve(root) + path.sep)) throw new Error('مسیر فایل خارج از پروژه است');
        if (path.basename(target).toLowerCase().startsWith('.env')) throw new Error('Protected file');
        let before = '';
        try { before = fs.readFileSync(target, 'utf8'); } catch { /* new file */ }
        action.diff = unifiedDiff(before, type === 'delete' ? '' : action.content);
      }
      saveAction(action); pendingActions.push(action);
      live.onEvent({ type: 'action', action });
      return { status: 'pending_confirmation', id: action.id, diff: action.diff || '' };
    };
    const attachmentText = textAttachment(data);
    const userContent = data.attachmentData && String(data.attachmentType || '').startsWith('image/')
      ? [{ type: 'text', text: message || `فایل ${data.attachmentName || ''} را بررسی کن` }, { type: 'image_url', image_url: { url: `data:${data.attachmentType};base64,${data.attachmentData}` } }]
      : `${message}${attachmentText ? `\n\n[پیوست ${data.attachmentName || 'file'}]\n${attachmentText}` : ''}`;
    const skillId = String(data.skill || 'general');
    let skillInstructions = '';
    if (skillId !== 'general') {
      if (!/^[a-z0-9][a-z0-9-]*$/i.test(skillId) || !skillsRoot) throw new Error('Skill معتبر نیست');
      try {
        skillInstructions = await fs.promises.readFile(path.join(skillsRoot, skillId, 'instructions.md'), 'utf8');
      } catch (error) {
        if (error.code === 'ENOENT') throw new Error('Skill پیدا نشد');
        throw error;
      }
    }
    const system = `تو Agent پروژه هستی. Skill فعال=${skillId} و حالت تأیید=${data.approvalMode || 'manual'}. ${skillInstructions ? `دستورالعمل Skill:\n${skillInstructions}\n` : ''}ابتدا برای بررسی از ابزارهای خواندنی استفاده کن. برای هر تغییر فایل یا Command فقط ابزار propose را فراخوانی کن؛ خودت هیچ تغییر اثرگذاری اعمال نکن. پس از پیشنهاد ابزار، هرگز شناسه، pending_confirmation، JSON خام یا محتوای کامل فایل را در پاسخ چاپ نکن؛ فقط یک جملهٔ طبیعی فارسی مانند «ویرایش ${'${'}path} آمادهٔ بررسی است.» بنویس. پیش از هر ابزار، شرح کوتاه و طبیعی از کار بعدی بنویس و بعد از نتیجهٔ ابزار، فقط نتیجهٔ قابل مشاهده را توضیح بده. پیشنهاد تغییر یا دستور هنوز اجرا نشده؛ تا دریافت نتیجهٔ اجرای واقعی هرگز نگو انجام شد، فایل ویرایش شد یا بیلد موفق بود. پاسخ نهایی را مختصر و شفاف بنویس.`;
    const result = await runAgent({ endpoint: 'https://openrouter.ai/api/v1/chat/completions', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'HTTP-Referer': `http://localhost:${port}`, 'X-Title': 'Game Vault Studio Agent' }, model: data.model || model || 'openrouter/free', messages: [{ role: 'system', content: system }, ...history.slice(-16).map(item => ({ role: item.role, content: item.content })), { role: 'system', content: `PROJECT CONTEXT: ${JSON.stringify(context.files)}` }, { role: 'user', content: userContent }], tools: { list_files: () => tools.listFiles(), read_file: args => tools.readFile(args.path), search_text: args => tools.searchText(args.query), propose_file_change: args => propose(args.operation === 'delete' ? 'delete' : 'write', { path: String(args.path || ''), content: String(args.content || '') }), propose_terminal_command: args => propose('command', { command: String(args.command || '') }) } });
    if (!transport.onToken || !timeline.some(item => item.type === 'text')) timeline.push({ type: 'text', text: result.reply });
    await agentMemory.append(game, version, { role: 'assistant', content: result.reply, timeline }, sessionId);
    return { message: result.reply, timeline, events: result.events, pendingActions, messages: await agentMemory.read(game, version, sessionId), context: { files: context.paths.length }, model: data.model || model || 'openrouter/free' };
  };
}
module.exports = { createAgentHandler };
