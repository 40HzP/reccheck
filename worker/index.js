/**
 * reccheck.40hzp.com の受け口。
 *
 * 静的ファイル（public/）は Cloudflare の Assets が先に返す。
 * ここに来るのはファイルが無いリクエストだけで、扱うのは次の2つ。
 *   POST /api/records         … 判定の数値と機材名を1件記録する
 *   POST /api/records/delete  … 同じブラウザの記録をまとめて消す
 * どちらも Turnstile を通らなければ受け付けない。
 *
 * 音声ファイルはここには来ない（ブラウザの中で読むだけ）。
 * IPアドレスと User-Agent は保存しない。ログにも出さない。
 *
 * 環境に要るもの（README「記録の準備」）
 *   DB                   … D1 のデータベース（wrangler.jsonc）
 *   TURNSTILE_SECRET_KEY … Turnstile の Secret Key（Cloudflare の画面でシークレットとして登録）
 */
import config from "../public/config.js";
import { ensureSchema, validateRecord, validBrowserId, insertRecord, deleteByBrowserId } from "./records.js";

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const MAX_BODY_BYTES = 8 * 1024;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

/** 表の用意は、Worker が立ち上がるたびに（データベースごとに）1回だけ行う */
const schemaReady = new WeakMap();
function prepare(db) {
  if (!schemaReady.has(db)) {
    schemaReady.set(
      db,
      ensureSchema(db).catch((e) => {
        schemaReady.delete(db);
        throw e;
      })
    );
  }
  return schemaReady.get(db);
}

async function readJson(request) {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > MAX_BODY_BYTES) return null;
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Turnstile の照会。IPアドレスは渡さない（任意項目のため）。
 * action はブラウザ側で付けた名前。記録用のトークンで削除はできない。
 */
async function verifyTurnstile(secret, token, action) {
  if (typeof token !== "string" || !token || token.length > 2048) return false;
  const body = new FormData();
  body.append("secret", secret);
  body.append("response", token);
  let result;
  try {
    const res = await fetch(SITEVERIFY, { method: "POST", body });
    if (!res.ok) {
      console.error(`[reccheck] Turnstile の照会に失敗しました（HTTP ${res.status}）`);
      return false;
    }
    result = await res.json();
  } catch {
    console.error("[reccheck] Turnstile に繋がりませんでした");
    return false;
  }
  if (result.success !== true) {
    // invalid-input-secret … TURNSTILE_SECRET_KEY が違う（Site Key を入れていないか）
    // timeout-or-duplicate … 同じトークンを二度使った、または時間切れ
    console.error(`[reccheck] Turnstile が拒否しました: ${(result["error-codes"] || []).join(", ") || "(理由の記載なし)"}`);
    return false;
  }
  if (result.action && result.action !== action) return false;
  return true;
}

async function handleRecord(request, env) {
  const body = await readJson(request);
  if (!body) return json({ error: "invalid" }, 400);
  const { record, error } = validateRecord(body.record);
  if (error) return json({ error: "invalid", field: error }, 400);
  if (!(await verifyTurnstile(env.TURNSTILE_SECRET_KEY, body.token, "record"))) {
    return json({ error: "turnstile" }, 403);
  }
  await prepare(env.DB);
  await insertRecord(env.DB, record);
  return json({ ok: true });
}

async function handleDelete(request, env) {
  const body = await readJson(request);
  if (!body) return json({ error: "invalid" }, 400);
  const browserId = validBrowserId(body.browser_id);
  if (!browserId) return json({ error: "invalid", field: "browser_id" }, 400);
  if (!(await verifyTurnstile(env.TURNSTILE_SECRET_KEY, body.token, "delete"))) {
    return json({ error: "turnstile" }, 403);
  }
  await prepare(env.DB);
  const deleted = await deleteByBrowserId(env.DB, browserId);
  return json({ ok: true, deleted });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const routes = {
      [config.record.endpoint]: handleRecord,
      [config.record.deleteEndpoint]: handleDelete,
    };
    const handler = routes[url.pathname];

    if (!handler) {
      if (url.pathname.startsWith("/api/")) return json({ error: "not_found" }, 404);
      return env.ASSETS.fetch(request);
    }
    if (request.method !== "POST") return json({ error: "method" }, 405);

    // ほかのサイトから送らせない
    const origin = request.headers.get("origin");
    if (origin && origin !== url.origin) return json({ error: "origin" }, 403);

    if (!env.DB || !env.TURNSTILE_SECRET_KEY) {
      console.error("[reccheck] DB か TURNSTILE_SECRET_KEY が設定されていません（README「記録の準備」）");
      return json({ error: "unavailable" }, 503);
    }

    try {
      return await handler(request, env);
    } catch (e) {
      console.error(`[reccheck] 記録の処理で失敗しました: ${e && e.message}`);
      return json({ error: "server" }, 500);
    }
  },
};
