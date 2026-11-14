import { test } from "node:test";
import assert from "node:assert/strict";

import config from "../public/config.js";
import { analyzeFile } from "../public/js/analyze.js";
import { judge, appVersion } from "../public/js/judge.js";
import { buildRecord } from "../public/js/record.js";
import { validateRecord } from "../worker/records.js";
import { makeWav, asFile, vocalLike } from "./wavgen.js";

const params = {
  windowMs: config.windowMs,
  minRunSamples: config.items.find((i) => i.id === "clipping").minRunSamples,
};

async function recordFor(bytes, name, extra = {}) {
  const analysis = await analyzeFile(asFile(bytes, name), params);
  const result = judge(analysis, null, config);
  return buildRecord({
    measures: result.measures,
    stages: result.stages,
    gear: { mic_raw: "SM7B", interface_raw: "UAC-232", preamp_raw: "", popfilter_raw: "", room_raw: "6畳" },
    gearChanged: null,
    browserId: "0f8fad5b-d9cb-469f-a165-70867728950e",
    appVersion: appVersion(config),
    ...extra,
  });
}

test("送る中身は、列の定義（server 以外）とちょうど同じ名前だけ", async () => {
  const bytes = makeWav({ seconds: 20, signal: vocalLike({ startSec: 3 }) });
  const record = await recordFor(bytes, "山田の歌_本番.wav");
  const expected = config.record.columns.filter((c) => !c.server).map((c) => c.name);
  assert.deepEqual(Object.keys(record), expected);
  // ファイル名はどこにも入らない
  assert.ok(!JSON.stringify(record).includes("山田"));
});

test("ブラウザで作った中身は、受け口の検証をそのまま通る", async () => {
  const bytes = makeWav({ seconds: 20, signal: vocalLike({ startSec: 3, phraseSec: 3, gapSec: 1.5 }) });
  const record = await recordFor(bytes, "vocal.wav");
  const { record: clean, error } = validateRecord(record);
  assert.equal(error, undefined);
  // 計った値が null に落ちていない
  for (const key of ["format", "sample_rate", "bit_depth", "channels", "peak_dbfs", "clip_samples", "noise_dbfs", "duration_sec", "results", "app_version"]) {
    assert.notEqual(clean[key], null, `${key} が null になった`);
  }
  assert.equal(clean.noise_excluded, 0);
  assert.equal(clean.mic_raw, "SM7B");
  assert.equal(clean.preamp_raw, null);
  assert.equal(JSON.parse(clean.results).format, 1);
});

test("mp3 の記録は形式と段階だけで、ほかは null のまま通る", async () => {
  const bytes = new Uint8Array([...new TextEncoder().encode("ID3"), 4, 0, 0, 0, 0, 0, 0]);
  const record = await recordFor(bytes, "voice.mp3", { gearChanged: "yes" });
  const { record: clean } = validateRecord(record);
  assert.equal(clean.format, "mp3");
  assert.equal(clean.sample_rate, null);
  assert.equal(clean.gear_changed, "yes");
  assert.equal(JSON.parse(clean.results).format, 2);
});
