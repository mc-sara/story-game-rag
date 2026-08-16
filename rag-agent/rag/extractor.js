/**
 * 角色 Profile 提取器 (Extractor)
 *
 * 两阶段提取：
 * 阶段1: 从各 chunk 的角色片段中提取性格、说话方式、处事风格等维度
 * 阶段2: 合并所有片段，为每个角色生成一条完整 profile
 *
 * 输出维度（7个）：
 *   personality    - 性格特征
 *   speech         - 说话癖好
 *   handlingStyle  - 处事风格
 *   backstory      - 背景故事
 *   relationships  - 关键关系
 *   keyEvents      - 重要事件
 */

const CONFIG = require('../config.js');
const https   = require('https');

const MAX_RETRIES  = 5;
const BASE_DELAY   = 2000;

// ---------------------------------------------------------------------------
// MiMo 调用（带指数退避）
// ---------------------------------------------------------------------------

function callMiMo(messages, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${CONFIG.BASE_URL}/chat/completions`);
    const body = JSON.stringify({
      model:              CONFIG.MODEL,
      messages,
      temperature:        options.temperature ?? 0.3,
      max_completion_tokens: options.maxTokens ?? 1024,
      stream:             false
    });

    function attempt(n) {
      const req = https.request({
        hostname: url.hostname,
        port:     443,
        path:     url.pathname,
        method:   'POST',
        headers:  {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${CONFIG.API_KEY}`,
          'Content-Length': Buffer.byteLength(body)
        }
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            const retryable = res.statusCode === 429 || (res.statusCode >= 500 && res.statusCode < 600);
            if (retryable && n < MAX_RETRIES) {
              const delay = BASE_DELAY * Math.pow(2, n);
              console.warn(`[Extractor] HTTP ${res.statusCode}，${delay / 1000}s 后重试（第 ${n + 1} 次）`);
              setTimeout(() => attempt(n + 1), delay);
              return;
            }
            if (res.statusCode >= 400) {
              reject(new Error(parsed.error?.message || `HTTP ${res.statusCode}`));
              return;
            }
            resolve(parsed.choices?.[0]?.message?.content || '');
          } catch (e) {
            reject(new Error(`响应解析失败: ${e.message}`));
          }
        });
      });
      req.on('error', err => {
        if (n < MAX_RETRIES) {
          const delay = BASE_DELAY * Math.pow(2, n);
          console.warn(`[Extractor] 请求错误（${err.message}），${delay / 1000}s 后重试（第 ${n + 1} 次）`);
          setTimeout(() => attempt(n + 1), delay);
        } else reject(err);
      });
      req.setTimeout(120000, () => { req.destroy(); reject(new Error('请求超时')); });
      req.write(body);
      req.end();
    }

    attempt(0);
  });
}

// ---------------------------------------------------------------------------
// 正文起始检测（与 novelAnalyzer 保持一致）
// ---------------------------------------------------------------------------

const BODY_PATTERNS = [
  /------章節內容開始-------/,
  /------章节内容开始-------/,
  /=====正文开始=====/,
  /第[一二三四五六七八九十百千\d]+章[　 ]/,
  /^\d+\.第.+章/m,
  /第一章\n/,
];

function findBodyStart(text) {
  for (const p of BODY_PATTERNS) {
    const m = text.match(p);
    if (m && m.index !== undefined) {
      const pos = m.index + m[0].length;
      if (pos < text.length) return pos;
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// 阶段1：批量提取角色片段（每批 chunks 抽取各角色的相关片段）
// ---------------------------------------------------------------------------

/**
 * 将文本分成若干批次，每批提取该批次中出现的角色及其片段。
 *
 * @param {Array<{text: string}>} chunks
 * @param {Array<string>} knownNames  已知的角色名（来自 indexer.getCharacters）
 * @returns {Promise<Array<{character: string, fragments: string[]}>}
 */
async function extractCharacterFragments(chunks, knownNames) {
  const BATCH = 3;
  const allFragments = [];   // [{character, fragments}]

  for (let i = 0; i < chunks.length; i += BATCH) {
    const batch = chunks.slice(i, i + BATCH);
    const batchText = batch.map((c, idx) =>
      `[片段${idx + 1}]\n${c.text.substring(0, 1500)}`
    ).join('\n\n');

    const namesList = knownNames.length
      ? '已知角色：' + knownNames.join('、') + '\n'
      : '';

    const prompt = `你是一个小说角色分析助手。${namesList}
请仔细阅读以下小说文本，提取其中出现的角色信息。

对每个出现的角色，请输出：
- 角色名（优先使用全名）
- 该角色在此片段中的：性格表现片段、说话方式特点、处事行为片段、与其他角色的互动片段

只输出以下 JSON 数组，不要输出任何其他内容：
[
  {"character": "角色名", "fragments": ["性格片段1", "说话方式片段1", "处事行为片段1", "互动片段1"]},
  ...
]
小说文本：
${batchText}`;

    try {
      const resp = await callMiMo([{ role: 'user', content: prompt }], { maxTokens: 2048 });
      const m = resp.match(/\[[\s\S]*\]/);
      if (m) {
        const parsed = JSON.parse(m[0]);
        for (const item of parsed) {
          if (!item.character || !item.fragments?.length) continue;
          const existing = allFragments.find(f => f.character === item.character);
          if (existing) {
            existing.fragments.push(...item.fragments);
          } else {
            allFragments.push({ character: item.character, fragments: [...item.fragments] });
          }
        }
      }
    } catch (err) {
      console.warn(`[Extractor] 批次 ${Math.floor(i / BATCH) + 1} 提取失败: ${err.message}`);
    }

    // 批次间延迟（API 限流窗口内连续发请求容易超时）
    console.log(`[Extractor] 角色片段批次 ${Math.floor(i / BATCH) + 1}/${Math.ceil(chunks.length / BATCH)} 完成`);
    if (i + BATCH < chunks.length) {
      await new Promise(r => setTimeout(r, 8000));
    }
  }

  return allFragments;
}

// ---------------------------------------------------------------------------
// 阶段2：合并片段，生成完整 character profile（7维度）
// ---------------------------------------------------------------------------

/**
 * @param {Array<{character: string, fragments: string[]}>} fragments
 * @returns {Promise<Array>}
 */
async function buildCharacterProfiles(fragments) {
  if (!fragments.length) return [];

  // 按片段数量降序，取前 20 个角色（避免 prompt 过长）
  const top = [...fragments]
    .sort((a, b) => b.fragments.length - a.fragments.length)
    .slice(0, 20);

  const characterInput = top.map(f =>
    `【${f.character}】\n相关片段：\n${f.fragments.slice(0, 10).join('\n')}`
  ).join('\n\n');

  const prompt = `你是一个小说角色分析助手。以下是从小说中提取的角色相关片段。

请为每个角色生成一份完整的 Profile，包含以下7个维度：
1. personality    - 性格特征（2-4个关键词）
2. speech         - 说话癖好（2-3句，描述说话方式、口头禅、表达习惯）
3. handlingStyle  - 处事风格（2-3句，描述遇到问题/冲突时的行为模式）
4. backstory      - 背景故事（2-3句，描述出身、经历、现状）
5. relationships  - 关键关系（2-4句，描述与其他主要角色的关系）
6. keyEvents      - 重要事件（2-3个，在原著中发生的重要事件）

只输出以下 JSON 数组，不要输出任何其他内容：
[
  {"name": "角色名", "personality": "...", "speech": "...", "handlingStyle": "...", "backstory": "...", "relationships": "...", "keyEvents": "..."},
  ...
]
${characterInput}`;

  try {
    const resp = await callMiMo([{ role: 'user', content: prompt }], { maxTokens: 4096 });
    const m = resp.match(/\[[\s\S]*\]/);
    if (!m) return [];
    return JSON.parse(m[0]);
  } catch (err) {
    console.warn(`[Extractor] buildCharacterProfiles 失败: ${err.message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 从小说文档中提取角色 profile。
 *
 * @param {string} novelId  文档 ID
 * @param {string} text     小说全文
 * @param {Array}  chapters 章节列表（用于重建 chunks）
 * @param {Array}  knownNames 已知角色名（来自 indexer）
 * @returns {Promise<Array>}
 */
async function extractCharacterProfiles(novelId, text, chapters, knownNames) {
  // 从章节重建 chunks（每个章节前 2000 字）
  const chunks = chapters.map(c => ({
    text: text.substring(c.start, c.end).substring(0, 2000)
  }));

  const fragments = await extractCharacterFragments(chunks, knownNames);
  const profiles  = await buildCharacterProfiles(fragments);

  console.log(`[Extractor] 小说 ${novelId} 提取完成，共 ${profiles.length} 个角色`);
  return profiles;
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

module.exports = {
  extractCharacterProfiles,
  extractCharacterFragments,
  buildCharacterProfiles
};
