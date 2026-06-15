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

export async function insertTransaction({ userId, amount, category, description, rawMessage, kind = "expense" }) {
  await pool.query(
    `insert into transactions (user_id, amount, category, description, raw_message, kind)
       values ($1, $2, $3, $4, $5, $6)`,
    [userId, amount, category, description, rawMessage, kind]
  );
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
  let income = 0, expense = 0;
  for (const r of rows) {
    if (r.kind === "income") income = parseFloat(r.total);
    else expense += parseFloat(r.total);
  }
  return { income, expense, balance: income - expense };
}

export async function getCategoryDetail(userId, category, period) {
  const { rows } = await pool.query(
    `select description, amount
       from transactions
      where user_id = $1
        and kind = 'expense'
        and category = $2
        and occurred_at at time zone '${TZ}' >= date_trunc($3, now() at time zone '${TZ}')
        and occurred_at at time zone '${TZ}' <  date_trunc($3, now() at time zone '${TZ}') + ('1 ' || $3)::interval
      order by occurred_at desc, created_at desc`,
    [userId, category, period]
  );
  return rows.map((r) => ({ description: r.description, amount: parseFloat(r.amount) }));
}

export async function getIncomeDetail(userId, period) {
  const { rows } = await pool.query(
    `select description, amount
       from transactions
      where user_id = $1
        and kind = 'income'
        and occurred_at at time zone '${TZ}' >= date_trunc($2, now() at time zone '${TZ}')
        and occurred_at at time zone '${TZ}' <  date_trunc($2, now() at time zone '${TZ}') + ('1 ' || $2)::interval
      order by occurred_at desc, created_at desc`,
    [userId, period]
  );
  return rows.map((r) => ({ description: r.description, amount: parseFloat(r.amount) }));
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

export async function deleteAllTransactions(userId) {
  const res = await pool.query(`delete from transactions where user_id = $1`, [userId]);
  return res.rowCount;
}