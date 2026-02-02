import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { analyzeV3Position } from './v3LpAnalyzer.js';

const PORT = 3000;

// 获取当前目录路径 (ES Module 模式下需要这样获取 __dirname)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const server = http.createServer(async (req, res) => {
  // 1. 设置 CORS 头 (API 使用)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // 2. 处理预检请求
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // 3. 构建 URL 对象
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // ================= 路由逻辑 =================

  // [路由 1] API 接口: /analyze
  if (pathname === '/analyze' && req.method === 'GET') {
    try {
      const chain = url.searchParams.get('chain');
      const protocol = url.searchParams.get('protocol');
      const tokenId = url.searchParams.get('tokenId');
      const costUsd = url.searchParams.get('costUsd');

      if (!chain || !protocol || !tokenId) {
        throw new Error('Missing required parameters: chain, protocol, tokenId');
      }

      console.log(`[API Request] Analyzing ${chain}/${protocol} TokenID: ${tokenId}...`);
      
      const result = await analyzeV3Position({
        chain,
        protocol,
        tokenId,
        costUsd: costUsd ? Number(costUsd) : null
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: result }));

    } catch (err) {
      console.error('[API Error]', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
  } 
  
  // [路由 2] 静态页面: / 或 /index.html
  else if (pathname === '/' || pathname === '/index.html') {
    const filePath = path.join(__dirname, 'index.html');

    // 读取 HTML 文件
    fs.readFile(filePath, (err, content) => {
      if (err) {
        if (err.code === 'ENOENT') {
          // 文件不存在
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('404 Not Found: index.html missing');
        } else {
          // 其他服务器错误
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end(`Server Error: ${err.code}`);
        }
      } else {
        // 成功返回 HTML
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(content);
      }
    });
  }
  
  // [路由 3] 忽略 favicon
  else if (pathname === '/favicon.ico') {
    res.writeHead(204);
    res.end();
  } 
  
  // [路由 4] 404 未找到
  else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: false,
      error: 'Endpoint not found. Use / or /analyze'
    }));
  }
});

// 启动服务器
server.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
  console.log(`1. Visit dashboard: http://localhost:${PORT}`);
  console.log(`2. API Endpoint:   http://localhost:${PORT}/analyze`);
});