/**
 * 向量化与检索器 (Embedder) v2
 *
 * 升级点：
 * 1. 混合检索：摘要 chunk（chunkType=summary）和原始内容 chunk（chunkType=content）
 * 2. 摘要层优先召回：先用摘要快速缩小范围
 * 3. 内容层精确召回：从摘要命中的章节中拉取原始段落
 *
 * 搜索流程（小说）：
 *   query → 摘要索引检索（top-5 summaries）
 *              ↓
 *         确定相关章节 → 内容索引检索（这些章节的 chunks）
 *              ↓
 *         合并 + Rerank → top-3
 *
 * 搜索流程（技术文档）：
 *   query → 内容索引检索（top-3，直接同 v1）
 */

const natural = require('natural');

class TFIDFEmbedder {
  constructor() {
    this.tfidf = new natural.TfIdf();
    this.chunks = [];
    this.summaryChunks = [];  // 摘要层
    this.contentChunks = []; // 内容层
    this.stemmer = natural.PorterStemmerZh || natural.PorterStemmer;
  }

  /**
   * 构建索引：将 chunks 分层建立 TF-IDF 向量空间
   * @param {Array<object>} chunks - 每个 chunk 有 chunkType: 'summary' | 'content'
   */
  buildIndex(chunks) {
    this.chunks = chunks;

    // 分层存储
    this.summaryChunks = chunks.filter(c => c.chunkType === 'summary');
    this.contentChunks = chunks.filter(c => c.chunkType === 'content');

    // 重建全局 TF-IDF 索引（用于内容层检索）
    this.tfidf = new natural.TfIdf();
    chunks.forEach((chunk, index) => {
      const tokens = this._tokenize(chunk.text);
      this.tfidf.addDocument(tokens, index.toString());
    });

    console.log(`[Embedder] 索引构建完成：` +
      `${chunks.length} 个 chunks，` +
      `${this.summaryChunks.length} 个摘要，` +
      `${this.contentChunks.length} 个内容`);
  }

  _tokenize(text) {
    const tokens = [];
    const englishWords = text.match(/[a-zA-Z]+/g) || [];
    englishWords.forEach(word => {
      tokens.push(this.stemmer.stem(word.toLowerCase()));
    });
    const chineseChars = text.match(/[\u4e00-\u9fa5]/g) || [];
    for (let i = 0; i < chineseChars.length - 1; i++) {
      tokens.push(chineseChars[i] + chineseChars[i + 1]);
    }
    chineseChars.forEach(c => tokens.push(c));
    return tokens;
  }

  // -------------------------------------------------------------------------
  // 混合检索
  // -------------------------------------------------------------------------

  /**
   * 搜索最相关的 chunks
   *
   * @param {string} query - 用户问题
   * @param {number} topK - 返回前 K 个结果
   * @param {'all'|'novel'|'technical'} docType - 文档类型
   * @param {object} extraData - 额外数据（如小说角色/关系信息）
   * @param {string|null} docId - 限定检索的文档 ID（null 则搜全部）
   * @returns {Array<{chunk: object, score: number, layer: string}>}
   */
  search(query, topK = 3, docType = 'all', extraData = {}, docId = null) {
    if (this.chunks.length === 0) return [];

    if (docType === 'novel' && this.summaryChunks.length > 0) {
      return this._hybridSearch(query, topK, extraData, docId);
    } else {
      return this._simpleSearch(query, topK, docId);
    }
  }

  /**
   * 简单检索（技术文档）
   */
  _simpleSearch(query, topK, docId = null) {
    const candidates = docId
      ? this.chunks.filter(c => c.docId === docId)
      : this.chunks;
    if (candidates.length === 0) return [];
    const localTfidf = new natural.TfIdf();
    candidates.forEach((chunk, i) => {
      localTfidf.addDocument(this._tokenize(chunk.text), i.toString());
    });
    const results = this._scoreChunksWithTfidf(query, candidates, localTfidf);
    return results.slice(0, topK).map(r => ({ ...r, layer: 'content' }));
  }

  /**
   * 混合检索（小说）
   * 策略：摘要层召回 → 定位相关章节 → 内容层精确召回 → 合并
   */
  _hybridSearch(query, topK, extraData = {}, docId = null) {
    // 先按 docId 过滤出当前小说的摘要和内容 chunks
    const mySummaryChunks   = docId ? this.summaryChunks.filter(c => c.docId === docId) : this.summaryChunks;
    const myContentChunks   = docId ? this.contentChunks.filter(c => c.docId === docId) : this.contentChunks;

    // Step 1: 摘要层检索（粗召回，快速定位意图）
    // 注意：必须用局部 TF-IDF（仅当前小说的摘要 chunks 建索引），不能用全局 this.tfidf
    const summaryTfidf = new natural.TfIdf();
    mySummaryChunks.forEach((chunk, i) => {
      summaryTfidf.addDocument(this._tokenize(chunk.text), i.toString());
    });
    const summaryResults = this._scoreChunksWithTfidf(query, mySummaryChunks, summaryTfidf);
    const topSummaries = summaryResults.slice(0, 5);

    if (topSummaries.length === 0) {
      // 没有摘要命中，降级到内容层
      return this._simpleSearch(query, topK, docId);
    }

    // Step 2: 确定相关章节（仅当前小说）
    const relatedChapterIndices = new Set(
      topSummaries.map(r => r.chunk.chapterIndex)
    );

    // Step 3: 内容层检索（仅限相关章节的 chunks）
    const relatedContentChunks = myContentChunks.filter(
      c => relatedChapterIndices.has(c.chapterIndex)
    );

    let contentResults = [];
    if (relatedContentChunks.length > 0) {
      // 重新对内容层建一个局部 TF-IDF
      const contentTfidf = new natural.TfIdf();
      relatedContentChunks.forEach((chunk, i) => {
        contentTfidf.addDocument(this._tokenize(chunk.text), i.toString());
      });
      contentResults = this._scoreChunksWithTfidf(query, relatedContentChunks, contentTfidf);
    }

    // Step 4: 合并两个结果（摘要层 + 内容层），加权排序
    const combined = [
      ...topSummaries.map(r => ({ ...r, layer: 'summary', weight: 1.2 })),
      ...contentResults.map(r => ({ ...r, layer: 'content', weight: 1.0 }))
    ];

    // 去重：同一文档同一章节的内容 chunk 只保留 top-1
    const seenChapters = new Set();
    const deduped = [];
    for (const r of combined) {
      const key = `${r.chunk.docId}-${r.chunk.chapterIndex}-${r.layer}`;
      if (!seenChapters.has(key)) {
        seenChapters.add(key);
        deduped.push(r);
      }
    }

    // 权重加成后排序
    deduped.sort((a, b) => (b.score * b.weight) - (a.score * a.weight));

    return deduped.slice(0, topK);
  }

  /**
   * 对所有 chunks 打分
   */
  _scoreAllChunks(query) {
    return this._scoreChunksWithTfidf(query, this.chunks, this.tfidf);
  }

  _scoreChunks(query, chunks, tfidf) {
    return this._scoreChunksWithTfidf(query, chunks, tfidf);
  }

  _scoreChunksWithTfidf(query, chunks, tfidf) {
    const queryTokens = this._tokenize(query);

    const results = [];
    chunks.forEach((chunk, index) => {
      const score = this._cosineSimilarity(queryTokens, tfidf, index);
      if (score > 0) {
        results.push({ chunk, score });
      }
    });

    results.sort((a, b) => b.score - a.score);
    return results;
  }

  _cosineSimilarity(queryTokens, tfidf, docIndex) {
    const docTerms = tfidf.documents[docIndex];
    if (!docTerms) return 0;

    const queryVector = {};
    const docTermSet = new Set(Object.keys(docTerms));

    queryTokens.forEach(term => {
      if (docTermSet.has(term)) {
        const tf = queryTokens.filter(t => t === term).length / queryTokens.length;
        const idf = this._getIDF(term, tfidf);
        queryVector[term] = tf * idf;
      }
    });

    let dotProduct = 0;
    Object.keys(queryVector).forEach(term => {
      dotProduct += queryVector[term] * docTerms[term];
    });

    const queryNorm = Math.sqrt(Object.values(queryVector).reduce((s, v) => s + v * v, 0));
    const docNorm = Math.sqrt(Object.values(docTerms).reduce((s, v) => s + v * v, 0));

    if (queryNorm === 0 || docNorm === 0) return 0;
    return dotProduct / (queryNorm * docNorm);
  }

  _getIDF(term, tfidf) {
    let docFreq = 0;
    for (const doc of tfidf.documents) {
      if (doc && term in doc) docFreq++;
    }
    if (docFreq === 0) return 0;
    return Math.log(tfidf.documents.length / docFreq);
  }

  getStats() {
    return {
      totalChunks: this.chunks.length,
      summaryChunks: this.summaryChunks.length,
      contentChunks: this.contentChunks.length,
      vocabSize: this.tfidf.listTerms(0).length
    };
  }
}

const embedder = new TFIDFEmbedder();
module.exports = { TFIDFEmbedder, embedder };
