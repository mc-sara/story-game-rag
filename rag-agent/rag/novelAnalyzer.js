/**
 * 小说分析器 (Novel Analyzer)
 *
 * 对小说文档做深层语义处理：
 * 1. 角色提取：从全文中识别主要人物（名字、别名、身份）
 * 2. 关系网络：识别人物间的关系（父子、恋人、仇敌等）
 * 3. 章节摘要：为每个章节生成一句话/几句话的摘要
 *
 * 所有操作通过调用 LLM（MiMo API）完成，
 * 调用量很小：角色提取 1 次 + 章节摘要 N 次（每章节 1 次）
 *
 * 注意：为节省 token，章节摘要只取章节的前 2000 字送入 LLM，
 * 因为章节开头通常包含最重要的情节信息。
 */

const CONFIG = require('../config.js');
const https = require('https');

const MAX_CHARS_FOR_SUMMARY = 2000; // 每个章节送入摘要的最大字符数
const MAX_RETRIES = 5;             // 最多重试 5 次
const BASE_DELAY_MS = 2000;        // 基础退避间隔 2s

// ---------------------------------------------------------------------------
// Helper: 调用 MiMo（带指数退避重试）
// ---------------------------------------------------------------------------

/**
 * 带指数退避重试的 MiMo 调用
 * 429 / "Too many requests" 时自动等待后重试
 */
function callMiMo(messages, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${CONFIG.BASE_URL}/chat/completions`);

    const body = JSON.stringify({
      model: CONFIG.MODEL,
      messages,
      temperature: options.temperature ?? 0.3,
      max_completion_tokens: options.maxTokens ?? 1024,
      stream: false,
      thinking: { type: 'disabled' }
    });

    function attempt(attemptNum) {
      const reqOptions = {
        hostname: url.hostname,
        port: 443,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${CONFIG.API_KEY}`,
          'Content-Length': Buffer.byteLength(body)
        }
      };

      const req = https.request(reqOptions, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);

            // 429 Too many requests / 5xx 服务端错误 → 指数退避重试
            const retryable = res.statusCode === 429 || (res.statusCode >= 500 && res.statusCode < 600);
            if (retryable && attemptNum < MAX_RETRIES) {
              const delay = BASE_DELAY_MS * Math.pow(2, attemptNum);
              console.warn(`[NovelAnalyzer] HTTP ${res.statusCode}，${delay / 1000}s 后重试（第 ${attemptNum + 1} 次）`);
              setTimeout(() => attempt(attemptNum + 1), delay);
              return;
            }

            if (res.statusCode >= 400) {
              return reject(new Error(parsed.error?.message || `HTTP ${res.statusCode}`));
            }

            resolve(parsed.choices?.[0]?.message?.content || '');
          } catch (e) {
            reject(new Error(`响应解析失败: ${e.message}`));
          }
        });
      });

      req.on('error', (err) => {
        if (attemptNum < MAX_RETRIES) {
          const delay = BASE_DELAY_MS * Math.pow(2, attemptNum);
          setTimeout(() => attempt(attemptNum + 1), delay);
        } else {
          reject(err);
        }
      });

      req.setTimeout(CONFIG.TIMEOUT, () => {
        req.destroy();
        if (attemptNum < MAX_RETRIES) {
          setTimeout(() => attempt(attemptNum + 1), BASE_DELAY_MS * Math.pow(2, attemptNum));
        } else {
          reject(new Error('请求超时'));
        }
      });

      req.write(body);
      req.end();
    }

    attempt(0);
  });
}

// ---------------------------------------------------------------------------
// 角色提取
// ---------------------------------------------------------------------------

/**
 * 从小说文本中提取角色和关系
 *
 * 采样策略：全文多点采样（开头 2000 + 中段 2000 + 末尾 4000 = 约 8000 字），
 * 确保覆盖各章节出现的人物，而非只依赖开篇简介。
 *
 * Prompt 设计：
 * - 输出严格 JSON，maxTokens 加大防止截断
 * - 提取全部主要角色（限制 20 个以内）
 * - 关系类型覆盖常见：父子/母子、恋人、义父义子、主仆、仇敌、挚友、同桌、兄弟
 *
 * @param {string} text - 小说全文
 * @returns {Promise<{characters: Array, relationships: Array}>}
 */
// ---------------------------------------------------------------------------
// 正文起始检测（跳过网站广告、版权、目录等头部元信息）
// ---------------------------------------------------------------------------

// 按出现顺序尝试匹配正文起始标记（越靠后的越精确）
const BODY_START_PATTERNS = [
  /------章節內容開始-------/,
  /------章节内容开始-------/,
  /=====正文开始=====/,
  /第[一二三四五六七八九十百千\d]+章[　 ]/,
  /^\d+\.第.+章/m,
  /第一章\n/,
];

function findBodyStart(text) {
  for (const pattern of BODY_START_PATTERNS) {
    const match = text.match(pattern);
    if (match && match.index !== undefined) {
      const pos = match.index + match[0].length;
      if (pos < text.length) return pos;
    }
  }
  return 0;
}

// 多点采样策略：从正文开始、中段、末尾各取字符，覆盖全篇人物分布
const SAMPLES = [
  { label: '开篇（前2000字）', start: 'body',    length: 2000 },
  { label: '中段（全文20%处）', start: 'auto',    length: 2000 },
  { label: '中后段（全文45%处）', start: 'mid',    length: 2000 },
  { label: '末尾（后4000字）', start: 'tail',     length: 4000 },
];

function buildCharacterSampleText(fullText) {
  const bodyStart = findBodyStart(fullText);
  const bodyText  = fullText.substring(bodyStart);
  const len       = bodyText.length;

  return SAMPLES.map(s => {
    let start;
    if (s.start === 'body') start = 0;
    else if (s.start === 'auto') start = Math.floor(len * 0.20);
    else if (s.start === 'mid')  start = Math.floor(len * 0.45);
    else if (s.start === 'tail') start = Math.max(0, len - s.length);
    else start = s.start;
    return `[${s.label}]\n${bodyText.substring(start, start + s.length)}`;
  }).join('\n\n');
}

async function extractCharacters(text) {
  const sampleText = buildCharacterSampleText(text);

  const prompt = `你是一个小说文本分析助手。请从以下小说文本中提取所有出现的主要角色及其关系。只输出以下格式的JSON，不要输出任何其他内容：
{
  "characters": [
    {"name": "角色名", "aliases": ["别名1", "别名2"], "role": "身份"}
  ],
  "relationships": [
    {"from": "角色A", "to": "角色B", "relation": "关系"}
  ]
}
小说文本：
${sampleText}`;

  try {
    const response = await callMiMo(
      [{ role: 'user', content: prompt }],
      { maxTokens: 2048 }
    );

    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn('[NovelAnalyzer] 角色提取返回非 JSON，响应:', response.substring(0, 200));
      return { characters: [], relationships: [] };
    }

    const parsed = JSON.parse(jsonMatch[0]);
    return {
      characters: parsed.characters || [],
      relationships: parsed.relationships || []
    };
  } catch (err) {
    console.warn(`[NovelAnalyzer] 角色提取失败: ${err.message}`);
    throw err;  // 重新抛出，让 Step2 的 catch 能感知到失败
  }
}

// ---------------------------------------------------------------------------
// 章节摘要
// ---------------------------------------------------------------------------

/**
 * 为单个章节生成摘要
 *
 * @param {object} chapter - { title, text, chapterIndex }
 * @returns {Promise<{chapterIndex: number, title: string, summary: string}>}
 */
async function summarizeChapter(chapter) {
  const text = chapter.text.substring(0, MAX_CHARS_FOR_SUMMARY);

  const prompt = `为以下小说章节生成一句话概括（30-80字）。只输出JSON数组，不要其他内容：[{"chapterIndex":${chapter.chapterIndex},"title":"${chapter.title}","summary":"概括内容"}]
章节内容：
${text}`;

  try {
    const response = await callMiMo(
      [{ role: 'user', content: prompt }],
      { maxTokens: 512 }
    );

    return {
      chapterIndex: chapter.chapterIndex,
      title: chapter.title,
      summary: response.trim().substring(0, 200)
    };
  } catch (err) {
    console.warn(`[NovelAnalyzer] 章节[${chapter.chapterIndex}]摘要失败: ${err.message}`);
    return {
      chapterIndex: chapter.chapterIndex,
      title: chapter.title,
      summary: '(摘要生成失败)'
    };
  }
}

/**
 * 分批生成章节摘要（每批 5 章，批次间有延迟）
 *
 * 策略：避免一次发太多章导致 JSON 截断；每批处理完等待 3s 避免触发 rate limit。
 *
 * @param {Array} chapters - 章节列表
 * @returns {Promise<Array<{chapterIndex, title, summary}>>}
 */
async function summarizeAllChapters(chapters) {
  if (chapters.length === 0) return [];

  const BATCH_SIZE = 5;
  const BATCH_DELAY_MS = 8000;
  const summaries = [];

  for (let i = 0; i < chapters.length; i += BATCH_SIZE) {
    const batch = chapters.slice(i, i + BATCH_SIZE);

    // 构造批量 prompt：每章只取前 300 字
    const chapterInputs = batch.map((ch, idx) =>
      `【${ch.chapterIndex + 1}】${ch.title}\n${ch.text.substring(0, 300)}`
    ).join('\n\n');

    const prompt = `为以下小说章节各生成一句话概括。只输出JSON数组，不要其他内容：[
${batch.map((_, idx) => `{"chapterIndex":${batch[idx].chapterIndex},"title":"${batch[idx].title}","summary":"概括内容"}`).join(',\n')}
]
章节列表：
${chapterInputs}`;

    console.log(`[NovelAnalyzer] 摘要批次 ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(chapters.length / BATCH_SIZE)}：章节 ${batch[0].chapterIndex + 1}～${batch[batch.length - 1].chapterIndex + 1}`);

    try {
      const response = await callMiMo([{ role: 'user', content: prompt }], { maxTokens: 2048 });
      const jsonMatch = response.match(/\[[\s\S]*\]/);
      if (!jsonMatch) throw new Error('LLM 未返回有效 JSON');

      const parsed = JSON.parse(jsonMatch[0]);
      for (const item of parsed) {
        summaries.push({
          chapterIndex: item.chapterIndex,
          title: item.title || chapters[item.chapterIndex]?.title || '',
          summary: (item.summary || '(摘要失败)').substring(0, 200)
        });
      }
    } catch (err) {
      console.warn(`[NovelAnalyzer] 批次 ${Math.floor(i / BATCH_SIZE) + 1} 失败: ${err.message}，逐章补做`);
      // 批次失败，逐章补做
      for (const ch of batch) {
        try {
          const s = await summarizeChapter(ch);
          summaries.push(s);
        } catch (e) {
          summaries.push({
            chapterIndex: ch.chapterIndex,
            title: ch.title,
            summary: '(摘要失败)'
          });
        }
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    // 批次间延迟，让 API 喘口气
    if (i + BATCH_SIZE < chapters.length) {
      await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  return summaries.sort((a, b) => a.chapterIndex - b.chapterIndex);
}

// ---------------------------------------------------------------------------
// 快速问答（角色关系类问题）
// ---------------------------------------------------------------------------

/**
 * 根据关系图直接回答简单的人物关系问题
 * 不需要检索，只需匹配关系网络
 *
 * @param {string} question - 用户问题
 * @param {Array} characters - 角色列表
 * @param {Array} relationships - 关系列表
 * @returns {string|null} - 如果能直接回答返回答案，否则返回 null
 */
function answerFromRelationshipGraph(question, characters, relationships) {
  const q = question.toLowerCase();

  // 模式1：问"X 和 Y 是什么关系"
  const relMatch = q.match(/(.+?)和(.+?)(是什么关系|的关系|有什么关系|是[啥么怎]关系)/);
  if (relMatch) {
    const nameA = relMatch[1].trim();
    const nameB = relMatch[2].trim();
    return findRelation(nameA, nameB, characters, relationships);
  }

  // 模式2：问"X 是谁的谁"
  const whoMatch = q.match(/(.+?)是(谁|谁的|什么)/);
  if (whoMatch) {
    const name = whoMatch[1].trim();
    return findRelationsFor(name, characters, relationships);
  }

  // 模式3：问"X 是谁"
  const whoisMatch = q.match(/(.+?)是谁/);
  if (whoisMatch) {
    const name = whoisMatch[1].trim();
    return findCharacter(name, characters, relationships);
  }

  return null;
}

function findRelation(nameA, nameB, characters, relationships) {
  for (const rel of relationships) {
    const aMatch = matchName(nameA, rel.from, characters) && matchName(nameB, rel.to, characters);
    const bMatch = matchName(nameA, rel.to, characters) && matchName(nameB, rel.from, characters);
    if (aMatch || bMatch) {
      return `${rel.from} 和 ${rel.to} 是${rel.relation}关系`;
    }
  }
  return null;
}

function findRelationsFor(name, characters, relationships) {
  const found = [];
  for (const rel of relationships) {
    if (matchName(name, rel.from, characters)) {
      found.push(`${rel.from}对${rel.to}是${rel.relation}`);
    }
    if (matchName(name, rel.to, characters)) {
      found.push(`${rel.to}对${rel.from}是${rel.relation}`);
    }
  }
  return found.length > 0 ? found.join('；') : null;
}

function findCharacter(name, characters, relationships) {
  for (const char of characters) {
    if (matchName(name, char.name, characters)) {
      const rels = relationships.filter(r =>
        matchName(name, r.from, characters) || matchName(name, r.to, characters)
      );
      const relStr = rels.slice(0, 3).map(r =>
        r.from === char.name ? `对${r.to}：${r.relation}` : `对${r.from}：${r.relation}`
      ).join('；');
      return `${char.name}（${char.aliases?.join('、') || ''}），身份：${char.role}${relStr ? '；' + relStr : ''}`;
    }
  }
  return null;
}

/**
 * 模糊匹配角色名（支持别名）
 */
function matchName(query, charName, characters) {
  const q = query.trim();
  for (const char of characters) {
    if (char.name.includes(q) || q.includes(char.name)) return true;
    if (char.aliases?.some(a => a.includes(q) || q.includes(a))) return true;
  }
  return charName.includes(q) || q.includes(charName);
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

module.exports = {
  extractCharacters,
  summarizeChapter,
  summarizeAllChapters,
  answerFromRelationshipGraph
};
