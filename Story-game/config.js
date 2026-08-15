/**
 * Story-game browser config.
 *
 * 真实 API Key 已改由 Story-game/server.js 的服务端代理处理（从环境变量读取），
 * 前端不再持有 Key。这里只保留非敏感的生成参数。
 * 模型名 / Key / Base URL 请在 Railway 环境变量中配置。
 */

const CONFIG = {
  MODEL: 'deepseek-v4-flash',
  MAX_TOKENS: 2048,
  TEMPERATURE: 0.8
};
