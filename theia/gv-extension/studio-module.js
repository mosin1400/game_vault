const { ContainerModule } = require('@theia/core/shared/inversify');
const { FrontendApplicationContribution } = require('@theia/core/lib/browser/frontend-application-contribution');
const { ApplicationShell } = require('@theia/core/lib/browser/shell/application-shell');
const { BaseWidget: Widget } = require('@theia/core/lib/browser/widgets/widget');
const { WidgetFactory, WidgetManager } = require('@theia/core/lib/browser/widget-manager');
const { WorkspaceService } = require('@theia/workspace/lib/browser/workspace-service');
const { FileService } = require('@theia/filesystem/lib/browser/file-service');
const URI = require('@theia/core/lib/common/uri').default;
const { renderMarkdown } = require('./markdown-renderer');
const { describeAgentActivity } = require('./codex-activity');
const { mountStudioToolbar } = require('./studio-toolbar');
const { installAgentChat } = require('./agent-chat');
const studioUrl = new URL(window.location.href);
const dashboardPort = Number(studioUrl.searchParams.get('gvApiPort')) || 8080;
const API = `${window.location.origin}/gv-api`;
const DASHBOARD = `http://127.0.0.1:${dashboardPort}`;
const models=[['openrouter/free','مدل رایگان'],['inclusionai/ling-3.0-flash-vl:free','Ling 3.0'],['nvidia/nemotron-3-ultra-550b-a55b:free','Nemotron'],['thinkingmachines/inkling-small:free','Inkling Small'],['thinkingmachines/inkling:free','Inkling'],['poolside/laguna-s-2.1:free','Laguna S 2.1']];
function project(){const u=new URL(window.location.href);return{game:u.searchParams.get('gvGame')||'',version:u.searchParams.get('gvVersion')||''}}
function apiFetch(url,options={}){const headers={...(options.headers||{}),'x-gv-api-port':String(dashboardPort)},token=new URL(window.location.href).searchParams.get('gvToken');if(token)headers['x-gv-studio-token']=token;return fetch(url,{...options,credentials:'include',headers})}
class GameVaultAgentWidget extends Widget{
 constructor(){super({node:document.createElement('section')});this.id='game-vault-agent';this.title.label='Game Vault AI';this.title.iconClass='codicon codicon-sparkle';this.title.closable=false;this.addClass('gv-native-agent');this.addClass('theia-widget');this.node.tabIndex=0;this.node.dir='rtl';this.render();window.gameVaultAgent=this}
 render(){const p=project();this.node.innerHTML=`<style>.gv-native-agent{height:100%;min-width:320px;display:flex;flex-direction:column;background:var(--theia-sideBar-background);color:var(--theia-foreground);font-family:Vazirmatn,Arial,sans-serif}.gv-head,.gv-compose{padding:13px;border-bottom:1px solid var(--theia-panel-border)}.gv-head{display:flex;justify-content:space-between}.gv-log{flex:1;overflow:auto;padding:14px;line-height:1.9}.gv-user{background:var(--theia-button-background);color:var(--theia-button-foreground);padding:10px;border-radius:12px 12px 3px;margin:10px 0}.gv-ai{padding:4px 2px 11px;margin:9px 0;border-bottom:1px solid var(--theia-panel-border)}.gv-ai pre,.gv-action-card pre{overflow:auto;padding:10px;background:var(--theia-textCodeBlock-background);direction:ltr}.gv-ai table{width:100%;border-collapse:collapse}.gv-ai td,.gv-ai th{border:1px solid var(--theia-panel-border);padding:5px}.gv-task{font-size:12px;color:var(--theia-descriptionForeground)}.gv-action-card{margin:12px 0;padding:13px;border:1px solid var(--theia-focusBorder);border-radius:12px;background:linear-gradient(135deg,var(--theia-editorWidget-background),var(--theia-sideBar-background));box-shadow:0 8px 25px #0002}.gv-action-title{display:flex;justify-content:space-between;gap:10px;font-weight:700}.gv-action-delta{direction:ltr;color:var(--theia-terminal-ansiGreen);font-family:var(--theia-code-font-family)}.gv-action-card button{border:0;border-radius:8px;padding:7px 12px;background:var(--theia-button-background);color:var(--theia-button-foreground);font:inherit}.gv-message-actions{display:flex;gap:4px;margin-top:7px}.gv-message-actions button,.gv-icon{border:0;background:transparent;color:var(--theia-descriptionForeground);font:inherit;padding:4px}.gv-compose{position:relative;border-top:1px solid var(--theia-panel-border);border-bottom:0}.gv-compose textarea,.gv-compose select{box-sizing:border-box;background:var(--theia-input-background);color:var(--theia-input-foreground);border:1px solid var(--theia-input-border);border-radius:8px;padding:8px;font:inherit}.gv-compose textarea{width:100%;min-height:70px;resize:vertical}.gv-compose-footer{display:flex;align-items:center;gap:7px;margin-top:7px}.gv-compose-footer select{flex:1}.gv-send{border:0;width:32px;height:32px;border-radius:50%;background:var(--theia-button-background);color:var(--theia-button-foreground)}.gv-more{position:absolute;bottom:100%;right:12px;display:none;flex-direction:column;gap:6px;padding:8px;border:1px solid var(--theia-panel-border);background:var(--theia-editorWidget-background);border-radius:9px;min-width:260px}.gv-more.open{display:flex}.gv-file{font-size:11px;color:var(--theia-descriptionForeground)}.gv-skills{border-top:1px solid var(--theia-panel-border);padding-top:7px}.gv-skills a{display:block;color:var(--theia-textLink-foreground);padding:4px;text-decoration:none}.gv-skills a:hover{text-decoration:underline}</style><div class="gv-head"><b>دستیار پروژه <small>${p.game||'Studio'}</small></b><button class="gv-icon" id="gv-clear" title="پاک کردن گفتگو">🗑</button></div><div class="gv-log" id="gv-log"></div><form class="gv-compose" id="gv-form"><div class="gv-more" id="gv-more"><select id="gv-skill"><option value="general">Skill: عمومی</option></select><div class="gv-skills" id="gv-skills"><b>راهنمای Skills</b></div><button type="button" class="gv-icon" id="gv-attach" title="ارسال فایل">📎</button><input id="gv-file" type="file" hidden><button type="button" class="gv-icon" id="gv-approval" title="تأیید دستی">🛡</button></div><textarea id="gv-input" placeholder="پیام برای Agent…"></textarea><div class="gv-file" id="gv-file-name"></div><div class="gv-compose-footer"><button type="button" class="gv-icon" id="gv-plus" title="Skill و ارسال فایل">＋</button><select id="gv-model">${models.map(([id,n])=>`<option value="${id}">${n}</option>`).join('')}</select><button class="gv-send" title="ارسال">↑</button></div></form>`;this.log=this.node.querySelector('#gv-log');this.form=this.node.querySelector('#gv-form');this.input=this.node.querySelector('#gv-input');this.model=this.node.querySelector('#gv-model');this.skill=this.node.querySelector('#gv-skill');this.file=this.node.querySelector('#gv-file');this.approvalMode='manual';this.form.onsubmit=e=>{e.preventDefault();this.send()};this.node.querySelector('#gv-clear').onclick=()=>this.clear();this.node.querySelector('#gv-plus').onclick=()=>this.node.querySelector('#gv-more').classList.toggle('open');this.node.querySelector('#gv-attach').onclick=()=>this.file.click();this.file.onchange=()=>{this.attachment=this.file.files[0];this.node.querySelector('#gv-file-name').textContent=this.attachment?`📎 ${this.attachment.name}`:''};this.node.querySelector('#gv-approval').onclick=e=>{this.approvalMode=this.approvalMode==='manual'?'auto':'manual';e.currentTarget.textContent=this.approvalMode==='manual'?'🛡':'⚡'};this.loadSkills();this.restore()}
 async loadSkills(){try{const response=await apiFetch(`${API}/api/skills`);if(!response.ok)throw Error(`Skills: HTTP ${response.status}`);const d=await response.json();const list=this.node.querySelector('#gv-skills');for(const s of d.skills||[]){const o=document.createElement('option');o.value=s.id;o.textContent=`Skill: ${s.name||s.id}`;this.skill.appendChild(o);const a=document.createElement('a');a.href=`${API}/api/skills/${encodeURIComponent(s.id)}/instructions`;a.target='_blank';a.rel='noreferrer';a.textContent=`${s.name||s.id} · بازکردن دستورالعمل`;list.appendChild(a)}}catch(error){this.node.querySelector('#gv-skills').textContent=`بارگذاری Skills ناموفق بود: ${error.message}`}}
 add(item,type='ai'){const m=typeof item==='string'?{content:item}:item,e=document.createElement('article');e.className=type==='user'?'gv-user':type==='task'?'gv-task':'gv-ai';const body=document.createElement('div');if(type==='ai')body.innerHTML=renderMarkdown(m.content);else body.textContent=m.content;e.appendChild(body);if(m.attachment){const file=document.createElement('div');file.className='gv-message-file';file.textContent=`📎 ${m.attachment.name} · ${Math.max(0,Number(m.attachment.size)||0).toLocaleString()} B`;file.title=m.attachment.type||'';e.appendChild(file)}if(m.id&&type!=='task'){const a=document.createElement('div');a.className='gv-message-actions';for(const [i,t,fn] of [['⧉','کپی',()=>navigator.clipboard?.writeText(m.content)],...(type==='user'?[['✎','ویرایش',()=>{this.input.value=m.content;this.editing=m.id;this.input.focus()}]]:[]),...(type==='ai'?[['↻','باز‌تولید',()=>this.send({regenerateOf:m.id})]]:[]),['🗑','حذف',()=>this.remove(m.id)]]){const b=document.createElement('button');b.title=t;b.textContent=i;b.onclick=fn;a.appendChild(b)}e.appendChild(a)}this.log.appendChild(e);this.log.scrollTop=this.log.scrollHeight}
 show(ms){this.log.replaceChildren();for(const m of ms||[]){if(m.role==='assistant'&&m.timeline?.length){for(const part of m.timeline){if(part.type==='text')this.add(part.text,'ai');else if(part.type==='activity')addCodexStep(this,part.event)}}else this.add(m,m.role==='user'?'user':'ai')}}
 async encodeAttachment(){if(!this.attachment)return{};const f=this.attachment;if(f.size>2*1024*1024)throw Error('Attachment must be 2 MB or smaller');if(!(/^(text\/|image\/|application\/(json|javascript|xml|pdf)$)/.test(f.type)||/\.(md|txt|js|ts|jsx|tsx|html|css|json|py|java|c|cpp|h|csv)$/i.test(f.name)))throw Error('This file type is not supported');const b=await new Promise((ok,bad)=>{const r=new FileReader();r.onload=()=>ok(String(r.result).split(',').at(-1));r.onerror=bad;r.readAsDataURL(f)});return{attachmentData:b,attachmentType:f.type||'application/octet-stream',attachmentName:f.name,attachmentSize:f.size}}
 async requestRewrite(){const p=project();if(!p.game||!p.version)return;this.add('AI در حال بررسی فایل‌ها و ساخت Diff است؛ هنوز هیچ تغییری اعمال نمی‌شود.','task');try{const r=await apiFetch(`${API}/api/ai/rewrite`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({game:p.game,version:p.version,model:this.model.value})}),d=await r.json();if(!r.ok)throw Error(d.error||'پیشنهاد AI ساخته نشد');if(!d.proposal){this.add(d.message||'تغییر ضروری پیدا نشد.','task');return}const card=document.createElement('article');card.className='gv-ai';const title=document.createElement('b');title.textContent=`Diff پیشنهادی: ${d.proposal.summary}`;card.append(title);for(const file of d.proposal.files){const h=document.createElement('h4'),pre=document.createElement('pre');h.textContent=file.path;pre.textContent=file.diff;card.append(h,pre)}const approve=document.createElement('button');approve.textContent='اعمال پس از Snapshot';approve.title='ابتدا Snapshot ساخته می‌شود، سپس فقط همین Diff اعمال خواهد شد';approve.onclick=async()=>{approve.disabled=true;const applied=await apiFetch(`${API}/api/ai/rewrite/apply`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:d.proposal.id,game:p.game,version:p.version})}),result=await applied.json();if(!applied.ok)throw Error(result.error||'اعمال نشد');this.add(`Snapshot ساخته شد و ${result.files.length} فایل تأییدشده اعمال شد.`,'task');card.remove()};card.append(approve);this.log.append(card);this.log.scrollTop=this.log.scrollHeight}catch(error){this.add(`خطای AI Fix: ${error.message}`,'task')}}
}

function ensureVazirmatn() {
 if (document.getElementById('gv-vazirmatn-font')) return;
 const font = document.createElement('link');
 font.id = 'gv-vazirmatn-font';
 font.rel = 'stylesheet';
 font.href = 'https://fonts.googleapis.com/css2?family=Vazirmatn:wght@400;500;600;700&display=swap';
 document.head.appendChild(font);
}

const renderAgentWidget = GameVaultAgentWidget.prototype.render;
GameVaultAgentWidget.prototype.render = function render() {
 ensureVazirmatn();
 return renderAgentWidget.call(this);
};

function addCodexStep(widget, event) {
 const activity = describeAgentActivity(event), card = document.createElement('article'), heading = document.createElement('strong'), detail = document.createElement('div');
 card.className = 'gv-action-card';
 card.style.borderColor = 'var(--theia-panel-border)';
 card.style.boxShadow = 'none';
 heading.textContent = activity.heading;
 detail.textContent = activity.detail;
 detail.style.direction = 'ltr';
 detail.style.fontFamily = 'var(--theia-code-font-family)';
 detail.style.fontSize = '12px';
 detail.style.marginTop = '5px';
 card.append(heading, detail);
 widget.log.appendChild(card);
 widget.log.scrollTop = widget.log.scrollHeight;
}

GameVaultAgentWidget.prototype.actionCard = function actionCard(action) {
 const activity = describeAgentActivity({ type: 'action', action }), card = document.createElement('article'), title = document.createElement('strong'), detail = document.createElement('div'), approve = document.createElement('button'), diff = String(action.diff || '');
 card.className = 'gv-action-card';
 title.textContent = activity.heading;
 detail.textContent = activity.detail;
 detail.style.direction = 'ltr';
 detail.style.fontFamily = 'var(--theia-code-font-family)';
 card.append(title, detail);
 if (diff) { const pre = document.createElement('pre'); pre.textContent = diff; card.appendChild(pre); }
 approve.textContent = action.approvalMode === 'auto' ? 'Applying…' : 'Approve and apply';
 approve.onclick = async () => {
   approve.disabled = true;
   try {
   const p = project(), response = await apiFetch(`${API}/api/agent/action/apply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...p, id: action.id }) }), result = await response.json();
   card.replaceChildren();
   const resultTitle = document.createElement('strong'), resultDetail = document.createElement('div');
   resultTitle.textContent = response.ok && result.result?.ok !== false ? describeAgentActivity({ type: 'action', action: { ...action, applied: true } }).heading : 'Result';
   resultDetail.textContent = response.ok && result.result?.ok !== false ? 'Completed' : `Failed: ${result.error || result.result?.error || 'Unknown error'}`;
   card.append(resultTitle, resultDetail);
   } catch (error) { approve.disabled = false; approve.textContent = `Retry: ${error.message}`; }
 };
 card.appendChild(approve);
 this.log.appendChild(card);
 this.log.scrollTop = this.log.scrollHeight;
 if (action.approvalMode === 'auto') approve.click();
};


installAgentChat(GameVaultAgentWidget, { project, apiFetch, API, addCodexStep });

class GameVaultProjectToolsWidget extends Widget{
 constructor(){super({node:document.createElement('section')});this.id='game-vault-project-tools';this.title.label='Project Tools';this.title.iconClass='codicon codicon-tools';this.title.closable=false;this.addClass('gv-project-tools');this.addClass('theia-widget');this.node.tabIndex=0;this.node.dir='rtl';this.render()}
 render(){this.node.innerHTML='<style>.gv-project-tools{padding:16px;min-width:290px;background:var(--theia-sideBar-background);color:var(--theia-foreground);font-family:Vazirmatn,Arial,sans-serif}.gv-project-tools h3{margin:0 0 14px}.gv-project-tools article{padding:11px;margin:9px 0;border:1px solid var(--theia-panel-border);border-radius:10px}.gv-project-tools button{margin:5px 0;border:0;border-radius:7px;padding:7px 10px;background:var(--theia-button-background);color:var(--theia-button-foreground)}</style><h3>وضعیت پروژه</h3><div id="gv-project-info">در حال دریافت اطلاعات…</div><button id="gv-project-refresh">بروزرسانی</button><h3>Snapshotها</h3><div id="gv-project-history">—</div>';this.node.querySelector('#gv-project-refresh').onclick=()=>this.refresh();this.refresh()}
 async refresh(){const p=project(),info=this.node.querySelector('#gv-project-info'),history=this.node.querySelector('#gv-project-history');if(!p.game||!p.version){info.textContent='پروژه‌ای انتخاب نشده است.';return}try{const [a,b]=await Promise.all([apiFetch(`${API}/api/project-tools?game=${encodeURIComponent(p.game)}&version=${encodeURIComponent(p.version)}`),apiFetch(`${API}/api/history?game=${encodeURIComponent(p.game)}&version=${encodeURIComponent(p.version)}`)]),tools=await a.json(),snapshots=await b.json();if(!a.ok)throw Error(tools.error||'دریافت اطلاعات ناموفق بود');info.innerHTML=`<article><b>Git</b><br>${tools.git?.available?`${tools.git.branch||'بدون شاخه'} · ${tools.git.changes?.length||0} تغییر`:'مخزن Git فعال نیست'}</article><article><b>منابع</b><br>${tools.resources?.files||0} فایل · ${tools.resources?.bytes||0} بایت<br>Asset: ${tools.resources?.assets||0} بایت</article>`;history.replaceChildren();for(const item of (snapshots.history||[]).slice(0,8)){const card=document.createElement('article'),button=document.createElement('button');card.textContent=`${item.message||'Snapshot'} · ${new Date(item.at).toLocaleString('fa-IR')}`;button.textContent='بازگردانی این Snapshot';button.onclick=async()=>{if(!confirm('کل نسخه به این Snapshot بازگردد؟'))return;const r=await apiFetch(`${API}/api/history/restore`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({game:p.game,version:p.version,id:item.id})});if(r.ok)this.refresh()};card.append(button);history.append(card)}if(!(snapshots.history||[]).length)history.textContent='هنوز Snapshotی ثبت نشده است.'}catch(error){info.textContent=`خطا: ${error.message}`}}
}
const studioModule = new ContainerModule(bind => {
  bind(WidgetFactory).toDynamicValue(() => ({ id: 'game-vault-agent', createWidget: () => new GameVaultAgentWidget() })).inSingletonScope();
  bind(WidgetFactory).toDynamicValue(() => ({ id: 'game-vault-project-tools', createWidget: () => new GameVaultProjectToolsWidget() })).inSingletonScope();
  bind(FrontendApplicationContribution).toDynamicValue(context => ({
    onStart: async () => {
      const shell = context.container.get(ApplicationShell);
      mountStudioToolbar({ shell, project, apiFetch, API, DASHBOARD });
      const manager = context.container.get(WidgetManager);
      const agent = await manager.getOrCreateWidget('game-vault-agent');
      const tools = await manager.getOrCreateWidget('game-vault-project-tools');
      if (!shell.getWidgetById(agent.id)) await shell.addWidget(agent, { area: 'right' });
      if (!shell.getWidgetById(tools.id)) await shell.addWidget(tools, { area: 'right' });
      const workspace = context.container.get(WorkspaceService), files = context.container.get(FileService);
      await workspace.ready;
      const requested = studioUrl.searchParams.get('workspace');
      if (requested && project().version) {
        const uri = new URI(requested);
        if (!workspace.workspace?.resource.isEqual(uri)) await workspace.setWorkspace(await files.resolve(uri));
      }
    }
  })).inSingletonScope();
});
module.exports.default = studioModule;
