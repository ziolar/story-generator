let gameData = null;
let charMap = {};
let storylines = {};        // { id: { name, description, nodes[] } }
let currentStoryline = 'main';
let cursor = 0;
let bgCache = {};
let typingTimer = null;
let sceneLocked = false;

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

// === Generate ===
async function generate() {
  const text = document.getElementById('story-text').value.trim();
  if (!text) return showError('请先输入文本内容');
  if (text.length < 20) return showError('内容太短');
  const btn = document.getElementById('btn-generate');
  btn.disabled = true;
  btn.querySelector('.btn-text').classList.add('hidden');
  btn.querySelector('.btn-loading').classList.remove('hidden');
  hideError();
  try {
    const res = await fetch('/api/generate', {
      method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({text})
    });
    const raw = await res.text();
    const dataLine = raw.split('\n').find(l => l.startsWith('DATA:'));
    const errLine = raw.split('\n').find(l => l.startsWith('ERROR:'));
    if (errLine) throw new Error(errLine.slice(6));
    if (!dataLine) throw new Error('生成失败，请重试');
    const data = JSON.parse(dataLine.slice(5));
    if (!data.storylines && !data.script) throw new Error('生成数据格式异常，请重试');
    gameData = data;
    showPostGenButtons();
  } catch(e) { showError(e.message); }
  finally {
    btn.disabled = false;
    btn.querySelector('.btn-text').classList.remove('hidden');
    btn.querySelector('.btn-loading').classList.add('hidden');
  }
}

// === Post-generation buttons ===
function showPostGenButtons() {
  const container = document.getElementById('post-gen-btns');
  if (container) { container.classList.remove('hidden'); return; }
  const el = document.createElement('div');
  el.id = 'post-gen-btns';
  el.style.cssText = 'display:flex;gap:12px;margin-top:16px;width:100%';
  el.innerHTML = `
    <button onclick="goPreview()" style="flex:1;padding:12px;border:2px solid #f5a623;background:none;color:#f5a623;font-family:inherit;font-size:14px;cursor:pointer;letter-spacing:1px">🔍 预览检查</button>
    <button onclick="startGame()" style="flex:1;padding:12px;border:2px solid #e94560;background:none;color:#e94560;font-family:inherit;font-size:14px;cursor:pointer;letter-spacing:1px">▶ 直接游玩</button>`;
  document.querySelector('.editor-container').appendChild(el);
}

function goPreview() {
  localStorage.setItem('gamePreview', JSON.stringify(gameData));
  window.location.href = '/preview.html';
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
  document.getElementById('game-title').textContent = gameData.title || '互动故事';
  document.getElementById('editor-view').classList.remove('active');
  document.getElementById('game-view').classList.add('active');
  generatePortraits();
  advance();
}

async function generatePortraits() {
  const chars = gameData.characters || [];
  for (const c of chars) {
    try {
      const res = await fetch('/api/gen-portrait', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ name: c.name, id: c.id })
      });
      const data = await res.json();
      if (data.b64) charMap[c.id].portrait = data.b64;
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
  document.getElementById('btn-next').classList.add('hidden');

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

  loadingEl.classList.remove('hidden');
  bgEl.style.opacity = '0.3';

  try {
    const res = await fetch('/api/gen-bg', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ prompt: node.bgPrompt || node.sceneKey, sceneKey: node.sceneKey })
    });
    const data = await res.json();
    if (data.b64) {
      bgCache[node.sceneKey] = data.b64;
      setBg(bgEl, data.b64);
    }
  } catch(e) {
    console.warn('bg gen failed', e);
  }

  loadingEl.classList.add('hidden');
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
  typeText(textEl, node.text, () => showNext());
}

// === Dialog ===
function handleDialog(node) {
  const speakerEl = document.getElementById('dialog-speaker');
  const textEl = document.getElementById('dialog-text');
  const portraitEl = document.getElementById('char-portrait');
  const char = charMap[node.speaker];
  if (node.speaker === 'narrator') {
    speakerEl.textContent = '';
    textEl.style.fontStyle = 'italic';
    textEl.style.color = '#a8a8b3';
    portraitEl.classList.add('hidden');
  } else {
    speakerEl.textContent = char ? char.name : node.speaker;
    speakerEl.style.color = char ? char.color : '#f5a623';
    textEl.style.fontStyle = 'normal';
    textEl.style.color = '#f4f4f4';
    if (char && char.portrait) {
      portraitEl.src = char.portrait;
      portraitEl.classList.remove('hidden');
    } else {
      portraitEl.classList.add('hidden');
    }
  }
  typeText(textEl, node.text, () => showNext());
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
}

// === Card ===
function handleCard(node) {
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
  document.getElementById('btn-next').classList.remove('hidden');
}

// click on dialog box to skip typing or advance
document.getElementById('dialog-box').addEventListener('click', () => {
  if (typingTimer) {
    // skip typing — re-render full text
    clearInterval(typingTimer);
    typingTimer = null;
    const textEl = document.getElementById('dialog-text');
    // find current node (cursor already incremented, so cursor-1)
    const nodes = storylines[currentStoryline]?.nodes || [];
    const node = nodes[cursor - 1];
    if (node && (node.type === 'narrate' || node.type === 'dialog')) {
      renderBold(textEl, node.text);
    }
    showNext();
  }
});

function restartGame() {
  document.getElementById('game-end').classList.add('hidden');
  currentStoryline = 'main';
  cursor = 0;
  advance();
}

function backToEditor() {
  if (typingTimer) { clearInterval(typingTimer); typingTimer = null; }
  document.getElementById('game-view').classList.remove('active');
  document.getElementById('editor-view').classList.add('active');
  document.getElementById('game-end').classList.add('hidden');
  document.getElementById('card-overlay').classList.add('hidden');
  document.getElementById('hero-overlay').classList.add('hidden');
  document.getElementById('gacha-overlay').classList.add('hidden');
  document.getElementById('panel-overlay').classList.add('hidden');
}

function showError(msg) {
  const el = document.getElementById('error-msg');
  el.textContent = msg; el.classList.remove('hidden');
}
function hideError() { document.getElementById('error-msg').classList.add('hidden'); }

// Auto-start from preview page
if (localStorage.getItem('gameAutoStart') === '1') {
  localStorage.removeItem('gameAutoStart');
  const raw = localStorage.getItem('gamePreview');
  if (raw) { gameData = JSON.parse(raw); startGame(); }
}
