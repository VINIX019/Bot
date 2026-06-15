import { handleMessage } from "../core.js";

const TOKEN = process.env.WHATSAPP_TOKEN;          // token permanente do app Meta
const PHONE_ID = process.env.WHATSAPP_PHONE_ID;     // id do número (não é o número)
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN; // string que VOCÊ inventa

async function sendMessage(to, text) {
  await fetch(`https://graph.facebook.com/v21.0/${PHONE_ID}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    }),
  });
}

export function mountWhatsApp(app) {
  // 1) Verificação do webhook (a Meta faz um GET uma vez, na configuração).
  app.get("/whatsapp/webhook", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === VERIFY_TOKEN) return res.send(challenge);
    return res.sendStatus(403);
  });

  // 2) Recebimento de mensagens (POST a cada mensagem).
  app.post("/whatsapp/webhook", async (req, res) => {
    res.sendStatus(200);

    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    const msg = value?.messages?.[0];
    if (!msg || msg.type !== "text") return;

    const from = msg.from;        // telefone do remetente (vem de graça)
    const text = msg.text.body;

    try {
      const reply = await handleMessage({ channel: "whatsapp", externalId: from, text });
      await sendMessage(from, reply); // resposta dentro da janela de 24h = grátis
    } catch (e) {
      console.error("whatsapp error:", e);
    }
  });
}
