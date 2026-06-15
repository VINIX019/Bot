import { handleMessage } from "../core.js";

const TOKEN = process.env.WHATSAPP_TOKEN;        
const PHONE_ID = process.env.WHATSAPP_PHONE_ID;    
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN; 

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

  app.get("/whatsapp/webhook", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === VERIFY_TOKEN) return res.send(challenge);
    return res.sendStatus(403);
  });

  app.post("/whatsapp/webhook", async (req, res) => {
    res.sendStatus(200);

    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    const msg = value?.messages?.[0];
    if (!msg || msg.type !== "text") return;

    const from = msg.from;        
    const text = msg.text.body;

    try {
      const reply = await handleMessage({ channel: "whatsapp", externalId: from, text });
      await sendMessage(from, reply); 
    } catch (e) {
      console.error("whatsapp error:", e);
    }
  });
}
