import { CATEGORIES, categoryFromKeywords } from "./categories.js";

export function extractAmount(text) {
  const m = text.match(/(?:r\$\s*)?(\d{1,3}(?:\.\d{3})+|\d+)(?:[.,](\d{1,2}))?/i);
  if (!m) return null;
  const intPart = m[1].replace(/\./g, "");
  const decPart = m[2] ? m[2] : "0";
  const value = parseFloat(`${intPart}.${decPart}`);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function parseInstallment(text) {
  const t = text.toLowerCase();
  const nMatch = t.match(/(\d+)\s*(?:x\b|vezes?\b|parcelas?\b)/);
  if (!nMatch) return null;
  const n = parseInt(nMatch[1], 10);
  if (n < 2 || n > 360) return null;

  const rest = t.slice(0, nMatch.index) + " " + t.slice(nMatch.index + nMatch[0].length);
  const amount = extractAmount(rest);
  if (amount === null) return null;

  const afterN = t.slice(nMatch.index + nMatch[0].length);
  const isPerParcela = /^\s*de\b/.test(afterN);
  const total = isPerParcela ? amount * n : amount;

  return { total, n };
}

export function parseIncome(text) {
  const t = text.toLowerCase();
  if (!/\b(recebi|ganhei|entrou|caiu|sal[áa]rio|recebimento|me pagaram|pix recebido)\b/.test(t)) return null;
  const amount = extractAmount(text);
  if (amount === null) return null;
  return { amount, description: text.trim() };
}

export function parseRefund(text) {
  const t = text.toLowerCase();
  if (!/\b(estorno|estornou|estornaram|estornei|estornad[oa]|devolu[çc][ãa]o|devolveram|devolvi|devolvido|reembolso|reembolsaram|reembolsad[oa])\b/.test(t)) return null;
  const amount = extractAmount(text);
  if (amount === null) return null;
  return { amount, description: text.trim() };
}

function parseByRules(text) {
  const amount = extractAmount(text);
  if (amount === null) return null;
  const category = categoryFromKeywords(text);
  return { amount, category: category || null, description: text.trim(), source: "rule" };
}

async function parseByLLM(text) {
  const prompt =
    `Extraia um gasto de uma mensagem em português.\n` +
    `Categorias válidas: ${CATEGORIES.join(", ")}.\n` +
    `Mensagem: "${text}"\n` +
    `Regras:\n` +
    `- "amount" é o valor em reais como número. Entenda valor por extenso ("trinta" = 30, "mil e quinhentos" = 1500).\n` +
    `- Se a mensagem NÃO for um gasto com valor identificável, devolva "amount": null.\n` +
    `- Escolha a categoria mais próxima da lista; se nenhuma servir, use "Outros".\n` +
    `Responda APENAS JSON, sem markdown: {"amount": number ou null, "category": "...", "description": "curta"}`;

  const res = await fetch(process.env.LLM_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.LLM_API_KEY}`,
    },
    body: JSON.stringify({
      model: process.env.LLM_MODEL,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 150,
      temperature: 0,
    }),
  });

  const data = await res.json();
  const raw = data.choices?.[0]?.message?.content ?? data.content?.[0]?.text ?? "";
  const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());

  if (typeof parsed.amount !== "number" || !(parsed.amount > 0)) return null;
  const category = CATEGORIES.includes(parsed.category) ? parsed.category : "Outros";
  return { amount: parsed.amount, category, description: parsed.description || text.trim(), source: "llm" };
}

export async function parseMessage(text) {
  const ruled = parseByRules(text);

  if (ruled && ruled.category) return ruled;

  if (process.env.LLM_API_URL) {
    try {
      const llm = await parseByLLM(text);
      if (llm) return llm;
    } catch (e) {
      console.error("LLM error:", e?.message || e);
    }
  }

  if (ruled) return { ...ruled, category: ruled.category || "Outros" };
  return null;
}
// ---------- Contas a pagar (boletos) ----------

const brtToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" }); // YYYY-MM-DD
const ymd = (y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const addDaysISO = (iso, n) => {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// Extrai a linha digitavel do boleto (44 a 48 digitos, podendo ter pontos/espacos).
export function extractBarcode(text) {
  const m = text.match(/\d[\d.\s]{38,}\d/);
  if (!m) return null;
  const digits = m[0].replace(/\D/g, "");
  if (digits.length >= 44 && digits.length <= 48) return { code: digits, raw: m[0] };
  if (digits.length > 48) {
    // pegou números colados antes do código; fica com o final (47 bancário / 48 arrecadação)
    const last48 = digits.slice(-48);
    const code = last48.startsWith("8") ? last48 : digits.slice(-47);
    return { code, raw: m[0] };
  }
  return null;
}

// Acha um vencimento no texto. Retorna { date: 'YYYY-MM-DD', raw }.
export function parseDueDate(text) {
  const today = brtToday();
  const [ty, tm] = today.split("-").map(Number);
  let m;
  if ((m = text.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/))) {
    const d = +m[1], mo = +m[2];
    let y = m[3] ? +m[3] : ty;
    if (m[3] && m[3].length === 2) y = 2000 + (+m[3]);
    if (d > 31 || mo > 12 || d < 1 || mo < 1) return null;
    let iso = ymd(y, mo, d);
    if (!m[3] && iso < today) iso = ymd(y + 1, mo, d);
    return { date: iso, raw: m[0] };
  }
  if ((m = text.match(/\bdia\s+(\d{1,2})\b/i))) {
    const d = +m[1];
    if (d > 31 || d < 1) return null;
    let mo = tm, y = ty;
    let iso = ymd(y, mo, d);
    if (iso < today) { mo++; if (mo > 12) { mo = 1; y++; } iso = ymd(y, mo, d); }
    return { date: iso, raw: m[0] };
  }
  if (/\bamanh[ãa]\b/i.test(text)) return { date: addDaysISO(today, 1), raw: text.match(/\bamanh[ãa]\b/i)[0] };
  if (/\bhoje\b/i.test(text)) return { date: today, raw: "hoje" };
  return null;
}

export function parseBill(text) {
  const t = text.toLowerCase().trim();

  // Listar
  if (/^\/?(contas|minhas contas|boletos|meus boletos)\s*$/.test(t)) return { action: "list" };

  // Dar baixa: "paguei conta 1", "conta luz paga", "paguei a conta luz"
  if (/\bconta\b/.test(t) && /\bpag(uei|a|o|ar|ou)\b/.test(t)) {
    const ref = t.replace(/\bpag\w+\b/g, " ").replace(/\b(a|as|o|os|de|da|do|minha|conta|contas)\b/g, " ").trim();
    return { action: "pay", ref };
  }

  // Remover: "remover conta 2", "excluir conta luz"
  if (/\bconta\b/.test(t) && /\b(remover|excluir|tirar|apagar|cancelar)\b/.test(t)) {
    const ref = t.replace(/\b(remover|excluir|tirar|apagar|cancelar)\b/g, " ").replace(/\b(a|as|o|os|de|da|do|minha|conta|contas)\b/g, " ").trim();
    return { action: "remove", ref };
  }

  // Adicionar: extrai data PRIMEIRO (pra não colidir com o código de barras), depois código, depois valor
  const due = parseDueDate(text);
  let work = due ? text.replace(due.raw, " ") : text;
  const bc = extractBarcode(work);
  const isBill = /\bboleto\b|\bfatura\b/.test(t) || (/\bconta\b/.test(t) && (due || /\bvenc/.test(t)));
  if (!isBill && !bc) return null;
  if (bc) work = work.replace(bc.raw, " ");
  const amount = extractAmount(work);

  let desc = work
    .replace(/r\$\s*\d[\d.,]*/gi, " ")
    .replace(/\b\d[\d.,]*\b/g, " ")
    .replace(/\bvenc\w*\b/gi, " ")
    .replace(/\b(boleto|fatura|conta|c[oó]digo|cod|linha|digit[aá]vel)\b/gi, " ")
    .replace(/[*_`\/]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!desc) desc = "Conta";
  desc = desc.charAt(0).toUpperCase() + desc.slice(1);

  return {
    action: "add",
    description: desc,
    amount,
    dueDate: due ? due.date : null,
    barcode: bc ? bc.code : null,
  };
}