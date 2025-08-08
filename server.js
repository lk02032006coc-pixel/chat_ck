import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import fetch from 'node-fetch';
import dotenv from 'dotenv';

dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const PORT = process.env.PORT || 8080;

const rooms = new Map();

const app = express();
app.use(express.json({ limit: '128kb' }));

app.post('/publish', async (req, res) => {
  try {
    const { roomId, author, uuid, msg, ts } = req.body || {};
    if (!roomId || !msg) return res.status(400).json({ ok: false, error: 'bad data' });

    const text = `[${roomId}] ${author ?? 'unknown'}: ${msg}`;
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text })
    });

    const payload = { roomId, author, uuid, msg, ts: ts ?? Date.now() };
    broadcast(roomId, JSON.stringify({ type: 'clan', data: payload }));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'server error' });
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const roomId = url.searchParams.get('room');
  if (!roomId) return ws.close();
  if (!rooms.has(roomId)) rooms.set(roomId, new Set());
  rooms.get(roomId).add(ws);

  ws.on('close', () => rooms.get(roomId)?.delete(ws));
});

function broadcast(roomId, msg) {
  const set = rooms.get(roomId);
  if (!set) return;
  for (const ws of set) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

server.listen(PORT, () => console.log('Relay running on port', PORT));
