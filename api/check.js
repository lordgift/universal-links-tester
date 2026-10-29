import { handleCheck } from '../lib/check.js';

// Vercel serverless function — ทำหน้าที่เดียวกับ /api/check ใน server.js
export default async function handler(req, res) {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405;
      return res.end(JSON.stringify({ error: 'Method not allowed' }));
    }
    const [status, body] = await handleCheck(new URL(req.url, 'http://localhost').searchParams);
    res.statusCode = status;
    res.end(JSON.stringify(body));
  } catch (err) {
    console.error(err);
    res.statusCode = 500;
    res.end(JSON.stringify({ error: 'Internal server error' }));
  }
}
