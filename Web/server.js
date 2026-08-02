const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8765;
const DATA_DIR = 'C:\\LibertyFinance\\Data';
const DEFAULT_FILE = 'liberty-finance.json';
const PUBLIC_DIR = __dirname;

const EMPTY_DATA = JSON.stringify({
  custodians: [], portfolios: [], accounts: [], transactions: [],
  incomes: [], expenses: [], debts: [], goals: [],
  exchangeRates: [], settings: {}
});

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

function resolveDataFile(fileName) {
  if (!fileName) fileName = DEFAULT_FILE;
  const safe = path.basename(fileName);
  if (safe !== fileName || path.extname(safe).toLowerCase() !== '.json') return null;
  return path.join(DATA_DIR, safe);
}

function json(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, 'http://localhost');
  const urlPath = parsedUrl.pathname;
  const fileParam = parsedUrl.searchParams.get('file');

  // API: list / create / delete data files
  if (urlPath === '/api/files') {
    if (req.method === 'GET') {
      let names = [];
      try { names = fs.readdirSync(DATA_DIR); } catch (e) { /* no dir yet */ }
      const files = names
        .filter(n => path.extname(n).toLowerCase() === '.json')
        .map(n => {
          const stat = fs.statSync(path.join(DATA_DIR, n));
          return { name: n, size: stat.size, modified: stat.mtime.toISOString() };
        })
        .sort((a, b) => b.modified.localeCompare(a.modified));
      json(res, 200, { files });
      return;
    }

    if (req.method === 'POST') {
      const dataFile = resolveDataFile(fileParam);
      if (!dataFile) { json(res, 400, { error: 'Invalid file name' }); return; }
      if (!fs.existsSync(dataFile)) {
        fs.writeFileSync(dataFile, EMPTY_DATA, 'utf8');
      }
      json(res, 200, { success: true });
      return;
    }

    if (req.method === 'DELETE') {
      const dataFile = resolveDataFile(fileParam);
      if (dataFile && fs.existsSync(dataFile)) {
        fs.unlinkSync(dataFile);
      }
      json(res, 200, { success: true });
      return;
    }

    json(res, 405, { error: 'Method not allowed' });
    return;
  }

  // API: GET /api/data — load from file
  if (urlPath === '/api/data' && req.method === 'GET') {
    const dataFile = resolveDataFile(fileParam);
    fs.readFile(dataFile, 'utf8', (err, content) => {
      if (err) {
        if (err.code === 'ENOENT') {
          json(res, 200, JSON.parse(EMPTY_DATA));
        } else {
          json(res, 500, { error: err.message });
        }
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(content);
    });
    return;
  }

  // API: POST /api/data — save to file
  if (urlPath === '/api/data' && req.method === 'POST') {
    const dataFile = resolveDataFile(fileParam);
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      fs.writeFile(dataFile, body, 'utf8', err => {
        if (err) {
          json(res, 500, { error: err.message });
          return;
        }
        json(res, 200, { success: true });
      });
    });
    return;
  }

  // Serve static files
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
  console.log('   Data:    ' + DATA_DIR);
  console.log('  ========================================');
  console.log('');
});
