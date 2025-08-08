import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import dotenv from 'dotenv';
import TelegramBot from 'node-telegram-bot-api';

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT;

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

bot.on('message', (msg) => {
  console.log(`📩 ${msg.from.username}: ${msg.text}`);
  if (process.env.CHAT_ID) {
    bot.sendMessage(process.env.CHAT_ID, `Echo: ${msg.text}`);
  }
});

io.on('connection', (socket) => {
  console.log('🧩 WebSocket подключён');

  socket.on('send', (data) => {
    bot.sendMessage(process.env.CHAT_ID, data);
  });
});

app.get('/', (req, res) => {
  res.send('🤖 Server is running!');
});

server.listen(PORT, () => {
  console.log(`🚀 Relay running on port ${PORT}`);
});
