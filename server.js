import express from 'express';
import http from 'http';
import dotenv from 'dotenv';
import TelegramBot from 'node-telegram-bot-api';
import pkg from 'socket.io'; // socket.io v2 is CommonJS -> import default and destructure
const { Server } = pkg;

dotenv.config();

const app = express();
app.use(express.json());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 10000;
const TOKEN = process.env.TELEGRAM_TOKEN || '';
const CHAT_ID = process.env.CHAT_ID || '';
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';

async function clearWebhook(token) {
  if (!token) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: 'POST',
      body: new URLSearchParams({ url: '' })
    });
    console.log('Webhook cleared (if any).');
  } catch (e) {
    console.warn('Failed to clear webhook (ignored):', e?.message || e);
  }
}

function startRelay(bot) {
  io.on('connection', (socket) => {
    console.log('🧩 WebSocket connected', socket.id);

    socket.on('send', (data) => {
      console.log('send received:', data);
      io.emit('recv', data);
      if (bot && CHAT_ID) {
        bot.sendMessage(CHAT_ID, data).catch(err => console.warn('TG send failed', err?.message || err));
      }
    });

    socket.on('disconnect', () => {
      console.log('socket disconnected', socket.id);
    });
  });

  app.get('/', (req, res) => res.send('🤖 Relay running'));
  server.listen(PORT, () => console.log(`🚀 Relay listening on ${PORT}`));
}

(async () => {
  let bot = null;
  if (WEBHOOK_URL && TOKEN) {
    try {
      bot = new TelegramBot(TOKEN, { polling: false });
      await bot.setWebHook(WEBHOOK_URL);
      console.log('Webhook set to', WEBHOOK_URL);
      app.post('/webhook', (req, res) => {
        try {
          bot.processUpdate(req.body);
          res.sendStatus(200);
        } catch (e) {
          console.error('processUpdate failed', e);
          res.sendStatus(500);
        }
      });
    } catch (e) {
      console.error('Failed to set webhook mode:', e);
      console.log('Falling back to polling attempt.');
      await clearWebhook(TOKEN);
      try {
        bot = new TelegramBot(TOKEN, { polling: true });
      } catch (err) {
        console.error('Failed to start polling bot:', err);
        bot = null;
      }
    }
  } else if (TOKEN) {
    await clearWebhook(TOKEN);
    try {
      bot = new TelegramBot(TOKEN, { polling: true });
    } catch (e) {
      console.error('Failed to start polling bot:', e);
      bot = null;
    }
  } else {
    console.log('No TELEGRAM_TOKEN provided; Telegram integration disabled.');
  }

  if (bot) {
    bot.on('message', (msg) => {
      console.log('📩', msg.from?.username || msg.from?.id, ':', msg.text);
      if (CHAT_ID) {
        bot.sendMessage(CHAT_ID, `Relay got message: ${msg.text}`).catch(() => {});
      }
    });
    bot.on('polling_error', (err) => console.error('polling_error', err));
  }

  startRelay(bot);
})();
