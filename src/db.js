import crypto from "crypto";
import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const TZ = "America/Sao_Paulo";

export async function getOrCreateUser(channel, externalId) {
  const { rows } = await pool.query(
    `insert into users (channel, external_id)
       values ($1, $2)
       on conflict (channel, external_id) do update set channel = excluded.channel
       returning id, (xmax = 0) as is_new`,
    [channel, externalId]
  );
  return { id: rows[0].id, isNew: rows[0].is_new };
}

// kind: 'expense' (padrao) ou 'income'
export async function insertTransaction({ userId, amount, category, description, rawMessage, kind = "expense" }) {
  const { rows } = await pool.query(
    `insert into transactions (user_id, amount, category, description, raw_message, kind)
       values ($1, $2, $3, $4, $5, $6)
       returning id`,
    [userId, amount, category, description, rawMessage, kind]
  );
  return rows[0].id;
}

export async function getTransactionById(userId, id) {
  const { rows } = await pool.query(
    `select amount, category from transactions where id = $1 and user_id = $2`,
    [id, userId]
  );
  return rows.length ? { amount: parseFloat(rows[0].amount), category: rows[0].category } : null;
}

export async function deleteTransactionById(userId, id) {
  const { rows } = await pool.query(
    `delete from transactions where id = $1 and user_id = $2 returning amount, category`,
    [id, userId]
  );
  return rows.length ? { amount: parseFloat(rows[0].amount), category: rows[0].category } : null;
}

export async function updateTransactionById(userId, id, { amount = null, category = null }) {
  const { rows } = await pool.query(
    `update transactions set amount = coalesce($3, amount), category = coalesce($4, category)
      where id = $1 and user_id = $2 returning amount, category`,
    [id, userId, amount, category]
  );
  return rows.length ? { amount: parseFloat(rows[0].amount), category: rows[0].category } : null;
}

export async function insertInstallments({ userId, total, n, category, description, rawMessage }) {
  const groupId = crypto.randomUUID();
  const cents = Math.round(total * 100);
  const base = Math.floor(cents / n);
  const remainder = cents - base * n;

  for (let k = 0; k < n; k++) {
    const amount = (base + (k < remainder ? 1 : 0)) / 100;
    await pool.query(
      `insert into transactions (user_id, amount, category, description, raw_message, occurred_at, installment_group, kind)
         values ($1, $2, $3, $4, $5, now() + ($6 || ' month')::interval, $7, 'expense')`,
      [userId, amount, category, `${description} (parcela ${k + 1}/${n})`, rawMessage, k, groupId]
    );
  }
  return { groupId };
}

// So GASTOS de hoje.
export async function getTodayTotal(userId) {
  const { rows } = await pool.query(
    `select coalesce(sum(amount), 0) as total
       from transactions
      where user_id = $1
        and kind = 'expense'
        and occurred_at at time zone '${TZ}' >= date_trunc('day', now() at time zone '${TZ}')
        and occurred_at at time zone '${TZ}' <  date_trunc('day', now() at time zone '${TZ}') + interval '1 day'`,
    [userId]
  );
  return parseFloat(rows[0].total);
}

// GASTOS por categoria no periodo.
export async function getSummary(userId, period) {
  const { rows } = await pool.query(
    `select category, sum(amount) as total
       from transactions
      where user_id = $1
        and kind = 'expense'
        and occurred_at at time zone '${TZ}' >= date_trunc($2, now() at time zone '${TZ}')
        and occurred_at at time zone '${TZ}' <  date_trunc($2, now() at time zone '${TZ}') + ('1 ' || $2)::interval
      group by category
      order by total desc`,
    [userId, period]
  );
  return rows.map((r) => ({ category: r.category, total: parseFloat(r.total) }));
}

// Totais de entrada e saida no periodo, pra calcular saldo.
export async function getPeriodTotals(userId, period) {
  const { rows } = await pool.query(
    `select kind, coalesce(sum(amount), 0) as total
       from transactions
      where user_id = $1
        and occurred_at at time zone '${TZ}' >= date_trunc($2, now() at time zone '${TZ}')
        and occurred_at at time zone '${TZ}' <  date_trunc($2, now() at time zone '${TZ}') + ('1 ' || $2)::interval
      group by kind`,
    [userId, period]
  );
  let income = 0, expense = 0, reserve = 0;
  for (const r of rows) {
    if (r.kind === "income") income = parseFloat(r.total);
    else if (r.kind === "reserve") reserve = parseFloat(r.total);
    else expense += parseFloat(r.total);
  }
  // reserva fica à parte: não entra no saldo (saldo = entradas − saídas)
  return { income, expense, reserve, balance: income - expense };
}

// Total acumulado da reserva (todo o histórico).
export async function getReserveTotal(userId) {
  const { rows } = await pool.query(
    `select coalesce(sum(amount), 0) as total from transactions where user_id = $1 and kind = 'reserve'`,
    [userId]
  );
  return parseFloat(rows[0].total);
}

export async function setReserveGoal(userId, target) {
  await pool.query(
    `insert into reserve_goals (user_id, target) values ($1, $2)
       on conflict (user_id) do update set target = excluded.target`,
    [userId, target]
  );
}

export async function getReserveGoal(userId) {
  const { rows } = await pool.query(`select target from reserve_goals where user_id = $1`, [userId]);
  return rows.length ? parseFloat(rows[0].target) : null;
}

export async function getCategoryDetail(userId, category, period) {
  const { rows } = await pool.query(
    `select description, amount, to_char(occurred_at at time zone '${TZ}', 'DD/MM') as day
       from transactions
      where user_id = $1
        and kind = 'expense'
        and category = $2
        and occurred_at at time zone '${TZ}' >= date_trunc($3, now() at time zone '${TZ}')
        and occurred_at at time zone '${TZ}' <  date_trunc($3, now() at time zone '${TZ}') + ('1 ' || $3)::interval
      order by occurred_at desc, created_at desc`,
    [userId, category, period]
  );
  return rows.map((r) => ({ description: r.description, amount: parseFloat(r.amount), day: r.day }));
}

// Lista as ENTRADAS do periodo. Pro "resumo entradas".
export async function getIncomeDetail(userId, period) {
  const { rows } = await pool.query(
    `select description, amount, to_char(occurred_at at time zone '${TZ}', 'DD/MM') as day
       from transactions
      where user_id = $1
        and kind = 'income'
        and occurred_at at time zone '${TZ}' >= date_trunc($2, now() at time zone '${TZ}')
        and occurred_at at time zone '${TZ}' <  date_trunc($2, now() at time zone '${TZ}') + ('1 ' || $2)::interval
      order by occurred_at desc, created_at desc`,
    [userId, period]
  );
  return rows.map((r) => ({ description: r.description, amount: parseFloat(r.amount), day: r.day }));
}

export async function updateLastTransaction(userId, { amount = null, category = null }) {
  const { rows } = await pool.query(
    `update transactions
        set amount   = coalesce($2, amount),
            category = coalesce($3, category)
      where id = (
        select id from transactions
         where user_id = $1 order by created_at desc limit 1
      )
      returning amount, category`,
    [userId, amount, category]
  );
  if (rows.length === 0) return null;
  return { amount: parseFloat(rows[0].amount), category: rows[0].category };
}

export async function deleteLastTransaction(userId) {
  const { rows } = await pool.query(
    `select id, amount, category, installment_group
       from transactions
      where user_id = $1 order by created_at desc limit 1`,
    [userId]
  );
  if (rows.length === 0) return null;
  const last = rows[0];

  if (last.installment_group) {
    const del = await pool.query(
      `delete from transactions
        where user_id = $1 and installment_group = $2
        returning amount`,
      [userId, last.installment_group]
    );
    const total = del.rows.reduce((s, r) => s + parseFloat(r.amount), 0);
    return { amount: total, category: last.category, installments: del.rows.length };
  }

  await pool.query(`delete from transactions where id = $1`, [last.id]);
  return { amount: parseFloat(last.amount), category: last.category };
}

// Apaga TODOS os lancamentos do usuario. Retorna quantos foram apagados.
export async function deleteAllTransactions(userId) {
  const res = await pool.query(`delete from transactions where user_id = $1`, [userId]);
  return res.rowCount;
}

// --- Limites por categoria (orcamento) ---
export async function setBudget(userId, category, limit) {
  await pool.query(
    `insert into budgets (user_id, category, monthly_limit) values ($1, $2, $3)
       on conflict (user_id, category) do update set monthly_limit = excluded.monthly_limit`,
    [userId, category, limit]
  );
}

export async function removeBudget(userId, category) {
  const res = await pool.query(
    `delete from budgets where user_id = $1 and category = $2`,
    [userId, category]
  );
  return res.rowCount;
}

export async function getBudget(userId, category) {
  const { rows } = await pool.query(
    `select monthly_limit from budgets where user_id = $1 and category = $2`,
    [userId, category]
  );
  return rows.length ? parseFloat(rows[0].monthly_limit) : null;
}

export async function listBudgets(userId) {
  const { rows } = await pool.query(
    `select category, monthly_limit from budgets where user_id = $1 order by category`,
    [userId]
  );
  return rows.map((r) => ({ category: r.category, limit: parseFloat(r.monthly_limit) }));
}

// Gasto do mes atual numa categoria (pro aviso de limite).
export async function getCategorySpentMonth(userId, category) {
  const { rows } = await pool.query(
    `select coalesce(sum(amount), 0) as total
       from transactions
      where user_id = $1 and kind = 'expense' and category = $2
        and occurred_at at time zone '${TZ}' >= date_trunc('month', now() at time zone '${TZ}')
        and occurred_at at time zone '${TZ}' <  date_trunc('month', now() at time zone '${TZ}') + interval '1 month'`,
    [userId, category]
  );
  return parseFloat(rows[0].total);
}

// --- Gastos recorrentes (moldes) ---
export async function addRecurring(userId, { amount, category, description }) {
  await pool.query(
    `insert into recurring (user_id, amount, category, description) values ($1, $2, $3, $4)`,
    [userId, amount, category, description]
  );
}

export async function listRecurring(userId) {
  const { rows } = await pool.query(
    `select id, amount, category, description from recurring
      where user_id = $1 and active = true order by created_at`,
    [userId]
  );
  return rows.map((r) => ({ id: r.id, amount: parseFloat(r.amount), category: r.category, description: r.description }));
}

export async function deactivateRecurring(userId, id) {
  const res = await pool.query(
    `update recurring set active = false where id = $1 and user_id = $2`,
    [id, userId]
  );
  // apaga a ocorrencia automatica DESTE mes, pra "criar e remover" ficar limpo
  // (meses passados ficam como historico)
  await pool.query(
    `delete from transactions
      where user_id = $1 and recurring_id = $2
        and occurred_at at time zone '${TZ}' >= date_trunc('month', now() at time zone '${TZ}')
        and occurred_at at time zone '${TZ}' <  date_trunc('month', now() at time zone '${TZ}') + interval '1 month'`,
    [userId, id]
  );
  return res.rowCount;
}

// Materializacao preguicosa: cria os lancamentos do mes atual pros recorrentes
// ativos que ainda nao tem ocorrencia neste mes. Idempotente.
export async function materializeRecurring(userId) {
  await pool.query(
    `insert into transactions (user_id, amount, category, description, raw_message, recurring_id, kind)
     select r.user_id, r.amount, r.category, r.description, '(recorrente)', r.id, 'expense'
       from recurring r
      where r.user_id = $1 and r.active = true
        and not exists (
          select 1 from transactions t
           where t.recurring_id = r.id
             and t.occurred_at at time zone '${TZ}' >= date_trunc('month', now() at time zone '${TZ}')
             and t.occurred_at at time zone '${TZ}' <  date_trunc('month', now() at time zone '${TZ}') + interval '1 month'
        )`,
    [userId]
  );
}

// Apaga TUDO do usuario (transacoes + recorrentes + limites + meta de reserva).
export async function deleteAllData(userId) {
  const res = await pool.query(`delete from transactions where user_id = $1`, [userId]);
  await pool.query(`delete from recurring where user_id = $1`, [userId]);
  await pool.query(`delete from budgets where user_id = $1`, [userId]);
  await pool.query(`delete from reserve_goals where user_id = $1`, [userId]);
  return res.rowCount;
}
// ---------- Contas a pagar (boletos) ----------
export async function addBill(userId, { description, amount, dueDate, barcode, category }) {
  const { rows } = await pool.query(
    `insert into bills (user_id, description, amount, due_date, barcode, category)
       values ($1, $2, $3, $4, $5, $6) returning id`,
    [userId, description, amount, dueDate, barcode, category]
  );
  return rows[0].id;
}

export async function listPendingBills(userId) {
  const { rows } = await pool.query(
    `select id, description, amount, barcode, category,
            to_char(due_date, 'DD/MM/YYYY') as due_fmt,
            (due_date - (now() at time zone '${TZ}')::date) as days_left
       from bills
      where user_id = $1 and paid = false
      order by due_date asc nulls last, created_at`,
    [userId]
  );
  return rows.map((r) => ({
    id: r.id,
    description: r.description,
    amount: r.amount != null ? parseFloat(r.amount) : null,
    barcode: r.barcode,
    category: r.category,
    dueFmt: r.due_fmt,
    daysLeft: r.days_left != null ? parseInt(r.days_left, 10) : null,
  }));
}

export async function getBillById(userId, id) {
  const { rows } = await pool.query(
    `select id, description, amount, barcode, category, paid from bills where id = $1 and user_id = $2`,
    [id, userId]
  );
  if (!rows.length) return null;
  const r = rows[0];
  return { id: r.id, description: r.description, amount: r.amount != null ? parseFloat(r.amount) : null, barcode: r.barcode, category: r.category, paid: r.paid };
}

export async function markBillPaid(userId, id) {
  const { rows } = await pool.query(
    `update bills set paid = true where id = $1 and user_id = $2 and paid = false
       returning description, amount, category`,
    [id, userId]
  );
  if (!rows.length) return null;
  const r = rows[0];
  return { description: r.description, amount: r.amount != null ? parseFloat(r.amount) : null, category: r.category };
}

export async function deleteBillById(userId, id) {
  const { rows } = await pool.query(
    `delete from bills where id = $1 and user_id = $2 returning description`,
    [id, userId]
  );
  return rows.length ? { description: rows[0].description } : null;
}

// Pro lembrete diario (so Telegram): contas nao pagas que vencem ate X dias (inclui vencidas).
export async function getDueBillsForChannel(channel, withinDays) {
  const { rows } = await pool.query(
    `select u.external_id, b.description, b.amount,
            to_char(b.due_date, 'DD/MM') as due_fmt,
            (b.due_date - (now() at time zone '${TZ}')::date) as days_left
       from bills b join users u on u.id = b.user_id
      where u.channel = $1 and b.paid = false and b.due_date is not null
        and b.due_date <= (now() at time zone '${TZ}')::date + ($2 || ' day')::interval
      order by u.external_id, b.due_date`,
    [channel, withinDays]
  );
  return rows.map((r) => ({
    externalId: r.external_id,
    description: r.description,
    amount: r.amount != null ? parseFloat(r.amount) : null,
    dueFmt: r.due_fmt,
    daysLeft: r.days_left != null ? parseInt(r.days_left, 10) : null,
  }));
}

export async function updateBillBarcode(userId, id, barcode) {
  const { rows } = await pool.query(
    `update bills set barcode = $3 where id = $1 and user_id = $2 returning description`,
    [id, userId, barcode]
  );
  return rows.length ? { description: rows[0].description } : null;
}