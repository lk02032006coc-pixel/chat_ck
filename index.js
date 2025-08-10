// relay/index.js
// Debug-friendly WebSocket relay + Telegram bridge
// - Logs all updates
// - Handles message, channel_post, edited_message
// - Forwards from configured CHAT_ID (or private chats) into Minecraft clients
// - Forwards client-origin messages to Telegram (avoids loops)
// - Loads user_mappings.json for mapping Telegram -> Minecraft names

const http = require('http');
const WebSocket = require('ws');
const { Telegraf } = require('telegraf');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

require('dotenv').config();

// Config
const BOT_TOKEN = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.CHAT_ID || process.env.TELEGRAM_CHAT_ID || process.env.TELE_CHAT_ID || '';
const TELEGRAM_ENABLED = !!(BOT_TOKEN && CHAT_ID);

// Load mappings (username/id -> MC nick)
const mappingPath = path.join(__dirname, 'user_mappings.json');
let usernameMap = {};
let idMap = {};
try {
  if (fs.existsSync(mappingPath)) {
    const raw = fs.readFileSync(mappingPath, 'utf8');
    const obj = JSON.parse(raw);
    Object.keys(obj).forEach(k => {
      const v = obj[k];
      if (/^-?\d+$/.test(String(k).trim())) idMap[String(k).trim()] = v;
      else usernameMap[String(k).toLowerCase()] = v;
    });
    console.log('[relay] loaded user mappings; username entries=', Object.keys(usernameMap).length, 'id entries=', Object.keys(idMap).length);
  } else {
    console.log('[relay] no user_mappings.json found; create relay/user_mappings.json to map Telegram => Minecraft names');
  }
} catch (e) {
  console.error('[relay] failed to load user_mappings.json', e);
}

// Dedupe helpers
const recentIds = new Set();
const recentHashTimestamps = new Map();
const DEDUPE_WINDOW_MS = 3000;
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

// HTTP & WS server
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
        obj = { id: genId(), origin: 'client', sender: 'unknown', message: s, ts: Date.now() };
      }
      // normalize
      if (!obj.id) obj.id = genId();
      if (!obj.origin) obj.origin = 'client';
      if (!obj.sender) obj.sender = obj.sender || 'unknown';
      if (!obj.message) obj.message = '';

      // dedupe
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

      // broadcast to other clients (not echo)
      const payload = JSON.stringify(obj);
      wss.clients.forEach(client => {
        if (client !== ws && client.readyState === WebSocket.OPEN) client.send(payload);
      });

      // forward to Telegram (only client-origin)
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
  console.log('[relay] upgrade attempt from', req.socket && req.socket.remoteAddress, 'headers=', req.headers);
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

// Telegram bot
let bot = null;
if (TELEGRAM_ENABLED) {
  bot = new Telegraf(BOT_TOKEN);
  // log bot identity
  bot.telegram.getMe().then(me => {
    console.log('[relay] bot identity:', me && me.username ? `@${me.username}` : me);
  }).catch(e => console.warn('[relay] getMe failed', e));

  // debug middleware - logs all updates (very verbose)
  bot.use((ctx, next) => {
    try {
      console.log('[relay] TG updateType=', ctx.updateType, 'raw=', JSON.stringify(ctx.update));
    } catch (e) {
      console.log('[relay] TG update stringify failed', e);
    }
    return next();
  });

  bot.launch().then(() => {
    console.log('[relay] Telegraf launched (polling). If group messages missing, try disabling privacy in @BotFather (/setprivacy -> Disable).');
  }).catch(err => {
    console.error('[relay] Telegraf launch error', err);
  });

  // universal handler for text-like content in different update types
  function extractTextFromCtx(ctx) {
    if (!ctx || !ctx.update) return null;
    // plain message
    if (ctx.update.message) {
      if (typeof ctx.update.message.text === 'string') return ctx.update.message.text;
      if (typeof ctx.update.message.caption === 'string') return ctx.update.message.caption;
    }
    // channel_post
    if (ctx.update.channel_post) {
      if (typeof ctx.update.channel_post.text === 'string') return ctx.update.channel_post.text;
      if (typeof ctx.update.channel_post.caption === 'string') return ctx.update.channel_post.caption;
    }
    // edited_message
    if (ctx.update.edited_message) {
      if (typeof ctx.update.edited_message.text === 'string') return ctx.update.edited_message.text;
      if (typeof ctx.update.edited_message.caption === 'string') return ctx.update.edited_message.caption;
    }
    return null;
  }

  // handle any incoming message-like update
  bot.on('message', async (ctx) => {
    try {
      // debug: show chat id/type
      const chat = ctx.chat || {};
      const chatIdStr = String(chat.id);
      const chatType = chat.type || '';
      const text = extractTextFromCtx(ctx);
      if (!text) {
        console.log('[relay] incoming TG update has no text; ignoring', ctx.updateType);
        return;
      }

      // Accept if from configured CHAT_ID (group/channel) OR if private chat
      if (CHAT_ID && String(CHAT_ID) !== chatIdStr && chatType !== 'private') {
        // ignore other groups
        console.log('[relay] telegram msg ignored (not target chat and not private). chat.id=', chatIdStr, 'configured=', CHAT_ID);
        return;
      }

      // Determine sender mapping
      const from = ctx.from || {};
      const username = from.username ? String(from.username) : null;
      const fromIdStr = from.id ? String(from.id) : null;
      let mapped = null;
      if (username && usernameMap[username.toLowerCase()]) mapped = usernameMap[username.toLowerCase()];
      if (!mapped && fromIdStr && idMap[fromIdStr]) mapped = idMap[fromIdStr];
      if (!mapped) {
        if (username) mapped = username;
        else if (from.first_name || from.last_name) mapped = (from.first_name || '') + (from.last_name ? ' ' + from.last_name : '');
        else mapped = fromIdStr || '[TG]';
      }

      const msgObj = {
        id: genId(),
        origin: 'telegram',
        sender: mapped,
        message: text,
        ts: Date.now()
      };

      const payload = JSON.stringify(msgObj);
      console.log('[relay] tg->broadcast payload=', payload, 'from chat=', chatIdStr, 'type=', chatType);

      wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) client.send(payload);
      });

    } catch (e) {
      console.error('[relay] bot.on message handler err', e);
    }
  });

  // also handle channel_post specifically (some updates may come as channel_post)
  bot.on('channel_post', async (ctx) => {
    try {
      // simply delegate to the same path: we'll reuse logic by re-emitting as message handler
      // create a synthetic ctx-like object
      const chat = ctx.chat || {};
      const chatIdStr = String(chat.id);
      const chatType = chat.type || '';
      const text = extractTextFromCtx(ctx);
      if (!text) {
        console.log('[relay] channel_post has no text; ignoring');
        return;
      }

      // same acceptance rules as above
      if (CHAT_ID && String(CHAT_ID) !== chatIdStr) {
        console.log('[relay] channel_post ignored (not target chat). chat.id=', chatIdStr);
        return;
      }

      const from = ctx.from || {};
      const username = from.username ? String(from.username) : null;
      const fromIdStr = from.id ? String(from.id) : null;
      let mapped = null;
      if (username && usernameMap[username.toLowerCase()]) mapped = usernameMap[username.toLowerCase()];
      if (!mapped && fromIdStr && idMap[fromIdStr]) mapped = idMap[fromIdStr];
      if (!mapped) {
        if (username) mapped = username;
        else if (from.first_name || from.last_name) mapped = (from.first_name || '') + (from.last_name ? ' ' + from.last_name : '');
        else mapped = fromIdStr || '[TG]';
      }

      const msgObj = {
        id: genId(),
        origin: 'telegram',
        sender: mapped,
        message: text,
        ts: Date.now()
      };
      const payload = JSON.stringify(msgObj);
      console.log('[relay] channel_post tg->broadcast payload=', payload);

      wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) client.send(payload);
      });

    } catch (e) {
      console.error('[relay] channel_post handler err', e);
    }
  });

  // simple /start handler
  bot.start((ctx) => ctx.reply('Relay bot active.'));

} else {
  console.log('[relay] Telegram DISABLED. BOT_TOKEN present?', !!BOT_TOKEN, 'CHAT_ID present?', !!CHAT_ID);
}

// start server
server.listen(PORT, () => {
  console.log('[relay] http+ws listening on', PORT);
});

// cleanup interval
setInterval(() => { pruneRecent(); }, 2000);
