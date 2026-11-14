import { test } from "node:test";
import assert from "node:assert/strict";

import config from "../public/config.js";
import { analyzeFile, wavDurationOf } from "../public/js/analyze.js";
import { judge, appVersion } from "../public/js/judge.js";
import { sniffFormat } from "../public/js/sniff.js";
import { makeWav, asFile, vocalLike, noiseSource } from "./wavgen.js";

const params = {
  windowMs: config.windowMs,
  minRunSamples: config.items.find((i) => i.id === "clipping").minRunSamples,
};

async function run(bytes, name = "vocal.wav", inst = null) {
  const analysis = await analyzeFile(asFile(bytes, name), params);
  return { analysis, result: judge(analysis, inst, config) };
}

function stageOf(result, id) {
  const it = result.items.find((i) => i.id === id);
  assert.ok(it, `item ${id} missing`);
  return it;
}

/* ---------------- ヘッダ ---------------- */

test("48kHz / 24bit / mono の素直な wav", async () => {
  const bytes = makeWav({ seconds: 30, signal: vocalLike({ startSec: 8 }) });
  const { analysis, result } = await run(bytes);
  assert.equal(analysis.wav.sampleRate, 48000);
  assert.equal(analysis.wav.channels, 1);
  assert.equal(analysis.wav.codec, "pcm");
  assert.equal(Math.round(analysis.wav.duration), 30);

  assert.equal(stageOf(result, "format").stage, 1);
  assert.equal(stageOf(result, "sampleRate").stage, 1);
  assert.equal(stageOf(result, "bitDepth").stage, 1);
  assert.equal(stageOf(result, "channels").stage, 1);
  assert.equal(stageOf(result, "content").stage, 1);
  assert.equal(stageOf(result, "clipping").stage, 1);
  assert.equal(stageOf(result, "level").stage, 1);
  assert.equal(stageOf(result, "noise").stage, 1);
  // 頭出しは「そのまま送れます」を出さない
  const cue = stageOf(result, "cueing");
  assert.equal(cue.stage, "check");
  assert.equal(cue.outcome, "leadingSilence");
  assert.match(cue.detail, /8\.0秒/);
  assert.equal(result.worst, "check");
});

test("32bit float と extensible、途中に JUNK / LIST があっても読める", async () => {
  const bytes = makeWav({
    codec: "float",
    bits: 32,
    extensible: true,
    seconds: 12,
    chunksBefore: [{ id: "JUNK", size: 28 }],
    chunksBetween: [{ id: "LIST", size: 37 }], // 奇数長（埋め草1バイト）
    signal: vocalLike({ startSec: 3 }),
  });
  const { analysis, result } = await run(bytes);
  assert.equal(analysis.wav.codec, "float");
  assert.equal(analysis.wav.formatTag, 0xfffe);
  assert.equal(stageOf(result, "bitDepth").detail, "32bit float");
  assert.equal(stageOf(result, "bitDepth").stage, 1);
});

test("44.1kHz / 16bit / ステレオは段階2", async () => {
  const sig = vocalLike({ startSec: 5 });
  const bytes = makeWav({ sampleRate: 44100, bits: 16, channels: 2, seconds: 20, signal: (f, c, sr) => sig(f, 0, sr) });
  const { result } = await run(bytes);
  assert.equal(stageOf(result, "sampleRate").stage, 2);
  assert.equal(stageOf(result, "sampleRate").detail, "44.1kHz");
  assert.equal(stageOf(result, "bitDepth").stage, 2);
  assert.equal(stageOf(result, "bitDepth").detail, "16bit");
  const ch = stageOf(result, "channels");
  assert.equal(ch.stage, 2);
  assert.equal(ch.outcome, "stereoSame");
  assert.equal(result.worst, 2);
});

test("片側にしか音が入っていないステレオ", async () => {
  const sig = vocalLike({ startSec: 5, noiseAmp: 0 });
  const bytes = makeWav({ channels: 2, seconds: 15, signal: (f, c, sr) => (c === 0 ? sig(f, 0, sr) : 0) });
  const { result } = await run(bytes);
  const ch = stageOf(result, "channels");
  assert.equal(ch.outcome, "stereoOneSide");
  assert.match(ch.detail, /左にしか/);
});

test("左右で違うステレオ", async () => {
  const a = vocalLike({ startSec: 5, seed: 1 });
  const b = vocalLike({ startSec: 5.3, seed: 2 });
  const bytes = makeWav({ channels: 2, seconds: 15, signal: (f, c, sr) => (c === 0 ? a(f, 0, sr) : b(f, 0, sr)) });
  const { result } = await run(bytes);
  assert.equal(stageOf(result, "channels").outcome, "stereoDifferent");
});

test("data の大きさが 0 のままのファイルは、ファイルの終わりまで読む", async () => {
  const bytes = makeWav({ seconds: 11, dataSizeOverride: 0, signal: vocalLike({ startSec: 2 }) });
  const { analysis, result } = await run(bytes);
  assert.equal(Math.round(analysis.wav.duration), 11);
  assert.equal(analysis.wav.truncated, false);
  assert.equal(stageOf(result, "content").stage, 1);
});

test("途中で切れたファイルは「中身」で知らせる", async () => {
  const full = makeWav({ seconds: 20, signal: vocalLike({ startSec: 2 }) });
  const cut = full.slice(0, full.length - 48000 * 3 * 5); // 後ろ5秒ぶんを落とす
  const { result } = await run(cut);
  const content = stageOf(result, "content");
  assert.equal(content.outcome, "truncated");
  assert.equal(content.stage, 2);
});

test("壊れた wav はエラーとして返す", async () => {
  const bytes = new TextEncoder().encode("RIFF\0\0\0\0WAVEjunk");
  const { result } = await run(bytes);
  assert.equal(result.error, config.messages.brokenWav);
});

test("音声でないファイルはエラーとして返す", async () => {
  const bytes = new TextEncoder().encode("hello, this is not audio at all");
  const { result } = await run(bytes, "memo.txt");
  assert.equal(result.error, config.messages.unreadable);
});

/* ---------------- 形式 ---------------- */

test("m4a は段階3、ほかの項目は確認できない", async () => {
  const bytes = new Uint8Array([0, 0, 0, 0x20, ...new TextEncoder().encode("ftypM4A "), 0, 0, 0, 0]);
  const { result } = await run(bytes, "voice.m4a");
  const f = stageOf(result, "format");
  assert.equal(f.stage, 3);
  assert.equal(f.detail, "m4a");
  assert.equal(stageOf(result, "cueing").stage, "skip");
  assert.equal(stageOf(result, "cueing").detail, config.messages.notWav);
  assert.equal(result.worst, 3);
});

test("mp3 は段階2", async () => {
  const bytes = new Uint8Array([...new TextEncoder().encode("ID3"), 4, 0, 0, 0, 0, 0, 0]);
  const { result } = await run(bytes, "voice.mp3");
  assert.equal(stageOf(result, "format").stage, 2);
  assert.equal(result.worst, 2);
});

test("拡張子が .wav でも中身が m4a なら m4a として扱う", async () => {
  const bytes = new Uint8Array([0, 0, 0, 0x20, ...new TextEncoder().encode("ftypM4A "), 0, 0, 0, 0]);
  const { result } = await run(bytes, "voice.wav");
  const f = stageOf(result, "format");
  assert.equal(f.stage, 3);
  assert.equal(f.notes[0], "拡張子は .wav ですが、中身は m4a です");
});

test("sniff: mp3 のフレーム同期と AAC(ADTS) を見分ける", () => {
  assert.equal(sniffFormat(new Uint8Array([0xff, 0xfb, 0x90, 0x00]), "a.mp3").kind, "mp3");
  assert.equal(sniffFormat(new Uint8Array([0xff, 0xf1, 0x50, 0x80]), "a.aac").kind, "aac");
  assert.equal(sniffFormat(new Uint8Array([0x66, 0x4c, 0x61, 0x43]), "a.flac").kind, "flac");
});

test("圧縮された wav（ADPCM）は形式だけ見る", async () => {
  const bytes = makeWav({ seconds: 1, bits: 16 });
  const dv = new DataView(bytes.buffer);
  dv.setUint16(20, 0x0011, true); // IMA ADPCM
  const { result } = await run(bytes);
  assert.equal(stageOf(result, "format").outcome, "wavCompressed");
  assert.equal(stageOf(result, "noise").detail, config.messages.undecodableWav);
});

/* ---------------- 音割れ・音量 ---------------- */

test("16bit で最大値に張り付いた音は音割れとして数える", async () => {
  const sig = vocalLike({ startSec: 2, amp: 1.6 }); // 2倍近く入れて潰す
  const bytes = makeWav({ bits: 16, seconds: 12, signal: sig });
  const { result } = await run(bytes);
  const clip = stageOf(result, "clipping");
  assert.equal(clip.outcome, "clipped");
  assert.equal(clip.stage, 2);
  assert.match(clip.detail, /最初は 2\.0秒 あたり/);
});

test("潰れたあとで音量を下げた音も、最大値への張り付きで見つける", async () => {
  const sig = vocalLike({ startSec: 2, amp: 1.6 });
  const bytes = makeWav({
    bits: 24,
    seconds: 12,
    signal: (f, c, sr) => 0.5 * Math.max(-1, Math.min(1, sig(f, c, sr))),
  });
  const { result } = await run(bytes);
  assert.equal(stageOf(result, "clipping").outcome, "clipped");
});

test("32bit float で 0dBFS を超えていても、潰れていなければ段階1", async () => {
  const bytes = makeWav({ codec: "float", bits: 32, seconds: 12, signal: vocalLike({ startSec: 2, amp: 1.5 }) });
  const { result } = await run(bytes);
  const clip = stageOf(result, "clipping");
  assert.equal(clip.outcome, "overButIntact");
  assert.equal(clip.stage, 1);
  // 音量の余裕では「余裕が少なめ」になる
  assert.equal(stageOf(result, "level").outcome, "high");
  assert.match(stageOf(result, "level").detail, /\+/);
});

test("32bit float でも 1.0 に張り付いていれば音割れ", async () => {
  const sig = vocalLike({ startSec: 2, amp: 1.5 });
  const bytes = makeWav({ codec: "float", bits: 32, seconds: 12, signal: (f, c, sr) => Math.max(-1, Math.min(1, sig(f, c, sr))) });
  const { result } = await run(bytes);
  assert.equal(stageOf(result, "clipping").outcome, "clipped");
});

test("小さすぎる録音", async () => {
  const bytes = makeWav({ seconds: 12, signal: vocalLike({ startSec: 2, amp: 0.05, noiseAmp: 0.00001 }) });
  const { result } = await run(bytes);
  assert.equal(stageOf(result, "level").outcome, "low");
});

test("ノイズが大きい録音", async () => {
  const bytes = makeWav({ seconds: 20, signal: vocalLike({ startSec: 2, noiseAmp: 0.01 }) });
  const { result } = await run(bytes);
  const n = stageOf(result, "noise");
  assert.equal(n.outcome, "high");
  assert.equal(n.stage, 2);
});

test("書き出しで入ったデジタル無音はノイズの計算から外す", async () => {
  // 冒頭10秒は完全な 0、そのあとに静かなノイズの上で歌う
  const sig = vocalLike({ startSec: 12, noiseAmp: 0.0003 });
  const bytes = makeWav({ seconds: 40, signal: (f, c, sr) => (f / sr < 10 ? 0 : sig(f, c, sr)) });
  const { result } = await run(bytes);
  const n = stageOf(result, "noise");
  assert.equal(n.outcome, "ok");
  assert.match(n.detail, /−7\d\.\ddBFS|−6\d\.\ddBFS/);
});

test("休みのない音源では、歌っていないところを見つけられないので判定しない", async () => {
  const bytes = makeWav({ seconds: 20, signal: (f, c, sr) => 0.3 * Math.sin((2 * Math.PI * 220 * f) / sr) });
  const { result } = await run(bytes);
  const n = stageOf(result, "noise");
  assert.equal(n.outcome, "noQuiet");
  assert.equal(n.stage, "skip");
  assert.match(n.detail, /^未測定/);
  assert.equal(result.measures.noise_dbfs, null);
  assert.equal(stageOf(result, "cueing").outcome, "startsAtTop");
});

/* ---------------- 中身 ---------------- */

test("ほぼ無音のファイル", async () => {
  const bytes = makeWav({ seconds: 15, signal: () => 0 });
  const { result } = await run(bytes);
  assert.equal(stageOf(result, "content").outcome, "silent");
  assert.equal(stageOf(result, "level").stage, "skip");
  assert.equal(stageOf(result, "cueing").stage, "skip");
  assert.equal(stageOf(result, "clipping").stage, "skip");
});

test("短すぎるファイル", async () => {
  const bytes = makeWav({ seconds: 4, signal: vocalLike({ startSec: 0.5 }) });
  const { result } = await run(bytes);
  assert.equal(stageOf(result, "content").outcome, "short");
});

/* ---------------- 頭出し ---------------- */

test("先頭からすぐ声が始まり、伴奏より大幅に短い → 頭出しされていない可能性が高い（段階3）", async () => {
  const bytes = makeWav({ seconds: 60, signal: vocalLike({ startSec: 0.2 }) });
  const { result } = await run(bytes, "vocal.wav", { duration: 90 });
  const cue = stageOf(result, "cueing");
  assert.equal(cue.outcome, "likelyNotCued");
  assert.equal(cue.stage, 3);
  assert.match(cue.detail, /30秒 短く/);
  assert.equal(result.worst, 3);
});

test("伴奏と長さがほぼ同じなら「確認してください」", async () => {
  const bytes = makeWav({ seconds: 60, signal: vocalLike({ startSec: 0.2 }) });
  const { result } = await run(bytes, "vocal.wav", { duration: 60.4 });
  const cue = stageOf(result, "cueing");
  assert.equal(cue.outcome, "sameLength");
  assert.equal(cue.detail, "長さは合っています。曲の先頭から書き出したかだけ確認してください");
});

test("冒頭に無音があり伴奏より短い → 断定しない", async () => {
  const bytes = makeWav({ seconds: 60, signal: vocalLike({ startSec: 10 }) });
  const { result } = await run(bytes, "vocal.wav", { duration: 90 });
  const cue = stageOf(result, "cueing");
  assert.equal(cue.outcome, "shorter");
  assert.equal(cue.stage, "check");
});

test("伴奏なしで先頭からすぐ声が始まる", async () => {
  const bytes = makeWav({ seconds: 30, signal: vocalLike({ startSec: 0 }) });
  const { result } = await run(bytes);
  assert.equal(stageOf(result, "cueing").outcome, "startsAtTop");
});

test("伴奏の長さが読めなかったときは、そう書く", async () => {
  const bytes = makeWav({ seconds: 30, signal: vocalLike({ startSec: 0 }) });
  const { result } = await run(bytes, "vocal.wav", { duration: null });
  const cue = stageOf(result, "cueing");
  assert.equal(cue.outcome, "startsAtTop");
  assert.equal(cue.hint, config.items.find((i) => i.id === "cueing").instUnreadable);
});

test("ノイズが大きい録音でも、ノイズを声の始まりと取り違えない", async () => {
  const bytes = makeWav({ seconds: 30, signal: vocalLike({ startSec: 6, noiseAmp: 0.012 }) });
  const { result } = await run(bytes);
  const cue = stageOf(result, "cueing");
  assert.equal(cue.outcome, "leadingSilence");
  assert.match(cue.detail, /6\.0秒/);
});

test("伴奏の wav の長さはヘッダから読む", async () => {
  const bytes = makeWav({ seconds: 7, channels: 2, bits: 16, sampleRate: 44100 });
  const { duration } = await wavDurationOf(asFile(bytes, "inst.wav"));
  assert.equal(duration, 7);
});

/* ---------------- 大きいファイル ---------------- */

test("分割して読んでも結果が同じ（チャンクの境目をまたぐ張り付き）", async () => {
  // 4MB の境目をまたぐ長さ。24bit mono 48kHz で 4MB ≒ 29秒
  const sig = vocalLike({ startSec: 1, amp: 1.6 });
  const bytes = makeWav({ seconds: 70, signal: sig });
  const { analysis, result } = await run(bytes);
  assert.equal(analysis.meter.frames, 70 * 48000);
  assert.equal(stageOf(result, "clipping").outcome, "clipped");
  const windows = analysis.meter.windows.length;
  assert.equal(windows, 70 * 50);
});

/* ---------------- 設定ファイル ---------------- */

test("設定ファイル：どの項目も既知のグループと段階を使っている", () => {
  const groups = new Set(config.groups.map((g) => g.id));
  const stages = new Set(Object.keys(config.stages).map((s) => (Number.isNaN(Number(s)) ? s : Number(s))));
  for (const item of config.items) {
    assert.ok(groups.has(item.group), `${item.id}: unknown group ${item.group}`);
    for (const [key, o] of Object.entries(item.outcomes)) {
      assert.ok(stages.has(o.stage), `${item.id}.${key}: unknown stage ${o.stage}`);
      assert.ok(o.detail, `${item.id}.${key}: detail is empty`);
      if (o.stage === 2 || o.stage === 3) assert.ok(o.fix, `${item.id}.${key}: 段階2以下には直し方が要る`);
    }
  }
});

test("設定ファイル：判定の文言に歌唱の評価を入れない", () => {
  const text = JSON.stringify(config);
  for (const word of ["上手", "下手", "音痴", "点数", "採点"]) {
    // 「上手い下手は見ていません」という注意書きだけは例外
    const hits = text.split(word).length - 1;
    assert.ok(hits <= 1, `「${word}」が判定文言に入っています`);
  }
});

test("ノイズ源は決まった順に並ぶ", () => {
  const a = noiseSource(3);
  const b = noiseSource(3);
  assert.equal(a(), b());
});

/* ---------------- 声の無い区間の雑音（拡張①） ---------------- */

test("雑音は声の無い区間だけで測る（歌の静かなところに引っぱられない）", async () => {
  // 雑音の振幅 0.0003 の一様ノイズ → 実効値は約 −75.2dBFS
  const bytes = makeWav({ seconds: 40, signal: vocalLike({ startSec: 3, noiseAmp: 0.0003, phraseSec: 3, gapSec: 1.5 }) });
  const { result } = await run(bytes);
  const n = stageOf(result, "noise");
  assert.equal(n.outcome, "ok");
  assert.ok(Math.abs(result.measures.noise_dbfs - -75.2) < 2, `noise ${result.measures.noise_dbfs}`);
  assert.equal(result.measures.noise_excluded, false);
});

test("声の無い区間が完全な無音なら、ゲートや編集の跡として未測定にする", async () => {
  const bytes = makeWav({ seconds: 30, signal: vocalLike({ startSec: 3, noiseAmp: 0, phraseSec: 3, gapSec: 1.5 }) });
  const { result } = await run(bytes);
  const n = stageOf(result, "noise");
  assert.equal(n.outcome, "zeroOnly");
  assert.equal(n.stage, "skip");
  assert.equal(result.measures.noise_dbfs, null);
  assert.equal(result.measures.noise_excluded, true);
});

test("書き出しで入った冒頭の完全な無音は外し、外したことを書く", async () => {
  const sig = vocalLike({ startSec: 12, noiseAmp: 0.0003, phraseSec: 3, gapSec: 1.5 });
  const bytes = makeWav({ seconds: 40, signal: (f, c, sr) => (f / sr < 10 ? 0 : sig(f, c, sr)) });
  const { result } = await run(bytes);
  const n = stageOf(result, "noise");
  assert.equal(n.outcome, "ok");
  assert.equal(result.measures.noise_excluded, true);
  assert.equal(n.notes[0], config.items.find((i) => i.id === "noise").excludedNote);
});

/* ---------------- 部屋の響き（拡張①） ---------------- */

const roomOf = async (tailRt60) => {
  const bytes = makeWav({
    seconds: 40,
    signal: vocalLike({ startSec: 2, phraseSec: 2, gapSec: 1.5, tailRt60, noiseAmp: 0.0003 }),
  });
  return (await run(bytes)).result;
};

test("声がすぐ消える録音は「響き：少ない」", async () => {
  const r = await roomOf(0);
  assert.equal(stageOf(r, "room").outcome, "low");
  assert.equal(r.measures.room, "low");
});

test("声のあとに 1.2秒かけて消える響きが残る録音は「響き：多い」（段階2）", async () => {
  const r = await roomOf(1.2);
  const room = stageOf(r, "room");
  assert.equal(room.outcome, "high");
  assert.equal(room.stage, 2);
});

test("雑音が大きめの部屋でも、響きの長さを取り違えない", async () => {
  const bytes = makeWav({
    seconds: 40,
    signal: vocalLike({ startSec: 2, phraseSec: 2, gapSec: 1.5, tailRt60: 1.2, noiseAmp: 0.002 }),
  });
  const { result } = await run(bytes);
  assert.equal(stageOf(result, "room").outcome, "high");
});

test("0.6秒くらいで消える響きは「普通」", async () => {
  const r = await roomOf(0.6);
  assert.equal(stageOf(r, "room").outcome, "normal");
});

test("フレーズの終わりが少なすぎると、響きは未測定", async () => {
  const bytes = makeWav({ seconds: 12, signal: vocalLike({ startSec: 1, phraseSec: 10, gapSec: 1 }) });
  const { result } = await run(bytes);
  assert.equal(stageOf(result, "room").outcome, "notMeasured");
  assert.equal(result.measures.room, null);
});

/* ---------------- 記録用の数値 ---------------- */

test("記録用の数値（measures）は列名どおりに並ぶ", async () => {
  const sig = vocalLike({ startSec: 2, amp: 1.6 });
  const bytes = makeWav({ bits: 16, seconds: 12, signal: sig });
  const { result } = await run(bytes);
  const m = result.measures;
  assert.equal(m.format, "wav");
  assert.equal(m.sample_rate, 48000);
  assert.equal(m.bit_depth, "16bit");
  assert.equal(m.channels, 1);
  assert.equal(m.duration_sec, 12);
  assert.equal(m.peak_dbfs, 0);
  const clipCount = Number(/(\d+) か所/.exec(stageOf(result, "clipping").detail)[1]);
  assert.ok(m.clip_samples >= clipCount * 4, `${m.clip_samples} samples / ${clipCount} places`);
  assert.equal(result.stages.clipping, 2);
});

test("wav 以外の記録用の数値は形式だけ", async () => {
  const bytes = new Uint8Array([...new TextEncoder().encode("ID3"), 4, 0, 0, 0, 0, 0, 0]);
  const { result } = await run(bytes, "voice.mp3");
  assert.deepEqual(result.measures, {
    format: "mp3",
    sample_rate: null,
    bit_depth: null,
    channels: null,
    peak_dbfs: null,
    clip_samples: null,
    noise_dbfs: null,
    noise_excluded: null,
    room: null,
    duration_sec: null,
  });
});

test("判定の版は、しきい値を変えると変わり、文言を変えても変わらない", () => {
  const base = appVersion(config);
  const textChanged = structuredClone(config);
  textChanged.items.find((i) => i.id === "level").outcomes.ok.detail = "別の文言";
  assert.equal(appVersion(textChanged), base);
  const thresholdChanged = structuredClone(config);
  thresholdChanged.items.find((i) => i.id === "level").maxDb = -2;
  assert.notEqual(appVersion(thresholdChanged), base);
});
