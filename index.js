// Simple WebSocket relay + Telegram bridge (minimal)
// Uses ws and telegraf. Put your BOT_TOKEN and CHAT_ID into .env or supply via env variables.

const http = require('http');
const WebSocket = require('ws');
const { Telegraf } = require('telegraf');
require('dotenv').config();

const BOT_TOKEN = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.CHAT_ID || process.env.TELEGRAM_CHAT_ID || '';

const telegramEnabled = !!(BOT_TOKEN && CHAT_ID);
let bot = null;
if (telegramEnabled) {
  bot = new Telegraf(BOT_TOKEN);
  console.log('[relay] Telegram enabled');
}

// Port from Render or default 8080
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 8080;

const server = http.createServer((req, res) => {
  console.log('[relay] http request', req.method, req.url, 'headers upgrade=', req.headers['upgrade']);
  res.writeHead(200, {'Content-Type': 'text/plain'});
  res.end('OK');
});

const wss = new WebSocket.Server({ noServer: true });

wss.on('connection', (ws, req) => {
  console.log('[relay] client connected from', req.socket.remoteAddress);
  ws.on('message', (msg) => {
    try {
      const s = msg.toString();
      console.log('[relay] recv:', s);
      // Broadcast to other clients
      wss.clients.forEach(client => {
        if (client !== ws && client.readyState === WebSocket.OPEN) {
          client.send(s);
        }
      });
      // Optionally forward to Telegram
      if (telegramEnabled) {
        try {
          const parsed = JSON.parse(s);
          const text = `<${parsed.sender}> ${parsed.message}`;
          bot.telegram.sendMessage(CHAT_ID, text).catch(e => console.error('[relay] telegram send err', e));
        } catch (e) {
          console.error('[relay] telegram forward parse err', e);
        }
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

server.listen(PORT, () => {
  console.log('[relay] http+ws listening on', PORT);
});
