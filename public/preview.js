const TYPE_COLOR = {
  scene:'#60a5fa', narrate:'#a78bfa', dialog:'#34d399', choice:'#f59e0b',
  card:'#f472b6', hero:'#fb923c', gacha:'#c084fc', ending:'#f87171', panel:'#94a3b8'
};

const RARITY_CLASS = { good:'g-good', normal:'g-normal', bad:'g-bad', hidden:'g-hidden' };
const RARITY_LABEL = { good:'好结局', normal:'普通', bad:'坏结局', hidden:'隐藏' };

let gameData = null;

function goPlay() {
  localStorage.setItem('gameAutoStart', '1');
  window.location.href = '/';
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
      body: JSON.stringify({ name: name || id, id, customPrompt: promptEl?.value })
    });
    const data = await res.json();
    if (data.b64) {
      let img = document.getElementById('pimg-' + id);
      if (!img) { img = document.createElement('img'); img.id = 'pimg-' + id; ph?.replaceWith(img); }
      img.src = data.b64;
      if (st) st.textContent = '✓ 已生成';
      // 存回 gameData，游戏启动时直接复用
      const char = (gameData.characters || []).find(c => c.id === id);
      if (char) {
        char.portrait = data.b64;
        localStorage.setItem('gamePreview', JSON.stringify(gameData));
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

// ③ 逻辑分支图（简洁版：只显示标题、choice、ending）
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

  const lineColors = ['#60a5fa','#34d399','#f59e0b','#f472b6','#c084fc','#fb923c'];
  const COL_W = 240, PAD_X = 20, PAD_Y = 20, NODE_W = 200, NODE_H = 28, HEADER_H = 48, ROW_H = 56;

  // 只保留 choice 和 ending 节点，记录原始索引
  const keyNodes = {}; // keyNodes[lineId] = [{origIdx, node}]
  ids.forEach(id => {
    keyNodes[id] = (lines[id].nodes || [])
      .map((node, i) => ({ origIdx: i, node }))
      .filter(({ node }) => node.type === 'choice' || node.type === 'ending');
  });

  // 计算位置：pos[lineId][origIdx] = {cx, cy}
  const pos = {};
  ids.forEach((id, ci) => {
    pos[id] = {};
    const cx = PAD_X + ci * COL_W + NODE_W / 2;
    keyNodes[id].forEach(({ origIdx }, ri) => {
      pos[id][origIdx] = { cx, cy: PAD_Y + HEADER_H + ri * ROW_H + NODE_H / 2 };
    });
  });

  const maxRows = Math.max(...ids.map(id => keyNodes[id].length));
  const totalH = PAD_Y * 2 + HEADER_H + Math.max(maxRows, 1) * ROW_H + 20;
  const totalW = ids.length * COL_W + PAD_X * 2;

  let svg = `<svg viewBox="0 0 ${totalW} ${totalH}" xmlns="http://www.w3.org/2000/svg" style="font-family:monospace;width:100%;overflow:visible">`;
  svg += `<defs>
    <marker id="arr" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 Z" fill="${TYPE_COLOR.choice}"/></marker>
    <marker id="arr-end" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 Z" fill="#888"/></marker>
  </defs>`;

  // 故事线标题列头
  ids.forEach((id, ci) => {
    const color = lineColors[ci % lineColors.length];
    const x = PAD_X + ci * COL_W;
    svg += `<rect x="${x}" y="${PAD_Y}" width="${NODE_W}" height="${HEADER_H - 8}" rx="4" fill="#1a1d2e" stroke="${color}" stroke-width="2"/>`;
    svg += `<text x="${x + NODE_W/2}" y="${PAD_Y + 20}" font-size="12" fill="${color}" font-weight="bold" text-anchor="middle">${escapeXml(lines[id].name || id)}</text>`;
    // 泳道竖线
    svg += `<line x1="${x + NODE_W/2}" y1="${PAD_Y + HEADER_H}" x2="${x + NODE_W/2}" y2="${totalH - PAD_Y}" stroke="${color}" stroke-width="0.5" stroke-dasharray="3,5" opacity="0.25"/>`;
  });

  // 线内顺序连接线（choice → 下一个 key 节点）
  ids.forEach(id => {
    const kn = keyNodes[id];
    for (let i = 0; i < kn.length - 1; i++) {
      const a = pos[id][kn[i].origIdx];
      const b = pos[id][kn[i+1].origIdx];
      if (!a || !b) continue;
      svg += `<line x1="${a.cx}" y1="${a.cy + NODE_H/2}" x2="${b.cx}" y2="${b.cy - NODE_H/2}" stroke="#2a2d45" stroke-width="1.5"/>`;
    }
  });

  // 节点
  ids.forEach((id, ci) => {
    const color = lineColors[ci % lineColors.length];
    keyNodes[id].forEach(({ origIdx, node }) => {
      const { cx, cy } = pos[id][origIdx];
      const isEnding = node.type === 'ending';
      const nodeColor = isEnding ? '#888' : TYPE_COLOR.choice;
      const x = cx - NODE_W / 2;
      const y = cy - NODE_H / 2;
      svg += `<rect x="${x}" y="${y}" width="${NODE_W}" height="${NODE_H}" rx="4" fill="#1a1d2e" stroke="${nodeColor}" stroke-width="1.5"/>`;
      if (isEnding) {
        svg += `<text x="${cx}" y="${cy + 5}" font-size="10" fill="${nodeColor}" text-anchor="middle">⬛ ${escapeXml(truncate(node.title || '结局', 20))}</text>`;
      } else {
        const opts = (node.options || []).map(o => o.text ? truncate(o.text, 8) : '?').join(' / ');
        svg += `<text x="${cx}" y="${cy + 5}" font-size="10" fill="${nodeColor}" text-anchor="middle">◆ ${escapeXml(truncate(opts, 26))}</text>`;
      }
    });
  });

  // choice 跨故事线跳转箭头
  ids.forEach(id => {
    keyNodes[id].forEach(({ origIdx, node }) => {
      if (node.type !== 'choice') return;
      const src = pos[id][origIdx];
      if (!src) return;
      (node.options || []).forEach(opt => {
        const targetLineId = opt.gotoStoryline;
        const targetNodeIdx = typeof opt.gotoNode === 'number' ? opt.gotoNode : null;
        if (!targetLineId || !pos[targetLineId]) return;

        // 找目标故事线中最近的 key 节点（>= targetNodeIdx）
        const targetKN = keyNodes[targetLineId];
        const match = targetKN.find(k => k.origIdx >= (targetNodeIdx ?? 0)) || targetKN[0];
        if (!match) return;
        const dst = pos[targetLineId][match.origIdx];
        if (!dst) return;

        const x0 = src.cx + NODE_W/2, y0 = src.cy;
        const x1 = dst.cx - NODE_W/2, y1 = dst.cy;
        const mx = (x0 + x1) / 2;
        svg += `<path d="M${x0},${y0} C${mx},${y0} ${mx},${y1} ${x1},${y1}" fill="none" stroke="${TYPE_COLOR.choice}" stroke-width="1.5" stroke-dasharray="6,3" marker-end="url(#arr)"/>`;
        svg += `<text x="${mx}" y="${Math.min(y0,y1) - 4}" font-size="9" fill="${TYPE_COLOR.choice}" text-anchor="middle">${escapeXml(truncate(opt.text, 12))}</text>`;
      });
    });
  });

  svg += '</svg>';
  document.getElementById('branch-content').innerHTML = svg;
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
      body: JSON.stringify({ prompt, sceneKey: key })
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
      // 存回 gameData 所有同 sceneKey 的 scene 节点，游戏启动时直接复用
      const allNodes = Object.values(gameData.storylines || {}).flatMap(l => l.nodes || []);
      allNodes.filter(n => n.type === 'scene' && n.sceneKey === key).forEach(n => n.bgCache = data.b64);
      localStorage.setItem('gamePreview', JSON.stringify(gameData));
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
