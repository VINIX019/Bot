// Meio-termo: a lista e FIXA. O parser sempre encaixa a mensagem livre
// numa dessas. Quer categoria nova? Adiciona aqui (e os keywords dela).

export const CATEGORIES = [
  "Alimentação",
  "Transporte",
  "Mercado",
  "Lazer",
  "Saúde",
  "Educação",
  "Casa",
  "Outros",
];

export const KEYWORD_MAP = {
  Alimentação: ["almoço", "almoco", "janta", "jantar", "lanche", "comida", "rango", "restaurante", "ifood", "café", "cafe", "padaria", "pizza", "hamburguer", "marmita"],
  Transporte: ["uber", "gasolina", "combustível", "combustivel", "ônibus", "onibus", "metrô", "metro", "passagem", "estacionamento", "pedágio", "pedagio"],
  Mercado: ["mercado", "supermercado", "feira", "compras", "hortifruti"],
  Lazer: ["cinema", "bar", "balada", "show", "netflix", "spotify", "jogo", "viagem", "passeio"],
  Saúde: ["farmácia", "farmacia", "remédio", "remedio", "médico", "medico", "dentista", "academia", "consulta", "exame"],
  Educação: ["faculdade", "facul", "curso", "mensalidade", "matrícula", "matricula", "livro", "livros", "material", "apostila", "escola"],
  Casa: ["aluguel", "luz", "água", "agua", "internet", "conta", "gás", "gas", "condomínio", "condominio"],
};

// tira acento e poe minusculo, pra comparar sem se preocupar com "educacao" vs "educação"
const norm = (s) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

function tokenize(text) {
  return text
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter(Boolean);
}

// Match por PALAVRA INTEIRA (token), nao substring. Assim "gas" so casa
// com "gas"/"gás" sozinho, nunca dentro de "gastei".
export function categoryFromKeywords(text) {
  const set = new Set(tokenize(text));
  for (const [category, words] of Object.entries(KEYWORD_MAP)) {
    if (words.some((w) => set.has(w))) return category;
  }
  return null;
}

// Acha o NOME de uma categoria escrito pelo usuario (ex: "educação", "lazer").
// Usado no comando de editar. Retorna null se nao reconhecer.
export function matchCategoryName(text) {
  const tokens = tokenize(text).map(norm);
  for (const cat of CATEGORIES) {
    if (tokens.includes(norm(cat))) return cat;
  }
  return null;
}