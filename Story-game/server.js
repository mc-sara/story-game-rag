const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const STORY_BIBLE_DIR = path.join(__dirname, 'story_bible');
const RAG_AGENT_URL = process.env.RAG_AGENT_URL || 'http://localhost:3000';

// LLM（DeepSeek）服务端配置：真实 Key 只从环境变量读取，绝不进前端/仓库
const API_KEY  = process.env.API_KEY || '';
const BASE_URL = process.env.BASE_URL || 'https://api.deepseek.com';
const MODEL    = process.env.MODEL || 'deepseek-v4-flash';

// 确保目录存在
if (!fs.existsSync(STORY_BIBLE_DIR)) {
  fs.mkdirSync(STORY_BIBLE_DIR, { recursive: true });
}

// ─────────────────────────────────────────
// 静态文件服务（原生 http 实现，无依赖）
// ─────────────────────────────────────────
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon'
};

function serveStatic(req, res) {
  var urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';

  var filePath = path.join(__dirname, urlPath);
  var ext      = path.extname(filePath);
  var mime     = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, function(err, data) {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
}

// ─────────────────────────────────────────
// POST /api/save-bible
// Body: { title: string, ...bibleFields }
// ─────────────────────────────────────────
function handleSaveBible(req, res) {
  var body = '';
  req.on('data', function(chunk) { body += chunk; });
  req.on('end', function() {
    var bible;
    try {
      bible = JSON.parse(body);
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    var title = (bible.title || 'story').replace(/[^\w\u4e00-\u9fa5]/g, '_');
    var now   = new Date();
    var ts    = now.getFullYear() +
      String(now.getMonth() + 1).padStart(2, '0') +
      String(now.getDate()).padStart(2, '0') + '_' +
      String(now.getHours()).padStart(2, '0') +
      String(now.getMinutes()).padStart(2, '0') +
      String(now.getSeconds()).padStart(2, '0');
    var filename = title + '_' + ts + '.json';
    var filePath  = path.join(STORY_BIBLE_DIR, filename);

    fs.writeFile(filePath, JSON.stringify(bible, null, 2), 'utf8', function(err) {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to write file: ' + err.message }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, filename: filename, path: '/story_bible/' + filename }));
    });
  });
}

// ─────────────────────────────────────────
// POST /api/debug-log — 写 NDJSON 调试日志
// Body: { messages: string (one JSON per line) }
// ─────────────────────────────────────────
function handleDebugLog(req, res) {
  var body = '';
  req.on('data', function(chunk) { body += chunk; });
  req.on('end', function() {
    var logPath = '/Users/sara/code/.cursor/debug-fe6f4a.log';
    fs.appendFile(logPath, body + '\n', function(err) {
      if (err) { /* silent */ }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
}

// ─────────────────────────────────────────
// 预读 body（供 handleSaveBible 和代理使用）
// ─────────────────────────────────────────
function readBody(req) {
  return new Promise(function(resolve) {
    var body = '';
    req.on('data', function(chunk) { body += chunk; });
    req.on('end', function() { resolve(body); });
  });
}

// ─────────────────────────────────────────
// 代理到 rag-agent（/api/novels, /api/novel-characters）
// ─────────────────────────────────────────
async function proxyToRagAgent(req, res) {
  var rawBody = await readBody(req);
  var targetUrl = RAG_AGENT_URL + req.url;
  var parsed = new URL(targetUrl);

  var options = {
    hostname: parsed.hostname,
    port:     parsed.port || 443,
    path:     parsed.pathname + parsed.search,
    method:   req.method,
    headers:  {
      'Content-Type':  req.headers['content-type'] || 'application/json',
      'Accept':        'application/json',
      'Content-Length': Buffer.byteLength(rawBody)
    }
  };

  var proxyReq = http.request(options, function(proxyRes) {
    res.writeHead(proxyRes.statusCode, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    });
    var body = '';
    proxyRes.on('data', function(chunk) { body += chunk; });
    proxyRes.on('end', function() {
      res.end(body);
    });
  });

  proxyReq.on('error', function(err) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: '无法连接 RAG Agent: ' + err.message }));
  });

  if (rawBody) proxyReq.write(rawBody);
  proxyReq.end();
}

// ─────────────────────────────────────────
// POST /api/chat-completions — 服务端代理 DeepSeek（隐藏 API Key）
// ─────────────────────────────────────────
function handleChatCompletions(req, res) {
  readBody(req).then(function(rawBody) {
    var payload;
    try {
      payload = JSON.parse(rawBody || '{}');
    } catch (e) {
      payload = {};
    }
    // 模型统一走服务端环境变量，前端传的 model 以这里为准
    payload.model = MODEL;
    var body = JSON.stringify(payload);

    var upstream = BASE_URL.replace(/\/+$/, '') + '/chat/completions';
    var parsed = new URL(upstream);
    var isHttps = parsed.protocol === 'https:';
    var transport = isHttps ? https : http;

    var options = {
      hostname: parsed.hostname,
      port:     parsed.port || (isHttps ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   'POST',
      headers:  {
        'Content-Type':  'application/json',
        'Accept':        'application/json',
        'Authorization': 'Bearer ' + API_KEY,
        'Content-Length': Buffer.byteLength(body)
      }
    };

    var proxyReq = transport.request(options, function(proxyRes) {
      var chunk = '';
      proxyRes.on('data', function(c) { chunk += c; });
      proxyRes.on('end', function() {
        res.writeHead(proxyRes.statusCode, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(chunk);
      });
    });

    proxyReq.on('error', function(err) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '无法连接 LLM API: ' + err.message }));
    });

    proxyReq.write(body);
    proxyReq.end();
  });
}

// ─────────────────────────────────────────
// 路由
// ─────────────────────────────────────────
var server = http.createServer(async function(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'POST' && req.url === '/api/save-bible') {
    handleSaveBible(req, res);
  } else if (req.method === 'POST' && req.url === '/api/debug-log') {
    handleDebugLog(req, res);
  } else if (req.method === 'POST' && req.url === '/api/chat-completions') {
    handleChatCompletions(req, res);
  } else if (req.method === 'GET' && (req.url.startsWith('/api/novels') || req.url.startsWith('/api/novel-characters'))) {
    proxyToRagAgent(req, res);
  } else {
    serveStatic(req, res);
  }
});

var PORT = process.env.PORT || 3002;
server.listen(PORT, function() {
  console.log('Story-game running at http://localhost:' + PORT);
});
