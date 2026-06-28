import { getDueBillsForChannel } from "./db.js";
import { notify } from "./channels/telegram.js";

const WITHIN_DAYS = 2; // avisa contas que vencem em até 2 dias (e as já vencidas)
const fmt = (n) => n.toFixed(2).replace(".", ",");

// 12:00 UTC = 09:00 no horário de Brasília (UTC-3).
function msUntilUTCHour(utcHour = 12) {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), utcHour, 0, 0));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next - now;
}

async function runOnce() {
  try {
    const bills = await getDueBillsForChannel("telegram", WITHIN_DAYS);
    const byUser = new Map();
    for (const b of bills) {
      if (!byUser.has(b.externalId)) byUser.set(b.externalId, []);
      byUser.get(b.externalId).push(b);
    }
    for (const [chatId, list] of byUser) {
      const linhas = list.map((b) => {
        let quando;
        if (b.daysLeft < 0) quando = `vencida há ${-b.daysLeft}d`;
        else if (b.daysLeft === 0) quando = "vence HOJE";
        else if (b.daysLeft === 1) quando = "vence amanhã";
        else quando = `vence em ${b.daysLeft}d (${b.dueFmt})`;
        const val = b.amount != null ? ` — R$${fmt(b.amount)}` : "";
        return `• ${b.description}${val} (${quando})`;
      }).join("\n");
      await notify(chatId, `⏰ Lembrete de contas\n\n${linhas}\n\nManda "contas" pra ver tudo.`);
    }
    console.log(`lembrete de contas: ${byUser.size} usuario(s) avisado(s)`);
  } catch (e) {
    console.error("scheduler error:", e);
  }
}

export function startBillReminders() {
  const schedule = () => {
    setTimeout(async () => {
      await runOnce();
      schedule(); // reagenda pro próximo dia
    }, msUntilUTCHour(12));
  };
  schedule();
  console.log("Lembrete diário de contas agendado (09:00 BRT, Telegram).");
}