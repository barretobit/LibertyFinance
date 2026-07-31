const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8765;
const DATA_DIR = 'C:\\LibertyFinance\\Data';
const DATA_FILE = path.join(DATA_DIR, 'liberty-finance.json');
const PUBLIC_DIR = __dirname;

try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  console.log('Data directory: ' + DATA_DIR);
} catch (e) {
  console.error('Failed to create data directory:', e.message);
  process.exit(1);
}

const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // API: GET /api/data — load from file
  if (req.url === '/api/data' && req.method === 'GET') {
    fs.readFile(DATA_FILE, 'utf8', (err, content) => {
      if (err) {
        if (err.code === 'ENOENT') {
          const empty = { custodians: [], portfolios: [], accounts: [], transactions: [], incomes: [], expenses: [], debts: [], goals: [] };
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(empty));
        } else {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(content);
    });
    return;
  }

  // API: POST /api/data — save to file
  if (req.url === '/api/data' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      fs.writeFile(DATA_FILE, body, 'utf8', err => {
        if (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      });
    });
    return;
  }

  // Serve static files
  const urlPath = req.url.split('?')[0];
  let filePath = urlPath === '/' ? '\\index.html' : decodeURIComponent(urlPath);
  filePath = path.normalize(filePath).replace(/^\.\.(\/|\\)?/, '');
  const fullPath = path.join(PUBLIC_DIR, filePath);

  // Prevent directory traversal
  if (!fullPath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const ext = path.extname(fullPath);

  fs.readFile(fullPath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404);
        res.end('Not found');
      } else {
        res.writeHead(500);
        res.end('Server error');
      }
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  });
});

server.listen(PORT, () => {
  console.log('');
  console.log('  ========================================');
  console.log('   LIBERTY FINANCE — Wealth Management');
  console.log('  ========================================');
  console.log('   Server:  http://localhost:' + PORT);
  console.log('   Data:    ' + DATA_FILE);
  console.log('  ========================================');
  console.log('');
});
