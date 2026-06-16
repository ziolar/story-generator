// load .env if present
const fs = require('fs');
const { jsonrepair } = require('jsonrepair');
const envPath = require('path').join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const [k, ...v] = line.split('=');
    if (k && v.length && !process.env[k.trim()]) process.env[k.trim()] = v.join('=').trim();
  });
}

const express = require('express');
const cheerio = require('cheerio');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3001;
const API_KEY = process.env.DEEPSEEK_API_KEY || '';
const IMAGE_API_KEY = process.env.IMAGE_API_KEY || '';

// === PostgreSQL game store ===
// Falls back to in-memory if DATABASE_URL is not set (local dev)
let db = null;
let gameStore = {}; // in-memory fallback

if (process.env.DATABASE_URL) {
  db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  // Init table on startup
  db.query(`
    CREATE TABLE IF NOT EXISTS games (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      saved_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).then(() => {
    console.log('[db] games table ready');
  }).catch(e => {
    console.error('[db] init error:', e.message);
  });
  db.query(`
    CREATE TABLE IF NOT EXISTS game_images (
      game_id TEXT NOT NULL,
      key TEXT NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY (game_id, key)
    )
  `).then(() => {
    console.log('[db] game_images table ready');
  }).catch(e => {
    console.error('[db] game_images init error:', e.message);
  });
} else {
  console.log('[db] DATABASE_URL not set — using in-memory store');
  // Load from local file as fallback
  const STORE_FILE = path.join(__dirname, 'games.json');
  try { gameStore = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')); } catch {}
}

async function dbSave(id, data) {
  if (db) {
    await db.query(
      `INSERT INTO games (id, data, saved_at) VALUES ($1, $2, NOW())
       ON CONFLICT (id) DO UPDATE SET data = $2, saved_at = NOW()`,
      [id, data]
    );
  } else {
    gameStore[id] = { data, savedAt: Date.now() };
    try { fs.writeFileSync(path.join(__dirname, 'games.json'), JSON.stringify(gameStore)); } catch {}
  }
}

async function dbLoad(id) {
  if (db) {
    const r = await db.query('SELECT data, saved_at FROM games WHERE id = $1', [id]);
    if (!r.rows.length) return null;
    return { data: r.rows[0].data, savedAt: new Date(r.rows[0].saved_at).getTime() };
  }
  return gameStore[id] || null;
}

async function dbSaveImage(gameId, key, data) {
  if (!db) return;
  await db.query(
    `INSERT INTO game_images (game_id, key, data) VALUES ($1, $2, $3)
     ON CONFLICT (game_id, key) DO UPDATE SET data = $3`,
    [gameId, key, data]
  );
}

async function dbLoadImages(gameId) {
  if (!db) return {};
  const r = await db.query('SELECT key, data FROM game_images WHERE game_id = $1', [gameId]);
  const result = {};
  r.rows.forEach(row => { result[row.key] = row.data; });
  return result;
}

async function dbDelete(id) {
  if (db) {
    const r = await db.query('DELETE FROM games WHERE id = $1 RETURNING id', [id]);
    return r.rowCount > 0;
  }
  if (!gameStore[id]) return false;
  delete gameStore[id];
  try { fs.writeFileSync(path.join(__dirname, 'games.json'), JSON.stringify(gameStore)); } catch {}
  return true;
}

async function dbList() {
  if (db) {
    const r = await db.query(
      `SELECT id, data, saved_at FROM games ORDER BY saved_at DESC LIMIT 100`
    );
    return r.rows.map(row => ({
      id: row.id,
      title: row.data?.title || '未命名故事',
      savedAt: new Date(row.saved_at).getTime(),
      characterCount: (row.data?.characters || []).length,
      storylineCount: Object.keys(row.data?.storylines || {}).length,
    }));
  }
  return Object.entries(gameStore)
    .map(([id, entry]) => ({
      id,
      title: entry.data?.title || '未命名故事',
      savedAt: entry.savedAt || 0,
      characterCount: (entry.data?.characters || []).length,
      storylineCount: Object.keys(entry.data?.storylines || {}).length,
    }))
    .sort((a, b) => b.savedAt - a.savedAt)
    .slice(0, 100);
}
const IMAGE_API = 'https://ark.cn-beijing.volces.com/api/v3/images/generations';
const IMAGE_MODEL = 'doubao-seedream-5-0-260128';

const { pinyin } = require('pinyin-pro');

function titleToSlug(title) {
  const hasChinese = /[\u4e00-\u9fff]/.test(title);
  if (!hasChinese) {
    return title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16) || 'story';
  }
  const initials = pinyin(title, { pattern: 'initial', toneType: 'none', separator: '' });
  const full = pinyin(title, { toneType: 'none', separator: '' });
  const base = initials.replace(/[^a-z]/gi, '').length >= 3 ? initials : full;
  return base.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16) || 'story';
}

const STYLE_PRESETS = {
  pixel:     'Pixel art retro game style, 16-bit pixel art, muted palette, cinematic composition, dramatic mood, image-rendering pixelated. ',
  anime:     'Japanese anime style illustration, vibrant colors, clean linework, cel shading, visual novel art style, detailed. ',
  ink:       'Chinese ink wash painting style, sumi-e, monochromatic with subtle color washes, elegant brushstrokes, traditional Chinese art aesthetic. ',
  realistic: 'Photorealistic cinematic style, dramatic lighting, high detail, film photography aesthetic, moody atmosphere. ',
  oil:       'Oil painting style, impressionist brushstrokes, rich textures, painterly aesthetic, dramatic chiaroscuro lighting. ',
};
const BG_COMPOSITION = 'vertical portrait orientation 9:16 ratio, full composition filling the entire frame, cinematic scene. ';

const OUTLINE_PROMPT = `你是一个视觉小说编剧。根据用户提供的文本，生成详细的故事大纲和人物档案。

输出严格的 JSON，格式如下：
{
  "title": "故事标题",
  "chapters": [
    {
      "id": 1,
      "title": "第一章：章节名",
      "summary": "章节摘要（50字以内）",
      "plotPoints": ["情节点1", "情节点2", "情节点3", "情节点4", "情节点5", "情节点6", "情节点7"]
    }
  ],
  "characters": [
    {
      "id": "c1",
      "name": "姓名",
      "gender": "性别",
      "era": "年代/时代背景",
      "personality": "性格特点（3-5个关键词）",
      "appearance": "外貌描述（中文，50字以内）",
      "background": "人物小传（100字以内，包含出身、经历、动机）",
      "portraitPrompt": "立绘提示词（中文，描述角色外貌、风格、表情、服装，用于AI绘图）"
    }
  ]
}

规则：
1. 至少生成10章，每章必须有7-8个情节点
2. 每个情节点是一个具体的剧情动作、对话要点或情感转折
3. 从原文提取所有主要人物，不超过5个
4. portraitPrompt 用中文撰写，描述具体外貌细节，便于 AI 生成立绘
5. 只输出纯 JSON，不要 markdown 代码块，不要任何其他文字
6. 所有字符串值中不得使用中文引号""，只用英文双引号`;

const SYSTEM_PROMPT = `你是一个视觉小说游戏生成器。将用户提供的文本转化为视觉小说脚本。

【核心概念】
- 故事线（Storyline）：从故事结构出发，相当于一个设定下的多个平行宇宙故事。每条故事线有独立的名称、描述和节点序列。
- 逻辑分支（Branch）：从游戏引擎出发，标注每个对话选择后进入的故事线和后续逻辑分支。
- 从第一个选择性对话开始，每个选项都会单独拉出一条后续的故事线。故事线可以在后期汇合，但故事线本身是平行的，不能混在一起。

输出严格的 JSON，格式如下：
{
  "title": "故事标题",
  "characters": [
    {"id": "c1", "name": "角色名", "color": "#十六进制颜色", "description": "角色外貌描述（英文，用于生成立绘）"}
  ],
  "storylines": {
    "main": {
      "name": "主线",
      "description": "故事开端，所有玩家共享的部分",
      "nodes": [节点数组]
    },
    "storyline_id_a": {
      "name": "故事线A的名称",
      "description": "这条故事线的简要描述",
      "nodes": [节点数组]
    },
    "storyline_id_b": {
      "name": "故事线B的名称",
      "description": "这条故事线的简要描述",
      "nodes": [节点数组]
    }
  }
}

节点类型（每条故事线的 nodes 数组中的元素）：

{ "type": "scene", "sceneKey": "唯一场景标识(英文)", "bgPrompt": "英文场景描述，用于生成背景图", "chapter": "第X章：章节名" }
{ "type": "narrate", "text": "旁白文字，支持**加粗**标记" }
{ "type": "dialog", "speaker": "c1", "text": "对话内容" }
{ "type": "panel", "src": "", "pos": "br", "caption": "图注文字" }
{ "type": "choice", "question": "选择提示（可省略）", "options": [
  {"text": "选项文字", "gotoStoryline": "目标故事线ID", "gotoNode": 目标节点索引数字},
  {"text": "选项文字", "gotoNode": 当前故事线内的节点索引数字}
] }
{ "type": "card", "title": "档案标题", "text": "档案内容", "teaser": "下一章预告" }
{ "type": "hero", "title": "英雄时刻标题", "subtitle": "副标题" }
{ "type": "gacha", "question": "抽卡提示", "pool": [{"weight": 20, "rarity": "good", "text": "结果文字"}, {"weight": 50, "rarity": "normal", "text": "..."}, {"weight": 25, "rarity": "bad", "text": "..."}, {"weight": 5, "rarity": "hidden", "text": "..."}] }
{ "type": "ending", "title": "结局标题", "text": "结局描述" }

【choice 节点跳转规则】
- 跨故事线跳转：同时提供 "gotoStoryline"（目标故事线ID）和 "gotoNode"（目标线内的节点索引，通常为0）
- 线内跳转：只提供 "gotoNode"（当前故事线内的节点索引）
- 不提供任何跳转字段 = 选完后继续当前故事线的下一个节点

规则：
1. 必须有一条 "main" 主线，包含所有玩家共享的开头（5-8个节点）
2. 主线末尾必须有一个 choice 节点，每个选项通过 gotoStoryline 跳转到不同的故事线
3. 生成 2 条独立故事线（不含主线），每条有独立的名称和描述
4. 每条故事线是一个完整的平行故事，有自己的场景、对话、发展和结局
5. 故事线内部也可以有 choice 节点，实现线内分支或跳转到其他故事线（汇合）
6. 每条故事线最终必须有一个 ending 节点
7. 每条故事线的 nodes 索引从 0 开始独立编号
8. 每章开头必须有 scene 节点切换背景
9. bgPrompt 用英文描述场景氛围，如 "rainy night city street, neon lights reflecting on wet pavement"
10. 每章末尾放一个 card 档案卡节点，title 是档案名，teaser 是下一章预告
11. 关键情节转折处放 hero 节点
12. 至少一个 gacha 节点，pool 权重之和为100
13. dialog 的 speaker 用 characters 中的 id，旁白用 "narrator"
14. 对话风格自然，符合角色性格，每段文字不超过30字
15. characters 的 description 字段用英文描述角色外貌，如 "young woman, short black hair, blue eyes, casual clothes"
16. storylines 的 key 用英文蛇形命名（如 chen_xia_line），name 用中文
17. 只输出纯 JSON，不要 markdown 代码块，不要任何其他文字
18. 每条故事线节点数不超过10个，主线不超过8个节点
19. characters 最多3个
19. 所有字符串值中不得使用中文引号""，只用英文双引号`;

// ===== Storylines-from-outline prompt (大规模，按大纲生成) =====
const STORYLINES_FROM_OUTLINE_PROMPT = `你是一个视觉小说游戏生成器。根据用户提供的【完整故事大纲】生成视觉小说脚本。

【核心结构】
- storylines.main（主线）：覆盖大纲所有章节，每章2-4个节点（dialog/narrate）；在第3章末、中间章末、最后章末各插入一个 choice 节点，共3个分支点
- 生成3条分支故事线（不是每章一条，而是整体3条）：
  - branch_a：第一个分支点选择A后的走向（8-12节点，有完整结局）
  - branch_b：第二个分支点选择A后的走向（8-12节点，有完整结局）
  - branch_c：最终章分支点选择A后的走向（6-10节点，有完整结局）
- 主线每条choice节点的选择B继续主线（gotoNode指向主线下一节点），选择A跳转到对应分支线
- 主线末尾必须有 ending 节点

【规模控制】
- 主线节点总数：每章2-4节点，10章约25-40节点
- 每条分支故事线：8-12节点
- 总节点数控制在100个以内

【JSON格式】
{
  "title": "故事标题",
  "characters": [
    {"id": "c1", "name": "角色名", "color": "#十六进制颜色", "description": "角色外貌描述（英文）"}
  ],
  "storylines": {
    "main": { "name": "主线", "description": "...", "nodes": [...] },
    "branch_a": { "name": "分支：命运A", "description": "...", "nodes": [...] },
    "branch_b": { "name": "分支：命运B", "description": "...", "nodes": [...] },
    "branch_c": { "name": "分支：终章抉择", "description": "...", "nodes": [...] }
  }
}

节点类型：
{ "type": "scene", "sceneKey": "唯一场景标识(英文)", "bgPrompt": "英文场景描述", "chapter": "第X章：章节名" }
{ "type": "narrate", "text": "旁白文字，支持**加粗**标记" }
{ "type": "dialog", "speaker": "c1", "text": "对话内容" }
{ "type": "choice", "question": "选择提示", "options": [
  {"text": "选项文字", "gotoStoryline": "branch_a", "gotoNode": 0},
  {"text": "选项文字", "gotoNode": 下一个主线节点的索引}
] }
{ "type": "card", "title": "档案标题", "text": "档案内容", "teaser": "下一章预告" }
{ "type": "hero", "title": "英雄时刻标题", "subtitle": "副标题" }
{ "type": "gacha", "question": "抽卡提示", "pool": [{"weight": 20, "rarity": "good", "text": "..."}, {"weight": 50, "rarity": "normal", "text": "..."}, {"weight": 25, "rarity": "bad", "text": "..."}, {"weight": 5, "rarity": "hidden", "text": "..."}] }
{ "type": "ending", "title": "结局标题", "text": "结局描述" }

规则：
1. 主线覆盖大纲所有章节，每章开头有 scene 节点，每章2-4个dialog/narrate节点，关键转折用 hero
2. 主线中间穿插3个 choice 节点，每个choice有两个选项：一个跳转分支线，一个继续主线（gotoNode=主线下一节点索引）
3. 分支故事线有自己的 scene、dialog、narrate 节点，最终有 ending 节点
4. characters 的 description 字段用英文外貌描述
5. storylines 的 key 用英文蛇形命名，name 用中文
6. 只输出纯 JSON，不要 markdown 代码块
7. 所有字符串值中不得使用中文引号""，只用英文双引号
8. dialog 每段文字不超过40字
9. 总节点数控制在100个以内，不要过度展开`;

app.post('/api/gen-outline', async (req, res) => {
  const { text, title, characters } = req.body;
  if (!text) return res.status(400).json({ error: '请提供文本内容' });
  if (!API_KEY) return res.status(500).json({ error: '未配置 DEEPSEEK_API_KEY 环境变量' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  const sendError = (msg) => { res.write('\nERROR:' + msg); res.end(); };

  let userHints = '';
  if (title) userHints += `\n故事标题请使用：「${title}」`;
  if (characters && characters.length) {
    const charList = characters.map(c => `- ${c.name}${c.description ? '：' + c.description : ''}`).join('\n');
    userHints += `\n以下是用户指定的主要角色，请优先在人物档案中体现：\n${charList}`;
  }

  let lastBadJson = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const heartbeat = setInterval(() => res.write('.'), 5000);
    try {
      const messages = attempt === 0
        ? [
            { role: 'system', content: OUTLINE_PROMPT },
            { role: 'user', content: `请根据以下内容生成故事大纲和人物档案：\n\n${text.substring(0, 6000)}${userHints}` }
          ]
        : [
            { role: 'user', content: `以下JSON格式有误，请修复并只输出合法JSON：\n\n${lastBadJson.substring(0, 8000)}` }
          ];
      const content = await callDeepSeek(messages, () => {});
      clearInterval(heartbeat);
      lastBadJson = content;
      const cleaned = content.replace(/```json\n?/gi, '').replace(/```\n?/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
      const m = cleaned.match(/\{[\s\S]*\}/);
      if (!m) throw new Error('无 JSON 块');
      let data;
      try { data = JSON.parse(m[0]); } catch { data = JSON.parse(require('jsonrepair').jsonrepair(m[0])); }
      if (!data.chapters?.length) throw new Error('缺少 chapters 数据');
      res.write('\nDATA:' + JSON.stringify(data));
      return res.end();
    } catch (e) {
      clearInterval(heartbeat);
      console.error(`[gen-outline attempt ${attempt + 1} failed]`, e.message);
      if (attempt === 2) return sendError('大纲生成失败，请重试');
      res.write('\n[fixing...]');
    }
  }
});

app.post('/api/gen-storylines', async (req, res) => {
  const { outline, characters } = req.body;
  if (!outline || !outline.chapters) return res.status(400).json({ error: '请提供大纲数据' });
  if (!API_KEY) return res.status(500).json({ error: '未配置 DEEPSEEK_API_KEY 环境变量' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  const sendError = (msg) => { res.write('\nERROR:' + msg); res.end(); };

  // Format outline as natural language for the AI
  const chapterLines = (outline.chapters || []).map(ch => {
    const pts = (ch.plotPoints || []).map((p, i) => `  ${i + 1}. ${p}`).join('\n');
    return `【${ch.title}】\n概述：${ch.summary || ''}\n${pts}`;
  }).join('\n\n');

  const charHints = (characters || []).map(c =>
    `- ${c.name}（${c.gender || ''}，${c.era || ''}）：${c.personality || ''}`
  ).join('\n');

  // Build English description hint for portrait generation
  const charDescHints = (characters || []).map(c =>
    `- ${c.name} (id: ${c.id || c.name}): ${c.appearance || c.background || ''}`
  ).join('\n');

  const userMsg = `请根据以下故事大纲生成视觉小说游戏脚本。

【故事标题】
${outline.title || ''}

【故事大纲（共${(outline.chapters || []).length}章）】
${chapterLines}

【主要人物】
${charHints}

【人物外貌参考（用于生成 characters[].description 英文描述）】
${charDescHints}

要求：
- 主线覆盖所有章节，每章2-4个节点，控制总节点数在100以内
- 主线中穿插3个 choice 节点（在第3章、中间章、最后章末尾），跳转到 branch_a / branch_b / branch_c
- 生成3条分支故事线（branch_a / branch_b / branch_c），每条8-12节点，有 ending
- characters 字段每个角色的 description 用英文外貌描述，参考上方人物外貌参考`;

  let lastBadJson = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const heartbeat = setInterval(() => res.write('.'), 5000);
    try {
      const messages = attempt === 0
        ? [
            { role: 'system', content: STORYLINES_FROM_OUTLINE_PROMPT },
            { role: 'user', content: userMsg }
          ]
        : [
            { role: 'user', content: `以下JSON格式有误，请修复并只输出合法JSON：\n\n${lastBadJson.substring(0, 12000)}` }
          ];
      const content = await callDeepSeek(messages, () => {}, 32000, 'deepseek-v4-flash');
      clearInterval(heartbeat);
      lastBadJson = content;
      const gameData = parseGameData(content);
      res.write('\nDATA:' + JSON.stringify(gameData));
      return res.end();
    } catch (e) {
      clearInterval(heartbeat);
      console.error(`[gen-storylines attempt ${attempt + 1} failed]`, e.message);
      if (attempt === 2) return sendError('故事线生成失败，请重试');
      res.write('\n[fixing...]');
    }
  }
});

app.post('/api/fetch-url', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: '请提供 URL' });
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; StoryBot/1.0)' }
    });
    const html = await resp.text();
    const $ = cheerio.load(html);
    $('script,style,nav,header,footer,aside,.ad,.sidebar').remove();
    const title = $('title').text().trim();
    const body = $('article').text().trim() || $('main').text().trim() || $('body').text().trim();
    const text = body.replace(/\s+/g, ' ').substring(0, 8000);
    res.json({ title, text });
  } catch (e) {
    res.status(500).json({ error: '无法获取该链接内容: ' + e.message });
  }
});

async function callDeepSeek(messages, onChunk, maxTokens = 8000, model = 'deepseek-v4-pro') {
  const resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
    body: JSON.stringify({ model, max_tokens: maxTokens, response_format: { type: 'json_object' }, messages })
  });
  if (!resp.ok) throw new Error('AI 接口错误: ' + await resp.text());
  const data = await resp.json();
  onChunk();
  return data.choices[0].message.content || '';
}

function parseGameData(content) {
  const cleaned = content
    .replace(/```json\n?/gi, '').replace(/```\n?/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('无 JSON 块');

  let data;
  try {
    data = JSON.parse(m[0]);
  } catch {
    // Fix: "...value""nextKey" → "...value"},{"nextKey"
    const preFixed = m[0].replace(/"("(?:type|speaker|text|title|sceneKey|bgPrompt|chapter|question|gotoStoryline|id|name|color|description)":)/g, '"},{ $1');
    try {
      data = JSON.parse(jsonrepair(preFixed));
    } catch (e2) {
      const pos = parseInt(e2.message.match(/position (\d+)/)?.[1] || '0');
      console.error('[parse error]', e2.message);
      console.error('[context]', m[0].substring(Math.max(0, pos - 80), pos + 80));
      throw e2;
    }
  }

  if (data.script && !data.storylines) {
    data.storylines = { main: { name: '主线', description: '完整故事', nodes: data.script } };
    delete data.script;
  }
  if (!data.storylines?.main?.nodes?.length) throw new Error('缺少主线数据');
  return data;
}

app.post('/api/generate', async (req, res) => {
  const { text, title, characters } = req.body;
  if (!text) return res.status(400).json({ error: '请提供文本内容' });
  if (!API_KEY) return res.status(500).json({ error: '未配置 DEEPSEEK_API_KEY 环境变量' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  const sendError = (msg) => { res.write('\nERROR:' + msg); res.end(); };

  // Build optional hints for title and characters
  let userHints = '';
  if (title) userHints += `\n故事标题请使用：「${title}」`;
  if (characters && characters.length) {
    const charList = characters.map(c => `- ${c.name}${c.description ? '：' + c.description : ''}`).join('\n');
    userHints += `\n主要角色（请在 characters 中优先使用这些角色，description 字段用英文外貌描述）：\n${charList}`;
  }

  let lastBadJson = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    // Heartbeat to prevent Render 30s timeout
    const heartbeat = setInterval(() => res.write('.'), 5000);
    try {
      const messages = attempt === 0
        ? [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: `请根据以下内容生成视觉小说游戏：\n\n${text.substring(0, 6000)}${userHints}` }
          ]
        : [
            { role: 'user', content: `以下JSON格式有误，请修复并只输出合法JSON，不要任何其他文字：\n\n${lastBadJson.substring(0, 8000)}` }
          ];
      const content = await callDeepSeek(messages, () => {});
      clearInterval(heartbeat);
      lastBadJson = content;
      const gameData = parseGameData(content);
      res.write('\nDATA:' + JSON.stringify(gameData));
      return res.end();
    } catch (e) {
      clearInterval(heartbeat);
      console.error(`[attempt ${attempt + 1} failed]`, e.message);
      if (attempt === 2) return sendError('生成失败，请重试');
      res.write('\n[fixing...]');
    }
  }
});

app.post('/api/gen-bg', async (req, res) => {
  const { prompt, style } = req.body;
  if (!prompt) return res.status(400).json({ error: '请提供 prompt' });
  if (!IMAGE_API_KEY) return res.status(500).json({ error: '未配置 IMAGE_API_KEY 环境变量' });

  const stylePrefix = STYLE_PRESETS[style] || STYLE_PRESETS.pixel;
  const fullPrompt = stylePrefix + BG_COMPOSITION + prompt;

  for (let i = 0; i < 3; i++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 300000);
      const resp = await fetch(IMAGE_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${IMAGE_API_KEY}` },
        body: JSON.stringify({ model: IMAGE_MODEL, prompt: fullPrompt, size: '1440x2560', response_format: 'url', sequential_image_generation: 'disabled', stream: false, watermark: false }),
        signal: controller.signal
      });
      clearTimeout(timer);

      if (!resp.ok) {
        const err = await resp.text();
        if (i === 2) return res.status(resp.status).json({ error: '图片生成失败: ' + err });
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }

      const data = await resp.json();
      const item = data.data[0];
      if (item.b64_json) {
        return res.json({ b64: 'data:image/png;base64,' + item.b64_json });
      }
      // url 格式：下载后转 base64
      const imgResp = await fetch(item.url);
      const buf = await imgResp.arrayBuffer();
      const b64 = Buffer.from(buf).toString('base64');
      return res.json({ b64: 'data:image/png;base64,' + b64 });
    } catch (e) {
      if (i === 2) return res.status(500).json({ error: '图片生成失败: ' + e.message });
      await new Promise(r => setTimeout(r, 5000));
    }
  }
});

app.post('/api/gen-portrait', async (req, res) => {
  const { name, id, customPrompt, style } = req.body;
  if (!name) return res.status(400).json({ error: '请提供角色名' });
  if (!IMAGE_API_KEY) return res.status(500).json({ error: '未配置 IMAGE_API_KEY' });

  const stylePrefix = STYLE_PRESETS[style] || STYLE_PRESETS.pixel;
  const prompt = stylePrefix + (customPrompt || `character portrait, upper body, facing slightly left, ${name}, solo character, plain dark background, centered composition`);

  for (let i = 0; i < 3; i++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 300000);
      const resp = await fetch(IMAGE_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${IMAGE_API_KEY}` },
        body: JSON.stringify({ model: IMAGE_MODEL, prompt, size: '1920x1920', response_format: 'url', sequential_image_generation: 'disabled', stream: false, watermark: false }),
        signal: controller.signal
      });
      clearTimeout(timer);
      if (!resp.ok) {
        const err = await resp.text();
        if (i === 2) return res.status(resp.status).json({ error: '立绘生成失败: ' + err });
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }
      const data = await resp.json();
      const item = data.data[0];
      if (item.b64_json) return res.json({ b64: 'data:image/png;base64,' + item.b64_json });
      const imgResp = await fetch(item.url);
      const buf = await imgResp.arrayBuffer();
      return res.json({ b64: 'data:image/png;base64,' + Buffer.from(buf).toString('base64') });
    } catch (e) {
      if (i === 2) return res.status(500).json({ error: '立绘生成失败: ' + e.message });
      await new Promise(r => setTimeout(r, 3000));
    }
  }
});

// === Douban import relay ===
const importStore = {}; // token → { text, savedAt }

// Allow cross-origin POST from Douban Reading (bookmarklet runs on read.douban.com)
app.options('/api/import', (req, res) => {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST',
    'Access-Control-Allow-Headers': 'Content-Type',
  }).sendStatus(204);
});

app.post('/api/import', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const { text } = req.body;
  if (!text || typeof text !== 'string') return res.status(400).json({ error: '无内容' });
  const token = crypto.randomBytes(4).toString('hex');
  importStore[token] = { text: text.substring(0, 12000), savedAt: Date.now() };
  // Clean up tokens older than 10 minutes
  const cutoff = Date.now() - 10 * 60 * 1000;
  Object.keys(importStore).forEach(k => { if (importStore[k].savedAt < cutoff) delete importStore[k]; });
  res.json({ token });
});

app.get('/api/import/:token', (req, res) => {
  const entry = importStore[req.params.token];
  if (!entry) return res.status(404).json({ error: '已过期或不存在' });
  delete importStore[req.params.token]; // one-time use
  res.json({ text: entry.text });
});

// === Games list ===
app.get('/api/games', async (req, res) => {
  try {
    const list = await dbList();
    res.json(list);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/games/:id', async (req, res) => {
  try {
    const found = await dbDelete(req.params.id);
    if (!found) return res.status(404).json({ error: '不存在' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// === Image store: save one image for a game ===
app.post('/api/save-image/:id', async (req, res) => {
  const { key, data } = req.body;
  if (!key || !data) return res.status(400).json({ error: '缺少 key 或 data' });
  try {
    await dbSaveImage(req.params.id, key, data);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// === Image store: load all images for a game ===
app.get('/api/load-images/:id', async (req, res) => {
  try {
    const imgs = await dbLoadImages(req.params.id);
    res.json(imgs);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// === Preview page for /preview/:id ===
app.get('/preview/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'preview.html'));
});

// === Games list page ===
app.get('/games', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'games.html'));
});

// === Share: save game data ===
app.post('/api/save', async (req, res) => {
  const data = req.body;
  if (!data || !data.storylines) return res.status(400).json({ error: '无效的游戏数据' });
  const slug = titleToSlug(data.title || 'story');
  const suffix = crypto.randomBytes(2).toString('hex');
  const id = slug + '-' + suffix;
  try {
    await dbSave(id, data);
    res.json({ id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// === Share: load game data ===
app.get('/api/load/:id', async (req, res) => {
  try {
    const entry = await dbLoad(req.params.id);
    if (!entry) return res.status(404).json({ error: '游戏不存在或已过期' });
    res.json(entry.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// === Share: serve game page for /play/:id ===
app.get('/play/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// === Outline editor page ===
app.get('/outline', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'outline.html'));
});

app.get('/outline.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'outline.html'));
});

app.listen(PORT, () => {
  console.log(`Story Generator running at http://localhost:${PORT}`);
  if (!API_KEY) console.warn('Warning: DEEPSEEK_API_KEY not set');
  if (!IMAGE_API_KEY) console.warn('Warning: IMAGE_API_KEY not set');
});
