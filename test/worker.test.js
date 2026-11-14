import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import config from "../public/config.js";
import worker from "../worker/index.js";
import { COLUMNS, TABLE, ensureSchema } from "../worker/records.js";

/** D1 の代わり。D1 と同じ prepare / bind / run / all の形で node:sqlite を包む */
class FakeD1 {
  constructor() {
    this.db = new DatabaseSync(":memory:");
  }
  prepare(sql) {
    const db = this.db;
    let args = [];
    return {
      bind(...values) {
        args = values;
        return this;
      },
      async run() {
        const r = db.prepare(sql).run(...args);
        return { meta: { changes: Number(r.changes) } };
      },
      async all() {
        return { results: db.prepare(sql).all(...args) };
      },
    };
  }
  rows() {
    return this.db.prepare(`SELECT * FROM ${TABLE} ORDER BY id`).all();
  }
}

const ORIGIN = "https://reccheck.40hzp.com";
const BROWSER_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
let env;
let realFetch;
let turnstileCalls;

beforeEach(() => {
  env = {
    DB: new FakeD1(),
    TURNSTILE_SECRET_KEY: "secret",
    ASSETS: { fetch: async () => new Response("asset") },
  };
  turnstileCalls = [];
  realFetch = globalThis.fetch;
  // Turnstile の照会だけを差し替える。"good-<action>" のトークンだけ通る
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://challenges.cloudflare.com/turnstile/v0/siteverify");
    const form = init.body;
    turnstileCalls.push(Object.fromEntries(form.entries()));
    const token = form.get("response");
    const m = /^good-(\w+)$/.exec(token);
    return Response.json(m ? { success: true, action: m[1] } : { success: false, "error-codes": ["invalid-input-response"] });
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function post(path, body, headers = {}) {
  return worker.fetch(
    new Request(ORIGIN + path, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    env
  );
}

const sampleRecord = () => ({
  browser_id: BROWSER_ID,
  app_version: "2-deadbeef",
  format: "wav",
  sample_rate: 48000,
  bit_depth: "24bit",
  channels: 1,
  peak_dbfs: -6.2,
  clip_samples: 0,
  noise_dbfs: -71.3,
  noise_excluded: false,
  room: "normal",
  duration_sec: 215.4,
  results: { content: 1, cueing: "check", noise: 1, unknown_item: 1 },
  mic_raw: "  SM7B  ",
  interface_raw: "UAC-232",
  preamp_raw: "",
  popfilter_raw: null,
  room_raw: "6畳・カーテンあり",
  gear_changed: "no",
});

test("記録すると、列の定義どおりに1行入る", async () => {
  const res = await post(config.record.endpoint, { token: "good-record", record: sampleRecord() });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });

  const rows = env.DB.rows();
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.match(row.created_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(row.browser_id, BROWSER_ID);
  assert.equal(row.sample_rate, 48000);
  assert.equal(row.peak_dbfs, -6.2);
  assert.equal(row.noise_excluded, 0);
  assert.equal(row.mic_raw, "SM7B"); // 前後の空白を取る
  assert.equal(row.preamp_raw, null); // 空欄は null
  assert.equal(row.popfilter_raw, null);
  assert.deepEqual(JSON.parse(row.results), { content: 1, cueing: "check", noise: 1 }); // 知らない項目は捨てる
  assert.equal(row.gear_changed, "no");
});

test("表の列は config.js の record.columns と同じ（IP・User-Agent・ファイル名の列は無い）", async () => {
  await ensureSchema(env.DB);
  const cols = env.DB.db.prepare(`PRAGMA table_info(${TABLE})`).all().map((c) => c.name);
  assert.deepEqual(cols, ["id", ...COLUMNS.map((c) => c.name)]);
  for (const banned of ["ip", "user_agent", "file_name", "filename"]) assert.ok(!cols.includes(banned));
});

test("Turnstile には IP アドレスを渡さない", async () => {
  await post(config.record.endpoint, { token: "good-record", record: sampleRecord() }, { "cf-connecting-ip": "203.0.113.5" });
  assert.equal(turnstileCalls.length, 1);
  assert.deepEqual(Object.keys(turnstileCalls[0]).sort(), ["response", "secret"]);
});

test("config.js に列を足すと、次の記録で表にも足される", async () => {
  // 古い形の表（gear_changed が無い）を先に作っておく
  const old = COLUMNS.filter((c) => c.name !== "gear_changed")
    .map((c) => `${c.name} TEXT`)
    .join(", ");
  env.DB.db.exec(`CREATE TABLE ${TABLE} (id INTEGER PRIMARY KEY AUTOINCREMENT, ${old})`);
  const res = await post(config.record.endpoint, { token: "good-record", record: sampleRecord() });
  assert.equal(res.status, 200);
  assert.equal(env.DB.rows()[0].gear_changed, "no");
});

test("Turnstile を通らなければ記録しない", async () => {
  const res = await post(config.record.endpoint, { token: "bad", record: sampleRecord() });
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: "turnstile" });
  // 表もまだ作られていない
  assert.equal(env.DB.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name = ?").get(TABLE).n, 0);
});

test("削除用のトークンでは記録できない（action の取り違え）", async () => {
  const res = await post(config.record.endpoint, { token: "good-delete", record: sampleRecord() });
  assert.equal(res.status, 403);
});

test("形の合わない値は null にし、長すぎる機材名は60字で切る", async () => {
  const r = sampleRecord();
  r.sample_rate = "48000";
  r.peak_dbfs = Infinity;
  r.room = "huge";
  r.mic_raw = "あ".repeat(100);
  r.extra_column = "ignored";
  const res = await post(config.record.endpoint, { token: "good-record", record: r });
  assert.equal(res.status, 200);
  const row = env.DB.rows()[0];
  assert.equal(row.sample_rate, null);
  assert.equal(row.peak_dbfs, null);
  assert.equal(row.room, null);
  assert.equal(row.mic_raw.length, 60);
  assert.ok(!("extra_column" in row));
});

test("browser_id が無い・形が違う記録は受け付けない", async () => {
  const r = sampleRecord();
  r.browser_id = "not-a-uuid";
  const res = await post(config.record.endpoint, { token: "good-record", record: r });
  assert.equal(res.status, 400);
  assert.equal(turnstileCalls.length, 0); // 検証で落ちたものは Turnstile に問い合わせない
});

test("ほかのサイトからの送信と、大きすぎる送信は受け付けない", async () => {
  const cross = await post(config.record.endpoint, { token: "good-record", record: sampleRecord() }, { origin: "https://evil.example" });
  assert.equal(cross.status, 403);
  const big = await post(config.record.endpoint, JSON.stringify({ token: "good-record", record: sampleRecord(), pad: "x".repeat(9000) }));
  assert.equal(big.status, 400);
  assert.equal(env.DB.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name = ?").get(TABLE).n, 0);
});

test("このブラウザの記録を消すと、同じ browser_id の行だけ消える", async () => {
  const other = { ...sampleRecord(), browser_id: "1b4e28ba-2fa1-41d2-883f-0016d3cca427" };
  await post(config.record.endpoint, { token: "good-record", record: sampleRecord() });
  await post(config.record.endpoint, { token: "good-record", record: sampleRecord() });
  await post(config.record.endpoint, { token: "good-record", record: other });

  const res = await post(config.record.deleteEndpoint, { token: "good-delete", browser_id: BROWSER_ID });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, deleted: 2 });
  const rows = env.DB.rows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].browser_id, other.browser_id);
});

test("削除も Turnstile を通らなければ受け付けない", async () => {
  await post(config.record.endpoint, { token: "good-record", record: sampleRecord() });
  const res = await post(config.record.deleteEndpoint, { token: "good-record", browser_id: BROWSER_ID });
  assert.equal(res.status, 403);
  assert.equal(env.DB.rows().length, 1);
});

test("鍵やデータベースが無いときは 503 で断る", async () => {
  delete env.TURNSTILE_SECRET_KEY;
  const res = await post(config.record.endpoint, { token: "good-record", record: sampleRecord() });
  assert.equal(res.status, 503);
});

test("POST 以外・知らない /api/ は断り、それ以外は静的ファイルに回す", async () => {
  const get = await worker.fetch(new Request(ORIGIN + config.record.endpoint), env);
  assert.equal(get.status, 405);
  const unknown = await worker.fetch(new Request(ORIGIN + "/api/nothing"), env);
  assert.equal(unknown.status, 404);
  const page = await worker.fetch(new Request(ORIGIN + "/somewhere"), env);
  assert.equal(await page.text(), "asset");
});
