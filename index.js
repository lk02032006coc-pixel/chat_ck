// relay/index.js
// Improved WebSocket relay + Telegram bridge
// - supports mapping telegram usernames/ids -> Minecraft names (user_mappings.json)
// - accepts messages from configured group chat (CHAT_ID) and from private messages
// - marks telegram-origin messages as origin: "telegram" and sets sender to mapped MC name
// - deduplicates client-origin messages (id + sender::message window)
// - logs extensively for debugging
//
// Configuration via environment variables:
//  - BOT_TOKEN (or TELEGRAM_BOT_TOKEN)
//  - CHAT_ID  (or TELEGRAM_CHAT_ID or TELE_CHAT_ID)  <-- target group/channel id (e.g. -1002722201967)
//  - PORT (Render provides this automatically)
// NOTE: To receive all group messages, disable BotFather "Privacy Mode" for your bot.

const http = require('http');
const WebSocket = require('ws');
const { Telegraf } = require('telegraf');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

require('dotenv').config();

// ----------- Config / envs -------------
const BOT_TOKEN = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.CHAT_ID || process.env.TELEGRAM_CHAT_ID || process.env.TELE_CHAT_ID || '';
const TELEGRAM_ENABLED = !!(BOT_TOKEN && CHAT_ID);

// ----------- mappings (username/id -> MC nick) -------------
const mappingPath = path.join(__dirname, 'user_mappings.json');
let userMappingsRaw = {};
let usernameMap = {}; // lowercase username -> mcname
let idMap = {};       // numeric id string -> mcname
try {
  if (fs.existsSync(mappingPath)) {
    const raw = fs.readFileSync(mappingPath, 'utf8');
    userMappingsRaw = JSON.parse(raw);
    // Build normalized maps
    Object.keys(userMappingsRaw).forEach(k => {
      const v = userMappingsRaw[k];
      if (/^-?\d+$/.test(String(k).trim())) {
        idMap[String(k).trim()] = v;
      } else {
        usernameMap[String(k).toLowerCase()] = v;
      }
    });
    console.log('[relay] loaded user_mappings.json; username entries=', Object.keys(usernameMap).length, 'id entries=', Object.keys(idMap).length);
  } else {
    console.log('[relay] no user_mappings.json found — create relay/user_mappings.json to map Telegram => Minecraft names');
  }
} catch (e) {
  console.error('[relay] failed to load user_mappings.json', e);
}

// ----------- dedupe structures -------------
const recentIds = new Set();
const recentHashTimestamps = new Map();
const DEDUPE_WINDOW_MS = 3000; // 3s

function pruneRecent() {
  const now = Date.now();
  for (const [k, t] of recentHashTimestamps.entries()) {
    if (now - t > DEDUPE_WINDOW_MS) recentHashTimestamps.delete(k);
  }
  if (recentIds.size > 2000) recentIds.clear();
}

function genId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return crypto.createHash('sha1').update(String(Math.random()) + Date.now()).digest('hex');
}

// ----------- HTTP + WebSocket server -------------
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 8080;
const server = http.createServer((req, res) => {
  console.log('[relay] http request', req.method, req.url, 'upgrade=', req.headers['upgrade']);
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK');
});

const wss = new WebSocket.Server({ noServer: true });

wss.on('connection', (ws, req) => {
  console.log('[relay] client connected from', req.socket.remoteAddress);
  ws.on('message', (msg) => {
    try {
      const s = msg.toString();
      let obj;
      try {
        obj = JSON.parse(s);
      } catch (e) {
        // not JSON - wrap
        obj = { id: genId(), origin: 'client', sender: 'unknown', message: s, ts: Date.now() };
      }

      // normalize
      if (!obj.id) obj.id = genId();
      if (!obj.origin) obj.origin = 'client';
      if (!obj.sender) obj.sender = obj.sender || 'unknown';
      if (!obj.message) obj.message = '';

      // dedupe by id and by sender::message within window
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
      recentIds.add(obj.id);
      recentHashTimestamps.set(hashKey, now);

      console.log('[relay] recv:', JSON.stringify(obj));

      // broadcast to other clients (do not echo back to same ws)
      const payload = JSON.stringify(obj);
      wss.clients.forEach(client => {
        if (client !== ws && client.readyState === WebSocket.OPEN) {
          client.send(payload);
        }
      });

      // forward to Telegram only if origin=client (avoid loops)
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

server.on('upgrade', (req, socket, head) => {
  console.log('[relay] upgrade attempt from', req.socket && req.socket.remoteAddress, 'headers:', req.headers);
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

// ----------- Telegram bot setup (Telegraf) -------------
let bot = null;
if (TELEGRAM_ENABLED) {
  bot = new Telegraf(BOT_TOKEN);
  console.log('[relay] Telegram enabled for CHAT_ID=', CHAT_ID);

  // Launch bot (polling)
  bot.launch().then(() => {
    console.log('[relay] Telegraf launched (long polling). If group messages are missing, disable BotFather privacy mode (/setprivacy -> Disable).');
  }).catch(err => {
    console.error('[relay] Telegraf launch error', err);
  });

  // Handle all incoming messages (text). We use 'message' to capture a bit more types; we extract text if present.
  bot.on('message', async (ctx) => {
    try {
      const chat = ctx.chat || {};
      const chatIdStr = String(chat.id);
      const chatType = chat.type || '';
      const from = ctx.from || {};
      // Determine if we should accept this message:
      // Accept if either:
      //  - message came from configured chat (CHAT_ID), OR
      //  - message is a private chat to bot (chat.type === 'private')
      // This lets both private PMs and messages in the target group be forwarded.
      if (CHAT_ID && String(CHAT_ID) !== chatIdStr && chatType !== 'private') {
        // Not the configured group and not a private message — ignore
        // (this prevents forwarding from arbitrary groups)
        console.log('[relay] telegram message ignored (not target chat or private). chat.id=', chatIdStr, 'configured=', CHAT_ID);
        return;
      }

      // Extract text (support text or caption for media)
      let text = '';
      if (ctx.message && typeof ctx.message.text === 'string') {
        text = ctx.message.text;
      } else if (ctx.message && typeof ctx.message.caption === 'string') {
        text = ctx.message.caption;
      } else {
        // nothing to forward
        console.log('[relay] telegram message has no text/caption; ignoring', ctx.updateType);
        return;
      }

      // Build sender name: prefer mapping by username (case-insensitive), then by numeric id mapping, then username, then first_name
      const username = from.username ? String(from.username) : null;
      const fromIdStr = from.id ? String(from.id) : null;
      let mapped = null;
      if (username) {
        mapped = usernameMap[username.toLowerCase()];
      }
      if (!mapped && fromIdStr && idMap[fromIdStr]) {
        mapped = idMap[fromIdStr];
      }
      if (!mapped) {
        // Fallback label: if username exists, use it; otherwise combine first_name/last_name or id
        if (username) mapped = username;
        else if (from.first_name || from.last_name) mapped = (from.first_name || '') + (from.last_name ? ' ' + from.last_name : '');
        else mapped = fromIdStr || '[TG]';
      }

      // Build message object to broadcast to clients
      const msgObj = {
        id: genId(),
        origin: 'telegram',
        sender: mapped,
        message: text,
        ts: Date.now()
      };

      const payload = JSON.stringify(msgObj);

      console.log('[relay] tg->broadcast from', mapped, 'chat:', chatIdStr, 'payload:', payload);

      // Broadcast to all connected websocket clients
      wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(payload);
        }
      });

    } catch (e) {
      console.error('[relay] bot.on message handler err', e);
    }
  });

  // Optional: handler for commands /start etc. Keep small logs.
  bot.start((ctx) => ctx.reply('Relay bot active.'));
} else {
  console.log('[relay] Telegram DISABLED. BOT_TOKEN present?', !!BOT_TOKEN, 'CHAT_ID present?', !!CHAT_ID);
}

// ----------- Start server -------------
server.listen(PORT, () => {
  console.log('[relay] http+ws listening on', PORT);
});

// periodic cleanup
setInterval(() => {
  pruneRecent();
}, 2000);
