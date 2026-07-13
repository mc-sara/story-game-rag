/**
 * RAG Agent 服务端 v2
 *
 * 升级内容：
 * - 文档类型自动识别（小说 / 技术文档）
 * - 小说：章节切分 + 角色分析 + 摘要生成 + 混合检索
 * - 技术文档：通用 chunk（保持 v1 逻辑）
 * - 流式持久化（解决大文档写入截断）
 *
 * REST 接口：
 *   GET  /health
 *   GET  /documents
 *   POST /documents          上传文档
 *   DELETE /documents/:id
 *   DELETE /documents
 *   POST /documents/text     文本直接入库
 *   GET  /documents/:id/characters   获取角色关系
 *   GET  /documents/:id/summaries   获取章节摘要
 *   POST /query             RAG 问答
 */

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const https = require('https');

const CONFIG = require('./config.js');
const { indexer } = require('./rag/indexer.js');
const { embedder } = require('./rag/embedder.js');
const { answerFromRelationshipGraph } = require('./rag/novelAnalyzer.js');
const { conversationStore } = require('./rag/conversationStore.js');
const { extractCharacterProfiles } = require('./rag/extractor.js');

// 角色 profile 文件存储目录
const PROFILES_DIR = path.join(__dirname, 'chapters');
if (!fs.existsSync(PROFILES_DIR)) {
  fs.mkdirSync(PROFILES_DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// Express App
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '50mb' }));   // 放宽限制（小说文本很大）
app.use(express.static(path.join(__dirname)));

// 允许跨域（Story-game 从不同端口调用）
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  next();
});

const upload = multer({
  dest: path.join(__dirname, 'uploads'),
  limits: { fileSize: 50 * 1024 * 1024 }  // 50MB
});

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Helper: 调用 MiMo
// ---------------------------------------------------------------------------

function callMiMo(messages, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${CONFIG.BASE_URL}/chat/completions`);

    const body = JSON.stringify({
      model: CONFIG.MODEL,
      messages,
      temperature: options.temperature ?? CONFIG.TEMPERATURE,
      max_completion_tokens: options.maxTokens ?? CONFIG.MAX_TOKENS,
      stream: false
    });

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
          if (res.statusCode >= 400) {
            return reject(new Error(parsed.error?.message || `HTTP ${res.statusCode}`));
          }
          resolve(parsed.choices?.[0]?.message?.content || '');
        } catch (e) {
          reject(new Error(`响应解析失败: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(CONFIG.TIMEOUT, () => { req.destroy(); reject(new Error('请求超时')); });
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Helper: 编码检测与转换
// ---------------------------------------------------------------------------

const iconv = require('iconv-lite');

/**
 * 智能读取文件并转换为 UTF-8
 * 策略：先用 UTF-8 读，再用字节级启发式检测 GBK 乱码特征，
 * 找到正确编码后自动将 UTF-8 版本保存到 uploads/cleaned/ 文件夹。
 *
 * @param {string} filePath - 原始文件路径
 * @param {string} originalName - 原始文件名
 * @returns {{ text: string, converted: boolean, encoding: string|null, savedPath: string|null }}
 */
function readFileAsUtf8(filePath, originalName) {
  const rawBuf = fs.readFileSync(filePath);

  // 1. 先尝试 UTF-8，若中文字符密度正常（>20%）且无替换符则直接返回
  const utf8Text = rawBuf.toString('utf-8');
  const utf8Chinese = (utf8Text.match(/[\u4e00-\u9fa5]/g) || []).length;
  const utf8Ratio = utf8Chinese / Math.max(utf8Text.length, 1);
  if (!utf8Text.includes('\uFFFD') && utf8Ratio > 0.20) {
    return { text: utf8Text, converted: false, encoding: null, savedPath: null };
  }

  // 2. 字节级 GBK 乱码检测
  // GBK 高字节范围 0x81-0xFE，若 UTF-8 解码文本中大量出现这个范围的字符
  //（被错误当成单字节解读），说明可能是 GBK 编码
  const gbkHighBytes = (() => {
    let count = 0;
    for (let i = 0; i < rawBuf.length; i++) {
      const b = rawBuf[i];
      if (b >= 0x81 && b <= 0xFE) count++;
    }
    return count;
  })();
  const gbkDensity = gbkHighBytes / Math.max(rawBuf.length, 1);

  // 若 GBK 高字节占比超过 10%，认为很可能是 GBK/GB2312 编码
  const likelyGBK = gbkDensity > 0.10;

  if (!likelyGBK) {
    // GBK 特征不明显但仍有乱码，用 latin1 兜底
    return { text: rawBuf.toString('latin1'), converted: false, encoding: 'latin1', savedPath: null };
  }

  // 3. 尝试 GBK 族编码
  const encodings = ['gbk', 'gb2312', 'gb18030', 'big5', 'shift-jis'];
  let bestText = null;
  let bestEncoding = null;
  let bestScore = -1;

  for (const enc of encodings) {
    try {
      const decoded = iconv.decode(rawBuf, enc);
      const replacementCount = (decoded.match(/\uFFFD/g) || []).length;
      const chineseCount = (decoded.match(/[\u4e00-\u9fa5]/g) || []).length;
      const ratio = chineseCount / Math.max(decoded.length, 1);

      // 打分：无替换符 + 中文字符比例高
      const score = ratio * 100 - replacementCount * 10;
      if (score > bestScore) {
        bestScore = score;
        bestText = decoded;
        bestEncoding = enc;
      }

      if (replacementCount === 0 && ratio > 0.20) {
        bestText = decoded;
        bestEncoding = enc;
        break; // 完美解码
      }
    } catch (_) {}
  }

  if (!bestText || bestScore < 0) {
    console.warn(`[Server] 文件 "${originalName}" 编码检测失败`);
    return { text: rawBuf.toString('latin1'), converted: false, encoding: 'latin1', savedPath: null };
  }

  // 4. 保存 UTF-8 版本到 uploads/cleaned/
  const cleanedDir = path.join(__dirname, 'uploads', 'cleaned');
  if (!fs.existsSync(cleanedDir)) {
    fs.mkdirSync(cleanedDir, { recursive: true });
  }

  const baseName = path.basename(originalName, path.extname(originalName));
  const savedFileName = `${baseName}_${Date.now()}.txt`;
  const savedPath = path.join(cleanedDir, savedFileName);

  try {
    fs.writeFileSync(savedPath, bestText, 'utf-8');
    console.log(`[Server] 文件 "${originalName}" (${bestEncoding}) → UTF-8 转换已保存: ${savedPath}`);
  } catch (err) {
    console.warn(`[Server] 保存 UTF-8 文件失败: ${err.message}`);
  }

  return { text: bestText, converted: true, encoding: bestEncoding, savedPath };
}

/**
 * 解析文件文本（支持 txt/md/json，自动处理非 UTF-8 编码）
 */
async function parseFileText(filePath, originalName) {
  const ext = path.extname(originalName).toLowerCase();

  if (ext === '.txt' || ext === '.md' || ext === '.json') {
    const result = readFileAsUtf8(filePath, originalName);
    return result.text;
  }

  throw new Error('请在前端使用 PDF.js 解析');
}

// ---------------------------------------------------------------------------
// REST API
// ---------------------------------------------------------------------------

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    model: CONFIG.MODEL,
    documents: indexer.listDocuments().length,
    ...embedder.getStats()
  });
});

app.get('/documents', (req, res) => {
  res.json(indexer.listDocuments());
});

app.delete('/documents/:id', (req, res) => {
  const ok = indexer.removeDocument(req.params.id);
  if (!ok) return res.status(404).json({ error: '文档不存在' });
  res.json({ success: true });
});

app.delete('/documents', (req, res) => {
  indexer.clearAll();
  res.json({ success: true });
});

// 获取角色关系（小说专用）
app.get('/documents/:id/characters', (req, res) => {
  const data = indexer.getCharacters(req.params.id);
  if (!data || data.characters.length === 0) {
    return res.status(404).json({ error: '该文档无角色数据（非小说类型）' });
  }
  res.json(data);
});

// 获取章节摘要
app.get('/documents/:id/summaries', (req, res) => {
  const summaries = indexer.getChapterSummaries(req.params.id);
  res.json(summaries);
});

// 获取小说列表（供 Story-game 调用）
app.get('/api/novels', (req, res) => {
  const docs = indexer.listDocuments();
  const novels = docs.filter(d => d.docType === 'novel').map(d => ({
    id: d.id,
    name: d.name,
    uploadedAt: d.uploadedAt,
    analyzing: d.analyzing,
    hasCharacterProfiles: d.hasCharacterProfiles || false
  }));
  res.json(novels);
});

// 获取角色 profile（供 Story-game 调用）
app.get('/api/novel-characters', (req, res) => {
  const { novelId } = req.query;
  if (!novelId) return res.status(400).json({ error: 'novelId 为必填' });

  const doc = indexer.getDocument(novelId);
  if (!doc) return res.status(404).json({ error: '小说不存在' });
  if (doc.analyzing) return res.status(202).json({ analyzing: true });

  const profiles = indexer.getCharacterProfiles(novelId);
  if (!profiles) return res.status(404).json({ error: '角色 profile 尚未生成' });

  res.json({
    novelId,
    title: doc.name,
    characters: profiles
  });
});

// 获取文档分析状态（供前端轮询）
app.get('/documents/:id/status', (req, res) => {
  const doc = indexer.getDocument(req.params.id);
  if (!doc) return res.status(404).json({ error: '文档不存在' });
  res.json({
    id: doc.id,
    name: doc.name,
    analyzing: doc.analyzing || false,
    analysisError: doc.analysisError || null,
    charactersCount: doc.characters?.length || 0,
    summariesCount: doc.chapterSummaries?.length || 0
  });
});

// 上传文档（支持进度回调）
app.post('/documents', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: '请上传文件（字段名: file）' });
  }

  const fileName = decodeURIComponent(escape(req.file.originalname));

  try {
    const text = await parseFileText(req.file.path, fileName);
    if (!text || text.trim().length < 10) {
      try { fs.unlinkSync(req.file.path); } catch (_) {}
      return res.status(400).json({ error: '文档内容过少或为空' });
    }

    // 立即入库，后台异步分析（不阻塞上传响应）
    const result = indexer.addDocument(fileName, text);

    try { fs.unlinkSync(req.file.path); } catch (_) {}
    res.json(result);
  } catch (err) {
    try { fs.unlinkSync(req.file.path); } catch (_) {}
    res.status(400).json({ error: err.message });
  }
});

// 文本直接入库（PDF 前端解析后走此接口）
app.post('/documents/text', (req, res) => {
  const { name, text } = req.body;
  if (!name || !text || text.trim().length < 10) {
    return res.status(400).json({ error: 'name 和 text 为必填项，且内容不能少于 10 字符' });
  }
  try {
    const result = indexer.addDocument(name, text.trim());
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 列出 uploads/cleaned/ 中的 UTF-8 文件
app.get('/cleaned-files', (req, res) => {
  const fs = require('fs');
  const path = require('path');
  const cleanedDir = path.join(__dirname, 'uploads', 'cleaned');
  if (!fs.existsSync(cleanedDir)) return res.json([]);
  const files = fs.readdirSync(cleanedDir).filter(f => f.endsWith('.txt'));
  res.json(files.map(f => ({
    name: f,
    size: fs.statSync(path.join(cleanedDir, f)).size
  })));
});

// 从 uploads/cleaned/ 中的 UTF-8 文件重新入库（编码转换后的补救入口）
// 若同名文档已存在则替换，否则新增
app.post('/documents/reimport-cleaned', (req, res) => {
  const { fileName, docId } = req.body;
  if (!fileName) return res.status(400).json({ error: 'fileName 为必填项' });

  const cleanedDir = path.join(__dirname, 'uploads', 'cleaned');
  const filePath = path.join(cleanedDir, fileName);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: `文件不存在: ${fileName}` });
  }

  try {
    const text = fs.readFileSync(filePath, 'utf-8');
    const baseName = path.basename(fileName, path.extname(fileName)).replace(/_[0-13]+$/, '');
    const targetName = baseName + '.txt';

    // 若传了 docId，先删除旧文档
    if (docId) {
      indexer.removeDocument(docId);
    } else {
      // 按名称查找并删除
      const existing = indexer.listDocuments().find(d => d.name === targetName);
      if (existing) indexer.removeDocument(existing.id);
    }

    const result = indexer.addDocument(targetName, text);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 重跑文档 LLM 分析（用于首次分析失败后重试）
app.post('/documents/:docId/reanalyze', async (req, res) => {
  const { docId } = req.params;
  const { text } = req.body;
  const doc = indexer.getDocument(docId);
  if (!doc) return res.status(404).json({ error: '文档不存在' });
  if (!text) return res.status(400).json({ error: 'text 为必填项' });
  try {
    await indexer.reanalyzeDocument(docId, text.trim());
    res.json({ ok: true, message: '分析完成' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// 核心 RAG 接口
// ---------------------------------------------------------------------------

app.post('/query', async (req, res) => {
  const { question, docId, sessionId } = req.body;

  if (!question || typeof question !== 'string' || question.trim().length === 0) {
    return res.status(400).json({ error: 'question 为必填项' });
  }

  const trimmedQuestion = question.trim();
  const activeSessionId = sessionId || `sess_${Date.now()}`;

  // 找出相关文档的 docType 和元数据
  let targetDoc = null;
  if (docId) {
    targetDoc = indexer.getDocument(docId);
  } else {
    const docs = indexer.listDocuments();
    if (docs.length > 0) {
      const latest = docs.sort((a, b) => b.uploadedAt - a.uploadedAt)[0];
      targetDoc = indexer.getDocument(latest.id);
    }
  }

  const docType = targetDoc?.docType || 'technical';
  const extraData = docType === 'novel' ? indexer.getCharacters(docId || targetDoc?.id) : {};

  // Step 1: 尝试从角色关系图直接回答
  if (docType === 'novel' && extraData.characters?.length > 0) {
    const directAnswer = answerFromRelationshipGraph(
      trimmedQuestion,
      extraData.characters,
      extraData.relationships || []
    );
    if (directAnswer) {
      conversationStore.createSessionIfNotExists(activeSessionId, docId || targetDoc?.id, targetDoc?.name);
      conversationStore.addMessage(activeSessionId, {
        question: trimmedQuestion,
        answer: directAnswer,
        answerSource: 'relationship-graph',
        sources: [],
        docType,
        hasContext: false
      });
      return res.json({
        question: trimmedQuestion,
        answer: directAnswer,
        answerSource: 'relationship-graph',
        sources: [],
        sessionId: activeSessionId
      });
    }
  }

  // Step 2: 混合检索
  const searchResults = embedder.search(trimmedQuestion, CONFIG.TOP_K_CHUNKS, docType, extraData, targetDoc?.id);

  // Step 3: 构建 context
  let context = '';
  let sources = [];

  if (searchResults.length > 0) {
    context = searchResults.map((r, i) => {
      const chapterTag = r.chunk.chapterTitle
        ? `[第${r.chunk.chapterIndex + 1}章 ${r.chunk.chapterTitle}]`
        : '';
      sources.push({
        docId: r.chunk.docId,
        docName: r.chunk.docName,
        chunkId: r.chunk.id,
        text: r.chunk.text.substring(0, 200) + (r.chunk.text.length > 200 ? '...' : ''),
        score: parseFloat(r.score.toFixed(4)),
        layer: r.layer,
        chapterTitle: r.chunk.chapterTitle
      });
      return `[参考${i + 1}${chapterTag}]\n${r.chunk.text}`;
    }).join('\n\n---\n\n');
  }

  // Step 4: 组装 Prompt
  const systemPrompt = buildSystemPrompt(docType, context, extraData);
  const userPrompt = `问题：${trimmedQuestion}`;

  try {
    const answer = await callMiMo([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ]);

    conversationStore.createSessionIfNotExists(activeSessionId, docId || targetDoc?.id, targetDoc?.name);
    conversationStore.addMessage(activeSessionId, {
      question: trimmedQuestion,
      answer,
      answerSource: 'llm',
      sources,
      docType,
      hasContext: searchResults.length > 0
    });

    res.json({
      question: trimmedQuestion,
      answer,
      answerSource: 'llm',
      sources,
      hasContext: searchResults.length > 0,
      docType,
      sessionId: activeSessionId
    });
  } catch (err) {
    console.error(`[Server] MiMo API 调用失败: ${err.message}`);
    res.status(502).json({ error: `AI 服务调用失败: ${err.message}` });
  }
});

// 对话会话管理
app.get('/sessions', (req, res) => {
  res.json(conversationStore.listSessions());
});

app.post('/sessions', (req, res) => {
  const { docId, docName } = req.body;
  const session = conversationStore.createSession(docId, docName);
  res.json(session);
});

app.get('/sessions/:sessionId', (req, res) => {
  const session = conversationStore.getSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: '会话不存在' });
  res.json(session);
});

app.post('/sessions/:sessionId/messages', (req, res) => {
  const session = conversationStore.addMessage(req.params.sessionId, req.body);
  if (!session) return res.status(404).json({ error: '会话不存在' });
  res.json(session);
});

app.delete('/sessions/:sessionId', (req, res) => {
  const ok = conversationStore.deleteSession(req.params.sessionId);
  if (!ok) return res.status(404).json({ error: '会话不存在' });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Helper: 构建 System Prompt
// ---------------------------------------------------------------------------

function buildSystemPrompt(docType, context, extraData = {}) {
  if (docType === 'novel') {
    const { characters = [], relationships = [] } = extraData;
    let charInfo = '';
    if (characters.length > 0) {
      charInfo = '\n【主要人物】\n' + characters.map(c =>
        `· ${c.name}（${c.aliases?.join('、') || ''}）：${c.role}`
      ).join('\n');
      if (relationships.length > 0) {
        charInfo += '\n【人物关系】\n' + relationships.slice(0, 10).map(r =>
          `· ${r.from} — ${r.relation} — ${r.to}`
        ).join('\n');
      }
    }

    return `你是一个基于小说的智能问答助手。${charInfo}

**回答规则：**
1. 只根据提供的小说内容回答，不要编造剧情
2. 如果相关内容不足以回答，诚实告知
3. 涉及人物关系时，优先使用上述【主要人物】和【人物关系】信息
4. 回答使用中文，可以引用具体情节（标注[参考X]）

**相关小说内容：**
${context || '（未找到相关情节）'}
`;
  } else {
    return `你是一个基于文档的智能问答助手。

**回答规则：**
1. 只根据提供的文档内容回答，不要编造信息
2. 如果相关内容不足以回答，诚实告知
3. 回答使用中文，简洁清晰

**相关文档内容：**
${context || '（未找到相关文档）'}
`;
  }
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
app.listen(CONFIG.PORT, () => {
  const stats = embedder.getStats();
  console.log(`
╔══════════════════════════════════════════════════════╗
║  RAG Agent v2 已启动                                 ║
║  地址: http://localhost:${CONFIG.PORT}                        ║
║  模型: ${CONFIG.MODEL.padEnd(20)}                ║
║  文档: ${indexer.listDocuments().length} 个已索引                          ║
║  Chunks: ${String(stats.totalChunks).padEnd(5)} 个                          ║
╚══════════════════════════════════════════════════════╝
  `);
});
