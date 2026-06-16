import { parseMessage, parseInstallment, parseIncome, parseRefund, extractAmount } from "./parser.js";
import { matchCategoryName, categoryFromKeywords } from "./categories.js";
import {
  getOrCreateUser,
  insertTransaction,
  insertInstallments,
  getTodayTotal,
  getSummary,
  getCategoryDetail,
  getIncomeDetail,
  getPeriodTotals,
  updateLastTransaction,
  deleteLastTransaction,
  deleteAllTransactions,
} from "./db.js";

const fmt = (n) => n.toFixed(2).replace(".", ",");
const short = (s) => (s.length > 40 ? s.slice(0, 39) + "…" : s).trim();

const CLEAR_TTL_MS = 2 * 60 * 1000;
const pendingClear = new Map(); 

function isClearAllRequest(text) {
  return /^\/?(apagar?\s+tudo|apagar?\s+todos|limpar\s+tudo|resetar(\s+tudo)?|apagartudo|zerar(\s+tudo)?)\b/.test(
    text.toLowerCase().trim()
  );
}

const TUTORIAL =
  "👋 Oi! Eu sou seu controle financeiro aqui no chat. Você me conta o que entra e o que sai, do seu jeito, e eu organizo.\n\n" +
  "💸 Gastos\n" +
  '• "gastei 30 no almoço"\n' +
  '• "celular 1500 em 3x" (parcelado)\n\n' +
  "💰 Entradas\n" +
  '• "recebi 2000 salário"\n' +
  '• "ganhei 150 de freela"\n\n' +
  "📊 Resumos\n" +
  '• "resumo" → mês, com saldo\n' +
  '• "resumo semana" / "resumo hoje"\n' +
  '• "resumo transporte" → uma categoria\n' +
  '• "resumo entradas" → só as entradas\n\n' +
  "✏️ Corrigir\n" +
  '• "editar 75" / "editar lazer"\n' +
  '• "apagar" → apaga o último\n' +
  '• "apagar tudo" → zera tudo (pede confirmação)\n\n' +
  "Pode começar: me manda seu primeiro lançamento. 🙂";

const NEW_USER_HINT = '\n\n💡 Primeira vez aqui? Manda "/start" pra ver tudo que eu faço.';

function isGreeting(text) {
  return /^\/?(start|oi+|ol[áa]|ola|opa|e a[íi]|ajuda|help|menu|come[çc]ar|tutorial|bom dia|boa tarde|boa noite)\b/.test(
    text.toLowerCase().trim()
  );
}

function isSummaryRequest(text) {
  const t = text.toLowerCase().trim();
  return /^\/?resumo\b/.test(t) || /^\/?relat[óo]rio\b/.test(t) || /^quanto (eu )?gastei\b/.test(t);
}

function detectPeriod(text) {
  const t = text.toLowerCase();
  if (/\b(hoje|do dia|di[áa]ri[oa])\b/.test(t)) return "day";
  if (/\b(semana|semanal)\b/.test(t)) return "week";
  return "month";
}

function periodLabel(period) {
  if (period === "day") return "de hoje";
  if (period === "week") return "da semana";
  return `de ${new Date().toLocaleDateString("pt-BR", { month: "long" })}`;
}

function emptyLabel(period) {
  if (period === "day") return "hoje";
  if (period === "week") return "esta semana";
  return "este mês";
}

function isDeleteRequest(text) {
  return /^\/?(apaga|apagar|cancela|cancelar|errei)\b/.test(text.toLowerCase().trim());
}

function parseEdit(text) {
  const t = text.toLowerCase().trim();
  if (!/^\/?(edita|editar|corrige|corrigir)\b/.test(t)) return null;
  const rest = text.replace(/^\s*\/?\w+\s*/, "");
  return { amount: extractAmount(rest), category: matchCategoryName(rest) };
}

function incomeSource(text) {
  const t = text.toLowerCase();
  if (/\bsal[áa]rio\b/.test(t)) return "Salário";
  if (/\b(freela|freelance)\b/.test(t)) return "Freelance";
  return "Entrada";
}

function wantsIncome(text) {
  return /\b(entradas?|ganhos?|receitas?|recebimentos?)\b/.test(text.toLowerCase());
}

async function buildIncomeSummary(userId, period) {
  const items = await getIncomeDetail(userId, period);
  if (items.length === 0) return `Nenhuma entrada ${emptyLabel(period)}. 🙂`;
  const total = items.reduce((s, i) => s + i.amount, 0);
  const linhas = items.map((i) => `• ${short(i.description)}: R$${fmt(i.amount)}`).join("\n");
  const plural = items.length === 1 ? "entrada" : "entradas";
  return `💰 Entradas ${periodLabel(period)}\n\n${linhas}\n\nTotal: R$${fmt(total)} (${items.length} ${plural})`;
}

async function buildSummary(userId, period, category) {
  if (category) {
    const items = await getCategoryDetail(userId, category, period);
    if (items.length === 0) return `Nenhum gasto em ${category} ${emptyLabel(period)}. 🙂`;
    const total = items.reduce((s, i) => s + i.amount, 0);
    const linhas = items.map((i) => `• ${short(i.description)}: R$${fmt(i.amount)}`).join("\n");
    const plural = items.length === 1 ? "lançamento" : "lançamentos";
    return `📋 ${category} ${periodLabel(period)}\n\n${linhas}\n\nTotal: R$${fmt(total)} (${items.length} ${plural})`;
  }

  const rows = await getSummary(userId, period);
  const totals = await getPeriodTotals(userId, period);
  if (rows.length === 0 && totals.income === 0) {
    return `Nenhum lançamento ${emptyLabel(period)}. 🙂`;
  }
  const icon = totals.balance >= 0 ? "🟢" : "🔴";
  const cats = rows.map((r) => `• ${r.category}: R$${fmt(r.total)}`).join("\n");

  let out = `📊 Resumo ${periodLabel(period)}\n\n`;
  if (cats) out += cats + "\n\n";
  out +=
    `Saídas: R$${fmt(totals.expense)}\n` +
    `Entradas: R$${fmt(totals.income)}\n` +
    `Saldo: R$${fmt(totals.balance)} ${icon}`;
  return out;
}

export async function handleMessage({ channel, externalId, text }) {
  const { id: userId, isNew } = await getOrCreateUser(channel, externalId);

  const t = text.trim().toLowerCase();
  const pend = pendingClear.get(userId);
  if (pend && Date.now() - pend.at > CLEAR_TTL_MS) {
    pendingClear.delete(userId); 
  }
  const active = pendingClear.get(userId);

  if (active) {
    if (t === "confirmar") {
      pendingClear.delete(userId);
      const n = await deleteAllTransactions(userId);
      return `🧹 Pronto, apaguei tudo (${n} lançamento${n === 1 ? "" : "s"}). Você está começando do zero.`;
    }
    pendingClear.delete(userId);
    return "❌ Apagar tudo cancelado — nada foi apagado. Pode mandar seu comando de novo.";
  }

  if (isClearAllRequest(text)) {
    pendingClear.set(userId, { at: Date.now() });
    return "⚠️ Isso vai apagar TODOS os seus lançamentos, pra sempre — não dá pra desfazer.\n\nSe tem certeza, responda: CONFIRMAR";
  }

  if (isGreeting(text)) return TUTORIAL;

  if (isSummaryRequest(text)) {
    const period = detectPeriod(text);
    if (wantsIncome(text)) return await buildIncomeSummary(userId, period);
    const category = matchCategoryName(text) || categoryFromKeywords(text);
    return await buildSummary(userId, period, category);
  }

  if (isDeleteRequest(text)) {
    const removed = await deleteLastTransaction(userId);
    if (!removed) return "Não há nenhum lançamento pra apagar. 🤷";
    if (removed.installments) {
      return `Apaguei o parcelamento inteiro ❌ R$${fmt(removed.amount)} em ${removed.installments}x — ${removed.category}`;
    }
    return `Apaguei o último ❌ R$${fmt(removed.amount)} — ${removed.category}`;
  }

  const edit = parseEdit(text);
  if (edit) {
    if (edit.amount === null && !edit.category) {
      return (
        "Pra editar o último lançamento, manda:\n" +
        '• "editar 75" (muda o valor)\n' +
        '• "editar educação" (muda a categoria)\n' +
        '• "editar 75 educação" (muda os dois)'
      );
    }
    const updated = await updateLastTransaction(userId, edit);
    if (!updated) return "Não há nenhum lançamento pra editar. 🤷";
    return `Corrigido ✅ R$${fmt(updated.amount)} — ${updated.category}`;
  }

  const refund = parseRefund(text);
  if (refund) {
    const category = categoryFromKeywords(text) || "Outros";
    await insertTransaction({
      userId,
      amount: -refund.amount,
      category,
      description: text,
      rawMessage: text,
      kind: "expense",
    });
    const totals = await getPeriodTotals(userId, "month");
    const icon = totals.balance >= 0 ? "🟢" : "🔴";
    let reply =
      `Estorno registrado ↩️ −R$${fmt(refund.amount)} — ${category}\n` +
      `Reduziu seus gastos. Saldo do mês: R$${fmt(totals.balance)} ${icon}`;
    if (isNew) reply += NEW_USER_HINT;
    return reply;
  }

  const income = parseIncome(text);
  if (income) {
    const category = incomeSource(text);
    await insertTransaction({
      userId,
      amount: income.amount,
      category,
      description: text,
      rawMessage: text,
      kind: "income",
    });
    const totals = await getPeriodTotals(userId, "month");
    const icon = totals.balance >= 0 ? "🟢" : "🔴";
    let reply =
      `Entrada registrada ✅ +R$${fmt(income.amount)} — ${category}\n` +
      `Saldo do mês: R$${fmt(totals.balance)} ${icon}`;
    if (isNew) reply += NEW_USER_HINT;
    return reply;
  }

  const inst = parseInstallment(text);
  if (inst) {
    const category = categoryFromKeywords(text) || "Outros";
    await insertInstallments({
      userId,
      total: inst.total,
      n: inst.n,
      category,
      description: text,
      rawMessage: text,
    });
    const per = inst.total / inst.n;
    let reply =
      `Parcelado ✅ R$${fmt(inst.total)} em ${inst.n}x de ~R$${fmt(per)} — ${category}\n` +
      `R$${fmt(per)} entram por mês, a partir de agora.`;
    if (isNew) reply += NEW_USER_HINT;
    return reply;
  }

  const parsed = await parseMessage(text);
  if (!parsed) {
    if (isNew) return TUTORIAL;
    return "Não achei um valor nessa mensagem 🤔\nManda \"gastei 30 no almoço\", \"recebi 2000 salário\", ou peça \"resumo\".";
  }

  await insertTransaction({
    userId,
    amount: parsed.amount,
    category: parsed.category,
    description: parsed.description,
    rawMessage: text,
  });

  const total = await getTodayTotal(userId);
  let reply =
    `Anotado ✅ R$${fmt(parsed.amount)} — ${parsed.category}\n` +
    `Hoje você já gastou R$${fmt(total)}.`;
  if (isNew) reply += NEW_USER_HINT;
  return reply;
}