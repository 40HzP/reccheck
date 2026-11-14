/**
 * 記録（Cloudflare D1）の中身を CSV に書き出す。
 *
 *   npm run export-csv
 *
 * 初回だけ `npx wrangler login` でブラウザから Cloudflare にログインしておく。
 * 書き出した CSV は records-日付.csv としてこのフォルダに出る（git には入らない）。
 * Excel で開いても文字化けしないよう、先頭に BOM を付けている。
 *
 * 列の並びは public/config.js の record.columns と同じ（先頭に id）。
 * 引数はそのまま wrangler に渡す（例：手元の試験用データベースなら --local）。
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import config from "../public/config.js";

const DATABASE = "reccheck";
const TABLE = "records";
const extra = process.argv.slice(2);
const target = extra.includes("--local") ? [] : ["--remote"];

const wrangler = process.env.WRANGLER ? [process.env.WRANGLER] : ["npx", "wrangler"];
const args = [
  ...wrangler.slice(1),
  "d1",
  "execute",
  DATABASE,
  ...target,
  ...extra,
  "--json",
  "--command",
  `SELECT * FROM ${TABLE} ORDER BY id`,
];

let output;
try {
  output = execFileSync(wrangler[0], args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
} catch {
  console.error("\n書き出せませんでした。`npx wrangler login` でログインしているか確かめてください。");
  process.exit(1);
}

const parsed = JSON.parse(output);
const rows = (Array.isArray(parsed) ? parsed[0] : parsed).results || [];
const columns = ["id", ...config.record.columns.map((c) => c.name)];

const cell = (value) => {
  if (value == null) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
const csv = [columns.join(","), ...rows.map((row) => columns.map((c) => cell(row[c])).join(","))].join("\r\n");

const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
const file = `records-${stamp}.csv`;
writeFileSync(file, "﻿" + csv + "\r\n", "utf8");
console.log(`${rows.length}件を ${file} に書き出しました。`);
