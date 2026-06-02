const TYPE_COLOR = {
  scene:'#60a5fa', narrate:'#a78bfa', dialog:'#34d399', choice:'#f59e0b',
  card:'#f472b6', hero:'#fb923c', gacha:'#c084fc', ending:'#f87171', panel:'#94a3b8'
};

const RARITY_CLASS = { good:'g-good', normal:'g-normal', bad:'g-bad', hidden:'g-hidden' };
const RARITY_LABEL = { good:'好结局', normal:'普通', bad:'坏结局', hidden:'隐藏' };

let gameData = null;

// 安全写入 localStorage（图片不存入，避免超限）
function saveGameDataSafe() {
  try {
    localStorage.setItem('gamePreview', JSON.stringify(gameData));
  } catch(e) {
    // 超限时忽略，图片已在 sessionStorage
    console.warn('localStorage save skipped:', e.message);
  }
}

function goPlay() {
  localStorage.setItem('gameAutoStart', '1');
  // If we already have a saved game ID in the URL, go directly to it
  const match = location.pathname.match(/^\/play\/([a-z0-9-]+)$/i);
  if (match) {
    window.location.href = '/play/' + match[1];
  } else {
    window.location.href = '/';
  }
}

function init() {
  const raw = localStorage.getItem('gamePreview');
  if (!raw) { document.body.innerHTML = '<p style="padding:40px;color:#888">无预览数据，请先生成游戏</p>'; return; }
  gameData = JSON.parse(raw);
  document.getElementById('preview-title').textContent = gameData.title || '游戏预览';
  renderInfo();
  renderPortraits();
  renderStory();
  renderBranch();
  renderGacha();
  renderCards();
  renderEndings();
  renderScenes();
}

// ① 角色立绘（异步生成）
async function renderPortraits() {
  const chars = gameData.characters || [];
  const el = document.getElementById('portraits-content');
  const bar = document.getElementById('portraits-bar');
  if (!chars.length) { el.innerHTML = '<p style="color:var(--text2);font-size:13px">无角色定义</p>'; return; }

  chars.forEach(c => {
    const defaultPrompt = `${c.name}, character portrait, upper body${c.description ? ', ' + c.description : ''}`;
    const card = document.createElement('div');
    card.className = 'scene-card';
    card.innerHTML = `<div class="scene-placeholder" id="pph-${c.id}">等待生成</div>
      <div class="scene-info">
        <div class="scene-key" style="color:${c.color}">${c.name}</div>
        <textarea id="pprompt-${c.id}" style="width:100%;background:#0f1117;color:#e8e8f0;border:1px solid #2a2d45;font-family:inherit;font-size:11px;padding:4px;resize:vertical;margin:4px 0;line-height:1.4">${defaultPrompt}</textarea>
        <button onclick="regenPortrait('${c.id}')" style="width:100%;background:none;border:1px solid #f5a623;color:#f5a623;font-family:inherit;font-size:11px;padding:3px;cursor:pointer">重新生成</button>
        <div class="scene-status" id="pst-${c.id}">等待生成</div>
      </div>`;
    el.appendChild(card);
  });

  let done = 0;
  for (const c of chars) {
    await genPortrait(c.id, c.name);
    done++;
    bar.style.width = (done / chars.length * 100) + '%';
  }
}

async function genPortrait(id, name) {
  const st = document.getElementById('pst-' + id);
  const ph = document.getElementById('pph-' + id);
  const promptEl = document.getElementById('pprompt-' + id);

  // 已有缓存，直接显示
  const char = (gameData.characters || []).find(c => c.id === id);
  if (char?.portrait) {
    let img = document.getElementById('pimg-' + id);
    if (!img) { img = document.createElement('img'); img.id = 'pimg-' + id; ph?.replaceWith(img); }
    img.src = char.portrait;
    if (st) st.textContent = '✓ 已生成';
    return;
  }
  try {
    const res = await fetch('/api/gen-portrait', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ name: name || id, id, customPrompt: promptEl?.value, style: localStorage.getItem('imageStyle') || 'pixel' })
    });
    const data = await res.json();
    if (data.b64) {
      let img = document.getElementById('pimg-' + id);
      if (!img) { img = document.createElement('img'); img.id = 'pimg-' + id; ph?.replaceWith(img); }
      img.src = data.b64;
      if (st) st.textContent = '✓ 已生成';
      // 图片存 sessionStorage，避免 localStorage 超限
      sessionStorage.setItem('portrait_' + id, data.b64);
      // gameData 只记录已生成标记，不存 b64
      const char = (gameData.characters || []).find(c => c.id === id);
      if (char) {
        char.portraitReady = true;
        saveGameDataSafe();
      }
    } else {
      if (st) st.textContent = '生成失败';
    }
  } catch(e) {
    if (st) st.textContent = '生成失败: ' + e.message;
  }
}

async function regenPortrait(id) {
  const btn = event.target;
  btn.disabled = true;
  const char = (gameData.characters || []).find(c => c.id === id);
  await genPortrait(id, char?.name || id);
  btn.disabled = false;
}

// ② 故事线（平行故事）
function renderStory() {
  const storylines = gameData.storylines || {};
  // 兼容旧格式
  const lines = Object.keys(storylines).length
    ? storylines
    : { main: { name: '主线', description: '', nodes: gameData.script || [] } };

  const el = document.getElementById('story-content');
  const lineColors = ['#60a5fa','#34d399','#f59e0b','#f472b6','#c084fc','#fb923c'];
  const ids = Object.keys(lines);

  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'display:flex;gap:16px;align-items:flex-start;overflow-x:auto;padding-bottom:8px';

  ids.forEach((id, ci) => {
    const line = lines[id];
    const color = lineColors[ci % lineColors.length];
    const col = document.createElement('div');
    col.style.cssText = `min-width:240px;max-width:280px;border-left:3px solid ${color};padding-left:10px`;

    const header = document.createElement('div');
    header.style.cssText = `margin-bottom:8px`;
    header.innerHTML = `<div style="font-size:11px;letter-spacing:2px;color:${color};padding:2px 6px;border:1px solid ${color};display:inline-block;margin-bottom:4px">${line.name || id}</div>`
      + (line.description ? `<div style="font-size:11px;color:var(--text2);line-height:1.4">${line.description}</div>` : '');
    col.appendChild(header);

    (line.nodes || []).forEach((node, i) => {
      const color2 = TYPE_COLOR[node.type] || '#888';
      const item = document.createElement('div');
      item.style.cssText = 'padding:5px 0;border-bottom:1px solid #2a2d45';
      let label = nodeLabel(node);
      // 对 choice 节点，显示跳转目标故事线
      if (node.type === 'choice') {
        label = (node.options || []).map(o => {
          const dest = o.gotoStoryline ? `→${lines[o.gotoStoryline]?.name || o.gotoStoryline}#${o.gotoNode ?? 0}` : (typeof o.gotoNode === 'number' ? `→#${o.gotoNode}` : (typeof o.goto === 'number' ? `→#${o.goto}` : ''));
          return `[${o.text} ${dest}]`;
        }).join(' ');
      }
      item.innerHTML = `<span style="font-size:10px;color:var(--text2)">#${i}</span> `
        + `<span style="font-size:10px;color:${color2};border:1px solid ${color2};padding:1px 4px;margin-right:4px">${node.type}</span>`
        + `<span style="font-size:12px;color:var(--text2)">${label}</span>`;
      col.appendChild(item);
    });
    wrapper.appendChild(col);
  });
  el.appendChild(wrapper);
}

// ③ 逻辑分支图（树状横向展开：从左到右，所有连线向右，折线直角）
function renderBranch() {
  const storylines = gameData.storylines || {};
  const lines = Object.keys(storylines).length
    ? storylines
    : { main: { name: '主线', description: '', nodes: gameData.script || [] } };

  const ids = Object.keys(lines);
  if (!ids.length) {
    document.getElementById('branch-content').innerHTML = '<p style="color:var(--text2);font-size:13px">无故事线数据</p>';
    return;
  }

  // 布局常量
  const NW = 100, NH = 36;   // 节点宽高（文字框）
  const ROW_H = 60;           // 行间距
  const COL_W = 180;          // 列间距（节点左边到下一节点左边）
  const PAD_X = 20, PAD_Y = 20;
  const lineColors = ['#60a5fa','#34d399','#f59e0b','#f472b6','#c084fc','#fb923c'];

  // 收集每条故事线的关键节点（scene起点 + choice + ending）
  const keyNodes = {};
  ids.forEach(id => {
    const nodes = lines[id].nodes || [];
    const result = [];
    const firstScene = nodes.findIndex(n => n.type === 'scene');
    if (firstScene >= 0) result.push({ origIdx: firstScene, node: nodes[firstScene], role: 'scene' });
    nodes.forEach((node, i) => {
      if (node.type === 'choice' || node.type === 'ending') result.push({ origIdx: i, node, role: node.type });
    });
    const seen = new Set();
    keyNodes[id] = result.filter(k => { if (seen.has(k.origIdx)) return false; seen.add(k.origIdx); return true; });
  });

  // 每条故事线的起始列：main从0开始，其他从1开始
  const colStartOf = {};
  ids.forEach((id, i) => { colStartOf[id] = i === 0 ? 0 : 1; });

  // 节点坐标（节点中心）
  const pos = {};
  ids.forEach((id, ri) => {
    pos[id] = {};
    const colStart = colStartOf[id];
    const nodeCY = PAD_Y + ri * ROW_H + NH / 2;
    keyNodes[id].forEach(({ origIdx }, ki) => {
      pos[id][origIdx] = {
        x: PAD_X + (colStart + ki) * COL_W + NW / 2,
        y: nodeCY
      };
    });
  });

  const maxCol = Math.max(1, ...ids.map(id => colStartOf[id] + keyNodes[id].length));
  const totalW = PAD_X * 2 + maxCol * COL_W + 40;
  const totalH = PAD_Y * 2 + ids.length * ROW_H;

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" style="font-family:'Courier New',monospace;display:block;background:#0f1117" width="${totalW}" height="${totalH}">`;
  svg += `<defs>
    <marker id="arr" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
      <path d="M0,0 L7,3.5 L0,7 Z" fill="#888"/>
    </marker>
    <marker id="arr-choice" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
      <path d="M0,0 L7,3.5 L0,7 Z" fill="#f59e0b"/>
    </marker>
  </defs>`;

  svg += `<rect width="${totalW}" height="${totalH}" fill="#0f1117"/>`;

  // ── 连接线（先画，节点覆盖在上面）──

  // 1. 同行节点间水平连线（向右）
  ids.forEach((id, ri) => {
    const color = lineColors[ri % lineColors.length];
    const kn = keyNodes[id];
    for (let i = 0; i < kn.length - 1; i++) {
      const a = pos[id][kn[i].origIdx];
      const b = pos[id][kn[i+1].origIdx];
      if (!a || !b) continue;
      // 水平直线，从左节点右边 → 右节点左边
      svg += `<line x1="${a.x + NW/2}" y1="${a.y}" x2="${b.x - NW/2}" y2="${b.y}" stroke="${color}" stroke-width="1.5" marker-end="url(#arr)"/>`;
    }
  });

  // 2. 跨故事线跳转：从 choice 节点右边出发，折线向右到目标行（直角，不回头）
  ids.forEach(id => {
    keyNodes[id].forEach(({ origIdx, node }) => {
      if (node.type !== 'choice') return;
      const src = pos[id][origIdx];
      if (!src) return;
      (node.options || []).forEach(opt => {
        const targetId = opt.gotoStoryline;
        if (!targetId || !pos[targetId]) return;
        const targetKN = keyNodes[targetId];
        const targetNodeIdx = typeof opt.gotoNode === 'number' ? opt.gotoNode : 0;
        const match = targetKN.find(k => k.origIdx >= targetNodeIdx) || targetKN[0];
        if (!match) return;
        const dst = pos[targetId][match.origIdx];
        if (!dst) return;

        // 出发点：choice 节点右边中点
        const x0 = src.x + NW/2, y0 = src.y;
        // 到达点：目标节点左边中点
        const x1 = dst.x - NW/2, y1 = dst.y;

        // 折线：右出 → 垂直到目标行 → 右进
        // 转折 x 取两者中点（保证始终向右）
        const tx = Math.max(x0 + 20, (x0 + x1) / 2);
        svg += `<polyline points="${x0},${y0} ${tx},${y0} ${tx},${y1} ${x1},${y1}" fill="none" stroke="#f59e0b" stroke-width="1.5" stroke-dasharray="4,3" marker-end="url(#arr-choice)"/>`;

        // 选项文字标签（贴在垂直段旁）
        const lbl = truncate(opt.text || '', 8);
        const lw = lbl.length * 7 + 10;
        const ly = (y0 + y1) / 2;
        svg += `<rect x="${tx + 3}" y="${ly - 9}" width="${lw}" height="13" rx="2" fill="#1a1400" stroke="#f59e0b" stroke-width="0.8"/>`;
        svg += `<text x="${tx + 3 + lw/2}" y="${ly + 1}" font-size="9" fill="#f59e0b" text-anchor="middle">${escapeXml(lbl)}</text>`;
      });
    });
  });

  // ── 节点 ──
  ids.forEach((id, ri) => {
    const color = lineColors[ri % lineColors.length];
    const kn = keyNodes[id];

    kn.forEach(({ origIdx, node, role }, ki) => {
      const { x, y } = pos[id][origIdx];
      const nx = x - NW/2, ny = y - NH/2;
      const isEnding = node.type === 'ending';
      const isChoice = node.type === 'choice';
      const isScene = role === 'scene';

      // 节点框
      const strokeColor = isEnding ? '#f87171' : isChoice ? '#f59e0b' : color;
      const fillColor = isEnding ? '#1a0a0a' : '#1a1d2e';
      svg += `<rect x="${nx}" y="${ny}" width="${NW}" height="${NH}" rx="4" fill="${fillColor}" stroke="${strokeColor}" stroke-width="1.5"/>`;

      // 节点文字
      let label = '';
      if (isEnding) label = truncate(node.title || '结局', 10);
      else if (isChoice) label = '◆ 选择';
      else label = truncate(node.sceneKey || node.chapter || '', 10);

      svg += `<text x="${x}" y="${y + 4}" font-size="11" fill="${strokeColor}" text-anchor="middle" dominant-baseline="middle">${escapeXml(label)}</text>`;

      // 行首第一个节点：在节点上方显示故事线名称
      if (ki === 0) {
        const lineName = lines[id].name || id;
        svg += `<circle cx="${nx}" cy="${ny - 8}" r="4" fill="${color}"/>`;
        svg += `<text x="${nx + 8}" y="${ny - 4}" font-size="11" fill="${color}" font-weight="bold">${escapeXml(lineName)}</text>`;
      }
    });
  });

  svg += '</svg>';

  const wrap = document.getElementById('branch-content');
  wrap.style.cssText = 'overflow-x:auto;overflow-y:visible;width:100%';
  wrap.innerHTML = svg;
}

// 将字符串按每行 n 个字符拆分（用于 SVG 多行文字）
function splitText(s, n) {
  s = s || '';
  const result = [];
  for (let i = 0; i < s.length; i += n) result.push(s.substring(i, i + n));
  return result.length ? result : [''];
}

function escapeXml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function nodeLabelPlain(node) {
  switch(node.type) {
    case 'scene':   return truncate(node.chapter || node.sceneKey, 16);
    case 'dialog':  return truncate(node.speaker + ': ' + node.text, 18);
    case 'narrate': return truncate(node.text, 18);
    case 'choice':  return (node.options||[]).map(o => o.gotoStoryline ? `→${o.gotoStoryline}` : `→#${o.gotoNode ?? o.goto ?? '?'}`).join(' ');
    case 'ending':  return truncate(node.title, 16);
    default:        return truncate(node.title || '', 16);
  }
}

// ① 基本信息
function renderInfo() {
  const chars = gameData.characters || [];
  const grid = document.createElement('div');
  grid.className = 'info-grid';
  chars.forEach(c => {
    const chip = document.createElement('div');
    chip.className = 'char-chip';
    chip.innerHTML = `<div class="char-dot" style="background:${c.color}"></div>
      <span class="char-name">${c.name} <span style="color:var(--text2);font-size:10px">${c.id}</span></span>`;
    grid.appendChild(chip);
  });
  if (!chars.length) grid.innerHTML = '<span style="color:var(--text2);font-size:13px">无角色定义</span>';
  document.getElementById('info-content').appendChild(grid);
}

function nodeLabel(node) {
  switch(node.type) {
    case 'scene':   return `<strong>${node.sceneKey || ''}</strong> — ${node.chapter || ''}`;
    case 'narrate': return truncate(node.text, 60);
    case 'dialog':  return `<strong>${node.speaker}</strong>: ${truncate(node.text, 50)}`;
    case 'choice':  return (node.options||[]).map(o=>`[${o.text}→#${o.goto}]`).join(' ');
    case 'card':    return `<strong>${node.title}</strong>`;
    case 'hero':    return `<strong>${node.title}</strong>`;
    case 'gacha':   return truncate(node.question, 50);
    case 'ending':  return `<strong>${node.title}</strong>`;
    default:        return JSON.stringify(node).substring(0,60);
  }
}

function truncate(s, n) { return s && s.length > n ? s.substring(0,n)+'…' : (s||''); }

// 从所有故事线中收集所有节点（兼容旧 script 格式）
function getAllNodes() {
  if (gameData.storylines) {
    return Object.values(gameData.storylines).flatMap(l => l.nodes || []);
  }
  return gameData.script || [];
}

// ④ 场景背景图（异步生成）
async function renderScenes() {
  const allNodes = getAllNodes();
  const scenes = allNodes.filter(n => n.type === 'scene' && n.bgPrompt);
  const grid = document.getElementById('scenes-content');
  const bar = document.getElementById('scenes-bar');

  if (!scenes.length) {
    grid.innerHTML = '<p style="color:var(--text2);font-size:13px">无场景节点</p>';
    document.getElementById('scenes-progress').style.display = 'none';
    return;
  }

  const unique = [...new Map(scenes.map(n => [n.sceneKey, n])).values()];
  unique.forEach(node => {
    const card = document.createElement('div');
    card.className = 'scene-card';
    const key = node.sceneKey;
    card.innerHTML = `
      <div class="scene-placeholder" id="ph-${key}">等待生成</div>
      <div class="scene-info">
        <div class="scene-key">${key}</div>
        <textarea id="prompt-${key}" style="width:100%;background:#0f1117;color:#e8e8f0;border:1px solid #2a2d45;font-family:inherit;font-size:11px;padding:4px;resize:vertical;margin:4px 0;line-height:1.4">${node.bgPrompt}</textarea>
        <button onclick="regenBg('${key}')" style="width:100%;background:none;border:1px solid #f5a623;color:#f5a623;font-family:inherit;font-size:11px;padding:3px;cursor:pointer">重新生成</button>
        <div class="scene-status" id="st-${key}">等待生成</div>
      </div>`;
    grid.appendChild(card);
  });

  let done = 0;
  for (const node of unique) {
    await genBg(node.sceneKey);
    done++;
    bar.style.width = (done / unique.length * 100) + '%';
  }
}

async function genBg(key) {
  const st = document.getElementById('st-' + key);
  const ph = document.getElementById('ph-' + key);
  const promptEl = document.getElementById('prompt-' + key);
  const prompt = promptEl ? promptEl.value : key;

  // 已有缓存，直接显示
  const allNodes = Object.values(gameData.storylines || {}).flatMap(l => l.nodes || []);
  const cached = allNodes.find(n => n.type === 'scene' && n.sceneKey === key && n.bgCache);
  if (cached) {
    let img = document.getElementById('img-' + key);
    if (!img) { img = document.createElement('img'); img.id = 'img-' + key; ph?.replaceWith(img); }
    img.src = cached.bgCache;
    if (st) st.textContent = '✓ 已生成';
    return;
  }
  try {
    const res = await fetch('/api/gen-bg', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ prompt, sceneKey: key, style: localStorage.getItem('imageStyle') || 'pixel' })
    });
    const data = await res.json();
    if (data.b64) {
      let img = document.getElementById('img-' + key);
      if (!img) {
        img = document.createElement('img');
        img.id = 'img-' + key;
        if (ph) ph.replaceWith(img); else document.getElementById('ph-' + key)?.replaceWith(img);
      }
      img.src = data.b64;
      if (st) st.textContent = '✓ 已生成';
      // 图片存 sessionStorage，避免 localStorage 超限
      sessionStorage.setItem('scene_' + key, data.b64);
      // gameData 只记录已生成标记
      const allNodes = Object.values(gameData.storylines || {}).flatMap(l => l.nodes || []);
      allNodes.filter(n => n.type === 'scene' && n.sceneKey === key).forEach(n => n.bgReady = true);
      saveGameDataSafe();
    } else {
      if (st) st.textContent = '生成失败';
    }
  } catch(e) {
    if (st) st.textContent = '生成失败: ' + e.message;
  }
}

async function regenBg(key) {
  const btn = event.target;
  btn.disabled = true;
  await genBg(key);
  btn.disabled = false;
}

// ⑤ 抽卡池
function renderGacha() {
  const gachas = getAllNodes().filter(n => n.type === 'gacha');
  const el = document.getElementById('gacha-content');
  if (!gachas.length) { el.innerHTML = '<p style="color:var(--text2);font-size:13px">无抽卡节点</p>'; return; }

  gachas.forEach((node, gi) => {
    const sec = document.createElement('div');
    sec.className = 'gacha-section';
    sec.innerHTML = `<div class="gacha-q">抽卡 ${gi+1}：${node.question || ''}</div>`;
    const pool = document.createElement('div');
    pool.className = 'gacha-pool';
    (node.pool || []).forEach(p => {
      const item = document.createElement('div');
      const cls = RARITY_CLASS[p.rarity] || 'g-normal';
      item.className = `gacha-item ${cls}`;
      item.innerHTML = `<div class="g-rarity">${RARITY_LABEL[p.rarity]||p.rarity}</div>
        <div>${truncate(p.text, 40)}</div>
        <div class="g-weight">权重 ${p.weight}%</div>`;
      pool.appendChild(item);
    });
    sec.appendChild(pool);
    el.appendChild(sec);
  });
}

// ⑥ 档案卡
function renderCards() {
  const cards = getAllNodes().filter(n => n.type === 'card');
  const el = document.getElementById('cards-content');
  if (!cards.length) { el.innerHTML = '<p style="color:var(--text2);font-size:13px">无档案卡节点</p>'; return; }

  cards.forEach(node => {
    const card = document.createElement('div');
    card.className = 'card-preview';
    card.innerHTML = `<h3>${node.title || '档案'}</h3>
      <p>${node.text || ''}</p>
      ${node.teaser ? `<div class="card-teaser">▶ ${node.teaser}</div>` : ''}`;
    el.appendChild(card);
  });
}

// ⑦ 结局列表
function renderEndings() {
  const endings = getAllNodes().filter(n => n.type === 'ending');
  const el = document.getElementById('endings-content');
  if (!endings.length) { el.innerHTML = '<p style="color:var(--text2);font-size:13px">无结局节点</p>'; return; }

  endings.forEach((node, i) => {
    const item = document.createElement('div');
    item.className = 'ending-item';
    item.innerHTML = `<h3>结局 ${i+1}：${node.title || ''}</h3>
      <p>${node.text || ''}</p>`;
    el.appendChild(item);
  });
}

init();
