import { handleMessage, handleCallback } from "../core.js";

const TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_ID = process.env.WHATSAPP_PHONE_ID;
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
const GRAPH = "https://graph.facebook.com/v21.0";

// Envia texto simples ou texto com botoes (reply = string OU { text, buttons }).
async function sendReply(to, reply) {
  if (typeof reply === "string") {
    return send({ messaging_product: "whatsapp", to, type: "text", text: { body: reply } });
  }
  // WhatsApp: no maximo 3 botoes, titulo <= 20 chars
  const buttons = reply.buttons.slice(0, 3).map((b) => ({
    type: "reply",
    reply: { id: b.id, title: b.title.slice(0, 20) },
  }));
  return send({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: { type: "button", body: { text: reply.text }, action: { buttons } },
  });
}

async function send(payload) {
  const res = await fetch(`${GRAPH}/${PHONE_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const erro = await res.text();
    console.error("whatsapp send FALHOU:", res.status, erro);
  }
}

export function mountWhatsApp(app) {
  // Verificacao do webhook (GET, uma vez na configuracao)
  app.get("/whatsapp/webhook", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === VERIFY_TOKEN) return res.send(challenge);
    return res.sendStatus(403);
  });

  // Recebimento de mensagens e cliques (POST)
  app.post("/whatsapp/webhook", async (req, res) => {
    res.sendStatus(200);
    const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg) return;
    const from = msg.from;

    try {
      if (msg.type === "text") {
        const reply = await handleMessage({ channel: "whatsapp", externalId: from, text: msg.text.body });
        await sendReply(from, reply);
      } else if (msg.type === "interactive" && msg.interactive?.type === "button_reply") {
        const reply = await handleCallback({
          channel: "whatsapp",
          externalId: from,
          data: msg.interactive.button_reply.id,
        });
        await sendReply(from, reply);
      }
    } catch (e) {
      console.error("whatsapp error:", e);
    }
  });
}