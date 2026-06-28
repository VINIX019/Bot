import { parseMessage, parseInstallment, parseIncome, parseRefund, extractAmount, parseBill, parseDueDate, extractBarcode } from "./parser.js";
import { matchCategoryName, categoryFromKeywords } from "./categories.js";
import { decodeBoleto, validateBoleto, extractBoletoInfo } from "./boleto.js";
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
  getTransactionById,
  deleteTransactionById,
  updateTransactionById,
  setBudget,
  removeBudget,
  getBudget,
  listBudgets,
  getCategorySpentMonth,
  getReserveTotal,
  setReserveGoal,
  getReserveGoal,
  addRecurring,
  listRecurring,
  deactivateRecurring,
  materializeRecurring,
  deleteAllData,
  addBill,
  listPendingBills,
  markBillPaid,
  deleteBillById,
  updateBillBarcode,
} from "./db.js";

const fmt = (n) => n.toFixed(2).replace(".", ",");
const short = (s) => (s.length > 40 ? s.slice(0, 39) + "…" : s).trim();
const hojeBR = () => new Date().toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
// limpa descricao pro cartao: tira valor, verbos e simbolos de markdown
function cleanDesc(text) {
  let s = text
    .replace(/r\$\s*\d[\d.,]*/gi, " ")
    .replace(/\d[\d.,]*/g, " ")
    .replace(/\b(gastei|paguei|comprei|gasto|comprar|pagar)\b/gi, " ")
    .replace(/[*_`\[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) s = text.replace(/[*_`\[\]]/g, "").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Estado da confirmacao de "apagar tudo" (na memoria do processo, expira em 2 min).
const CLEAR_TTL_MS = 2 * 60 * 1000;
const pendingClear = new Map(); // userId -> { stage, at }

// Estado do "Editar" via botao: espera a proxima mensagem com o novo valor/categoria.
const EDIT_TTL_MS = 5 * 60 * 1000;
const pendingEdit = new Map(); // userId -> { id, at }

function card(title, lines, footer, id) {
  let text = `${title}\n\n` + lines.join("\n");
  if (footer) text += `\n\n${footer}`;
  return {
    text,
    buttons: [
      { id: `edit:${id}`, title: "✏️ Editar" },
      { id: `del:${id}`, title: "🗑️ Excluir" },
    ],
  };
}

function txFields(descricao, categoria, valor) {
  return [
    `📝 *Descrição:* ${descricao}`,
    `🏷️ *Categoria:* ${categoria}`,
    `💵 *Valor:* R$${fmt(valor)}`,
    `📅 *Data:* ${hojeBR()}`,
  ];
}

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
  "🎯 Limites\n" +
  '• "limite lazer 300" → te aviso quando chegar perto\n' +
  '• "limites" → ver como você está em cada um\n\n' +
  "🔁 Recorrentes\n" +
  '• "recorrente aluguel 1200" → lanço sozinho todo mês\n' +
  '• "recorrentes" → ver os fixos\n\n' +
  "🏦 Reserva\n" +
  '• "guardei 200 na reserva"\n' +
  '• "meta reserva 5000" → acompanho seu progresso\n' +
  '• "reserva" → quanto você já guardou\n\n' +
  "🧾 Contas a pagar\n" +
  '• "registrar boleto" → cadastro passo a passo (com foto ou código)\n' +
  '• "conta luz 120 vence 30/06" → cadastro rápido numa linha\n' +
  '• "contas" → ver as pendentes\n' +
  '• "paguei conta 1" → dá baixa e vira gasto\n\n' +
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
  const linhas = items.map((i) => `• ${i.day} — ${short(i.description)}: R$${fmt(i.amount)}`).join("\n");
  const plural = items.length === 1 ? "entrada" : "entradas";
  return `💰 Entradas ${periodLabel(period)}\n\n${linhas}\n\nTotal: R$${fmt(total)} (${items.length} ${plural})`;
}

function parseLimit(text) {
  const t = text.toLowerCase().trim();
  if (!/^\/?(limites?|tirar limite|remover limite)\b/.test(t)) return null;

  const category = matchCategoryName(t) || categoryFromKeywords(t);

  if (/^\/?(tirar|remover)\s+limite\b/.test(t)) {
    return { action: "remove", category };
  }
  const amount = extractAmount(t.replace(/limites?/, " "));
  if (!category && amount === null) return { action: "list" };
  if (category && amount !== null) return { action: amount > 0 ? "set" : "remove", category, amount };
  return { action: "help", category };
}

async function buildLimits(userId) {
  const budgets = await listBudgets(userId);
  if (budgets.length === 0) return 'Você não tem limites definidos.\nDefina com: "limite lazer 300".';
  const linhas = [];
  for (const b of budgets) {
    const spent = await getCategorySpentMonth(userId, b.category);
    const icon = spent > b.limit ? "⚠️" : spent >= b.limit * 0.8 ? "🟡" : "🟢";
    linhas.push(`${icon} ${b.category}: R$${fmt(spent)} / R$${fmt(b.limit)}`);
  }
  return `🎯 Seus limites (mês)\n\n${linhas.join("\n")}`;
}

// Sufixo de aviso pra anexar na confirmacao de um gasto. "" se nao houver limite.
async function budgetAlert(userId, category) {
  const limit = await getBudget(userId, category);
  if (!limit) return "";
  const spent = await getCategorySpentMonth(userId, category);
  if (spent > limit) return `\n⚠️ Estourou ${category}: R$${fmt(spent)} de R$${fmt(limit)} no mês.`;
  if (spent >= limit * 0.8) return `\n🟡 Quase no limite de ${category}: R$${fmt(spent)} de R$${fmt(limit)}.`;
  return "";
}

function parseRecurring(text) {
  const t = text.toLowerCase().trim();
  if (!/^\/?(recorrentes?|tirar recorrente|remover recorrente)\b/.test(t)) return null;

  const rem = t.match(/^\/?(?:tirar|remover)\s+recorrente\s+(\d+)/);
  if (rem) return { action: "remove", index: parseInt(rem[1], 10) };

  if (/^\/?recorrentes\b/.test(t) && extractAmount(t) === null) return { action: "list" };

  if (/^\/?recorrente\b/.test(t)) {
    const rest = text.replace(/^\s*\/?recorrente\s*/i, "");
    const amount = extractAmount(rest);
    if (amount === null) return { action: "help" };
    const category = categoryFromKeywords(rest) || "Outros";
    return { action: "add", amount, category, description: rest.trim() };
  }
  return { action: "help" };
}

async function buildRecurringList(userId) {
  const items = await listRecurring(userId);
  if (items.length === 0) return 'Você não tem gastos recorrentes.\nAdicione com: "recorrente aluguel 1200".';
  const linhas = items
    .map((r, i) => `${i + 1}. ${short(r.description)}: R$${fmt(r.amount)} — ${r.category}`)
    .join("\n");
  return `🔁 Seus gastos recorrentes\n\n${linhas}\n\nPra tirar um: "tirar recorrente <número>".`;
}

function parseReserve(text) {
  const t = text.toLowerCase().trim();
  if (/^\/?meta\s+reserva\b/.test(t)) {
    const target = extractAmount(t.replace(/meta\s+reserva/, " "));
    return { action: target ? "goal" : "help", target };
  }
  if (/\b(guardei|guardar|guardando|poupei|poupar|reservei)\b/.test(t)) {
    const amount = extractAmount(text);
    return { action: amount === null ? "help" : "deposit", amount };
  }
  if (/\breserva\b/.test(t) && /\b(tirei|tirar|saquei|sacar|resgatei|resgatar|usei|usar|retirei|retirar)\b/.test(t)) {
    const amount = extractAmount(text);
    return { action: amount === null ? "help" : "withdraw", amount };
  }
  if (/^\/?reservas?\b/.test(t) && extractAmount(t) === null) return { action: "show" };
  return null;
}

async function reserveLine(userId) {
  const total = await getReserveTotal(userId);
  const goal = await getReserveGoal(userId);
  if (goal && goal > 0) {
    const pct = Math.round((total / goal) * 100);
    return `🏦 Reserva: R$${fmt(total)} de R$${fmt(goal)} (${pct}%)`;
  }
  return `🏦 Reserva: R$${fmt(total)}`;
}

async function buildSummary(userId, period, category) {
  // Detalhe de uma categoria (gastos)
  if (category) {
    const items = await getCategoryDetail(userId, category, period);
    if (items.length === 0) return `Nenhum gasto em ${category} ${emptyLabel(period)}. 🙂`;
    const total = items.reduce((s, i) => s + i.amount, 0);
    const linhas = items.map((i) => `• ${i.day} — ${short(i.description)}: R$${fmt(i.amount)}`).join("\n");
    const plural = items.length === 1 ? "lançamento" : "lançamentos";
    return `📋 ${category} ${periodLabel(period)}\n\n${linhas}\n\nTotal: R$${fmt(total)} (${items.length} ${plural})`;
  }

  // Resumo geral: gastos por categoria + saldo
  const rows = await getSummary(userId, period);
  const totals = await getPeriodTotals(userId, period);
  if (rows.length === 0 && totals.income === 0 && totals.reserve === 0) {
    return `Nenhum lançamento ${emptyLabel(period)}. 🙂`;
  }
  const icon = totals.balance >= 0 ? "🟢" : "🔴";
  const cats = rows.map((r) => `• ${r.category}: R$${fmt(r.total)}`).join("\n");

  let out = `📊 Resumo ${periodLabel(period)}\n\n`;
  if (cats) out += cats + "\n\n";
  out += `Saídas: R$${fmt(totals.expense)}\n` + `Entradas: R$${fmt(totals.income)}\n`;
  out += `Saldo: R$${fmt(totals.balance)} ${icon}`;
  if (totals.reserve !== 0) out += `\n\n🏦 Guardado (à parte): R$${fmt(totals.reserve)}`;
  return out;
}

function fmtDateISO(iso) {
  if (!iso) return null;
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

function billStatus(b) {
  if (b.daysLeft == null) return "sem vencimento";
  if (b.daysLeft < 0) return `🔴 vencida há ${-b.daysLeft}d`;
  if (b.daysLeft === 0) return "🟠 vence hoje";
  if (b.daysLeft <= 3) return `🟡 vence em ${b.daysLeft}d`;
  return `vence ${b.dueFmt}`;
}

function resolveBill(bills, ref) {
  if (!ref) return bills.length === 1 ? bills[0] : null;
  const n = parseInt(ref, 10);
  if (Number.isInteger(n) && n >= 1 && n <= bills.length) return bills[n - 1];
  const key = ref.toLowerCase().trim();
  return key ? bills.find((b) => b.description.toLowerCase().includes(key)) || null : null;
}

async function buildBillsList(userId) {
  const bills = await listPendingBills(userId);
  if (!bills.length) return "Você não tem contas pendentes. 🎉";
  const linhas = bills.map((b, i) => {
    const val = b.amount != null ? ` — R$${fmt(b.amount)}` : "";
    let line = `${i + 1}. ${b.description}${val} (${billStatus(b)})`;
    if (b.barcode) line += `\n   🔢 ${b.barcode}`;
    return line;
  }).join("\n");
  return `📋 Contas a pagar\n\n${linhas}\n\nPra dar baixa: "paguei conta 1".\nPra remover: "remover conta 2".`;
}

// --- Cadastro guiado de boleto (valor -> nome -> vencimento -> registra -> código opcional) ---
const BILLFLOW_TTL_MS = 10 * 60 * 1000;
const pendingBill = new Map(); // userId -> { stage, amount, name, due, barcode, billId, at }

function startsBillFlow(text) {
  return /^\/?(registrar|cadastrar|nov[oa]|adicionar)\s+(boleto|conta)\b/.test(text.toLowerCase().trim());
}

function billQuestion(stage) {
  if (stage === "amount") return "💵 Qual o valor da conta? (ex: 120 ou 89,90)";
  if (stage === "name") return "📝 Qual o nome dessa conta? (ex: Luz, Internet)";
  if (stage === "due") return '📅 Qual o vencimento? (ex: "30/06", "dia 10") — ou manda "sem".';
  if (stage === "code_choice") return "Quer adicionar o código de barras? (sim/não)";
  if (stage === "code_input") return "Manda a *foto* do boleto ou *cola o código*.";
  return "";
}

async function finalizeBill(st) {
  const lines = [`📝 *Descrição:* ${st.name}`];
  if (st.amount != null) lines.push(`💵 *Valor:* R$${fmt(st.amount)}`);
  lines.push(`📅 *Vencimento:* ${fmtDateISO(st.due) || "não informado"}`);
  if (st.barcode) lines.push(`🔢 *Código:* ${st.barcode}`);
  return {
    text: "🧾 *Conta registrada!*\n\n" + lines.join("\n"),
    buttons: [
      { id: `pay:${st.billId}`, title: "✅ Paguei" },
      { id: `delbill:${st.billId}`, title: "🗑️ Excluir" },
    ],
  };
}

// Registra o boleto assim que temos valor+nome+vencimento. Devolve o billId.
async function registerPendingBill(userId, st) {
  const category = categoryFromKeywords(st.name) || "Casa";
  st.billId = await addBill(userId, {
    description: st.name, amount: st.amount, dueDate: st.due,
    barcode: st.barcode || null, category,
  });
  return st.billId;
}

// Avança o fluxo a partir de uma mensagem de texto. Retorna a resposta, ou null se não há fluxo ativo.
async function advanceBillFlow(userId, text) {
  const st = pendingBill.get(userId);
  if (!st) return null;
  if (Date.now() - st.at > BILLFLOW_TTL_MS) { pendingBill.delete(userId); return null; }
  const t = text.trim().toLowerCase();
  if (/^(cancelar|cancela|parar|sair)$/.test(t)) { pendingBill.delete(userId); return "Cadastro cancelado."; }
  st.at = Date.now();

  if (st.stage === "amount") {
    const a = extractAmount(text);
    if (a == null) return 'Não entendi o valor. Manda só o número (ex: "120"). Ou "cancelar".';
    st.amount = a; st.stage = "name";
    return billQuestion("name");
  }
  if (st.stage === "name") {
    const name = text.trim().replace(/[*_`]/g, "");
    if (!name) return billQuestion("name");
    st.name = name.charAt(0).toUpperCase() + name.slice(1);
    st.stage = "due";
    return billQuestion("due");
  }
  if (st.stage === "due") {
    if (/^(sem|n[ãa]o|pular|skip)$/.test(t)) st.due = null;
    else {
      const d = parseDueDate(text);
      if (!d) return 'Não entendi a data. Manda "30/06", "dia 10", ou "sem".';
      st.due = d.date;
    }
    await registerPendingBill(userId, st);
    if (st.barcode) { pendingBill.delete(userId); return await finalizeBill(st); }
    st.stage = "code_choice";
    return "Conta registrada! ✅ " + billQuestion("code_choice");
  }
  if (st.stage === "code_choice") {
    if (/^(sim|s|quero|claro|pode)$/.test(t)) { st.stage = "code_input"; return billQuestion("code_input"); }
    pendingBill.delete(userId);
    return await finalizeBill(st);
  }
  if (st.stage === "code_input") {
    const bc = extractBarcode(text);
    if (!bc) return 'Não vi um código válido. Cola a linha digitável (uns 47 números) ou manda a foto. Ou "cancelar".';
    if (!validateBoleto(bc.code)) return "Esse código não passou na validação — confere e manda de novo, ou a foto.";
    await updateBillBarcode(userId, st.billId, bc.code);
    st.barcode = bc.code;
    pendingBill.delete(userId);
    return await finalizeBill(st);
  }
  return null;
}

export async function handleMessage({ channel, externalId, text }) {
  const { id: userId, isNew } = await getOrCreateUser(channel, externalId);

  // Lança os recorrentes do mês atual se ainda não foram lançados (idempotente).
  await materializeRecurring(userId);

  // --- Apagar tudo, com dupla confirmacao (tem prioridade sobre tudo) ---
  const t = text.trim().toLowerCase();
  const pend = pendingClear.get(userId);
  if (pend && Date.now() - pend.at > CLEAR_TTL_MS) {
    pendingClear.delete(userId); // expirou
  }
  const active = pendingClear.get(userId);

  if (active) {
    if (t === "confirmar") {
      pendingClear.delete(userId);
      const n = await deleteAllData(userId);
      return `🧹 Pronto, apaguei tudo (${n} lançamento${n === 1 ? "" : "s"}), além dos limites e recorrentes. Você está começando do zero.`;
    }
    // qualquer outra coisa aborta, por segurança
    pendingClear.delete(userId);
    return "❌ Apagar tudo cancelado — nada foi apagado. Pode mandar seu comando de novo.";
  }

  if (isClearAllRequest(text)) {
    pendingClear.set(userId, { at: Date.now() });
    return "⚠️ Isso vai apagar TODOS os seus lançamentos, pra sempre — não dá pra desfazer.\n\nSe tem certeza, responda: CONFIRMAR";
  }

  // --- Edição via botão: a próxima mensagem traz o novo valor/categoria ---
  const pe = pendingEdit.get(userId);
  if (pe && Date.now() - pe.at > EDIT_TTL_MS) pendingEdit.delete(userId);
  const activeEdit = pendingEdit.get(userId);
  if (activeEdit) {
    const amount = extractAmount(text);
    const category = matchCategoryName(text) || categoryFromKeywords(text);
    if (amount !== null || category) {
      pendingEdit.delete(userId);
      const updated = await updateTransactionById(userId, activeEdit.id, { amount, category });
      if (!updated) return "Esse lançamento já não existe mais. 🤷";
      return `Corrigido ✅ R$${fmt(updated.amount)} — ${updated.category}`;
    }
    // não parece edição -> cancela e segue o fluxo normal
    pendingEdit.delete(userId);
  }

  // Cadastro guiado de boleto em andamento?
  const billFlow = await advanceBillFlow(userId, text);
  if (billFlow !== null) return billFlow;
  if (startsBillFlow(text)) {
    pendingBill.set(userId, { stage: "amount", amount: null, name: null, due: null, barcode: null, billId: null, at: Date.now() });
    return billQuestion("amount");
  }

  if (isGreeting(text)) return TUTORIAL;

  if (isSummaryRequest(text)) {
    const period = detectPeriod(text);
    if (wantsIncome(text)) return await buildIncomeSummary(userId, period);
    const category = matchCategoryName(text) || categoryFromKeywords(text);
    return await buildSummary(userId, period, category);
  }

  // --- Contas a pagar (boletos) ---
  const bill = parseBill(text);
  if (bill) {
    if (bill.action === "list") return await buildBillsList(userId);

    if (bill.action === "pay" || bill.action === "remove") {
      const bills = await listPendingBills(userId);
      if (!bills.length) return "Você não tem contas pendentes. 🎉";
      const target = resolveBill(bills, bill.ref);
      if (!target) return 'Não achei essa conta. Manda "contas" pra ver a lista numerada.';
      if (bill.action === "pay") {
        const paid = await markBillPaid(userId, target.id);
        if (!paid) return "Essa conta já foi paga. 🤷";
        if (paid.amount != null) {
          await insertTransaction({
            userId, amount: paid.amount, category: paid.category || "Casa",
            description: paid.description, rawMessage: "(conta paga)",
          });
          return `✅ Conta paga: ${paid.description} — R$${fmt(paid.amount)} lançado em ${paid.category || "Casa"}.`;
        }
        return `✅ Conta paga: ${paid.description}.`;
      }
      const removed = await deleteBillById(userId, target.id);
      return `🗑️ Conta removida: ${removed.description}.`;
    }

    // add
    const category = categoryFromKeywords(text) || "Casa";
    const id = await addBill(userId, {
      description: bill.description, amount: bill.amount,
      dueDate: bill.dueDate, barcode: bill.barcode, category,
    });
    const lines = [`📝 *Descrição:* ${bill.description}`];
    if (bill.amount != null) lines.push(`💵 *Valor:* R$${fmt(bill.amount)}`);
    lines.push(`📅 *Vencimento:* ${fmtDateISO(bill.dueDate) || "não informado"}`);
    if (bill.barcode) lines.push(`🔢 *Código:* ${bill.barcode}`);
    return {
      text: "🧾 *Conta registrada!*\n\n" + lines.join("\n"),
      buttons: [
        { id: `pay:${id}`, title: "✅ Paguei" },
        { id: `delbill:${id}`, title: "🗑️ Excluir" },
      ],
    };
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

  // Limites de orçamento: definir / listar / remover
  const limit = parseLimit(text);
  if (limit) {
    if (limit.action === "list") return await buildLimits(userId);
    if (limit.action === "help" || !limit.category) {
      return 'Pra definir um limite: "limite lazer 300".\nVer todos: "limites".\nTirar: "tirar limite lazer".';
    }
    if (limit.action === "remove") {
      const n = await removeBudget(userId, limit.category);
      return n ? `Limite de ${limit.category} removido.` : `Não havia limite em ${limit.category}.`;
    }
    await setBudget(userId, limit.category, limit.amount);
    return `🎯 Limite de ${limit.category}: R$${fmt(limit.amount)}/mês. Te aviso quando chegar perto.`;
  }

  // Gastos recorrentes: criar / listar / remover
  const rec = parseRecurring(text);
  if (rec) {
    if (rec.action === "list") return await buildRecurringList(userId);
    if (rec.action === "help") {
      return 'Pra criar um gasto recorrente: "recorrente aluguel 1200".\nVer todos: "recorrentes". Tirar: "tirar recorrente 1".';
    }
    if (rec.action === "remove") {
      const items = await listRecurring(userId);
      const item = items[rec.index - 1];
      if (!item) return `Não achei o recorrente número ${rec.index}. Veja a lista com "recorrentes".`;
      await deactivateRecurring(userId, item.id);
      return `Recorrente removido: ${short(item.description)} (R$${fmt(item.amount)}). Tirei também o lançamento deste mês.`;
    }
    await addRecurring(userId, { amount: rec.amount, category: rec.category, description: rec.description });
    await materializeRecurring(userId); // já lança o deste mês
    return `🔁 Recorrente criado: ${short(rec.description)} — R$${fmt(rec.amount)}/mês em ${rec.category}.\nVou lançar sozinho todo mês.`;
  }

  // Reserva de emergência: guardar / tirar / ver / meta
  const reserve = parseReserve(text);
  if (reserve) {
    if (reserve.action === "show") return await reserveLine(userId);
    if (reserve.action === "goal") {
      await setReserveGoal(userId, reserve.target);
      return `🎯 Meta de reserva: R$${fmt(reserve.target)}. Bora guardar! 💪`;
    }
    if (reserve.action === "help") {
      return 'Pra guardar: "guardei 200 na reserva".\nTirar: "tirei 100 da reserva".\nVer: "reserva". Meta: "meta reserva 5000".';
    }
    if (reserve.action === "withdraw") {
      const total = await getReserveTotal(userId);
      if (reserve.amount > total) {
        return `Você tem só R$${fmt(total)} na reserva — não dá pra tirar R$${fmt(reserve.amount)}.`;
      }
      await insertTransaction({
        userId, amount: -reserve.amount, category: "Reserva",
        description: text, rawMessage: text, kind: "reserve",
      });
      return `↩️ Tirei R$${fmt(reserve.amount)} da reserva (voltou pro disponível).\n${await reserveLine(userId)}`;
    }
    // deposit
    const id = await insertTransaction({
      userId, amount: reserve.amount, category: "Reserva",
      description: text, rawMessage: text, kind: "reserve",
    });
    return card(
      "🏦 *Guardado na reserva!*",
      [`💵 *Valor:* R$${fmt(reserve.amount)}`, `📅 *Data:* ${hojeBR()}`],
      await reserveLine(userId),
      id
    );
  }

  // Estorno / devolucao (dinheiro que volta) -> gasto negativo na categoria
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

  // Entrada (recebi/ganhei/salário...)
  const income = parseIncome(text);
  if (income) {
    const category = incomeSource(text);
    const id = await insertTransaction({
      userId,
      amount: income.amount,
      category,
      description: text,
      rawMessage: text,
      kind: "income",
    });
    const totals = await getPeriodTotals(userId, "month");
    const icon = totals.balance >= 0 ? "🟢" : "🔴";
    let footer = `📊 Saldo do mês: R$${fmt(totals.balance)} ${icon}`;
    if (isNew) footer += NEW_USER_HINT;
    return card("💰 *Entrada registrada!*", txFields(cleanDesc(income.description), category, income.amount), footer, id);
  }

  // Compra parcelada
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

  // Gasto comum
  const parsed = await parseMessage(text);
  if (!parsed) {
    if (isNew) return TUTORIAL;
    return "Não achei um valor nessa mensagem 🤔\nManda \"gastei 30 no almoço\", \"recebi 2000 salário\", ou peça \"resumo\".";
  }

  const id = await insertTransaction({
    userId,
    amount: parsed.amount,
    category: parsed.category,
    description: parsed.description,
    rawMessage: text,
  });

  const total = await getTodayTotal(userId);
  let footer = `📊 Hoje: R$${fmt(total)}`;
  footer += await budgetAlert(userId, parsed.category);
  if (isNew) footer += NEW_USER_HINT;
  return card("✅ *Novo gasto registrado!*", txFields(cleanDesc(parsed.description), parsed.category, parsed.amount), footer, id);
}

// Tratamento dos cliques nos botões (Editar / Excluir). data = "del:<id>" ou "edit:<id>".
export async function handleCallback({ channel, externalId, data }) {
  const { id: userId } = await getOrCreateUser(channel, externalId);
  const sep = data.indexOf(":");
  const action = data.slice(0, sep);
  const txId = data.slice(sep + 1);

  if (action === "del") {
    const removed = await deleteTransactionById(userId, txId);
    if (!removed) return "Esse lançamento já não existe mais. 🤷";
    return `Excluído ❌ R$${fmt(removed.amount)} — ${removed.category}`;
  }
  if (action === "edit") {
    const tx = await getTransactionById(userId, txId);
    if (!tx) return "Esse lançamento já não existe mais. 🤷";
    pendingEdit.set(userId, { id: txId, at: Date.now() });
    return '✏️ Manda o novo valor e/ou categoria desse lançamento.\nEx: "75", "lazer", ou "75 lazer".';
  }
  if (action === "pay") {
    const paid = await markBillPaid(userId, txId);
    if (!paid) return "Essa conta já foi paga ou não existe mais. 🤷";
    if (paid.amount != null) {
      await insertTransaction({
        userId, amount: paid.amount, category: paid.category || "Casa",
        description: paid.description, rawMessage: "(conta paga)",
      });
      return `✅ Conta paga: ${paid.description} — R$${fmt(paid.amount)} lançado em ${paid.category || "Casa"}.`;
    }
    return `✅ Conta paga: ${paid.description}.`;
  }
  if (action === "delbill") {
    const removed = await deleteBillById(userId, txId);
    if (!removed) return "Essa conta não existe mais. 🤷";
    return `🗑️ Conta removida: ${removed.description}.`;
  }
  return "Ação não reconhecida.";
}

// Foto de boleto: alimenta o cadastro guiado (o valor vem da pessoa, não da leitura).
export async function handlePhoto({ channel, externalId, imageBuffer }) {
  const { id: userId } = await getOrCreateUser(channel, externalId);
  const st = pendingBill.get(userId);
  const code = await decodeBoleto(imageBuffer);

  // Fluxo em andamento esperando o código
  if (st && st.stage === "code_input") {
    if (!code || !validateBoleto(code)) {
      return "Não consegui ler o código da foto 😕. Tenta mais reta/iluminada, ou cola o número.";
    }
    await updateBillBarcode(userId, st.billId, code);
    st.barcode = code;
    pendingBill.delete(userId);
    return await finalizeBill(st);
  }

  // Fluxo em andamento em outra etapa: guarda o código e segue de onde estava
  if (st) {
    if (code && validateBoleto(code)) { st.barcode = code; st.at = Date.now(); return "Li o código ✅. " + billQuestion(st.stage); }
    return billQuestion(st.stage);
  }

  // Foto solta: começa o cadastro guiado já com o código (a pessoa informa o valor)
  if (!code || !validateBoleto(code)) {
    return "Não consegui ler o boleto 😕. Tenta uma foto mais reta e iluminada, cola o número, ou manda \"registrar boleto\" pra cadastrar na mão.";
  }
  pendingBill.set(userId, { stage: "amount", amount: null, name: null, due: null, barcode: code, billId: null, at: Date.now() });
  return "Li o código ✅. Agora me diz o *valor* da conta. (ex: 120)";
}