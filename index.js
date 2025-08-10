// Simple WebSocket relay + Telegram bridge (improved)
// Uses ws and telegraf. Put your BOT_TOKEN and CHAT_ID into .env or supply via env variables.

const http = require('http');
const WebSocket = require('ws');
const { Telegraf } = require('telegraf');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

require('dotenv').config();

// Configuration
const BOT_TOKEN = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.CHAT_ID || process.env.TELEGRAM_CHAT_ID || process.env.TELE_CHAT_ID || '';
const TELEGRAM_ENABLED = !!(BOT_TOKEN && CHAT_ID);

// Load optional user mappings from relay/user_mappings.json
// Format: { "telegram_username_or_id": "MinecraftName", ... }
let userMappings = {};
const mappingPath = path.join(__dirname, 'user_mappings.json');
try {
  if (fs.existsSync(mappingPath)) {
    const raw = fs.readFileSync(mappingPath, 'utf8');
    userMappings = JSON.parse(raw);
    console.log('[relay] loaded user mappings:', Object.keys(userMappings).length);
  } else {
    console.log('[relay] no user_mappings.json found; create one to map Telegram users to Minecraft names');
  }
} catch (e) {
  console.error('[relay] failed to load user_mappings.json', e);
}

// Simple in-memory dedupe: recent message ids and recent sender|message hashes
const recentIds = new Set();
const recentHashTimestamps = new Map(); // key -> timestamp (ms)
const DEDUPE_WINDOW_MS = 3000; // 3 seconds

function pruneRecent() {
  const now = Date.now();
  for (const [k, t] of recentHashTimestamps.entries()) {
    if (now - t > DEDUPE_WINDOW_MS) recentHashTimestamps.delete(k);
  }
  // Also prune recentIds if many (we'll prune all older than window by tracking can be simplified)
  if (recentIds.size > 1000) recentIds.clear();
}

// Helper to generate an id
function genId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return crypto.createHash('sha1').update(String(Math.random()) + Date.now()).digest('hex');
}

// Bot setup
let bot = null;
if (TELEGRAM_ENABLED) {
  bot = new Telegraf(BOT_TOKEN);
  console.log('[relay] Telegram enabled. CHAT_ID=', CHAT_ID);
  bot.launch().then(() => {
    console.log('[relay] Telegraf launched (long polling)');
  }).catch(err => {
    console.error('[relay] Telegraf launch error', err);
  });

  // When a message arrives from Telegram, broadcast to connected clients (Minecraft players).
  bot.on('text', (ctx) => {
    try {
      const from = ctx.from || {};
      const username = from.username || String(from.id || 'unknown');
      const mapped = userMappings[username] || userMappings[String(from.id)] || `[TG] ${username}`;
      const text = ctx.message && ctx.message.text ? ctx.message.text : '';
      const msgObj = {
        id: genId(),
        origin: 'telegram',
        sender: mapped,
        message: text,
        ts: Date.now()
      };
      // Broadcast to all websocket clients
      const payload = JSON.stringify(msgObj);
      console.log('[relay] tg->broadcast:', payload);
      wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(payload);
        }
      });
    } catch (e) {
      console.error('[relay] bot.on text handler err', e);
    }
  });
} else {
  console.log('[relay] Telegram DISABLED. BOT_TOKEN present?', !!BOT_TOKEN, 'CHAT_ID present?', !!CHAT_ID);
}

// HTTP + WebSocket server
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 8080;
const server = http.createServer((req, res) => {
  console.log('[relay] http request', req.method, req.url, 'upgrade=', req.headers['upgrade']);
  res.writeHead(200, {'Content-Type': 'text/plain'});
  res.end('OK');
});

const wss = new WebSocket.Server({ noServer: true });

wss.on('connection', (ws, req) => {
  console.log('[relay] client connected from', req.socket.remoteAddress);
  ws.on('message', (msg) => {
    try {
      const s = msg.toString();
      // Attempt to parse JSON - accept both raw strings and JSON objects
      let obj = null;
      try {
        obj = JSON.parse(s);
      } catch (e) {
        // not JSON - wrap it
        obj = { id: genId(), origin: 'client', sender: 'unknown', message: s, ts: Date.now() };
      }

      // normalize fields
      if (!obj.id) obj.id = genId();
      if (!obj.origin) obj.origin = 'client';
      if (!obj.sender) obj.sender = 'unknown';
      if (!obj.message) obj.message = '';

      // Dedupe: ignore if we've seen same id or same sender+message recently
      const hashKey = `${obj.sender}::${obj.message}`;
      pruneRecent();
      if (recentIds.has(obj.id)) {
        console.log('[relay] duplicate by id, ignoring', obj.id);
        return;
      }
      const now = Date.now();
      if (recentHashTimestamps.has(hashKey) && (now - recentHashTimestamps.get(hashKey) < DEDUPE_WINDOW_MS)) {
        console.log('[relay] duplicate by hash, ignoring', hashKey);
        return;
      }
      // record
      recentIds.add(obj.id);
      recentHashTimestamps.set(hashKey, now);

      console.log('[relay] recv:', JSON.stringify(obj));
      // Broadcast to other clients (do not send back to same ws)
      const payload = JSON.stringify(obj);
      wss.clients.forEach(client => {
        if (client !== ws && client.readyState === WebSocket.OPEN) {
          client.send(payload);
        }
      });

      // Forward to Telegram only if origin is client (avoid loops)
      if (TELEGRAM_ENABLED && obj.origin === 'client') {
        const tgText = `<${obj.sender}> ${obj.message}`;
        bot.telegram.sendMessage(CHAT_ID, tgText)
          .then(res => console.log('[relay] telegram sent ok message_id=', res && res.message_id))
          .catch(err => {
            const body = err && err.response && err.response.body ? err.response.body : err;
            console.error('[relay] telegram send err', body);
          });
      }

    } catch (e) {
      console.error('[relay] message handling error', e);
    }
  });

  ws.on('close', () => {
    console.log('[relay] client disconnected');
  });
});

// handle upgrades
server.on('upgrade', (req, socket, head) => {
  console.log('[relay] upgrade attempt from', req.socket && req.socket.remoteAddress, 'headers:', req.headers);
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

server.listen(PORT, () => {
  console.log('[relay] http+ws listening on', PORT);
});

// Periodic cleanup
setInterval(() => {
  pruneRecent();
}, 2000);
