\
    // Simple WebSocket relay + Telegram bridge (minimal)
    // Uses ws and telegraf. Put your BOT_TOKEN and CHAT_ID into .env or supply via env variables.
    const WebSocket = require('ws');
    const { Telegraf } = require('telegraf');
    require('dotenv').config();
    const PORT = process.env.PORT ? parseInt(process.env.PORT) : 8080;
    const BOT_TOKEN = process.env.BOT_TOKEN || '';
    const TELE_CHAT_ID = process.env.TELE_CHAT_ID || '';

    const wss = new WebSocket.Server({ port: PORT }, () => {
      console.log('[relay] ws listening on', PORT);
    });

    // Broadcast helper
    function broadcast(obj, exclude=null) {
      const s = JSON.stringify(obj);
      wss.clients.forEach(c => {
        if (c !== exclude && c.readyState === WebSocket.OPEN) {
          c.send(s);
        }
      });
    }

    // Telegram bot (optional)
    let bot = null;
    if (BOT_TOKEN) {
      bot = new Telegraf(BOT_TOKEN);
      bot.on('text', (ctx) => {
        // when message from telegram, forward to clients
        const from = ctx.message.from.username || (ctx.message.from.first_name || 'tg');
        const text = ctx.message.text || '';
        broadcast({ type: 'chat', sender: '[TG] ' + from, message: text });
      });
      bot.launch().then(() => console.log('[relay] telegram bot launched'));
    } else {
      console.log('[relay] no BOT_TOKEN provided, telegram disabled');
    }

    wss.on('connection', ws => {
      ws.on('message', (raw) => {
        try {
          const obj = JSON.parse(raw.toString());
          if (obj && obj.type === 'chat') {
            // forward to other clients and optionally to telegram
            broadcast(obj, ws);
            if (bot && TELE_CHAT_ID) {
              bot.telegram.sendMessage(TELE_CHAT_ID, obj.sender + ': ' + obj.message).catch(console.error);
            }
          }
        } catch (e) {
          console.error('invalid message', e);
        }
      });
    });

    process.on('SIGINT', () => {
      console.log('[relay] shutting down');
      if (bot) bot.stop();
      wss.close(() => process.exit(0));
    });
