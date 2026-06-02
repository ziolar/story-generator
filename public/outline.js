let outlineData = null;

function init() {
  const raw = localStorage.getItem('storyOutline');
  if (!raw) {
    document.body.innerHTML = '<p style="padding:40px;color:#888;font-family:system-ui">无大纲数据，请先生成大纲</p>';
    return;
  }
  outlineData = JSON.parse(raw);
  document.getElementById('outline-title-input').value = outlineData.title || '';
  renderChapters();
  renderCharacters();
}

// ── Chapters ──────────────────────────────────────────────────────────────

function renderChapters() {
  const list = document.getElementById('chapters-list');
  list.innerHTML = '';
  const chapters = outlineData.chapters || [];
  document.getElementById('chapter-count').textContent = chapters.length + ' 章';

  chapters.forEach((ch, ci) => {
    const item = document.createElement('div');
    item.className = 'chapter-item';
    item.id = 'chapter-' + ci;

    item.innerHTML = `
      <div class="chapter-head" onclick="toggleChapter(${ci})">
        <span class="chapter-num">${ci + 1}</span>
        <input type="text" class="chapter-title-input" value="${escapeAttr(ch.title || '')}"
          placeholder="章节标题" onclick="event.stopPropagation()" data-ci="${ci}">
        <span class="chapter-toggle" id="toggle-${ci}">▼</span>
      </div>
      <div class="chapter-body" id="body-${ci}">
        <div class="summary-label">章节概述</div>
        <textarea class="summary-input" id="summary-${ci}" rows="2">${escapeHtml(ch.summary || '')}</textarea>
        <div class="plot-label">情节点</div>
        <div class="plot-list" id="plots-${ci}"></div>
        <button class="btn-add-plot" onclick="addPlot(${ci})">+ 添加情节点</button>
      </div>`;

    list.appendChild(item);
    renderPlots(ci, ch.plotPoints || []);
  });
}

function toggleChapter(ci) {
  const body = document.getElementById('body-' + ci);
  const toggle = document.getElementById('toggle-' + ci);
  const isOpen = body.classList.contains('open');
  body.classList.toggle('open', !isOpen);
  toggle.classList.toggle('open', !isOpen);
}

function renderPlots(ci, plotPoints) {
  const container = document.getElementById('plots-' + ci);
  container.innerHTML = '';
  plotPoints.forEach((pt, pi) => {
    container.appendChild(makePlotRow(ci, pi, pt));
  });
}

function makePlotRow(ci, pi, text) {
  const row = document.createElement('div');
  row.className = 'plot-row';
  row.dataset.ci = ci;
  row.dataset.pi = pi;
  row.innerHTML = `
    <span class="plot-num">${pi + 1}</span>
    <input type="text" class="plot-input" value="${escapeAttr(text)}" placeholder="情节描述">
    <button class="btn-del-plot" onclick="deletePlot(this)" title="删除">✕</button>`;
  return row;
}

function addPlot(ci) {
  const container = document.getElementById('plots-' + ci);
  const pi = container.children.length;
  container.appendChild(makePlotRow(ci, pi, ''));
  container.lastElementChild.querySelector('.plot-input').focus();
  renumberPlots(container);
}

function deletePlot(btn) {
  const row = btn.closest('.plot-row');
  const container = row.closest('.plot-list');
  row.remove();
  renumberPlots(container);
}

function renumberPlots(container) {
  Array.from(container.children).forEach((row, i) => {
    row.querySelector('.plot-num').textContent = i + 1;
  });
}

// ── Characters ────────────────────────────────────────────────────────────

function renderCharacters() {
  const list = document.getElementById('characters-list');
  list.innerHTML = '';
  const chars = outlineData.characters || [];
  document.getElementById('char-count').textContent = chars.length + ' 人';

  chars.forEach((c, ci) => {
    const card = document.createElement('div');
    card.className = 'char-card';
    card.id = 'char-' + ci;

    const cachedPortrait = sessionStorage.getItem('portrait_' + (c.id || c.name));

    card.innerHTML = `
      <div class="char-card-header">
        <div class="char-portrait-thumb" id="thumb-${ci}">
          ${cachedPortrait ? `<img src="${cachedPortrait}" alt="">` : '👤'}
        </div>
        <div class="char-basic">
          <div class="char-row-inline">
            <input type="text" class="char-field f-name" placeholder="姓名"
              value="${escapeAttr(c.name || '')}" data-field="name" data-ci="${ci}">
            <input type="text" class="char-field f-gender" placeholder="性别"
              value="${escapeAttr(c.gender || '')}" data-field="gender" data-ci="${ci}">
            <input type="text" class="char-field f-era" placeholder="年代/时代"
              value="${escapeAttr(c.era || '')}" data-field="era" data-ci="${ci}">
          </div>
          <input type="text" class="char-field f-personality" placeholder="性格特点"
            value="${escapeAttr(c.personality || '')}" data-field="personality" data-ci="${ci}">
        </div>
      </div>

      <div class="char-textarea-label">外貌描述</div>
      <textarea class="char-textarea" rows="2" data-field="appearance" data-ci="${ci}"
        placeholder="外貌描述（中文）">${escapeHtml(c.appearance || '')}</textarea>

      <div class="char-textarea-label">人物小传</div>
      <textarea class="char-textarea" rows="3" data-field="background" data-ci="${ci}"
        placeholder="出身、经历、动机…">${escapeHtml(c.background || '')}</textarea>

      <div class="char-portrait-area">
        <div class="char-portrait-preview" id="preview-${ci}">
          ${cachedPortrait ? `<img src="${cachedPortrait}" alt="">` : '立绘预览'}
        </div>
        <div class="char-portrait-right">
          <div class="char-textarea-label" style="margin-top:0">立绘提示词（中文）</div>
          <textarea class="char-textarea" rows="3" id="pprompt-${ci}"
            data-field="portraitPrompt" data-ci="${ci}"
            placeholder="用于 AI 生成立绘的提示词">${escapeHtml(c.portraitPrompt || '')}</textarea>
          <button class="btn-gen-portrait" id="pbtn-${ci}" onclick="genPortraitPreview(${ci})">生成立绘预览</button>
          <div class="portrait-status" id="pst-${ci}">
            ${cachedPortrait ? '✓ 已生成' : ''}
          </div>
        </div>
      </div>`;

    list.appendChild(card);
  });
}

async function genPortraitPreview(ci) {
  const btn = document.getElementById('pbtn-' + ci);
  const st = document.getElementById('pst-' + ci);
  const thumb = document.getElementById('thumb-' + ci);
  const preview = document.getElementById('preview-' + ci);
  const promptEl = document.getElementById('pprompt-' + ci);

  const char = outlineData.characters[ci];
  const id = char.id || char.name;
  const name = char.name || id;
  const customPrompt = promptEl ? promptEl.value.trim() : '';

  btn.disabled = true;
  st.textContent = '生成中…';

  try {
    const style = localStorage.getItem('imageStyle') || 'pixel';
    const res = await fetch('/api/gen-portrait', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ name, id, customPrompt: customPrompt || undefined, style })
    });
    const data = await res.json();
    if (data.b64) {
      // Update thumb
      thumb.innerHTML = `<img src="${data.b64}" alt="">`;
      // Update preview
      preview.innerHTML = `<img src="${data.b64}" alt="">`;
      st.textContent = '✓ 已生成';
      sessionStorage.setItem('portrait_' + id, data.b64);
    } else {
      st.textContent = '生成失败: ' + (data.error || '未知');
    }
  } catch(e) {
    st.textContent = '生成失败: ' + e.message;
  } finally {
    btn.disabled = false;
  }
}

// ── Collect edited data ───────────────────────────────────────────────────

function collectOutline() {
  const title = document.getElementById('outline-title-input').value.trim();

  // Chapters
  const chapters = [];
  const chapterItems = document.querySelectorAll('.chapter-item');
  chapterItems.forEach((item, ci) => {
    const chTitle = item.querySelector('.chapter-title-input')?.value.trim() || '';
    const summary = document.getElementById('summary-' + ci)?.value.trim() || '';
    const plotInputs = document.querySelectorAll(`#plots-${ci} .plot-input`);
    const plotPoints = Array.from(plotInputs).map(inp => inp.value.trim()).filter(Boolean);
    chapters.push({ id: ci + 1, title: chTitle, summary, plotPoints });
  });

  // Characters
  const characters = (outlineData.characters || []).map((orig, ci) => {
    const card = document.getElementById('char-' + ci);
    const get = (field) => card?.querySelector(`[data-field="${field}"]`)?.value?.trim() || '';
    return {
      id: orig.id || ('c' + (ci + 1)),
      name: get('name') || orig.name,
      gender: get('gender'),
      era: get('era'),
      personality: get('personality'),
      appearance: get('appearance'),
      background: get('background'),
      portraitPrompt: get('portraitPrompt'),
    };
  });

  return { title, chapters, characters };
}

// ── Generate storylines (Phase 3) ─────────────────────────────────────────

async function genStorylines() {
  const outline = collectOutline();
  if (!outline.chapters.length) return showGenError('大纲为空，无法生成');

  setGenLoading(true);
  hideGenError();

  try {
    const res = await fetch('/api/gen-storylines', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ outline, characters: outline.characters })
    });
    const raw = await res.text();
    const dataLine = raw.split('\n').find(l => l.startsWith('DATA:'));
    const errLine = raw.split('\n').find(l => l.startsWith('ERROR:'));
    if (errLine) throw new Error(errLine.slice(6));
    if (!dataLine) throw new Error('生成失败，请重试');
    const gameData = JSON.parse(dataLine.slice(5));
    if (!gameData.storylines) throw new Error('生成数据格式异常，请重试');
    localStorage.setItem('gamePreview', JSON.stringify(gameData));
    window.location.href = '/preview.html';
  } catch(e) {
    showGenError(e.message);
  } finally {
    setGenLoading(false);
  }
}

function setGenLoading(on) {
  const btns = ['btn-gen-storylines', 'btn-gen-bottom'];
  btns.forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.disabled = on;
  });
  document.getElementById('btn-gen-text').style.display = on ? 'none' : '';
  document.getElementById('btn-gen-loading').style.display = on ? '' : 'none';
  document.getElementById('btn-gen-text2').style.display = on ? 'none' : '';
  document.getElementById('btn-gen-loading2').style.display = on ? '' : 'none';
}

function showGenError(msg) {
  const el = document.getElementById('gen-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}
function hideGenError() {
  document.getElementById('gen-error').classList.add('hidden');
}

// ── Utils ─────────────────────────────────────────────────────────────────

function escapeHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function escapeAttr(s) {
  return String(s || '').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

init();
