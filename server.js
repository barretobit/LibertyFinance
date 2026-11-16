/* ===== Liberty Finance — static dev server (LOCAL PREVIEW ONLY) =====
 *
 * GitHub Pages serves the very same files in production; this tiny server is
 * only here so you can preview the site locally:  node server.js
 *
 * No API, no file access — everything runs client-side in the browser.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8765;
const PUBLIC_FOLDER = __dirname;

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

const server = http.createServer((request, response) => {
  const parsedUrl = new URL(request.url, 'http://localhost');
  let filePath = parsedUrl.pathname === '/' ? '/index.html' : decodeURIComponent(parsedUrl.pathname);
  filePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, '');
  const fullPath = path.join(PUBLIC_FOLDER, filePath);

  // Prevent directory traversal
  if (!fullPath.startsWith(PUBLIC_FOLDER)) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }

  const extension = path.extname(fullPath);

  fs.readFile(fullPath, (error, content) => {
    if (error) {
      response.writeHead(404);
      response.end('Not found');
      return;
    }
    response.writeHead(200, { 'Content-Type': MIME[extension] || 'application/octet-stream' });
    response.end(content);
  });
});

server.listen(PORT, () => {
  console.log('');
  console.log('  ========================================');
  console.log('   LIBERTY FINANCE — Wealth Management');
  console.log('  ========================================');
  console.log('   Local preview: http://localhost:' + PORT);
  console.log('   Production:    GitHub Pages (static files)');
  console.log('  ========================================');
  console.log('');
});
