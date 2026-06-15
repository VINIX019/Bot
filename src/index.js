import "dotenv/config";
import express from "express";
import { mountTelegram } from "./channels/telegram.js";
import { mountWhatsApp } from "./channels/whatsapp.js";

const app = express();
app.use(express.json());

// Escolhe o canal por variável de ambiente. É AQUI que você troca
// Telegram <-> WhatsApp sem tocar no núcleo.
const CHANNEL = process.env.CHANNEL || "telegram";

if (CHANNEL === "telegram") mountTelegram(app);
else if (CHANNEL === "whatsapp") mountWhatsApp(app);
else throw new Error(`CHANNEL inválido: ${CHANNEL}`);

app.get("/", (_req, res) => res.send(`bot no ar (canal: ${CHANNEL})`));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Rodando na porta ${port} | canal: ${CHANNEL}`));
