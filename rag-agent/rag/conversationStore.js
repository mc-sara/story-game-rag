/**
 * 对话历史存储
 * 每个 query+answer 为一条记录，归属于一个 session
 */

const fs = require('fs');
const path = require('path');

const CONFIG = require('../config.js');

const DATA_DIR = CONFIG.DATA_DIR;
const HISTORY_FILE = path.join(DATA_DIR, 'conversations.json');

// 确保 data 目录存在
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

class ConversationStore {
  constructor() {
    this.sessions = new Map();   // sessionId -> session
    this._load();
  }

  _load() {
    try {
      if (!fs.existsSync(HISTORY_FILE)) return;
      const raw = fs.readFileSync(HISTORY_FILE, 'utf-8').trim();
      if (!raw || raw === '[]') return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const session of parsed) {
          if (!session.id) continue;
          this.sessions.set(session.id, session);
        }
      }
    } catch (err) {
      console.warn(`[ConversationStore] 加载失败: ${err.message}`);
    }
  }

  _save() {
    try {
      const all = Array.from(this.sessions.values());
      fs.writeFileSync(HISTORY_FILE, JSON.stringify(all, null, 2), 'utf-8');
    } catch (err) {
      console.error(`[ConversationStore] 保存失败: ${err.message}`);
    }
  }

  /**
   * 创建新会话
   */
  createSession(docId, docName) {
    const id = `sess_${Date.now()}`;
    const session = {
      id,
      docId: docId || null,
      docName: docName || null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: []
    };
    this.sessions.set(id, session);
    this._save();
    return session;
  }

  /**
   * 如果 session 不存在则创建（幂等操作，用于 query 时自动建会话）
   */
  createSessionIfNotExists(sessionId, docId, docName) {
    if (this.sessions.has(sessionId)) return this.sessions.get(sessionId);
    const session = {
      id: sessionId,
      docId: docId || null,
      docName: docName || null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: []
    };
    this.sessions.set(sessionId, session);
    this._save();
    return session;
  }

  /**
   * 添加对话记录
   */
  addMessage(sessionId, { question, answer, answerSource, sources, docType, hasContext }) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    session.updatedAt = Date.now();
    session.messages.push({
      id: `msg_${Date.now()}`,
      question,
      answer,
      answerSource,
      sources: sources || [],
      docType,
      hasContext,
      timestamp: Date.now()
    });
    this._save();
    return session;
  }

  /**
   * 获取会话列表（按更新时间倒序）
   */
  listSessions() {
    return Array.from(this.sessions.values())
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(s => ({
        id: s.id,
        docId: s.docId,
        docName: s.docName,
        messageCount: s.messages.length,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        lastQuestion: s.messages.length > 0
          ? s.messages[s.messages.length - 1].question
          : null
      }));
  }

  /**
   * 获取单个会话（含完整消息）
   */
  getSession(sessionId) {
    return this.sessions.get(sessionId) || null;
  }

  /**
   * 删除会话
   */
  deleteSession(sessionId) {
    const deleted = this.sessions.delete(sessionId);
    if (deleted) this._save();
    return deleted;
  }

  /**
   * 清空所有会话
   */
  clearAll() {
    this.sessions.clear();
    this._save();
  }
}

const conversationStore = new ConversationStore();
module.exports = { conversationStore };
