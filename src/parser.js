import { CATEGORIES, categoryFromKeywords } from "./categories.js";

// Extrai valor em R$ de "30", "R$ 30", "gastei 12,90", "8 reais".
export function extractAmount(text) {
  const m = text.match(/(?:r\$\s*)?(\d{1,3}(?:\.\d{3})+|\d+)(?:[.,](\d{1,2}))?/i);
  if (!m) return null;
  const intPart = m[1].replace(/\./g, "");
  const decPart = m[2] ? m[2] : "0";
  const value = parseFloat(`${intPart}.${decPart}`);
  return Number.isFinite(value) && value > 0 ? value : null;
}

// Detecta compra parcelada: "12x", "12 vezes", "12 parcelas".
// Convencao: o valor e o TOTAL, salvo quando vem "Nx de VALOR" (= por parcela).
//   "celular 1200 em 12x"   -> total 1200, 12 parcelas
//   "12x de 100"            -> 100 por parcela, total 1200
export function parseInstallment(text) {
  const t = text.toLowerCase();
  const nMatch = t.match(/(\d+)\s*(?:x\b|vezes?\b|parcelas?\b)/);
  if (!nMatch) return null;
  const n = parseInt(nMatch[1], 10);
  if (n < 2 || n > 360) return null;

  // texto sem o "Nx" pra nao confundir o N com o valor
  const rest = t.slice(0, nMatch.index) + " " + t.slice(nMatch.index + nMatch[0].length);
  const amount = extractAmount(rest);
  if (amount === null) return null;

  // "de" logo apos o Nx => valor por parcela; senao => total
  const afterN = t.slice(nMatch.index + nMatch[0].length);
  const isPerParcela = /^\s*de\b/.test(afterN);
  const total = isPerParcela ? amount * n : amount;

  return { total, n };
}

// Detecta ENTRADA (dinheiro recebido): "recebi 2000 salario", "ganhei 50".
export function parseIncome(text) {
  const t = text.toLowerCase();
  if (!/\b(recebi|ganhei|entrou|caiu|sal[áa]rio|recebimento|me pagaram|pix recebido)\b/.test(t)) return null;
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

  if (typeof parsed.amount !== "number" || !(parsed.amount > 0)) return null; // nao e um gasto
  const category = CATEGORIES.includes(parsed.category) ? parsed.category : "Outros";
  return { amount: parsed.amount, category, description: parsed.description || text.trim(), source: "llm" };
}

export async function parseMessage(text) {
  const ruled = parseByRules(text);

  // Caminho barato: regra achou valor E categoria -> sem LLM.
  if (ruled && ruled.category) return ruled;

  // Senao, tenta o LLM (resolve valor por extenso e categoria desconhecida).
  if (process.env.LLM_API_URL) {
    try {
      const llm = await parseByLLM(text);
      if (llm) return llm;
    } catch (e) {
      console.error("LLM error:", e?.message || e);
    }
  }

  // LLM indisponivel/falhou: usa o que a regra deu (valor sem categoria -> Outros).
  if (ruled) return { ...ruled, category: ruled.category || "Outros" };
  return null;
}