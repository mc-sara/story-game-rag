/**
 * 文本分块器 (Text Chunker)
 *
 * RAG 第一步：分块
 * 将长文档切分成固定大小的 chunk，以便检索时能精确定位相关内容。
 *
 * 策略说明：
 * 1. 按段落分割（\n\n），保留语义完整性
 * 2. 每个 chunk 不超过 CHUNK_SIZE 字符
 * 3. 相邻 chunk 有 CHUNK_OVERLAP 字符重叠，保证跨段落的信息不丢失
 * 4. 超长段落强制截断（尾部截断）
 *
 * 学习要点：
 * - chunk 大小影响检索粒度：太大丢失精度，太小丢失上下文
 * - 重叠机制解决的是"答案跨两个 chunk"的问题
 * - 更高级方案：按句子边界切分（而非字符数）+ 递归分块
 */

const CONFIG = require('../config.js');

/**
 * 将文本按段落分割
 * @param {string} text - 原始文本
 * @returns {string[]} 段落数组
 */
function splitByParagraphs(text) {
  // 按双换行分割段落
  return text.split(/\n\n+/).map(p => p.trim()).filter(p => p.length > 0);
}

/**
 * 将长段落按字符数限制截断
 * @param {string} text - 输入文本
 * @param {number} maxLen - 最大字符数
 * @returns {string} 截断后的文本
 */
function truncateText(text, maxLen) {
  if (text.length <= maxLen) return text;
  // 在 maxLen 处截断，保留末尾完整句子感
  return text.substring(0, maxLen);
}

/**
 * 核心分块函数
 *
 * @param {string} text - 原始文档文本
 * @param {object} options - 可选配置覆盖
 * @param {number} options.chunkSize - 每块最大字符数（默认 500）
 * @param {number} options.overlap - 相邻块重叠字符数（默认 50）
 * @returns {Array<{id: string, text: string, start: number, end: number}>}
 */
function chunkText(text, options = {}) {
  const chunkSize = options.chunkSize || CONFIG.CHUNK_SIZE;
  const overlap = options.overlap || CONFIG.CHUNK_OVERLAP;

  // 清理文本：统一换行符，移除多余空白
  const cleaned = text.replace(/\r\n/g, '\n').replace(/\t/g, ' ').trim();
  if (!cleaned) return [];

  const paragraphs = splitByParagraphs(cleaned);
  const chunks = [];
  let globalOffset = 0; // 当前处理到的全局字符位置

  for (const para of paragraphs) {
    const paraLen = para.length;

    // 如果单段落就超长，直接截断
    if (paraLen > chunkSize) {
      const start = globalOffset;
      const end = globalOffset + chunkSize;
      chunks.push({
        id: `chunk_${chunks.length}`,
        text: truncateText(para, chunkSize),
        start,
        end
      });
      globalOffset += paraLen + 2; // +2 for \n\n
      continue;
    }

    // 普通段落：尝试追加到最后一个 chunk
    if (chunks.length === 0) {
      chunks.push({
        id: `chunk_${chunks.length}`,
        text: para,
        start: globalOffset,
        end: globalOffset + paraLen
      });
    } else {
      const lastChunk = chunks[chunks.length - 1];

      if (lastChunk.text.length + paraLen + 2 <= chunkSize) {
        // 可以合并到上一个 chunk
        const separator = lastChunk.text.endsWith('。') || lastChunk.text.endsWith('.') ? ' ' : '\n\n';
        lastChunk.text += separator + para;
        lastChunk.end = globalOffset + paraLen;
      } else {
        // 需要创建新 chunk（带重叠）
        const overlapText = lastChunk.text.slice(-overlap);
        chunks.push({
          id: `chunk_${chunks.length}`,
          text: overlapText + (overlapText ? '\n\n' : '') + para,
          start: globalOffset - overlap,
          end: globalOffset + paraLen
        });
      }
    }

    globalOffset += paraLen + 2; // +2 for paragraph separator
  }

  // 重新生成 chunk ID（从 0 开始，便于理解）
  return chunks.map((c, i) => ({ ...c, id: `chunk_${i}` }));
}

/**
 * 为文档生成所有 chunks，带文档归属元数据
 *
 * @param {string} docId - 文档 ID
 * @param {string} docName - 文档名称（用于引用展示）
 * @param {string} text - 文档文本
 * @returns {Array<object>} 带元数据的 chunks
 */
function chunkDocument(docId, docName, text) {
  const chunks = chunkText(text);
  return chunks.map(c => ({
    ...c,
    docId,
    docName
  }));
}

module.exports = { chunkText, chunkDocument, splitByParagraphs };
