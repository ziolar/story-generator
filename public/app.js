let gameData = null;
let charMap = {};
let storylines = {};        // { id: { name, description, nodes[] } }
let currentStoryline = 'main';
let cursor = 0;
let bgCache = {};
let typingTimer = null;
let sceneLocked = false;
let currentDialogSpeaker = null; // tracks active dialog speaker for portrait hide logic

// === Image Style ===
let selectedStyle = localStorage.getItem('imageStyle') || 'pixel';

// Style selector
document.querySelectorAll('.style-opt').forEach(btn => {
  if (btn.dataset.style === selectedStyle) btn.classList.add('active');
  else btn.classList.remove('active');
  btn.addEventListener('click', () => {
    document.querySelectorAll('.style-opt').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    selectedStyle = btn.dataset.style;
    localStorage.setItem('imageStyle', selectedStyle);
  });
});

// === Douban Reading bookmarklet ===
function isDoubanRead(url) {
  return /read\.douban\.com\/reader\//i.test(url);
}

function buildBookmarklet() {
  const origin = location.origin;
  // Runs on the Douban Reading page (different domain), so can't use localStorage.
  // Instead: POST text to our API, get a token, redirect with ?import=TOKEN.
  const code = `(function(){
    var title = (document.querySelector('.chapter-title,.article-title,h1') || {}).textContent || document.title;
    var paras = Array.from(document.querySelectorAll('p[data-pid],.paragraph p,.story p,p'));
    paras = paras.filter(function(p){ return p.textContent.trim().length > 5; });
    if(!paras.length){ alert('\\u672a\\u627e\\u5230\\u6b63\\u6587\\uff0c\\u8bf7\\u786e\\u4fdd\\u7ae0\\u8282\\u5df2\\u5b8c\\u5168\\u52a0\\u8f7d\\u540e\\u518d\\u70b9\\u51fb'); return; }
    var text = title.trim() + '\\n\\n' + paras.map(function(p){ return p.textContent.trim(); }).join('\\n\\n');
    fetch('${origin}/api/import', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:text})})
      .then(function(r){ return r.json(); })
      .then(function(d){ window.open('${origin}/?import=' + d.token, '_blank') || (location.href='${origin}/?import=' + d.token); })
      .catch(function(){ alert('\\u5bfc\\u5165\\u5931\\u8d25\\uff0c\\u8bf7\\u68c0\\u67e5\\u7f51\\u7edc'); });
  })();`;
  return 'javascript:' + encodeURIComponent(code);
}

function onUrlInput(val) {
  const hint = document.getElementById('douban-hint');
  if (isDoubanRead(val)) {
    hint.classList.remove('hidden');
    document.getElementById('douban-bookmarklet').href = buildBookmarklet();
    document.getElementById('btn-fetch').disabled = true;
  } else {
    hint.classList.add('hidden');
    document.getElementById('btn-fetch').disabled = false;
  }
}

// Auto-import from Douban bookmarklet (?import=TOKEN)
(function checkDoubanImport() {
  const params = new URLSearchParams(location.search);
  const token = params.get('import');
  if (!token) return;
  // Clean URL without reloading
  history.replaceState(null, '', location.pathname);
  fetch('/api/import/' + token)
    .then(r => r.json())
    .then(data => {
      if (!data.text) return;
      document.querySelectorAll('.tab')[0].click();
      document.getElementById('story-text').value = data.text;
      const notice = document.createElement('div');
      notice.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);background:#f59e0b;color:#000;padding:8px 18px;font-family:inherit;font-size:13px;z-index:99;letter-spacing:1px';
      notice.textContent = '✓ 豆瓣阅读内容已导入';
      document.body.appendChild(notice);
      setTimeout(() => notice.remove(), 3000);
    })
    .catch(e => console.warn('import fetch failed', e));
})();

// === Tab switching ===
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('panel-' + tab.dataset.tab).classList.add('active');
  });
});

// === Fetch URL ===
async function fetchUrl() {
  const url = document.getElementById('story-url').value.trim();
  if (!url) return;
  const btn = document.getElementById('btn-fetch');
  btn.textContent = '抓取中…'; btn.disabled = true;
  try {
    const res = await fetch('/api/fetch-url', {
      method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({url})
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    document.getElementById('url-preview').textContent = data.text.substring(0,500) + '…';
    document.getElementById('url-preview').classList.remove('hidden');
    document.getElementById('story-text').value = data.text;
    document.querySelectorAll('.tab')[0].click();
  } catch(e) { showError(e.message); }
  finally { btn.textContent = '抓取'; btn.disabled = false; }
}

// === Generate (Phase 1: outline) ===
async function generate() {
  const text = document.getElementById('story-text').value.trim();
  if (!text) return showError('请先输入文本内容');
  if (text.length < 20) return showError('内容太短');

  // Collect optional title and characters
  const titleInput = (document.getElementById('story-title')?.value || '').trim();
  const charRows = document.querySelectorAll('.char-row');
  const customChars = [];
  charRows.forEach(row => {
    const name = row.querySelector('.char-name')?.value.trim();
    const desc = row.querySelector('.char-desc')?.value.trim();
    if (name) customChars.push({ name, description: desc || '' });
  });

  const btn = document.getElementById('btn-generate');
  btn.disabled = true;
  btn.querySelector('.btn-text').classList.add('hidden');
  btn.querySelector('.btn-loading').classList.remove('hidden');
  hideError();
  try {
    const res = await fetch('/api/gen-outline', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ text, title: titleInput || undefined, characters: customChars.length ? customChars : undefined })
    });
    const raw = await res.text();
    const dataLine = raw.split('\n').find(l => l.startsWith('DATA:'));
    const errLine = raw.split('\n').find(l => l.startsWith('ERROR:'));
    if (errLine) throw new Error(errLine.slice(6));
    if (!dataLine) throw new Error('生成失败，请重试');
    const data = JSON.parse(dataLine.slice(5));
    if (!data.chapters?.length) throw new Error('大纲数据格式异常，请重试');
    localStorage.setItem('storyOutline', JSON.stringify(data));
    localStorage.setItem('imageStyle', selectedStyle);
    window.location.href = '/outline.html';
  } catch(e) { showError(e.message); }
  finally {
    btn.disabled = false;
    btn.querySelector('.btn-text').classList.remove('hidden');
    btn.querySelector('.btn-loading').classList.add('hidden');
  }
}

// === Game Start ===
function startGame() {
  charMap = {};
  (gameData.characters || []).forEach(c => { charMap[c.id] = c; });

  // 兼容旧格式：script → storylines
  if (gameData.script && !gameData.storylines) {
    storylines = { main: { name: '主线', description: '完整故事', nodes: gameData.script } };
  } else {
    storylines = gameData.storylines || {};
  }

  currentStoryline = 'main';
  cursor = 0;
  bgCache = {};

  // Show cover screen
  const title = gameData.title || '互动故事';
  document.getElementById('game-title').textContent = title;
  document.getElementById('cover-title').textContent = title;
  document.getElementById('cover-subtitle').textContent = gameData.tagline || gameData.description || '';

  document.getElementById('editor-view').classList.remove('active');
  document.getElementById('game-view').classList.add('active');

  // Show cover over game view
  const cover = document.getElementById('cover-view');
  cover.classList.remove('fade-out');
  cover.classList.add('visible');

  // Try to use first scene bg as cover image (check scoped key first)
  const firstScene = (storylines.main?.nodes || []).find(n => n.type === 'scene');
  if (firstScene) {
    const cached = (currentGameId ? ImgCache.getSync(currentGameId + '_scene_' + firstScene.sceneKey) : null)
                || ImgCache.getSync('scene_' + firstScene.sceneKey);
    if (cached) {
      document.getElementById('cover-bg').src = cached;
    }
  }

  // Tap anywhere on cover to enter
  cover.addEventListener('click', enterGame, { once: true });

  generatePortraits();
}

function enterGame() {
  const cover = document.getElementById('cover-view');
  cover.classList.add('fade-out');
  setTimeout(() => { cover.classList.remove('visible', 'fade-out'); }, 500);
  advance();
}

async function generatePortraits() {
  const chars = gameData.characters || [];
  for (const c of chars) {
    // Check scoped key first, then unscoped fallback
    const pKey = portraitCacheKey(c.id);
    const cached = ImgCache.getSync(pKey) || (currentGameId ? ImgCache.getSync('portrait_' + c.id) : null);
    if (cached) { charMap[c.id].portrait = cached; continue; }
    // 兼容旧格式（直接存了 b64）
    if (c.portrait) { charMap[c.id].portrait = c.portrait; continue; }
    try {
      const res = await fetch('/api/gen-portrait', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ name: c.name, id: c.id, customPrompt: c.portraitPrompt || undefined, style: selectedStyle })
      });
      const data = await res.json();
      if (data.b64) {
        charMap[c.id].portrait = data.b64;
        ImgCache.set(pKey, data.b64);
        saveImageToDB('portrait_' + c.id, data.b64);
      }
    } catch(e) { console.warn('portrait gen failed', c.id, e); }
  }
}

// === Main Loop ===
async function advance() {
  if (sceneLocked) return;
  const nodes = storylines[currentStoryline]?.nodes || [];
  if (cursor >= nodes.length) return;

  const node = nodes[cursor];
  cursor++;

  hideChoices();
  document.getElementById('tap-hint').classList.add('hidden');

  switch (node.type) {
    case 'scene':    await handleScene(node); break;
    case 'narrate':  handleNarrate(node); break;
    case 'dialog':   handleDialog(node); break;
    case 'panel':    handlePanel(node); break;
    case 'choice':   handleChoice(node); break;
    case 'card':     handleCard(node); break;
    case 'hero':     handleHero(node); break;
    case 'gacha':    handleGacha(node); break;
    case 'ending':   handleEnding(node); break;
    default:         advance(); break;
  }
}

// === Scene ===
async function handleScene(node) {
  if (node.chapter) {
    document.getElementById('game-chapter').textContent = node.chapter;
  }

  const bgEl = document.getElementById('scene-bg');
  const loadingEl = document.getElementById('bg-loading');

  if (bgCache[node.sceneKey]) {
    setBg(bgEl, bgCache[node.sceneKey]);
    advance();
    return;
  }

  // Check IndexedDB cache first (set by preview.js or previous session)
  const ssKey = sceneCacheKey(node.sceneKey);
  const ssCached = ImgCache.getSync(ssKey) || (currentGameId ? ImgCache.getSync('scene_' + node.sceneKey) : null);
  if (ssCached) {
    bgCache[node.sceneKey] = ssCached;
    setBg(bgEl, ssCached);
    advance();
    return;
  }
  // 兼容旧格式（直接存了 b64）
  if (node.bgCache) {
    bgCache[node.sceneKey] = node.bgCache;
    setBg(bgEl, node.bgCache);
    advance();
    return;
  }

  loadingEl.classList.remove('hidden');
  bgEl.style.opacity = '0.3';

  try {
    const res = await fetch('/api/gen-bg', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ prompt: node.bgPrompt || node.sceneKey, sceneKey: node.sceneKey, style: selectedStyle })
    });
    const data = await res.json();
    if (data.b64) {
      bgCache[node.sceneKey] = data.b64;
      ImgCache.set(ssKey, data.b64);
      saveImageToDB('scene_' + node.sceneKey, data.b64);
      setBg(bgEl, data.b64);
    } else {
      console.error('bg gen error:', data.error);
      loadingEl.textContent = '图片生成失败，点击继续';
      loadingEl.style.cursor = 'pointer';
      loadingEl.onclick = () => advance();
    }
  } catch(e) {
    console.error('bg gen failed', e);
    loadingEl.textContent = '图片请求失败，点击继续';
    loadingEl.style.cursor = 'pointer';
    loadingEl.onclick = () => advance();
  }

  loadingEl.classList.add('hidden');
  loadingEl.style.cursor = '';
  loadingEl.onclick = null;
  bgEl.style.opacity = '1';
  advance();
}

function setBg(el, src) {
  el.src = src;
  el.style.opacity = '1';
  const anims = ['pan-lr', 'pan-rl', 'zoom'];
  el.className = 'scene-bg ' + anims[Math.floor(Math.random() * anims.length)];
}

// === Narrate ===
function handleNarrate(node) {
  const speakerEl = document.getElementById('dialog-speaker');
  const textEl = document.getElementById('dialog-text');
  speakerEl.textContent = '';
  textEl.style.fontStyle = 'italic';
  textEl.style.color = '#a8a8b3';
  // Hide portrait when narration interrupts a dialog run
  hidePortrait();
  typeText(textEl, node.text, () => showNext());
}

// === Dialog ===
function handleDialog(node) {
  const speakerEl = document.getElementById('dialog-speaker');
  const textEl = document.getElementById('dialog-text');
  const char = charMap[node.speaker];
  if (node.speaker === 'narrator') {
    speakerEl.textContent = '';
    textEl.style.fontStyle = 'italic';
    textEl.style.color = '#a8a8b3';
    hidePortrait();
  } else {
    speakerEl.textContent = char ? char.name : node.speaker;
    speakerEl.style.color = char ? char.color : '#f5a623';
    textEl.style.fontStyle = 'normal';
    textEl.style.color = '#f4f4f4';
    if (char && char.portrait) {
      const portraitEl = document.getElementById('char-portrait');
      const speakerChanged = currentDialogSpeaker !== node.speaker;
      currentDialogSpeaker = node.speaker;
      portraitEl.src = char.portrait;
      if (speakerChanged) {
        portraitEl.classList.remove('hidden');
        portraitEl.style.animation = 'none';
        requestAnimationFrame(() => { portraitEl.style.animation = ''; });
        const dialogArea = document.getElementById('dialog-box-area');
        if (dialogArea) {
          document.getElementById('game-view').style.setProperty('--dialog-h', dialogArea.offsetHeight + 'px');
        }
      }
    } else {
      hidePortrait();
    }
  }
  typeText(textEl, node.text, () => showNext());
}

function hidePortrait() {
  const portraitEl = document.getElementById('char-portrait');
  portraitEl.classList.add('hidden');
  currentDialogSpeaker = null;
}

// === Typewriter ===
function typeText(el, rawText, onDone) {
  if (typingTimer) clearInterval(typingTimer);
  el.innerHTML = '';

  // parse **bold** markers
  const parts = rawText.split(/(\*\*[^*]+\*\*)/g);
  const tokens = [];
  parts.forEach(p => {
    if (p.startsWith('**') && p.endsWith('**')) {
      tokens.push({ text: p.slice(2, -2), bold: true });
    } else {
      tokens.push({ text: p, bold: false });
    }
  });

  let ti = 0, ci = 0;
  const speed = 70;

  typingTimer = setInterval(() => {
    if (ti >= tokens.length) {
      clearInterval(typingTimer);
      typingTimer = null;
      if (onDone) onDone();
      return;
    }
    const tok = tokens[ti];
    if (ci === 0) {
      const span = document.createElement(tok.bold ? 'strong' : 'span');
      el.appendChild(span);
    }
    const span = el.lastChild;
    span.textContent += tok.text[ci];
    ci++;
    if (ci >= tok.text.length) { ti++; ci = 0; }
  }, speed);
}

function skipTyping() {
  if (!typingTimer) return false;
  clearInterval(typingTimer);
  typingTimer = null;
  // render full text immediately
  const textEl = document.getElementById('dialog-text');
  const rawText = textEl.dataset.raw || '';
  if (rawText) renderBold(textEl, rawText);
  return true;
}

function renderBold(el, text) {
  el.innerHTML = '';
  text.split(/(\*\*[^*]+\*\*)/g).forEach(p => {
    if (p.startsWith('**') && p.endsWith('**')) {
      const s = document.createElement('strong');
      s.textContent = p.slice(2, -2);
      el.appendChild(s);
    } else {
      el.appendChild(document.createTextNode(p));
    }
  });
}

// === Panel ===
function handlePanel(node) {
  const overlay = document.getElementById('panel-overlay');
  const img = document.getElementById('panel-img');
  const caption = document.getElementById('panel-caption');

  overlay.className = 'panel-overlay pos-' + (node.pos || 'br');
  img.src = node.src || '';
  caption.textContent = node.caption || '';
  overlay.classList.remove('hidden');

  const autoClose = setTimeout(() => closePanel(), 4000);
  overlay.onclick = () => { clearTimeout(autoClose); closePanel(); };

  advance();
}

function closePanel() {
  document.getElementById('panel-overlay').classList.add('hidden');
}

// === Choice ===
function handleChoice(node) {
  const choicesEl = document.getElementById('game-choices');
  choicesEl.innerHTML = '';

  if (node.question) {
    const q = document.createElement('div');
    q.style.cssText = 'font-size:12px;color:var(--text2);padding:0 0 6px;letter-spacing:1px';
    q.textContent = node.question;
    choicesEl.appendChild(q);
  }

  (node.options || []).forEach(opt => {
    const btn = document.createElement('button');
    btn.className = 'choice-btn';
    btn.textContent = opt.text;
    btn.onclick = () => {
      btn.classList.add('selected');
      choicesEl.querySelectorAll('.choice-btn').forEach(b => b.disabled = true);
      setTimeout(() => {
        hideChoices();
        // 新格式：gotoStoryline + gotoNode
        if (opt.gotoStoryline && storylines[opt.gotoStoryline]) {
          currentStoryline = opt.gotoStoryline;
          cursor = typeof opt.gotoNode === 'number' ? opt.gotoNode : 0;
        } else if (opt.gotoStoryline && !storylines[opt.gotoStoryline]) {
          // Target storyline missing (AI only generated main) — continue main
          console.warn('Missing storyline:', opt.gotoStoryline, '— staying on main');
        } else if (typeof opt.gotoNode === 'number') {
          cursor = opt.gotoNode;
        }
        // 兼容旧格式：goto
        else if (typeof opt.goto === 'number') {
          cursor = opt.goto;
        }
        advance();
      }, 400);
    };
    choicesEl.appendChild(btn);
  });

  choicesEl.classList.remove('hidden');
}

function hideChoices() {
  const el = document.getElementById('game-choices');
  el.innerHTML = '';
  el.classList.add('hidden');
  document.getElementById('tap-hint').classList.add('hidden');
}

// === Card ===
function handleCard(node) {
  if (gameData && gameData.disableCards) { advance(); return; }
  document.getElementById('card-title').textContent = node.title || '';
  document.getElementById('card-text').textContent = node.text || '';
  document.getElementById('card-teaser').textContent = node.teaser ? '▶ ' + node.teaser : '';
  document.getElementById('card-overlay').classList.remove('hidden');
}

function closeCard() {
  document.getElementById('card-overlay').classList.add('hidden');
  advance();
}

// === Hero ===
function handleHero(node) {
  document.getElementById('hero-title').textContent = node.title || '';
  document.getElementById('hero-subtitle').textContent = node.subtitle || '';
  document.getElementById('hero-overlay').classList.remove('hidden');
}

function closeHero() {
  document.getElementById('hero-overlay').classList.add('hidden');
  advance();
}

// === Gacha ===
let gachaNode = null;

function handleGacha(node) {
  if (gameData && gameData.disableGacha) { advance(); return; }
  gachaNode = node;
  document.getElementById('gacha-question').textContent = node.question || '抽取命运';
  const cardInner = document.getElementById('gacha-card').querySelector('.gacha-card-inner');
  cardInner.classList.remove('flipped');
  const back = document.getElementById('gacha-card-back');
  back.innerHTML = '';
  back.className = 'gacha-card-back';
  document.getElementById('gacha-btn').classList.remove('hidden');
  document.getElementById('gacha-next').classList.add('hidden');
  document.getElementById('gacha-overlay').classList.remove('hidden');
}

function doGacha() {
  if (!gachaNode) return;
  const pool = gachaNode.pool || [];
  const result = pickGacha(pool);

  const back = document.getElementById('gacha-card-back');
  back.className = 'gacha-card-back rarity-' + result.rarity;

  const rarityLabel = { good: '好结局', normal: '普通', bad: '坏结局', hidden: '隐藏' };
  back.innerHTML = `<div class="gacha-rarity">${rarityLabel[result.rarity] || result.rarity}</div>
    <div class="gacha-result-text">${result.text}</div>`;

  const cardInner = document.getElementById('gacha-card').querySelector('.gacha-card-inner');
  cardInner.classList.add('flipped');

  document.getElementById('gacha-btn').classList.add('hidden');
  document.getElementById('gacha-next').classList.remove('hidden');
}

function pickGacha(pool) {
  const total = pool.reduce((s, p) => s + (p.weight || 0), 0);
  let r = Math.random() * total;
  for (const p of pool) {
    r -= p.weight || 0;
    if (r <= 0) return p;
  }
  return pool[pool.length - 1];
}

function closeGacha() {
  document.getElementById('gacha-overlay').classList.add('hidden');
  gachaNode = null;
  advance();
}

// === Ending ===
function handleEnding(node) {
  document.getElementById('end-title').textContent = node.title || '故事结束';
  document.getElementById('end-text').textContent = node.text || '';
  document.getElementById('game-end').classList.remove('hidden');
}

// === Helpers ===
function showNext() {
  document.getElementById('tap-hint').classList.remove('hidden');
}

// click on dialog box to skip typing or advance
document.getElementById('dialog-box').addEventListener('click', () => {
  if (typingTimer) {
    clearInterval(typingTimer);
    typingTimer = null;
    const textEl = document.getElementById('dialog-text');
    const nodes = storylines[currentStoryline]?.nodes || [];
    const node = nodes[cursor - 1];
    if (node && (node.type === 'narrate' || node.type === 'dialog')) {
      renderBold(textEl, node.text);
    }
    showNext();
  } else {
    // tap-hint visible means waiting for next
    const hint = document.getElementById('tap-hint');
    if (!hint.classList.contains('hidden')) {
      // Check if portrait should hide when advancing to next node
      const nodes = storylines[currentStoryline]?.nodes || [];
      const nextNode = nodes[cursor];
      const currentNode = nodes[cursor - 1];
      const nextIsSameSpeaker = nextNode?.type === 'dialog' && nextNode?.speaker === currentNode?.speaker && nextNode?.speaker !== 'narrator';
      if (!nextIsSameSpeaker) {
        hidePortrait();
      }
      advance();
    }
  }
});

function restartGame() {
  document.getElementById('game-end').classList.add('hidden');
  currentStoryline = 'main';
  cursor = 0;
  hidePortrait();
  // Show cover again on restart
  const cover = document.getElementById('cover-view');
  cover.classList.remove('fade-out');
  cover.classList.add('visible');
  cover.addEventListener('click', enterGame, { once: true });
}

function backToEditor() {
  if (typingTimer) { clearInterval(typingTimer); typingTimer = null; }
  document.getElementById('game-end').classList.add('hidden');
  document.getElementById('card-overlay').classList.add('hidden');
  document.getElementById('hero-overlay').classList.add('hidden');
  document.getElementById('gacha-overlay').classList.add('hidden');
  document.getElementById('panel-overlay').classList.add('hidden');
  // Return to preview page scoped to this game if we have an ID
  if (currentGameId) {
    window.location.href = '/preview/' + currentGameId;
  } else if (localStorage.getItem('gamePreview')) {
    window.location.href = '/preview.html';
  } else {
    document.getElementById('game-view').classList.remove('active');
    document.getElementById('editor-view').classList.add('active');
  }
}

function showError(msg) {
  const el = document.getElementById('error-msg');
  el.textContent = msg; el.classList.remove('hidden');
}
function hideError() { document.getElementById('error-msg').classList.add('hidden'); }

// Fire-and-forget: persist one image to the DB under this game's namespace
function saveImageToDB(imgKey, b64) {
  if (!currentGameId) return;
  fetch('/api/save-image/' + currentGameId, {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ key: imgKey, data: b64 })
  }).catch(() => {});
}

// Scoped ImgCache key helpers (use game ID prefix when available)
function portraitCacheKey(id)  { return currentGameId ? currentGameId + '_portrait_' + id  : 'portrait_' + id;  }
function sceneCacheKey(sKey)   { return currentGameId ? currentGameId + '_scene_' + sKey   : 'scene_' + sKey;   }

// === Share ===
let shareToastEl = null;
let currentGameId = null; // set after auto-save

// Auto-save game and update URL to /play/slug-xxxx
async function autoSaveGame() {
  if (!gameData) return;
  try {
    const res = await fetch('/api/save', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify(gameData)
    });
    const data = await res.json();
    if (data.id) {
      currentGameId = data.id;
      history.replaceState(null, '', '/play/' + data.id);
    }
  } catch(e) {
    console.warn('auto-save failed', e);
  }
}

async function shareGame() {
  if (!gameData) return;
  // If already saved, just show the current URL
  if (currentGameId) {
    showShareToast(location.origin + '/play/' + currentGameId);
    return;
  }
  const btn = document.querySelector('.btn-share');
  const origText = btn.textContent;
  btn.textContent = '保存中…'; btn.disabled = true;
  try {
    await autoSaveGame();
    if (currentGameId) showShareToast(location.origin + '/play/' + currentGameId);
  } catch(e) {
    alert('分享失败: ' + e.message);
  } finally {
    btn.textContent = origText; btn.disabled = false;
  }
}

function showShareToast(url) {
  if (shareToastEl) shareToastEl.remove();
  shareToastEl = document.createElement('div');
  shareToastEl.className = 'share-toast';
  shareToastEl.innerHTML = `
    <span>分享链接</span>
    <input id="share-url-input" type="text" value="${url}" readonly onclick="this.select()">
    <button onclick="copyShareUrl('${url}')">复制</button>
    <button class="toast-close" onclick="this.closest('.share-toast').remove()">✕</button>`;
  document.body.appendChild(shareToastEl);
  document.getElementById('share-url-input').select();
}

function copyShareUrl(url) {
  navigator.clipboard.writeText(url).then(() => {
    const btn = shareToastEl.querySelector('button');
    btn.textContent = '已复制 ✓';
    setTimeout(() => { btn.textContent = '复制'; }, 2000);
  }).catch(() => {
    document.getElementById('share-url-input').select();
    document.execCommand('copy');
  });
}

// Init image cache, then auto-start if needed
ImgCache.init().then(() => {
  // Auto-start from preview page
  if (localStorage.getItem('gameAutoStart') === '1') {
    localStorage.removeItem('gameAutoStart');
    const raw = localStorage.getItem('gamePreview');
    if (raw) {
      gameData = JSON.parse(raw);
      autoSaveGame().then(() => startGame());
    }
  }

  // Auto-start from shared URL /play/:id
  const playMatch = location.pathname.match(/^\/play\/([a-z0-9-]+)$/i);
  if (playMatch) {
    currentGameId = playMatch[1];
    // Load game data and images from DB in parallel
    Promise.all([
      fetch('/api/load/' + currentGameId).then(r => r.json()),
      fetch('/api/load-images/' + currentGameId).then(r => r.json()).catch(() => ({}))
    ]).then(([data, imgs]) => {
        // Populate ImgCache with game-scoped keys so generatePortraits/handleScene find them
        for (const [key, b64] of Object.entries(imgs || {})) {
          ImgCache.set(currentGameId + '_' + key, b64);
        }
        if (data && data.storylines) {
          gameData = data;
          startGame();
        } else {
          history.replaceState(null, '', '/');
          showError('游戏链接已过期，请重新生成');
        }
      })
      .catch(e => {
        history.replaceState(null, '', '/');
        showError('加载失败，请重试');
        console.warn('load shared game failed', e);
      });
  }
});
