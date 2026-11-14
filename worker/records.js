/**
 * 記録の表（Cloudflare D1）の作成・検証・書き込み・削除。
 *
 * 列の定義は public/config.js の record.columns だけにある。
 * ここでは、その一覧から表を作り、足りない列を足し、受け取った値を確かめる。
 * 同じ列の一覧を、ここや別のファイル（SQL など）に二重に書かない。
 */
import config from "../public/config.js";

export const TABLE = "records";
export const COLUMNS = config.record.columns;

const SQL_TYPE = {
  text: "TEXT",
  enum: "TEXT",
  uuid: "TEXT",
  stages: "TEXT",
  int: "INTEGER",
  bool: "INTEGER",
  real: "REAL",
};

const NAME = /^[a-z][a-z0-9_]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STAGES = new Set([1, 2, 3, "check", "skip"]);
const ITEM_IDS = new Set(config.items.map((i) => i.id));

// 設定ファイルの書き間違いで、壊れた SQL を流さないための確認
for (const c of COLUMNS) {
  if (!NAME.test(c.name) || !SQL_TYPE[c.kind]) {
    throw new Error(`record.columns の書き方が正しくありません: ${JSON.stringify(c)}`);
  }
}

/** 表が無ければ作り、設定ファイルに足された列があれば表にも足す */
export async function ensureSchema(db) {
  const defs = COLUMNS.map((c) => `${c.name} ${SQL_TYPE[c.kind]}`).join(", ");
  await db.prepare(`CREATE TABLE IF NOT EXISTS ${TABLE} (id INTEGER PRIMARY KEY AUTOINCREMENT, ${defs})`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS ${TABLE}_browser_id ON ${TABLE} (browser_id)`).run();
  const { results } = await db.prepare(`PRAGMA table_info(${TABLE})`).all();
  const have = new Set((results || []).map((r) => r.name));
  for (const c of COLUMNS) {
    if (!have.has(c.name)) {
      await db.prepare(`ALTER TABLE ${TABLE} ADD COLUMN ${c.name} ${SQL_TYPE[c.kind]}`).run();
    }
  }
}

/** 制御文字を消して前後の空白を取り、長さを切る。空なら null */
function cleanText(value, max) {
  if (typeof value !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max || 200);
  return text === "" ? null : text;
}

function coerce(column, value) {
  switch (column.kind) {
    case "text":
      return cleanText(value, column.max);
    case "uuid":
      return typeof value === "string" && UUID.test(value.toLowerCase()) ? value.toLowerCase() : null;
    case "enum":
      return column.values.includes(value) ? value : null;
    case "int":
      return Number.isInteger(value) && Math.abs(value) < 1e12 ? value : null;
    case "real":
      return typeof value === "number" && Number.isFinite(value) && Math.abs(value) < 1e9 ? value : null;
    case "bool":
      return value === true ? 1 : value === false ? 0 : null;
    case "stages": {
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      const out = {};
      for (const [id, stage] of Object.entries(value)) {
        if (ITEM_IDS.has(id) && STAGES.has(stage)) out[id] = stage;
      }
      return Object.keys(out).length ? JSON.stringify(out) : null;
    }
    default:
      return null;
  }
}

/**
 * ブラウザから来た値を、列の定義どおりに整える。
 * 定義に無い名前は捨てる。形の合わない値は null にする。
 * 必須の列が欠けていたら error を返す。
 */
export function validateRecord(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { error: "record" };
  const record = {};
  for (const c of COLUMNS) {
    if (c.server) continue;
    record[c.name] = coerce(c, input[c.name]);
    if (c.required && record[c.name] == null) return { error: c.name };
  }
  return { record };
}

export function validBrowserId(value) {
  return typeof value === "string" && UUID.test(value.toLowerCase()) ? value.toLowerCase() : null;
}

export async function insertRecord(db, record, now = new Date()) {
  const row = { ...record, created_at: now.toISOString() };
  const names = COLUMNS.map((c) => c.name);
  const sql = `INSERT INTO ${TABLE} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`;
  await db
    .prepare(sql)
    .bind(...names.map((n) => (row[n] === undefined ? null : row[n])))
    .run();
}

export async function deleteByBrowserId(db, browserId) {
  const result = await db.prepare(`DELETE FROM ${TABLE} WHERE browser_id = ?`).bind(browserId).run();
  return Number((result && result.meta && result.meta.changes) || 0);
}
