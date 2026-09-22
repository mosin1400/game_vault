function mountStudioToolbar({ shell, project, apiFetch, API, DASHBOARD = API }) {
  if (!document.querySelector('link[href$="gv-theme.css"]')) {
    const stylesheet = document.createElement('link');
    stylesheet.rel = 'stylesheet';
    stylesheet.href = new URL('gv-theme.css', document.baseURI).href;
    document.head.appendChild(stylesheet);
  }
  if (document.getElementById('gv-studio-toolbar')) return;
  const bar = document.createElement('div'), p = project();
  bar.id = 'gv-studio-toolbar';
  bar.innerHTML = `<div class="gv-control-group"><button id="gv-layout-explorer" title="Explorer">◧</button><button id="gv-layout-split" title="Both side panels">▣</button><button id="gv-layout-focus" title="Focus editor">◨</button><button id="gv-layout-bottom" title="Toggle bottom panel">▤</button></div><div class="gv-control-group gv-version-group"><span>Version</span><select id="gv-version" aria-label="Project version"></select><button id="gv-version-add" title="Clone to a new version">＋</button><button id="gv-version-rename" title="Rename version">✎</button><button id="gv-version-delete" title="Delete version">⌫</button></div><div class="gv-control-group"><button id="gv-preview">▷ Preview</button><button id="gv-fix">✣ AI Fix</button><button id="gv-agent">✦ Agent</button></div><span id="gv-toolbar-status" role="status"></span>`;
  document.body.appendChild(bar);
  const select = bar.querySelector('#gv-version'), status = bar.querySelector('#gv-toolbar-status');
  const request = async (path, method, data) => {
    const response = await apiFetch(`${API}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const result = await response.json();
    if (!response.ok) throw Error(result.error || 'Request failed');
    return result;
  };
  const notify = () => {
    const channel = new BroadcastChannel('game-vault');
    channel.postMessage({ type: 'versions-changed', game: p.game }); channel.close();
  };
  const open = async version => {
    const data = await request('/api/theia/open', 'POST', { game: p.game, version });
    const url = new URL(data.url);
    url.searchParams.set('gvTheme', localStorage.getItem('gv-theia-theme-mode') || 'modern-dark');
    // gvVersion and the fresh access token change the query, causing a full
    // navigation. The fragment selects the native workspace during startup.
    window.location.assign(url.href);
  };
  const perform = async action => {
    if (bar.dataset.busy) return;
    bar.dataset.busy = 'true'; status.textContent = 'Working…';
    bar.querySelectorAll('button,select').forEach(control => { control.disabled = true; });
    try { await action(); status.textContent = ''; }
    catch (error) { status.textContent = error.message; status.title = error.message; select.value = p.version; }
    finally { delete bar.dataset.busy; bar.querySelectorAll('button,select').forEach(control => { control.disabled = !p.game && control.closest('.gv-version-group'); }); }
  };
  if (p.game) apiFetch(`${API}/api/versions?game=${encodeURIComponent(p.game)}`).then(async response => {
    const data = await response.json(); if (!response.ok) throw Error(data.error || 'Cannot load versions');
    for (const item of data.versions || []) {
      const option = document.createElement('option'); option.value = item.name; option.textContent = item.name;
      option.selected = item.name === p.version; select.appendChild(option);
    }
  }).catch(error => { status.textContent = error.message; });
  select.onchange = () => perform(() => open(select.value));
  bar.querySelector('#gv-version-add').onclick = () => {
    const version = window.prompt('نام نسخهٔ جدید'); if (!version?.trim()) return;
    perform(async () => { await request('/api/version', 'POST', { game: p.game, version: version.trim(), fromVersion: p.version }); notify(); await open(version.trim()); });
  };
  bar.querySelector('#gv-version-rename').onclick = () => {
    const version = window.prompt('نام تازهٔ نسخه', p.version); if (!version?.trim() || version.trim() === p.version) return;
    perform(async () => { await request('/api/version', 'PATCH', { game: p.game, version: p.version, newVersion: version.trim() }); notify(); await open(version.trim()); });
  };
  bar.querySelector('#gv-version-delete').onclick = () => {
    if (!window.confirm(`نسخهٔ ${p.version} حذف شود؟`)) return;
    perform(async () => {
      await request('/api/version', 'DELETE', { game: p.game, version: p.version }); notify();
      const remaining = [...select.options].map(option => option.value).filter(version => version !== p.version);
      if (remaining.length) await open(remaining[0]); else window.location.assign(`${DASHBOARD}/manage.html`);
    });
  };
  bar.querySelector('#gv-preview').onclick = () => window.open(`${DASHBOARD}/games/${encodeURIComponent(p.game)}/versions/${encodeURIComponent(p.version)}/game.html`, '_blank', 'noopener');
  bar.querySelector('#gv-agent').onclick = () => shell.activateWidget('game-vault-agent');
  bar.querySelector('#gv-fix').onclick = () => { shell.activateWidget('game-vault-agent'); window.gameVaultAgent?.requestRewrite(); };
  bar.querySelector('#gv-layout-explorer').onclick = () => { shell.leftPanelHandler.expand(); shell.rightPanelHandler.collapse(); };
  bar.querySelector('#gv-layout-split').onclick = () => { shell.leftPanelHandler.expand(); shell.rightPanelHandler.expand(); };
  bar.querySelector('#gv-layout-focus').onclick = () => { shell.leftPanelHandler.collapse(); shell.rightPanelHandler.collapse(); shell.collapseBottomPanel(); };
  bar.querySelector('#gv-layout-bottom').onclick = () => shell.bottomPanel.isHidden ? shell.expandBottomPanel() : shell.collapseBottomPanel();
}
module.exports = { mountStudioToolbar };
