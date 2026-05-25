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

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3001;
const API_KEY = process.env.DEEPSEEK_API_KEY || '';
const IMAGE_API_KEY = process.env.IMAGE_API_KEY || '';
const IMAGE_API = 'https://ai.flashapi.top/v1/images/generations';

const PIXEL_STYLE = 'Pixel art retro game style, 16-bit pixel art, muted palette, cinematic composition, dramatic mood, image-rendering pixelated. COMPOSITION FOR MOBILE PHONE SCREEN: vertical portrait orientation 9:16 ratio, key visual elements positioned in UPPER 60% of frame, LOWER 40% must be empty/dark/negative space reserved for dialog box overlay. ';

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

async function callDeepSeek(messages, onChunk) {
  const resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
    body: JSON.stringify({ model: 'deepseek-v4-pro', max_tokens: 8000, response_format: { type: 'json_object' }, messages })
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
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: '请提供文本内容' });
  if (!API_KEY) return res.status(500).json({ error: '未配置 DEEPSEEK_API_KEY 环境变量' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  const sendError = (msg) => { res.write('\nERROR:' + msg); res.end(); };

  let lastBadJson = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    // Heartbeat to prevent Render 30s timeout
    const heartbeat = setInterval(() => res.write('.'), 5000);
    try {
      const messages = attempt === 0
        ? [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: `请根据以下内容生成视觉小说游戏：\n\n${text.substring(0, 6000)}` }
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
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: '请提供 prompt' });
  if (!IMAGE_API_KEY) return res.status(500).json({ error: '未配置 IMAGE_API_KEY 环境变量' });

  const fullPrompt = PIXEL_STYLE + prompt;

  for (let i = 0; i < 3; i++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 300000);
      const resp = await fetch(IMAGE_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${IMAGE_API_KEY}` },
        body: JSON.stringify({ model: 'gpt-image-2', prompt: fullPrompt, size: '1024x1536', quality: 'medium', n: 1 }),
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
  const { name, id, customPrompt } = req.body;
  if (!name) return res.status(400).json({ error: '请提供角色名' });
  if (!IMAGE_API_KEY) return res.status(500).json({ error: '未配置 IMAGE_API_KEY' });

  const prompt = PIXEL_STYLE + (customPrompt || `character portrait, upper body, facing slightly left, ${name}, solo character, plain dark background, centered composition`);

  for (let i = 0; i < 3; i++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 300000);
      const resp = await fetch(IMAGE_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${IMAGE_API_KEY}` },
        body: JSON.stringify({ model: 'gpt-image-2', prompt, size: '1024x1536', quality: 'low', n: 1 }),
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

app.listen(PORT, () => {
  console.log(`Story Generator running at http://localhost:${PORT}`);
  if (!API_KEY) console.warn('Warning: DEEPSEEK_API_KEY not set');
  if (!IMAGE_API_KEY) console.warn('Warning: IMAGE_API_KEY not set');
});
