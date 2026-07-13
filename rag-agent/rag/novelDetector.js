/**
 * 文档类型检测器 & 章节切分器 (Novel Detector)
 *
 * RAG 增强第一步：识别文档类型
 *
 * 判断逻辑：
 * 1. 通过文件名关键词（小说/书/作者名 + txt） → 初步判定小说
 * 2. 通过章节标记密度（每 N 段出现一次章节标记） → 确认小说
 * 3. 通过结构性特征评分（对话占比、短段落密度、叙事词频率等） → 辅助判断（普适，不依赖具体内容）
 *
 * 章节检测正则（覆盖主流中文网络小说格式）：
 * - "第X章" / "第X节"
 * - "☆、" / "★、" / "●、" 开头的行
 * - "第X卷"
 * - 纯数字编号 "1. " "2. "
 */

const CONFIG = require('../config.js');

// 章节标题正则（优先级从高到低）
const CHAPTER_PATTERNS = [
  // ☆、第1章 标题
  { regex: /^[\s　]*(?:☆|★|●|○|■|□|▲|△|◆|◇)\s*[,，\.。]?\s*(.+)$/m,        titleGroup: 1 },
  // 第1章 标题
  { regex: /^[\s　]*(?:第)[一二三四五六七八九十百千0-9零一二三四五六七八九十百千]{1,6}(?:章|节|卷|部)\s*[,，\.。]?\s*(.*)$/m, titleGroup: 1 },
  // 1. 标题 / 01. 标题
  { regex: /^[\s　]*(\d{1,3})\s*[.、]\s*(.+)$/m,                              titleGroup: 2 },
  // 第 1 章（中间有空格）
  { regex: /^[\s　]*(?:第)\s*[一二三四五六七八九十百千0-9零一二三四五六七八九十百千]{1,6}\s*(?:章|节|卷)\s*[,，\.。]?\s*(.*)$/m, titleGroup: 1 },
  // 【第X章】标题
  { regex: /^[\s　]*【(.+?)】\s*$/m,                                            titleGroup: 1 },
];

// ============================
// 结构性特征评分（普适，不依赖具体内容词）
// ============================

/**
 * 通过文本结构性特征判断文档类型
 * @param {string} text - 采样文本（前 3000 字符）
 * @returns {{ novelScore: number, techScore: number }}
 */
function scoreStructuralFeatures(text) {
  const lines = text.split('\n');
  const totalLines = Math.max(lines.length, 1);

  // 1. 对话行占比：引号对出现次数 / 总行数
  const quotePairs = (text.match(/["""'"][^"""\n]{2,50}["""'"]/g) || []).length;
  const quoteScore = Math.min(quotePairs / totalLines * 10, 1);

  // 2. 短句段落密度：平均每段字数（小说 < 40，技术文档 > 60）
  const paragraphs = text.split(/\n\n+/).filter(p => p.trim().length > 0);
  const avgParaLen = paragraphs.length > 0
    ? paragraphs.reduce((sum, p) => sum + p.trim().length, 0) / paragraphs.length
    : 100;
  const shortParaRatio = paragraphs.filter(p => p.trim().length < 40).length
    / Math.max(paragraphs.length, 1);

  // 3. 章节标题密度：章节正则能匹配多少行
  const chapterMatches = findChapterMarkers(text);
  const chapterDensity = chapterMatches.length / totalLines;

  // 4. 叙事视角词频率（中性词，任何小说都会出现）
  const narrativeWords = (text.match(
    /[我你他她它]说|[我你他她它]道|[我你他她它]见|[我你他她它]想|只见|不觉|心中|忽然|缓缓|低声|抬头|转身/g
  ) || []).length;
  const narrativeScore = Math.min(narrativeWords / 30, 1);

  // 5. 重复人名模式：同一行出现多次人名（人名=2-3字词，非词表）
  const potentialNames = (text.match(/[一-龥]{2,3}(?=[:：,\s]|$)/g) || []);
  const uniqueNames = [...new Set(potentialNames)];
  const nameDensity = Math.min(Math.max((uniqueNames.length - 3) / 20, 0), 1);

  // 6. 技术文档反指征
  const hasCodeBlock = /```|def\s|class\s|function\s|import\s/.test(text);
  const hasFormula  = /\$\$[\s\S]+?\$\$|\{[^}]{5,50}\}/.test(text);
  const hasUrl       = /https?:\/\/|www\./.test(text);
  const techScore = (hasCodeBlock ? 0.3 : 0) + (hasFormula ? 0.3 : 0) + (hasUrl ? 0.1 : 0);

  // 综合小说评分
  const novelScore =
    quoteScore * 0.25 +
    shortParaRatio * 0.2 +
    (chapterDensity > 0.002 ? 1 : chapterDensity * 300) * 0.25 +
    narrativeScore * 0.15 +
    nameDensity * 0.15;

  return { novelScore, techScore };
}

/**
 * 检测文档类型
 * @param {string} fileName - 文件名
 * @param {string} text - 文档内容（前 3000 字符采样）
 * @returns {'novel' | 'technical' | 'unknown'}
 */
function detectDocType(fileName, text) {
  const fileNameLower = fileName.toLowerCase();
  const isLikelyNovelByName = ['小说', '书', 'book', 'novel'].some(k => fileNameLower.includes(k));

  // 章节标记密度
  const chapterMatches = findChapterMarkers(text);
  const chapterDensity = chapterMatches.length / Math.max(text.split('\n').length, 1);

  // 结构性特征评分
  const { novelScore, techScore } = scoreStructuralFeatures(text.substring(0, 3000));

  // 决策
  if (isLikelyNovelByName && chapterDensity > 0.01) return 'novel';
  if (techScore > novelScore + 0.2) return 'technical';
  if (chapterDensity > 0.003 && novelScore > 0.15) return 'novel';
  if (isLikelyNovelByName) return 'novel';

  return 'unknown';
}

/**
 * 找出所有章节标题位置
 * @param {string} text - 全文章节
 * @returns {Array<{title: string, start: number, end: number, index: number}>}
 */
function findChapterMarkers(text) {
  const lines = text.split('\n');
  const markers = [];
  let charOffset = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineStart = charOffset;
    const lineEnd = charOffset + line.length;

    for (const pattern of CHAPTER_PATTERNS) {
      const match = line.match(pattern.regex);
      if (match) {
        const title = (match[pattern.titleGroup] || match[1] || '').trim();
        if (title && title.length >= 2 && title.length <= 50) {
          markers.push({
            title,
            lineIndex: i,
            start: lineStart,
            end: lineEnd,
            index: markers.length
          });
          break; // 每个标题行只取第一个匹配
        }
      }
    }

    charOffset = lineEnd + 1; // +1 for newline
  }

  return markers;
}

/**
 * 将文本按章节切分
 * @param {string} text - 全文章节
 * @returns {Array<{chapterIndex: number, title: string, start: number, end: number, text: string}>}
 */
function splitByChapters(text) {
  const markers = findChapterMarkers(text);
  const lines = text.split('\n');
  const chapters = [];

  // 预处理：计算每行的字符偏移量
  const lineOffsets = [0];
  for (let i = 0; i < lines.length; i++) {
    lineOffsets.push(lineOffsets[i] + lines[i].length + 1);
  }

  // 无章节标记：整篇作为一个"章节"
  if (markers.length === 0) {
    chapters.push({
      chapterIndex: 0,
      title: '(无章节标题)',
      start: 0,
      end: text.length,
      text: text.trim()
    });
    return chapters;
  }

  // 按章节切分
  for (let i = 0; i < markers.length; i++) {
    const marker = markers[i];
    const nextMarker = markers[i + 1];

    const startOffset = marker.lineIndex;
    const endOffset = nextMarker ? nextMarker.lineIndex : lines.length;

    // 章节内容：从标题下一行到下一个标题前
    const chapterLines = lines.slice(startOffset + 1, endOffset);
    const chapterText = chapterLines.join('\n').trim();

    if (!chapterText || chapterText.length < 20) continue; // 过滤太短的章节

    chapters.push({
      chapterIndex: chapters.length,
      title: marker.title,
      start: lineOffsets[startOffset],
      end: nextMarker ? lineOffsets[nextMarker.lineIndex] : text.length,
      text: chapterText
    });
  }

  return chapters;
}

/**
 * 对小说章节做二次分块（每个章节内部按段落继续切）
 * 确保单个 chunk 不会跨章节
 *
 * @param {Array<{chapterIndex: number, title: string, text: string, start: number, end: number}>} chapters
 * @param {number} chunkSize - 每块最大字符数
 * @param {number} overlap - 重叠字符数
 * @returns {Array<object>}
 */
function chunkChapters(chapters, chunkSize, overlap) {
  const allChunks = [];

  for (const chapter of chapters) {
    const paragraphs = chapter.text
      .split(/\n\n+/)
      .map(p => p.trim())
      .filter(p => p.length > 0);

    let currentChunk = '';
    let chunkStart = chapter.start;

    for (const para of paragraphs) {
      if (para.length > chunkSize) {
        // 当前有积压则先保存
        if (currentChunk.length >= 100) {
          allChunks.push({
            id: `chunk_${allChunks.length}`,
            text: currentChunk.trim(),
            start: chunkStart,
            end: chunkStart + currentChunk.trim().length,
            chapterIndex: chapter.chapterIndex,
            chapterTitle: chapter.title
          });
          // 带重叠
          const overlapText = currentChunk.slice(-overlap);
          currentChunk = overlapText + '\n\n' + para;
          chunkStart = chunkStart + currentChunk.length - para.length - overlap;
        } else {
          // 当前chunk太小，直接用截断的段落
          currentChunk = para.substring(0, chunkSize);
          chunkStart = chunkStart + currentChunk.length;
        }
      } else if (currentChunk.length + para.length + 2 <= chunkSize) {
        currentChunk += (currentChunk ? '\n\n' : '') + para;
      } else {
        // 保存当前 chunk，启用新 chunk
        if (currentChunk.length >= 50) {
          allChunks.push({
            id: `chunk_${allChunks.length}`,
            text: currentChunk.trim(),
            start: chunkStart,
            end: chunkStart + currentChunk.trim().length,
            chapterIndex: chapter.chapterIndex,
            chapterTitle: chapter.title
          });
          // 重叠部分
          const overlapText = currentChunk.slice(-overlap);
          currentChunk = overlapText + '\n\n' + para;
          chunkStart = chunkStart + currentChunk.length - para.length - overlap;
        } else {
          currentChunk = para;
        }
      }
    }

    // 章节末尾剩余内容
    if (currentChunk.trim().length >= 50) {
      allChunks.push({
        id: `chunk_${allChunks.length}`,
        text: currentChunk.trim(),
        start: chunkStart,
        end: chapter.end,
        chapterIndex: chapter.chapterIndex,
        chapterTitle: chapter.title
      });
    }
  }

  return allChunks;
}

/**
 * 处理小说文本：检测类型 → 切分章节 → 分块
 *
 * @param {string} text - 全文章节
 * @param {string} fileName - 文件名（用于类型检测）
 * @returns {{ type: string, chapters: Array, chunks: Array }}
 */
function processNovel(text, fileName) {
  const docType = detectDocType(fileName, text);
  if (docType !== 'novel' && docType !== 'unknown') {
    return { type: docType, chapters: [], chunks: null };
  }

  const chapters = splitByChapters(text);
  const chunkSize = CONFIG.CHUNK_SIZE || 500;
  const overlap = CONFIG.CHUNK_OVERLAP || 50;
  const chunks = chunkChapters(chapters, chunkSize, overlap);

  return { type: 'novel', chapters, chunks };
}

module.exports = { detectDocType, findChapterMarkers, splitByChapters, chunkChapters, processNovel, scoreStructuralFeatures };
