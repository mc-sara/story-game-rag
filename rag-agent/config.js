/**
 * RAG Agent 配置文件
 *
 * 本项目使用 oops.asia API 作为 LLM，
 * Embedding 使用 Node.js 端的 TF-IDF + 余弦相似度实现（免费、离线可用）。
 */

require('dotenv').config();

const CONFIG = {
  // oops.asia API 配置
  API_KEY: process.env.API_KEY || '',
  BASE_URL: process.env.BASE_URL || 'https://api.hushijunshitiancai666.store/v1',

  // 模型配置
  MODEL: process.env.MODEL || 'gpt-5.5',
  MAX_TOKENS: parseInt(process.env.MAX_TOKENS) || 2048,
  TEMPERATURE: parseFloat(process.env.TEMPERATURE) || 0.7,

  // RAG 配置
  TOP_K_CHUNKS: parseInt(process.env.TOP_K_CHUNKS) || 3,
  CHUNK_SIZE: parseInt(process.env.CHUNK_SIZE) || 500,
  CHUNK_OVERLAP: parseInt(process.env.CHUNK_OVERLAP) || 50,

  // 服务配置
  PORT: parseInt(process.env.PORT) || 3000,
  TIMEOUT: parseInt(process.env.TIMEOUT) || 60000,
  INDEX_FILE: process.env.INDEX_FILE || './index.json'
};

module.exports = CONFIG;
