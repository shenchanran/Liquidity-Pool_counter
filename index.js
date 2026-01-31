import http from 'http';
import { analyzeV3Position } from './v3LpAnalyzer.js'; // 确保文件名对应

const PORT = 3000;

const server = http.createServer(async (req, res) => {
  // 1. 设置 CORS 头，允许前端跨域访问
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // 2. 处理预检请求 (OPTIONS)
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // 3. 构建 URL 对象以解析参数
  // 注意：在 IncomingMessage 中只有 url 路径字符串，需要拼接 base 来构造 URL 对象
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // 4. 路由处理：只处理 /analyze 接口
  if (pathname === '/analyze' && req.method === 'GET') {
    try {
      // 获取参数
      const chain = url.searchParams.get('chain');
      const protocol = url.searchParams.get('protocol');
      const tokenId = url.searchParams.get('tokenId');
      const costUsd = url.searchParams.get('costUsd');

      // 参数校验
      if (!chain || !protocol || !tokenId) {
        throw new Error('Missing required parameters: chain, protocol, tokenId');
      }

      // 调用核心分析函数
      console.log(`[Request] Analyzing ${chain}/${protocol} TokenID: ${tokenId}...`);
      
      const result = await analyzeV3Position({
        chain,
        protocol,
        tokenId,
        costUsd: costUsd ? Number(costUsd) : null
      });

      // 返回成功结果
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        data: result
      }));

    } catch (err) {
      console.error('[Error]', err.message);
      
      // 错误适配：返回 500 和错误信息
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: false,
        error: err.message
      }));
    }
  } else if (pathname === '/favicon.ico') {
    // 忽略 favicon 请求
    res.writeHead(204);
    res.end();
  } else {
    // 404 处理
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: false,
      error: 'Endpoint not found. Use /analyze'
    }));
  }
});

// 启动服务器
server.listen(PORT, () => {
  console.log(`Server is running natively on http://localhost:${PORT}`);
  console.log(`Example: http://localhost:${PORT}/analyze?chain=bsc&protocol=pancake&tokenId=123456&costUsd=1000`);
});