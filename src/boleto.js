// Leitura e validação de boleto a partir de imagem.
// Pipeline: zbar (barras) -> OCR (tesseract) -> valida checksum -> extrai valor/vencimento.
// As libs são importadas sob demanda; se faltarem, cai no fallback silenciosamente.

const isoToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
function addDaysISO(iso, n) {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Pega uma sequência de 44/47/48 dígitos a partir de um texto solto.
function onlyBoletoDigits(text) {
  const run = (text.match(/\d[\d.\s]{38,}\d/) || [""])[0].replace(/\D/g, "");
  if (run.length === 44 || run.length === 47 || run.length === 48) return run;
  if (run.length > 48) return run.slice(-47);
  const all = text.replace(/\D/g, "");
  if (all.length === 44 || all.length === 47 || all.length === 48) return all;
  return null;
}

async function decodeWithZbar(buffer) {
  const jpeg = (await import("jpeg-js")).default;
  const { scanImageData } = await import("@undecaf/zbar-wasm");
  const img = jpeg.decode(buffer, { useTArray: true, maxMemoryUsageInMB: 1024 });
  const symbols = await scanImageData({ data: img.data, width: img.width, height: img.height });
  if (!symbols || !symbols.length) return null;
  const s = symbols[0];
  const txt = typeof s.decode === "function" ? s.decode() : (s.data || "");
  return txt ? onlyBoletoDigits(String(txt)) : null;
}

async function decodeWithOCR(buffer) {
  const Tesseract = (await import("tesseract.js")).default;
  const { data } = await Tesseract.recognize(buffer, "eng");
  return onlyBoletoDigits(data?.text || "");
}

// Tenta as barras primeiro; se falhar, OCR. Retorna os dígitos ou null.
export async function decodeBoleto(buffer) {
  try {
    const code = await decodeWithZbar(buffer);
    if (code) return code;
  } catch (e) {
    console.error("zbar falhou:", e?.message || e);
  }
  try {
    const code = await decodeWithOCR(buffer);
    if (code) return code;
  } catch (e) {
    console.error("ocr falhou:", e?.message || e);
  }
  return null;
}

// ---- Checksum ----
function mod10(num) {
  let sum = 0, weight = 2;
  for (let i = num.length - 1; i >= 0; i--) {
    let p = parseInt(num[i], 10) * weight;
    if (p > 9) p = Math.floor(p / 10) + (p % 10);
    sum += p;
    weight = weight === 2 ? 1 : 2;
  }
  return (10 - (sum % 10)) % 10;
}

function validateLinha47(d) {
  const c1 = d.slice(0, 9), dv1 = +d[9];
  const c2 = d.slice(10, 20), dv2 = +d[20];
  const c3 = d.slice(21, 31), dv3 = +d[31];
  return mod10(c1) === dv1 && mod10(c2) === dv2 && mod10(c3) === dv3;
}

// Valida o que dá pra validar com segurança. 47 dígitos: 3 DVs mod10 (pega erro de OCR).
// 44/48: aceita por formato (validação completa não implementada).
export function validateBoleto(d) {
  if (!/^\d+$/.test(d)) return false;
  if (d.length === 47) return validateLinha47(d);
  if (d.length === 44 || d.length === 48) return true;
  return false;
}

// ---- Extração de valor e vencimento ----
function linha47ToBarcode44(d) {
  const banco = d.slice(0, 4);
  const dvGeral = d[32];
  const fator = d.slice(33, 37);
  const valor = d.slice(37, 47);
  const livre = d.slice(4, 9) + d.slice(10, 20) + d.slice(21, 31);
  return banco + dvGeral + fator + valor + livre;
}

// Fator de vencimento -> data. Testa base antiga e pós-rollover; só aceita data numa janela sã.
function fatorToDate(fator) {
  if (!fator) return null;
  const today = isoToday();
  const candidates = [
    addDaysISO("1997-10-07", fator),
    addDaysISO("2025-02-22", fator - 1000), // pós-rollover, fator reinicia ~1000
  ];
  for (const iso of candidates) {
    if (iso >= addDaysISO(today, -370) && iso <= addDaysISO(today, 400)) return iso;
  }
  return null;
}

export function extractBoletoInfo(d) {
  let bc = null;
  if (d.length === 47) bc = linha47ToBarcode44(d);
  else if (d.length === 44) bc = d;
  if (!bc) return { amount: null, dueDate: null }; // 48 (arrecadação): estrutura diferente, não extrai

  const cents = parseInt(bc.slice(9, 19), 10);
  const amount = cents > 0 ? cents / 100 : null;
  const dueDate = fatorToDate(parseInt(bc.slice(5, 9), 10));
  return { amount, dueDate };
}