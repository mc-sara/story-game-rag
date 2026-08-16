/**
 * 文档索引器 (Indexer)
 *
 * 负责：
 * 1. 文档 CRUD（根据类型路由到不同处理流程）
 * 2. 小说类：章节切分 + 角色分析 + 摘要生成 + 混合检索
 * 3. 技术类：通用 chunk 分块
 * 4. 流式持久化（解决大文档写入截断问题）
 *
 * 数据模型（v2）：
 * {
 *   documents: [
 *     {
 *       id: "uuid",
 *       name: "xxx.txt",
 *       uploadedAt: ms,
 *       docType: "novel" | "technical",
 *       // === 小说特有 ===
 *       chapters: [{chapterIndex, title, start, end, text}],
 *       chapterSummaries: [{chapterIndex, title, summary}],
 *       characters: [{name, aliases, role}],
 *       relationships: [{from, to, relation}],
 *       // === 通用 ===
 *       chunks: [{id, text, docId, docName, start, end, chapterIndex?, chapterTitle?}]
 *     }
 *   ]
 * }
 *
 * 持久化策略：
 * - 使用 JSONL 流式写入：每个文档一行 JSON，避免大内存拼接
 * - 加载时逐行解析，重建内存索引
 */

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const uuidv4 = () => randomUUID();

const CONFIG = require('../config.js');
const PROFILES_DIR = CONFIG.PROFILES_DIR;
if (!fs.existsSync(PROFILES_DIR)) {
  fs.mkdirSync(PROFILES_DIR, { recursive: true });
}

const { chunkDocument } = require('./chunker.js');
const { processNovel } = require('./novelDetector.js');
const { extractCharacters, summarizeAllChapters } = require('./novelAnalyzer.js');
const { extractCharacterProfiles } = require('./extractor.js');
const { embedder } = require('./embedder.js');

class Indexer {
  constructor() {
    this.documents = [];
    this.indexFile = CONFIG.INDEX_FILE;
    this._loadIndex();
  }

  // -------------------------------------------------------------------------
  // 公开 API
  // -------------------------------------------------------------------------

  /**
   * 添加文档
   *
   * 技术文档 → 同步处理
   * 小说文档 → 第一步同步入库，第二步后台异步分析
   *
   * @param {string} docName
   * @param {string} text
   * @returns {{ id, name, analyzing? }}
   */
  addDocument(docName, text) {
    const docId = uuidv4();

    const { type, chapters, chunks } = processNovel(text, docName);

    if (type === 'novel' && chunks) {
      const step1 = this._addNovelDocumentStep1(docId, docName, text, chapters, chunks);
      this._addNovelDocumentStep2(docId, docName, text, chapters).catch(err => {
        console.error(`[Indexer] 小说 "${docName}" 后台分析失败: ${err.message}`);
        const doc = this.documents.find(d => d.id === docId);
        if (doc) {
          doc.analyzing = false;
          doc.analysisError = err.message;
        }
      });
      return step1;
    } else {
      return this._addTechnicalDocument(docId, docName, text);
    }
  }

  // -------------------------------------------------------------------------
  // 小说文档处理
  // -------------------------------------------------------------------------

  /**
   * 添加小说文档 - 第一步（同步，立即入库）
   * 只做章节切分 + 内容分块，不等待 LLM
   */
  _addNovelDocumentStep1(docId, docName, text, chapters, chunks) {
    const metaChunks = chunks.map(c => ({
      ...c,
      docId,
      docName,
      chunkType: 'content'
    }));

    const doc = {
      id: docId,
      name: docName,
      uploadedAt: Date.now(),
      docType: 'novel',
      analyzing: true,                      // 标记：分析中
      analysisError: null,                  // 分析错误信息
      fullText: text,                      // 存全文，重启后分析可继续
      chapters: chapters.map(c => ({
        chapterIndex: c.chapterIndex,
        title: c.title,
        start: c.start,
        end: c.end
      })),
      chapterSummaries: [],                // 待填充
      characters: [],                       // 待填充
      relationships: [],                   // 待填充
      chunks: metaChunks                   // 先只有内容 chunk，摘要 chunk 等分析完再加
    };

    this.documents.push(doc);
    embedder.buildIndex(this.documents.flatMap(d => d.chunks));
    this._saveIndexStream();

    console.log(`[Indexer] 小说 "${docName}" 第一步入库完成（后台分析中）：` +
      `${chapters.length} 章，${metaChunks.length} 个内容 chunk`);

    return { id: docId, name: docName, analyzing: true };
  }

  /**
   * 补充小说文档 - 第二步（后台异步，更新分析结果）
   * 等 LLM 分析完成后调用，更新 doc 并重建索引
   */
  async _addNovelDocumentStep2(docId, docName, fullText, chapters) {
    const doc = this.documents.find(d => d.id === docId);
    if (!doc) return;

    // 摘要全跑完后等 10s，让 API 冷却窗口过去，再启动角色提取
    await new Promise(r => setTimeout(r, 10000));

    // 恢复章节原文
    const chaptersWithText = chapters.map(c => ({
      ...c,
      text: fullText.substring(c.start, c.end)
    }));

    // 先做章节摘要（token 少，优先完成）
    const chapterSummaries = await summarizeAllChapters(chaptersWithText);

    // 摘要结果立即写入 doc，避免后续角色提取失败时白做
    const summaryChunks = chapterSummaries.map(s => ({
      id: `summary_${s.chapterIndex}`,
      text: `【${s.title}】${s.summary}`,
      docId,
      docName,
      chunkType: 'summary',
      chapterIndex: s.chapterIndex,
      chapterTitle: s.title
    }));

    doc.chapterSummaries = chapterSummaries;
    doc.chunks = [...doc.chunks, ...summaryChunks];
    embedder.buildIndex(this.documents.flatMap(d => d.chunks));
    await this._saveIndexStream();

    console.log(`[Indexer] 小说 "${docName}" 章节摘要完成：${chapterSummaries.length} 个`);

    // 最后做角色提取（采样量约 8000 字，最容易超时）
    const { characters, relationships } = await extractCharacters(fullText);

    // 提取角色 profile（7维度硬约束数据）
    const knownNames = characters.map(c => c.name);
    const characterProfiles = await extractCharacterProfiles(docId, fullText, chaptersWithText, knownNames);

    // 保存到独立文件
    const profileFile = path.join(PROFILES_DIR, `${docId}_profiles.json`);
    fs.writeFileSync(profileFile, JSON.stringify(characterProfiles, null, 2), 'utf-8');

    doc.analyzing = false;
    doc.characters = characters;
    doc.relationships = relationships;
    doc.chapterSummaries = chapterSummaries;
    doc.characterProfiles = characterProfiles;
    doc.chunks = [...doc.chunks, ...summaryChunks];

    embedder.buildIndex(this.documents.flatMap(d => d.chunks));
    await this._saveIndexStream();

    console.log(`[Indexer] 小说 "${docName}" 分析完成：` +
      `${characters.length} 个角色，${characterProfiles.length} 个 profile，${chapterSummaries.length} 个章节摘要`);
  }

  /**
   * 手动重跑文档的 LLM 分析（用于文档入库后分析失败的情况）
   */
  async reanalyzeDocument(docId, fullText) {
    const doc = this.documents.find(d => d.id === docId);
    if (!doc) throw new Error(`文档 ${docId} 不存在`);
    doc.analyzing = true;
    // 先更新 fullText，再重新切分章节（因为字符偏移会随正确编码变化）
    doc.fullText = fullText;
    // 用新文本重新切分章节
    const { chapters } = processNovel(fullText, doc.name);
    await this._addNovelDocumentStep2(docId, doc.name, fullText, chapters);
  }

  // -------------------------------------------------------------------------
  // 技术文档处理
  // -------------------------------------------------------------------------

  _addTechnicalDocument(docId, docName, text) {
    const chunks = chunkDocument(docId, docName, text);
    const metaChunks = chunks.map(c => ({ ...c, chunkType: 'content' }));

    const doc = {
      id: docId,
      name: docName,
      uploadedAt: Date.now(),
      docType: 'technical',
      chunks: metaChunks
    };

    this.documents.push(doc);
    embedder.buildIndex(metaChunks);
    this._saveIndexStream();

    console.log(`[Indexer] 技术文档 "${docName}" 入库，包含 ${chunks.length} 个 chunks`);
    return { id: docId, name: docName, chunkCount: metaChunks.length, docType: 'technical' };
  }

  // -------------------------------------------------------------------------
  // CRUD
  // -------------------------------------------------------------------------

  removeDocument(docId) {
    const idx = this.documents.findIndex(d => d.id === docId);
    if (idx === -1) return false;
    const removed = this.documents.splice(idx, 1)[0];
    const allChunks = this.documents.flatMap(d => d.chunks);
    embedder.buildIndex(allChunks);
    this._saveIndexStream();
    console.log(`[Indexer] 文档 "${removed.name}" 已删除`);
    return true;
  }

  listDocuments() {
    return this.documents.map(d => ({
      id: d.id,
      name: d.name,
      uploadedAt: d.uploadedAt,
      docType: d.docType,
      analyzing: d.analyzing || false,
      chunkCount: d.chunks.length,
      chapters: d.chapters?.length || 0,
      characters: d.characters?.length || 0,
      hasCharacterProfiles: Array.isArray(d.characterProfiles) && d.characterProfiles.length > 0
    }));
  }

  getDocument(docId) {
    return this.documents.find(d => d.id === docId) || null;
  }

  getCharacters(docId) {
    const doc = this.getDocument(docId);
    if (!doc) return { characters: [], relationships: [] };
    return {
      characters: doc.characters || [],
      relationships: doc.relationships || []
    };
  }

  getCharacterProfiles(docId) {
    const doc = this.getDocument(docId);
    if (!doc || !Array.isArray(doc.characterProfiles) || !doc.characterProfiles.length) {
      return null;
    }
    return doc.characterProfiles;
  }

  getChapterSummaries(docId) {
    const doc = this.getDocument(docId);
    return doc?.chapterSummaries || [];
  }

  /**
   * 为 Story-game 聚合故事生成上下文。
   *
   * 只做结构化上下文检索，不调用 LLM：
   * - 角色 profile：作为硬约束
   * - 人物关系：作为关系约束
   * - 原著相关片段：作为 Writer 的场景/语气/关系氛围参考
   * - 章节摘要：作为轻量背景
   *
   * @param {{novelId: string, characters?: string[], query?: string, topK?: number}} options
   * @returns {{novelId, title, characterProfiles, relationships, chapterSummaries, relevantScenes}}
   */
  getStoryContext(options) {
    const novelId = options?.novelId;
    const doc = this.getDocument(novelId);
    if (!doc) {
      const err = new Error('小说不存在');
      err.statusCode = 404;
      throw err;
    }
    if (doc.docType !== 'novel') {
      const err = new Error('该文档不是小说类型');
      err.statusCode = 400;
      throw err;
    }
    if (doc.analyzing) {
      const err = new Error('小说仍在分析中');
      err.statusCode = 202;
      throw err;
    }

    const allProfiles = this.getCharacterProfiles(novelId);
    if (!allProfiles) {
      const err = new Error('角色 profile 尚未生成');
      err.statusCode = 404;
      throw err;
    }

    const requestedCharacters = Array.isArray(options.characters)
      ? options.characters.map(n => String(n || '').trim()).filter(Boolean)
      : [];
    const requestedSet = new Set(requestedCharacters);

    const characterProfiles = requestedCharacters.length
      ? allProfiles.filter(p => requestedSet.has(p.name))
      : allProfiles;

    const relationships = (doc.relationships || []).filter(r => {
      if (!requestedCharacters.length) return true;
      return requestedSet.has(r.from) || requestedSet.has(r.to);
    });

    const topK = Math.max(1, Math.min(Number(options.topK) || 5, 8));
    const queryParts = [
      options.query || '',
      requestedCharacters.join(' '),
      characterProfiles.map(p => [
        p.name,
        p.personality,
        p.speech,
        p.handlingStyle,
        p.relationships,
        p.keyEvents
      ].filter(Boolean).join(' ')).join(' ')
    ].filter(Boolean);
    const query = queryParts.join('\n').trim() || doc.name;

    const searchResults = embedder.search(
      query,
      topK,
      'novel',
      {
        characters: doc.characters || [],
        relationships: doc.relationships || []
      },
      novelId
    );

    const relevantScenes = searchResults.map(r => ({
      chapterIndex: r.chunk.chapterIndex,
      chapterTitle: r.chunk.chapterTitle || '',
      text: this._trimText(r.chunk.text, 600),
      score: Number(r.score.toFixed(4)),
      layer: r.layer || r.chunk.chunkType || 'content'
    }));

    const relevantChapterIndices = new Set(
      relevantScenes
        .map(s => s.chapterIndex)
        .filter(i => typeof i === 'number')
    );
    const selectedSummaries = (doc.chapterSummaries || [])
      .filter(s => relevantChapterIndices.size === 0 || relevantChapterIndices.has(s.chapterIndex))
      .slice(0, 5)
      .map(s => ({
        chapterIndex: s.chapterIndex,
        title: s.title,
        summary: this._trimText(s.summary, 300)
      }));

    return {
      novelId,
      title: doc.name,
      characterProfiles,
      relationships,
      chapterSummaries: selectedSummaries,
      relevantScenes
    };
  }

  clearAll() {
    this.documents = [];
    embedder.buildIndex([]);
    this._saveIndexStream();
    console.log('[Indexer] 所有文档已清空');
  }

  // -------------------------------------------------------------------------
  // 流式持久化（JSONL 格式，逐文档写入，不积累大字符串）
  // -------------------------------------------------------------------------

  /**
   * 加载 index.json（兼容旧格式，检测 version 字段）
   */
  _loadIndex() {
    try {
      if (!fs.existsSync(this.indexFile)) return;

      const raw = fs.readFileSync(this.indexFile, 'utf-8').trim();
      if (!raw) return;

      // 旧格式检测（version 字段存在则用旧格式解析）
      if (raw.startsWith('{') && raw.includes('"version"')) {
        this._loadOldFormat();
        return;
      }

      // 新格式：标准 JSON 数组
      const parsed = JSON.parse(raw);
      this.documents = [];

      if (Array.isArray(parsed)) {
        for (const doc of parsed) {
          if (!doc || !doc.id) continue;
          doc.analyzing = doc.analyzing ?? false;
          doc.analysisError = doc.analysisError ?? null;
          doc.chapters = doc.chapters || [];
          doc.chapterSummaries = doc.chapterSummaries || [];
          doc.characters = doc.characters || [];
          doc.relationships = doc.relationships || [];
          this.documents.push(doc);
        }
      }

      // 重建 embedder 索引
      const allChunks = this.documents.flatMap(d => d.chunks);
      embedder.buildIndex(allChunks);
      console.log(`[Indexer] 从 ${this.indexFile} 加载了 ${this.documents.length} 个文档`);
    } catch (err) {
      this.documents = [];
      console.warn(`[Indexer] 加载索引失败: ${err.message}，将使用空索引`);
    }
  }

  _loadOldFormat() {
    try {
      const data = JSON.parse(fs.readFileSync(this.indexFile, 'utf-8'));
      this.documents = (data.documents || []).map(d => ({
        ...d,
        docType: d.docType || 'technical'
      }));
      const allChunks = this.documents.flatMap(d => d.chunks);
      embedder.buildIndex(allChunks);
      console.log(`[Indexer] 从旧格式索引加载了 ${this.documents.length} 个文档`);
    } catch (err) {
      console.warn(`[Indexer] 旧格式加载失败: ${err.message}`);
      this.documents = [];
    }
  }

  /**
   * 同步完整保存：将所有文档序列化后直接写入文件
   * 包含完整章节原文（支持重启后重分析）
   */
  _saveIndexStream() {
    try {
      const serialized = this.documents.map(doc => {
        const copy = { ...doc };
        // chapters 保留完整文本（start/end 仍保留，text 也存以便重分析）
        if (copy.chapters) {
          copy.chapters = copy.chapters.map(c => ({
            chapterIndex: c.chapterIndex,
            title: c.title,
            start: c.start,
            end: c.end,
            text: c.text || ''
          }));
        }
        return copy;
      });

      const json = JSON.stringify(serialized, null, 2);
      fs.writeFileSync(this.indexFile, json, 'utf-8');
    } catch (err) {
      console.error(`[Indexer] 保存索引失败: ${err.message}`);
    }
  }

  _trimText(text, maxLength) {
    const value = String(text || '').replace(/\s+/g, ' ').trim();
    if (value.length <= maxLength) return value;
    return value.slice(0, maxLength) + '...';
  }

}

const indexer = new Indexer();
module.exports = { Indexer, indexer };
