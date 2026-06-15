import { handleMessage } from "../core.js";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API = `https://api.telegram.org/bot${TOKEN}`;
const WEBHOOK_URL = process.env.WEBHOOK_URL;

async function sendMessage(chatId, text) {
  await fetch(`${API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

async function processUpdate(update) {
  const msg = update?.message;
  if (!msg?.text) return;
  try {
    const reply = await handleMessage({
      channel: "telegram",
      externalId: String(msg.chat.id),
      text: msg.text,
    });
    await sendMessage(msg.chat.id, reply);
  } catch (e) {
    console.error("telegram error:", e);
    await sendMessage(msg.chat.id, "Deu ruim aqui do meu lado 😅 tenta de novo.");
  }
}

export async function mountTelegram(app) {
  if (WEBHOOK_URL) {
    await fetch(`${API}/setWebhook?url=${WEBHOOK_URL}/telegram/webhook`);
    app.post("/telegram/webhook", (req, res) => {
      res.sendStatus(200);
      processUpdate(req.body);
    });
    console.log("Telegram: modo WEBHOOK ->", WEBHOOK_URL);
  } else {
    await fetch(`${API}/deleteWebhook`); 
    console.log("Telegram: modo POLLING (local). Manda mensagem pro bot.");
    let offset = 0;
    while (true) {
      try {
        const res = await fetch(`${API}/getUpdates?timeout=30&offset=${offset}`);
        const data = await res.json();
        for (const update of data.result ?? []) {
          offset = update.update_id + 1;
          await processUpdate(update);
        }
      } catch (e) {
        console.error("polling error:", e);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }
}