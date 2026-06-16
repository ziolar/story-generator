// ── Constants ──────────────────────────────────────────────────────────────
const TYPE_COLOR = {
  scene:'#60a5fa', narrate:'#a78bfa', dialog:'#34d399', choice:'#f59e0b',
  card:'#f472b6', hero:'#fb923c', gacha:'#c084fc', ending:'#f87171', panel:'#94a3b8'
};
const RARITY_CLASS = { good:'g-good', normal:'g-normal', bad:'g-bad', hidden:'g-hidden' };
const RARITY_LABEL = { good:'好结局', normal:'普通', bad:'坏结局', hidden:'隐藏' };

// ── State ──────────────────────────────────────────────────────────────────
let gameData = null;
let isDirty = false;
let genTotal = 0, genDone = 0;

const _match = location.pathname.match(/^\/preview\/([a-zA-Z0-9-]+)$/);
const previewGameId = _match ? _match[1] : null;

function portraitKey(id) { return previewGameId ? previewGameId + '_portrait_' + id : 'portrait_' + id; }
function sceneKey(key)   { return previewGameId ? previewGameId + '_scene_' + key  : 'scene_' + key;    }

// ── Dirty / Save indicator ─────────────────────────────────────────────────
function markDirty() {
  isDirty = true;
  const el = document.getElementById('save-indicator');
  if (el) { el.textContent = '● 有未保存修改'; el.className = 'save-indicator dirty'; }
}
function markSaved() {
  isDirty = false;
  const el = document.getElementById('save-indicator');
  if (el) { el.textContent = '✓ 已保存'; el.className = 'save-indicator saved'; }
  setTimeout(() => { if (!isDirty && el) { el.textContent = ''; el.className = 'save-indicator'; } }, 3000);
}

// ── Persist to localStorage (no images) ───────────────────────────────────
function saveLocal() {
  try { localStorage.setItem('gamePreview', JSON.stringify(gameData)); } catch {}
}

// ── Fire-and-forget image to DB ────────────────────────────────────────────
function saveImageToDB(imgKey, b64) {
  if (!previewGameId) return;
  fetch('/api/save-image/' + previewGameId, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ key: imgKey, data: b64 })
  }).catch(() => {});
}

// ── Save full gameData to DB ───────────────────────────────────────────────
async function saveGame() {
  if (!previewGameId) { saveLocal(); markSaved(); return; }
  const btn = document.getElementById('btn-save');
  if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }
  try {
    const res = await fetch('/api/update/' + previewGameId, {
      method: 'PUT', headers: {'Content-Type':'application/json'},
      body: JSON.stringify(gameData)
    });
    if (!res.ok) throw new Error(await res.text());
    saveLocal();
    markSaved();
  } catch(e) {
    alert('保存失败: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '💾 保存'; }
  }
}

// ── goPlay ─────────────────────────────────────────────────────────────────
function goPlay() {
  localStorage.setItem('gameAutoStart', '1');
  if (previewGameId) { window.location.href = '/play/' + previewGameId; return; }
  window.location.href = '/play';
}

// ── Gen-all progress bar ───────────────────────────────────────────────────
function startGenProgress(total) {
  genTotal = total; genDone = 0;
  const wrap = document.getElementById('gen-progress-wrap');
  const bar  = document.getElementById('gen-progress-bar');
  const txt  = document.getElementById('gen-progress-text');
  if (wrap) wrap.style.display = 'flex';
  if (bar)  bar.style.setProperty('--pct', '0%');
  if (txt)  txt.textContent = '0/' + total;
}
function tickGenProgress() {
  genDone++;
  const bar = document.getElementById('gen-progress-bar');
  const txt = document.getElementById('gen-progress-text');
  const pct = genTotal ? Math.round(genDone / genTotal * 100) : 0;
  if (bar) bar.style.setProperty('--pct', pct + '%');
  if (txt) txt.textContent = genDone + '/' + genTotal;
  if (genDone >= genTotal) {
    setTimeout(() => {
      const wrap = document.getElementById('gen-progress-wrap');
      if (wrap) wrap.style.display = 'none';
    }, 1500);
  }
}

// ── Batch generate all missing images ─────────────────────────────────────
async function genAll() {
  const btn = document.getElementById('btn-gen-all');
  if (btn) { btn.disabled = true; btn.textContent = '生成中…'; }

  const chars  = gameData.characters || [];
  const scenes = getUniqueScenes();

  // Collect what needs generating
  const tasks = [];
  for (const c of chars) {
    const cached = ImgCache.getSync(portraitKey(c.id))
                || (previewGameId ? ImgCache.getSync('portrait_' + c.id) : null);
    if (!cached) tasks.push({ type:'portrait', id:c.id, name:c.name });
  }
  for (const node of scenes) {
    const cached = ImgCache.getSync(sceneKey(node.sceneKey))
                || (previewGameId ? ImgCache.getSync('scene_' + node.sceneKey) : null);
    if (!cached) tasks.push({ type:'scene', key:node.sceneKey, prompt:node.bgPrompt });
  }

  if (!tasks.length) {
    if (btn) { btn.disabled = false; btn.textContent = '◎ 全部生成'; }
    return;
  }

  startGenProgress(tasks.length);

  for (const t of tasks) {
    if (t.type === 'portrait') {
      await _genPortrait(t.id, t.name);
    } else {
      await _genBg(t.key, t.prompt);
    }
    tickGenProgress();
  }

  if (btn) { btn.disabled = false; btn.textContent = '◎ 全部生成'; }
  // If currently viewing portraits or scenes, re-render to show new images
  const active = document.querySelector('.nav-item.active');
  if (active) {
    const panel = active.dataset.panel;
    if (panel === 'portraits' || panel === 'scenes') switchPanel(panel);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────
function getAllNodes() {
  if (gameData.storylines) return Object.values(gameData.storylines).flatMap(l => l.nodes || []);
  return gameData.script || [];
}
function getUniqueScenes() {
  const all = getAllNodes().filter(n => n.type === 'scene' && n.bgPrompt);
  return [...new Map(all.map(n => [n.sceneKey, n])).values()];
}
function truncate(s, n) { return s && s.length > n ? s.substring(0,n)+'…' : (s||''); }
function escapeXml(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Panel switcher ─────────────────────────────────────────────────────────
const PANELS = {
  new:       renderNew,
  library:   renderLibrary,
  info:      renderInfo,
  outline:   renderOutline,
  portraits: renderPortraits,
  scenes:    renderScenes,
  story:     renderStory,
  branch:    renderBranch,
  gacha:     renderGacha,
  cards:     renderCards,
  endings:   renderEndings,
};

function switchPanel(name) {
  document.querySelectorAll('.nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.panel === name);
  });
  const main = document.getElementById('editor-main');
  main.innerHTML = '';
  const fn = PANELS[name];
  if (fn) fn(main);
}

// ── ☰ Library panel ───────────────────────────────────────────────────────
async function renderLibrary(container) {
  const el = container || document.getElementById('editor-main');
  el.innerHTML = `
    <div class="panel-header"><h2>故事列表</h2></div>
    <div id="library-list"><div class="empty-state">加载中…</div></div>`;

  try {
    const res = await fetch('/api/games');
    const list = await res.json();
    const cont = el.querySelector('#library-list');
    if (!list.length) {
      cont.innerHTML = '<div class="empty-state">暂无保存的故事</div>';
      return;
    }
    cont.innerHTML = '';
    list.forEach(g => {
      const div = document.createElement('div');
      div.className = 'library-item';
      const date = new Date(g.savedAt).toLocaleDateString('zh-CN', { month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit' });
      div.innerHTML = `
        <div class="library-item-main" onclick="loadGame('${g.id}')">
          <div class="library-title">${g.title || '未命名故事'}</div>
          <div class="library-meta">${date} · ${g.storylineCount || 0} 条故事线 · ${g.characterCount || 0} 角色</div>
        </div>
        <div class="library-actions">
          <button class="lib-btn" onclick="loadGame('${g.id}')">打开</button>
          <button class="lib-btn lib-btn-del" onclick="deleteGame('${g.id}', this)">删除</button>
        </div>`;
      cont.appendChild(div);
    });
  } catch(e) {
    el.querySelector('#library-list').innerHTML = `<div class="empty-state">加载失败: ${e.message}</div>`;
  }
}

function loadGame(id) {
  window.location.href = '/preview/' + id;
}

async function deleteGame(id, btn) {
  if (!confirm('确认删除这个故事？')) return;
  btn.disabled = true;
  try {
    await fetch('/api/games/' + id, { method: 'DELETE' });
    // Re-render library
    const main = document.getElementById('editor-main');
    renderLibrary(main);
  } catch(e) {
    btn.disabled = false;
    alert('删除失败: ' + e.message);
  }
}

// ── ⊕ New story panel ─────────────────────────────────────────────────────
function renderNew() {
  openGenDialog();
}

// ── ② Outline panel ───────────────────────────────────────────────────────
const BEAT_LABELS = {
  setup:      { label: 'SETUP',      cls: 'beat-setup' },
  inciting:   { label: 'INCITING',   cls: 'beat-inciting' },
  rising:     { label: 'RISING',     cls: 'beat-rising' },
  midpoint:   { label: 'MIDPOINT',   cls: 'beat-midpoint' },
  dark:       { label: 'DARK',       cls: 'beat-dark' },
  climax:     { label: 'CLIMAX',     cls: 'beat-climax' },
  resolution: { label: 'RESOLUTION', cls: 'beat-resolution' },
};

function renderOutline(container) {
  const el = container || document.getElementById('editor-main');
  const outline = gameData.outline;
  if (!outline) {
    el.innerHTML = `<div class="panel-header"><h2>② 故事大纲</h2></div>
      <div class="empty-state">无大纲数据</div>`;
    return;
  }
  const chapters = outline.chapters || [];
  el.innerHTML = `
    <div class="panel-header">
      <h2>② 故事大纲</h2>
      <span style="font-size:11px;color:var(--text2)">${chapters.length} 章</span>
    </div>
    <div id="outline-chapters"></div>`;

  const list = el.querySelector('#outline-chapters');
  chapters.forEach((ch, ci) => {
    const beat = BEAT_LABELS[ch.beatType] || null;
    const div = document.createElement('div');
    div.className = 'outline-chapter';
    div.innerHTML = `
      <div class="outline-ch-head" onclick="this.nextElementSibling.classList.toggle('open')">
        <span class="outline-ch-num">${ci + 1}</span>
        <span class="outline-ch-title">${ch.title || ''}</span>
        ${beat ? `<span class="outline-ch-beat ${beat.cls}">${beat.label}</span>` : ''}
      </div>
      <div class="outline-ch-body">
        ${ch.summary ? `<div class="outline-ch-summary">${ch.summary}</div>` : ''}
        ${ch.scenePrompt ? `<div class="outline-scene-prompt"><span class="outline-scene-label">SCENE</span>${ch.scenePrompt}</div>` : ''}
        <div class="outline-beats">
          ${(ch.plotPoints || []).map((pt, pi) =>
            `<div class="outline-beat-row">
              <span class="outline-beat-num">${pi + 1}</span>
              <span class="outline-beat-text">${pt}</span>
            </div>`
          ).join('')}
        </div>
      </div>`;
    list.appendChild(div);
  });
}

// ── ① Basic Info ──────────────────────────────────────────────────────────
function renderInfo(container) {
  const el = container || document.getElementById('editor-main');
  const title = gameData.title || '';

  el.innerHTML = `
    <div class="panel-header"><h2>① 基本信息</h2></div>
    <div class="info-section">
      <div class="info-field">
        <label>故事标题</label>
        <input id="field-title" value="${escapeXml(title)}" placeholder="输入标题…">
      </div>
    </div>`;

  // Title edits
  el.querySelector('#field-title').addEventListener('input', e => {
    gameData.title = e.target.value;
    document.getElementById('preview-title').textContent = e.target.value || '故事引擎';
    markDirty();
  });
}

// ── Gen dialog ────────────────────────────────────────────────────────────
function openGenDialog() {
  document.getElementById('gen-dialog-backdrop').classList.remove('hidden');
  document.getElementById('gen-dialog').classList.remove('hidden');
  // Set bookmarklet href
  const bm = document.getElementById('gd-bookmarklet');
  if (bm) {
    const script = `javascript:(function(){var t=document.body.innerText;window.open('${location.origin}/?import=1&text='+encodeURIComponent(t.slice(0,8000)),'_blank')})()`;
    bm.href = script;
  }
}

function closeGenDialog() {
  document.getElementById('gen-dialog-backdrop').classList.add('hidden');
  document.getElementById('gen-dialog').classList.add('hidden');
  // If no game loaded, go back to "new" nav item active but don't loop
  if (!gameData) return;
  // Switch back to last game panel
  const firstGame = document.querySelector('.nav-item[data-panel="info"]');
  if (firstGame) switchPanel('info');
}

function gdSwitchTab(tab) {
  document.querySelectorAll('.gd-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.querySelectorAll('.gd-panel').forEach(p => p.classList.toggle('active', p.id === 'gd-panel-' + tab));
}

function gdCheckUrl(val) {
  const hint = document.getElementById('gd-douban-hint');
  if (!hint) return;
  if (val.includes('douban.com/read')) {
    hint.classList.remove('hidden');
  } else {
    hint.classList.add('hidden');
  }
}

async function gdFetchUrl() {
  const urlEl = document.getElementById('gd-url');
  const preview = document.getElementById('gd-url-preview');
  const url = urlEl?.value.trim();
  if (!url) return;
  preview.textContent = '抓取中…';
  preview.classList.remove('hidden');
  try {
    const res = await fetch('/api/fetch-url', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ url })
    });
    const data = await res.json();
    if (data.text) {
      preview.textContent = data.text.slice(0, 200) + (data.text.length > 200 ? '…' : '');
      preview.dataset.fullText = data.text;
    } else {
      preview.textContent = '抓取失败: ' + (data.error || '未知错误');
    }
  } catch(e) {
    preview.textContent = '请求失败: ' + e.message;
  }
}

async function gdGenerate() {
  const btn = document.getElementById('gd-btn-generate');
  const btnText = document.getElementById('gd-btn-text');
  const btnLoading = document.getElementById('gd-btn-loading');
  const errEl = document.getElementById('gd-error');

  // Collect inputs
  const title = document.getElementById('gd-title')?.value.trim() || '';
  const activeStyle = document.querySelector('.gd-style-btn.active')?.dataset.style || 'pixel';
  localStorage.setItem('imageStyle', activeStyle);

  // Get text content
  const activeTab = document.querySelector('.gd-tab.active')?.dataset.tab || 'text';
  let text = '';
  if (activeTab === 'text') {
    text = document.getElementById('gd-text')?.value.trim() || '';
  } else {
    const preview = document.getElementById('gd-url-preview');
    text = preview?.dataset.fullText || preview?.textContent || '';
    if (!text || text.startsWith('抓取') || text.startsWith('请求')) {
      text = document.getElementById('gd-url')?.value.trim() || '';
    }
  }

  if (!text) {
    errEl.textContent = '请输入故事文本或链接';
    errEl.classList.remove('hidden');
    return;
  }
  errEl.classList.add('hidden');

  btn.disabled = true;
  btnText.classList.add('hidden');
  btnLoading.classList.remove('hidden');

  try {
    const res = await fetch('/api/gen-outline', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ text, title, style: activeStyle })
    });
    const raw = await res.text();
    const dataLine = raw.split('\n').find(l => l.startsWith('DATA:'));
    const errLine  = raw.split('\n').find(l => l.startsWith('ERROR:'));
    if (errLine) throw new Error(errLine.slice(6));
    if (!dataLine) throw new Error('生成失败，请重试');
    const outline = JSON.parse(dataLine.slice(5));
    localStorage.setItem('storyOutline', JSON.stringify(outline));
    window.location.href = '/outline';
  } catch(e) {
    errEl.textContent = e.message;
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btnText.classList.remove('hidden');
    btnLoading.classList.add('hidden');
  }
}

// Wire style buttons
document.querySelectorAll('.gd-style-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.gd-style-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });
});

// ── Show game nav items ────────────────────────────────────────────────────
function showGameNav() {
  const ids = ['nav-game-label','nav-info','nav-outline',
    'nav-assets-label','nav-portraits','nav-scenes',
    'nav-story-label','nav-story','nav-branch',
    'nav-elements-label','nav-gacha','nav-cards','nav-endings'];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = '';
  });
  // Show toolbar buttons
  ['btn-gen-all','btn-play','btn-save'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = '';
  });
}

// ── ③ Portraits ───────────────────────────────────────────────────────────
function renderPortraits(container) {
  const el = container || document.getElementById('editor-main');
  const chars = gameData.characters || [];
  el.innerHTML = `
    <div class="panel-header">
      <h2>③ 角色立绘</h2>
      <div class="panel-header-actions">
        <span style="font-size:11px;color:var(--text2)" id="portrait-count"></span>
      </div>
    </div>
    <div class="asset-grid" id="portrait-grid"></div>`;

  if (!chars.length) {
    el.querySelector('#portrait-grid').innerHTML = '<div class="empty-state">无角色定义</div>';
    return;
  }

  const grid = el.querySelector('#portrait-grid');
  chars.forEach(c => {
    const defaultPrompt = c.portraitPrompt || `${c.name}, character portrait, upper body${c.description ? ', ' + c.description : ''}`;
    const card = document.createElement('div');
    card.className = 'asset-card';
    card.id = 'pcard-' + c.id;
    card.innerHTML = `
      <div class="asset-img-wrap" id="pimgwrap-${c.id}">
        <div class="asset-placeholder" id="pph-${c.id}">
          <span class="ph-icon">👤</span>
          <span>等待生成</span>
        </div>
      </div>
      <div class="asset-info">
        <div class="asset-name" style="color:${c.color}">${c.name}</div>
        <div class="asset-name-sub">${c.id}</div>
        <textarea class="asset-prompt" id="pprompt-${c.id}">${defaultPrompt}</textarea>
        <div class="asset-actions">
          <button class="asset-btn" id="pbtn-${c.id}" onclick="regenPortrait('${c.id}')">重新生成</button>
        </div>
        <div class="asset-status" id="pst-${c.id}">等待生成</div>
      </div>`;
    grid.appendChild(card);
    // load cached image immediately
    _showPortraitIfCached(c.id);
  });
  _updatePortraitCount();
}

function _showPortraitIfCached(id) {
  const pKey = portraitKey(id);
  const src = ImgCache.getSync(pKey)
           || (previewGameId ? ImgCache.getSync('portrait_' + id) : null)
           || (gameData.characters||[]).find(c=>c.id===id)?.portrait;
  if (src) _setPortraitImg(id, src, true);
}

function _setPortraitImg(id, src, fromCache) {
  const wrap = document.getElementById('pimgwrap-' + id);
  if (!wrap) return;
  let img = document.getElementById('pimg-' + id);
  if (!img) {
    img = document.createElement('img');
    img.id = 'pimg-' + id;
    img.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block';
    const ph = document.getElementById('pph-' + id);
    if (ph) ph.replaceWith(img); else wrap.appendChild(img);
  }
  img.src = src;
  const st = document.getElementById('pst-' + id);
  if (st) { st.textContent = '✓ 已生成'; st.className = 'asset-status ok'; }
  // remove overlay if any
  wrap.querySelector('.gen-overlay')?.remove();
  if (!fromCache) _updatePortraitCount();
}

function _updatePortraitCount() {
  const chars = gameData.characters || [];
  let done = 0;
  chars.forEach(c => {
    const k = portraitKey(c.id);
    if (ImgCache.getSync(k) || ImgCache.getSync('portrait_' + c.id)) done++;
  });
  const el = document.getElementById('portrait-count');
  if (el) el.textContent = `${done} / ${chars.length} 已生成`;
}

async function _genPortrait(id, name) {
  const promptEl = document.getElementById('pprompt-' + id);
  const st       = document.getElementById('pst-' + id);
  const wrap     = document.getElementById('pimgwrap-' + id);
  const btn      = document.getElementById('pbtn-' + id);

  // Check cache first
  const pKey = portraitKey(id);
  const cached = ImgCache.getSync(pKey) || (previewGameId ? ImgCache.getSync('portrait_' + id) : null);
  if (cached) { _setPortraitImg(id, cached, true); return; }

  // Show overlay
  if (wrap) {
    let ov = wrap.querySelector('.gen-overlay');
    if (!ov) { ov = document.createElement('div'); ov.className = 'gen-overlay'; ov.textContent = '生成中…'; wrap.appendChild(ov); }
  }
  if (st) { st.textContent = '生成中…'; st.className = 'asset-status working'; }
  if (btn) btn.disabled = true;

  try {
    const char = (gameData.characters||[]).find(c=>c.id===id);
    const res = await fetch('/api/gen-portrait', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ name: name||id, id, customPrompt: promptEl?.value, style: localStorage.getItem('imageStyle')||'pixel' })
    });
    const data = await res.json();
    if (data.b64) {
      ImgCache.set(pKey, data.b64);
      saveImageToDB('portrait_' + id, data.b64);
      if (char) { char.portraitReady = true; saveLocal(); }
      _setPortraitImg(id, data.b64, false);
    } else {
      if (st) { st.textContent = '生成失败'; st.className = 'asset-status err'; }
      wrap?.querySelector('.gen-overlay')?.remove();
    }
  } catch(e) {
    if (st) { st.textContent = '请求失败'; st.className = 'asset-status err'; }
    wrap?.querySelector('.gen-overlay')?.remove();
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function regenPortrait(id) {
  const pKey = portraitKey(id);
  ImgCache.set(pKey, null);
  ImgCache.set('portrait_' + id, null);
  const char = (gameData.characters||[]).find(c=>c.id===id);
  await _genPortrait(id, char?.name||id);
}

// ── ④ Scenes ──────────────────────────────────────────────────────────────
function renderScenes(container) {
  const el = container || document.getElementById('editor-main');
  const scenes = getUniqueScenes();
  el.innerHTML = `
    <div class="panel-header">
      <h2>④ 场景背景</h2>
      <div class="panel-header-actions">
        <span style="font-size:11px;color:var(--text2)" id="scene-count"></span>
      </div>
    </div>
    <div class="asset-grid" id="scene-grid"></div>`;

  if (!scenes.length) {
    el.querySelector('#scene-grid').innerHTML = '<div class="empty-state">无场景节点</div>';
    return;
  }

  const grid = el.querySelector('#scene-grid');
  scenes.forEach(node => {
    const key = node.sceneKey;
    const card = document.createElement('div');
    card.className = 'asset-card';
    card.id = 'scard-' + key;
    card.innerHTML = `
      <div class="asset-img-wrap" id="simgwrap-${key}">
        <div class="asset-placeholder" id="sph-${key}">
          <span class="ph-icon">🌄</span>
          <span>等待生成</span>
        </div>
      </div>
      <div class="asset-info">
        <div class="asset-name">${key}</div>
        <div class="asset-name-sub">${truncate(node.chapter||'',20)}</div>
        <textarea class="asset-prompt" id="sprompt-${key}">${node.bgPrompt||''}</textarea>
        <div class="asset-actions">
          <button class="asset-btn" id="sbtn-${key}" onclick="regenBg('${key}')">重新生成</button>
        </div>
        <div class="asset-status" id="sst-${key}">等待生成</div>
      </div>`;
    grid.appendChild(card);
    _showSceneIfCached(key);
  });
  _updateSceneCount();
}

function _showSceneIfCached(key) {
  const sKey = sceneKey(key);
  const src = ImgCache.getSync(sKey)
           || (previewGameId ? ImgCache.getSync('scene_' + key) : null);
  if (src) _setSceneImg(key, src, true);
}

function _setSceneImg(key, src, fromCache) {
  const wrap = document.getElementById('simgwrap-' + key);
  if (!wrap) return;
  let img = document.getElementById('simg-' + key);
  if (!img) {
    img = document.createElement('img');
    img.id = 'simg-' + key;
    img.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block';
    const ph = document.getElementById('sph-' + key);
    if (ph) ph.replaceWith(img); else wrap.appendChild(img);
  }
  img.src = src;
  const st = document.getElementById('sst-' + key);
  if (st) { st.textContent = '✓ 已生成'; st.className = 'asset-status ok'; }
  wrap.querySelector('.gen-overlay')?.remove();
  if (!fromCache) _updateSceneCount();
}

function _updateSceneCount() {
  const scenes = getUniqueScenes();
  let done = 0;
  scenes.forEach(n => {
    const k = sceneKey(n.sceneKey);
    if (ImgCache.getSync(k) || ImgCache.getSync('scene_' + n.sceneKey)) done++;
  });
  const el = document.getElementById('scene-count');
  if (el) el.textContent = `${done} / ${scenes.length} 已生成`;
}

async function _genBg(key, fallbackPrompt) {
  const promptEl = document.getElementById('sprompt-' + key);
  const prompt   = promptEl?.value || fallbackPrompt || key;
  const st       = document.getElementById('sst-' + key);
  const wrap     = document.getElementById('simgwrap-' + key);
  const btn      = document.getElementById('sbtn-' + key);

  const sKey = sceneKey(key);
  const cached = ImgCache.getSync(sKey) || (previewGameId ? ImgCache.getSync('scene_' + key) : null);
  if (cached) { _setSceneImg(key, cached, true); return; }

  if (wrap) {
    let ov = wrap.querySelector('.gen-overlay');
    if (!ov) { ov = document.createElement('div'); ov.className = 'gen-overlay'; ov.textContent = '生成中…'; wrap.appendChild(ov); }
  }
  if (st) { st.textContent = '生成中…'; st.className = 'asset-status working'; }
  if (btn) btn.disabled = true;

  try {
    const res = await fetch('/api/gen-bg', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ prompt, sceneKey: key, style: localStorage.getItem('imageStyle')||'pixel' })
    });
    const data = await res.json();
    if (data.b64) {
      ImgCache.set(sKey, data.b64);
      saveImageToDB('scene_' + key, data.b64);
      // mark bgReady on all matching nodes
      getAllNodes().filter(n=>n.type==='scene'&&n.sceneKey===key).forEach(n=>n.bgReady=true);
      saveLocal();
      _setSceneImg(key, data.b64, false);
    } else {
      if (st) { st.textContent = '生成失败'; st.className = 'asset-status err'; }
      wrap?.querySelector('.gen-overlay')?.remove();
    }
  } catch(e) {
    if (st) { st.textContent = '请求失败'; st.className = 'asset-status err'; }
    wrap?.querySelector('.gen-overlay')?.remove();
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function regenBg(key) {
  const sKey = sceneKey(key);
  ImgCache.set(sKey, null);
  ImgCache.set('scene_' + key, null);
  await _genBg(key);
}

// ── ④ Story ───────────────────────────────────────────────────────────────
function renderStory(container) {
  const el = container || document.getElementById('editor-main');
  const storylines = gameData.storylines || {};
  const ids = Object.keys(storylines);
  const lineColors = ['#60a5fa','#34d399','#f59e0b','#f472b6','#c084fc','#fb923c'];

  el.innerHTML = `
    <div class="panel-header">
      <h2>⑤ 故事线</h2>
      <span style="font-size:11px;color:var(--text2)">${ids.length} 条故事线 · 点击文字可编辑</span>
    </div>
    <div class="story-scroll"><div class="story-cols" id="story-cols"></div></div>`;

  const cols = el.querySelector('#story-cols');
  if (!ids.length) {
    cols.innerHTML = '<div class="empty-state">无故事线数据</div>';
    return;
  }

  ids.forEach((id, ci) => {
    const line  = storylines[id];
    const color = lineColors[ci % lineColors.length];
    const col   = document.createElement('div');
    col.className = 'story-col';
    col.style.borderLeftColor = color;

    const header = document.createElement('div');
    header.className = 'story-col-header';
    header.innerHTML = `<div class="story-col-name" style="color:${color};border-color:${color}">${line.name||id}</div>`
      + (line.description ? `<div class="story-col-desc">${line.description}</div>` : '');
    col.appendChild(header);

    (line.nodes || []).forEach((node, i) => {
      const typeColor = TYPE_COLOR[node.type] || '#888';
      const div = document.createElement('div');
      div.className = 'story-node';

      let contentHtml = '';
      if (node.type === 'dialog') {
        // Speaker name (not editable) + editable text
        contentHtml = `<strong style="color:var(--text)">${node.speaker||'narrator'}</strong>: `
          + `<span class="node-editable" contenteditable="true" data-line="${id}" data-node="${i}" data-field="text">${node.text||''}</span>`;
      } else if (node.type === 'narrate') {
        contentHtml = `<span class="node-editable" contenteditable="true" data-line="${id}" data-node="${i}" data-field="text">${node.text||''}</span>`;
      } else if (node.type === 'choice') {
        const opts = (node.options||[]).map(o => {
          const dest = o.gotoStoryline
            ? `→${storylines[o.gotoStoryline]?.name||o.gotoStoryline}`
            : (typeof o.gotoNode === 'number' ? `→#${o.gotoNode}` : '');
          return `<span style="color:#f59e0b">[${o.text} ${dest}]</span>`;
        }).join(' ');
        contentHtml = opts;
      } else if (node.type === 'scene') {
        contentHtml = `<strong>${node.sceneKey||''}</strong> — ${node.chapter||''}`;
      } else if (node.type === 'ending') {
        contentHtml = `<strong style="color:#f87171">${node.title||'结局'}</strong>`;
      } else if (node.type === 'card') {
        contentHtml = `<strong>${node.title||''}</strong>`;
      } else if (node.type === 'hero') {
        contentHtml = `<strong>${node.title||''}</strong>`;
      } else if (node.type === 'gacha') {
        contentHtml = truncate(node.question||'', 40);
      } else {
        contentHtml = truncate(node.title||node.text||'', 40);
      }

      div.innerHTML = `<span class="node-idx">#${i}</span> `
        + `<span class="node-type" style="color:${typeColor};border-color:${typeColor}">${node.type}</span>`
        + `<span class="node-text">${contentHtml}</span>`;
      col.appendChild(div);
    });

    cols.appendChild(col);
  });

  // Inline edit: save on blur
  el.querySelectorAll('.node-editable').forEach(span => {
    span.addEventListener('blur', e => {
      const lineId  = e.target.dataset.line;
      const nodeIdx = parseInt(e.target.dataset.node);
      const field   = e.target.dataset.field;
      const newVal  = e.target.textContent;
      const node = storylines[lineId]?.nodes?.[nodeIdx];
      if (node && field) {
        node[field] = newVal;
        markDirty();
      }
    });
    // Prevent newline on Enter
    span.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); span.blur(); }
    });
  });
}

// ── ⑤ Branch diagram ──────────────────────────────────────────────────────
function renderBranch(container) {
  const el = container || document.getElementById('editor-main');
  el.innerHTML = `<div class="panel-header"><h2>⑥ 逻辑分支</h2></div><div class="branch-wrap" id="branch-svg-wrap"></div>`;
  _drawBranchSvg(el.querySelector('#branch-svg-wrap'));
}

function _drawBranchSvg(wrap) {
  const storylines = gameData.storylines || {};
  const ids = Object.keys(storylines);
  if (!ids.length) { wrap.innerHTML = '<div class="empty-state">无故事线数据</div>'; return; }

  const NW=100, NH=36, ROW_H=60, COL_W=180, PAD_X=20, PAD_Y=20;
  const lineColors = ['#60a5fa','#34d399','#f59e0b','#f472b6','#c084fc','#fb923c'];

  const keyNodes = {};
  ids.forEach(id => {
    const nodes = storylines[id].nodes || [];
    const result = [];
    const firstScene = nodes.findIndex(n=>n.type==='scene');
    if (firstScene>=0) result.push({origIdx:firstScene, node:nodes[firstScene], role:'scene'});
    nodes.forEach((node,i) => {
      if (node.type==='choice'||node.type==='ending') result.push({origIdx:i, node, role:node.type});
    });
    const seen = new Set();
    keyNodes[id] = result.filter(k=>{ if(seen.has(k.origIdx)) return false; seen.add(k.origIdx); return true; });
  });

  const colStartOf = {};
  ids.forEach((id,i)=>{ colStartOf[id] = i===0 ? 0 : 1; });

  const pos = {};
  ids.forEach((id,ri)=>{
    pos[id]={};
    const colStart = colStartOf[id];
    const nodeCY = PAD_Y + ri*ROW_H + NH/2;
    keyNodes[id].forEach(({origIdx},ki)=>{
      pos[id][origIdx] = { x: PAD_X+(colStart+ki)*COL_W+NW/2, y: nodeCY };
    });
  });

  const maxCol = Math.max(1, ...ids.map(id=>colStartOf[id]+keyNodes[id].length));
  const totalW = PAD_X*2 + maxCol*COL_W + 40;
  const totalH = PAD_Y*2 + ids.length*ROW_H;

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" style="font-family:'Courier New',monospace;display:block;background:#0a0c14" width="${totalW}" height="${totalH}">`;
  svg += `<defs>
    <marker id="arr" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 Z" fill="#888"/></marker>
    <marker id="arr-c" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 Z" fill="#f59e0b"/></marker>
  </defs>`;
  svg += `<rect width="${totalW}" height="${totalH}" fill="#0a0c14"/>`;

  ids.forEach((id,ri)=>{
    const color=lineColors[ri%lineColors.length];
    const kn=keyNodes[id];
    for(let i=0;i<kn.length-1;i++){
      const a=pos[id][kn[i].origIdx], b=pos[id][kn[i+1].origIdx];
      if(!a||!b) continue;
      svg+=`<line x1="${a.x+NW/2}" y1="${a.y}" x2="${b.x-NW/2}" y2="${b.y}" stroke="${color}" stroke-width="1.5" marker-end="url(#arr)"/>`;
    }
  });

  ids.forEach(id=>{
    keyNodes[id].forEach(({origIdx,node})=>{
      if(node.type!=='choice') return;
      const src=pos[id][origIdx];
      if(!src) return;
      (node.options||[]).forEach(opt=>{
        const targetId=opt.gotoStoryline;
        if(!targetId||!pos[targetId]) return;
        const targetKN=keyNodes[targetId];
        const targetNodeIdx=typeof opt.gotoNode==='number'?opt.gotoNode:0;
        const match=targetKN.find(k=>k.origIdx>=targetNodeIdx)||targetKN[0];
        if(!match) return;
        const dst=pos[targetId][match.origIdx];
        if(!dst) return;
        const x0=src.x+NW/2, y0=src.y, x1=dst.x-NW/2, y1=dst.y;
        const tx=Math.max(x0+20,(x0+x1)/2);
        svg+=`<polyline points="${x0},${y0} ${tx},${y0} ${tx},${y1} ${x1},${y1}" fill="none" stroke="#f59e0b" stroke-width="1.5" stroke-dasharray="4,3" marker-end="url(#arr-c)"/>`;
        const lbl=truncate(opt.text||'',8);
        const lw=lbl.length*7+10;
        const ly=(y0+y1)/2;
        svg+=`<rect x="${tx+3}" y="${ly-9}" width="${lw}" height="13" rx="2" fill="#1a1400" stroke="#f59e0b" stroke-width="0.8"/>`;
        svg+=`<text x="${tx+3+lw/2}" y="${ly+1}" font-size="9" fill="#f59e0b" text-anchor="middle">${escapeXml(lbl)}</text>`;
      });
    });
  });

  ids.forEach((id,ri)=>{
    const color=lineColors[ri%lineColors.length];
    keyNodes[id].forEach(({origIdx,node,role},ki)=>{
      const {x,y}=pos[id][origIdx];
      const nx=x-NW/2, ny=y-NH/2;
      const isEnding=node.type==='ending', isChoice=node.type==='choice';
      const sc=isEnding?'#f87171':isChoice?'#f59e0b':color;
      const fc=isEnding?'#1a0a0a':'#1a1d2e';
      svg+=`<rect x="${nx}" y="${ny}" width="${NW}" height="${NH}" rx="4" fill="${fc}" stroke="${sc}" stroke-width="1.5"/>`;
      let label = isEnding?truncate(node.title||'结局',10):isChoice?'◆ 选择':truncate(node.sceneKey||node.chapter||'',10);
      svg+=`<text x="${x}" y="${y+4}" font-size="11" fill="${sc}" text-anchor="middle" dominant-baseline="middle">${escapeXml(label)}</text>`;
      if(ki===0){
        const lineName=storylines[id].name||id;
        svg+=`<circle cx="${nx}" cy="${ny-8}" r="4" fill="${color}"/>`;
        svg+=`<text x="${nx+8}" y="${ny-4}" font-size="11" fill="${color}" font-weight="bold">${escapeXml(lineName)}</text>`;
      }
    });
  });

  svg += '</svg>';
  wrap.innerHTML = svg;
}

// ── ⑥ Gacha ───────────────────────────────────────────────────────────────
function renderGacha(container) {
  const el = container || document.getElementById('editor-main');
  const gachas = getAllNodes().filter(n=>n.type==='gacha');
  el.innerHTML = `
    <div class="panel-header">
      <h2>⑦ 抽卡池</h2>
      <div class="panel-header-actions">
        <label class="toggle-row" style="margin:0">
          <input type="checkbox" id="toggle-gacha" ${gameData.disableGacha?'':'checked'} onchange="setGachaEnabled(this.checked)">
          <span>游戏中启用</span>
        </label>
      </div>
    </div>
    <div id="gacha-list"></div>`;

  const list = el.querySelector('#gacha-list');
  if (!gachas.length) { list.innerHTML = '<div class="empty-state">无抽卡节点</div>'; return; }
  gachas.forEach((node,gi)=>{
    const sec = document.createElement('div');
    sec.className = 'gacha-section';
    sec.innerHTML = `<div class="gacha-q">抽卡 ${gi+1}：${node.question||''}</div>`;
    const pool = document.createElement('div');
    pool.className = 'gacha-pool';
    (node.pool||[]).forEach(p=>{
      const item = document.createElement('div');
      item.className = `gacha-item ${RARITY_CLASS[p.rarity]||'g-normal'}`;
      item.innerHTML = `<div class="g-rarity">${RARITY_LABEL[p.rarity]||p.rarity}</div>
        <div>${truncate(p.text,40)}</div><div class="g-weight">权重 ${p.weight}%</div>`;
      pool.appendChild(item);
    });
    sec.appendChild(pool);
    list.appendChild(sec);
  });
  if (gameData.disableGacha) list.style.opacity='0.4';
}

function setGachaEnabled(enabled) {
  gameData.disableGacha = !enabled;
  const list = document.getElementById('gacha-list');
  if (list) list.style.opacity = enabled?'':'0.4';
  markDirty();
}

// ── ⑦ Cards ───────────────────────────────────────────────────────────────
function renderCards(container) {
  const el = container || document.getElementById('editor-main');
  const cards = getAllNodes().filter(n=>n.type==='card');
  el.innerHTML = `
    <div class="panel-header">
      <h2>⑧ 档案卡</h2>
      <div class="panel-header-actions">
        <label class="toggle-row" style="margin:0">
          <input type="checkbox" id="toggle-cards" ${gameData.disableCards?'':'checked'} onchange="setCardsEnabled(this.checked)">
          <span>游戏中启用</span>
        </label>
      </div>
    </div>
    <div id="cards-list"></div>`;

  const list = el.querySelector('#cards-list');
  if (!cards.length) { list.innerHTML = '<div class="empty-state">无档案卡节点</div>'; return; }
  cards.forEach(node=>{
    const div = document.createElement('div');
    div.className = 'card-preview';
    div.innerHTML = `<h3>${node.title||'档案'}</h3>
      <p>${node.text||''}</p>
      ${node.teaser?`<div class="card-teaser">▶ ${node.teaser}</div>`:''}`;
    list.appendChild(div);
  });
  if (gameData.disableCards) list.style.opacity='0.4';
}

function setCardsEnabled(enabled) {
  gameData.disableCards = !enabled;
  const list = document.getElementById('cards-list');
  if (list) list.style.opacity = enabled?'':'0.4';
  markDirty();
}

// ── ⑧ Endings ─────────────────────────────────────────────────────────────
function renderEndings(container) {
  const el = container || document.getElementById('editor-main');
  const endings = getAllNodes().filter(n=>n.type==='ending');
  el.innerHTML = `<div class="panel-header"><h2>⑨ 结局</h2></div><div id="endings-list"></div>`;
  const list = el.querySelector('#endings-list');
  if (!endings.length) { list.innerHTML = '<div class="empty-state">无结局节点</div>'; return; }
  endings.forEach((node,i)=>{
    const div = document.createElement('div');
    div.className = 'ending-item';
    div.innerHTML = `<h3>结局 ${i+1}：${node.title||''}</h3><p>${node.text||''}</p>`;
    list.appendChild(div);
  });
}

// ── Init ──────────────────────────────────────────────────────────────────
async function init() {

  if (previewGameId) {
    try {
      const res = await fetch('/api/load/' + previewGameId);
      if (res.ok) { gameData = await res.json(); saveLocal(); }
    } catch(e) { console.warn('load from DB failed:', e); }

    try {
      const imgRes = await fetch('/api/load-images/' + previewGameId);
      if (imgRes.ok) {
        const imgs = await imgRes.json();
        for (const [key, data] of Object.entries(imgs)) {
          ImgCache.set(previewGameId + '_' + key, data);
          if (!ImgCache.getSync(key)) ImgCache.set(key, data);
        }
      }
    } catch(e) { console.warn('load images failed:', e); }

    if (!gameData) {
      const raw = localStorage.getItem('gamePreview');
      if (raw) try { gameData = JSON.parse(raw); } catch {}
    }
  } else {
    const raw = localStorage.getItem('gamePreview');
    if (raw) try { gameData = JSON.parse(raw); } catch {}
  }

  // Wire up nav (always, so "新建故事" works even without gameData)
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => switchPanel(item.dataset.panel));
  });

  if (!gameData) {
    // No game — show the new story dialog immediately
    document.getElementById('editor-main').innerHTML = '';
    openGenDialog();
    return;
  }

  document.getElementById('preview-title').textContent = gameData.title || '故事引擎';
  showGameNav();

  // Default panel
  switchPanel('info');
}

ImgCache.init().then(init);
