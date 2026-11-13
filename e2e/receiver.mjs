// A webhook receiver for the end-to-end test: stores every request and lists them on GET /received.
import { createServer } from 'node:http';

const received = [];

createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/received') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(received));
    return;
  }
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    received.push({
      path: req.url,
      headers: req.headers,
      body: Buffer.concat(chunks).toString('utf8'),
    });
    res.writeHead(204).end();
  });
}).listen(4000, '0.0.0.0');
