/**
 * 計った数値（analyze.js の結果）と設定ファイルから、項目ごとの段階と文言を決める。
 * 画面には触らない。しきい値と文言はすべて config から読む。
 */
import { depthLabel } from "./wav.js";

/** 段階の重さ。結果の見出しは、いちばん重いものに合わせる。 */
const SEVERITY = { 3: 4, 2: 3, check: 2, 1: 1, skip: 0 };

/* ---------------- 表示用の整形 ---------------- */

export function ampToDb(amp) {
  return amp > 0 ? 20 * Math.log10(amp) : -Infinity;
}

export function meanSquareToDb(ms) {
  return ms > 0 ? 10 * Math.log10(ms) : -Infinity;
}

export function formatDb(db) {
  if (db === -Infinity) return "−∞dBFS";
  const text = Math.abs(db).toFixed(1);
  if (text === "0.0") return "0.0dBFS";
  return `${db < 0 ? "−" : "+"}${text}dBFS`;
}

export function formatSec(sec) {
  if (sec < 10) return `${(Math.round(sec * 10) / 10).toFixed(1)}秒`;
  const total = Math.round(sec);
  if (total < 60) return `${total}秒`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s === 0 ? `${m}分` : `${m}分${s}秒`;
}

export function formatRate(hz) {
  return `${Number((hz / 1000).toFixed(3))}kHz`;
}

export function formatSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

export function fill(template, vars) {
  return String(template || "").replace(/\{(\w+)\}/g, (all, key) => (key in vars ? String(vars[key]) : all));
}

/* ---------------- 計測値からの導出 ---------------- */

function percentile(sorted, p) {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[idx];
}

/** 判定の前に、計った値から使う数値をまとめて出しておく */
function derive(analysis, config) {
  const { wav, meter } = analysis;
  const item = (id) => config.items.find((i) => i.id === id) || {};
  const content = item("content");
  const cueing = item("cueing");
  const noise = item("noise");

  const peak = Math.max(0, ...meter.channels.map((c) => c.peak));
  const peakDb = ampToDb(peak);
  const silent = peakDb < (content.silentPeakDb ?? -50);

  const winDb = Array.from(meter.windows, meanSquareToDb);
  const floorLimit = noise.digitalSilenceDb ?? -90;
  const audible = winDb.filter((d) => d >= floorLimit).sort((a, b) => a - b);
  const noiseDb = audible.length ? percentile(audible, noise.percentile ?? 10) : -Infinity;

  // いちばん静かなところでも声と同じくらい大きいなら、歌っていないところは
  // 見つかっていない（休みのない音源や、ゲートで隙間を消した音源）。
  const voiceDb = cueing.voiceDb ?? -40;
  const quietFound = Number.isFinite(noiseDb) && noiseDb < voiceDb;

  // 声が始まったとみなす音量。ノイズが大きい録音では、ノイズより一段大きい音にする。
  let onsetDb = voiceDb;
  if (quietFound) onsetDb = Math.max(onsetDb, noiseDb + (cueing.aboveNoiseDb ?? 12));
  const firstVoice = winDb.findIndex((d) => d >= onsetDb);
  const leadSec = firstVoice < 0 ? null : firstVoice * meter.windowSec;

  return { wav, meter, peak, peakDb, silent, noiseDb, quietFound, leadSec, duration: wav.duration };
}

/* ---------------- 項目ごとの判定 ---------------- */

/**
 * 各関数は、使う outcome の名前と、文言に差し込む値を返す。
 * outcome の名前は config の outcomes のキーと対応している。
 */
const RULES = {
  content(cfg, d) {
    const vars = { duration: formatSec(d.duration), peak: formatDb(d.peakDb) };
    if (d.wav.truncated) return { outcome: "truncated", vars };
    if (d.silent) return { outcome: "silent", vars };
    if (d.duration < cfg.minDurationSec) return { outcome: "short", vars };
    return { outcome: "ok", vars };
  },

  cueing(cfg, d, inst) {
    if (d.silent || d.leadSec == null) return { skip: "noSound" };
    const immediate = d.leadSec < cfg.immediateStartSec;
    const vars = { lead: formatSec(d.leadSec) };

    const instDuration = inst && Number.isFinite(inst.duration) ? inst.duration : null;
    if (instDuration != null) {
      const diff = instDuration - d.duration; // プラスなら伴奏より短い
      vars.diff = formatSec(Math.abs(diff));
      if (Math.abs(diff) <= cfg.sameLengthSec) return { outcome: "sameLength", vars };
      if (immediate && diff >= cfg.shorterThanInstSec) return { outcome: "likelyNotCued", vars };
      if (diff > 0) return { outcome: "shorter", vars };
      return { outcome: "longer", vars };
    }

    const result = { outcome: immediate ? "startsAtTop" : "leadingSilence", vars };
    if (inst) result.hint = cfg.instUnreadable; // 伴奏は入っているが長さが読めなかった
    return result;
  },

  clipping(cfg, d) {
    if (d.silent) return { skip: "noSound" };
    let count = 0;
    let first = -1;
    for (const ch of d.meter.channels) {
      for (const side of [ch.pos, ch.neg]) {
        if (ampToDb(side.peak) < cfg.ignoreBelowDb) continue;
        count += side.events;
        if (side.firstFrame >= 0 && (first < 0 || side.firstFrame < first)) first = side.firstFrame;
      }
    }
    if (count >= cfg.minCount) {
      return {
        outcome: "clipped",
        vars: { count, time: formatSec(Math.max(0, first) / d.meter.sampleRate) },
      };
    }
    if (d.wav.codec === "float" && d.meter.overCount > 0) return { outcome: "overButIntact", vars: {} };
    return { outcome: "none", vars: {} };
  },

  level(cfg, d) {
    if (d.silent) return { skip: "noSound" };
    const vars = { peak: formatDb(d.peakDb) };
    if (d.peakDb < cfg.minDb) return { outcome: "low", vars };
    if (d.peakDb > cfg.maxDb) return { outcome: "high", vars };
    return { outcome: "ok", vars };
  },

  noise(cfg, d) {
    if (d.silent || !Number.isFinite(d.noiseDb)) return { skip: "noSound" };
    const vars = { noise: formatDb(d.noiseDb) };
    if (!d.quietFound) return { outcome: "notFound", vars };
    return { outcome: d.noiseDb > cfg.maxDb ? "high" : "ok", vars };
  },

  sampleRate(cfg, d) {
    const vars = { rate: formatRate(d.wav.sampleRate) };
    return { outcome: cfg.okHz.includes(d.wav.sampleRate) ? "ok" : "other", vars };
  },

  bitDepth(cfg, d) {
    const depth = depthLabel(d.wav);
    return { outcome: cfg.ok.includes(depth) ? "ok" : "other", vars: { depth } };
  },

  channels(cfg, d) {
    const n = d.wav.channels;
    if (n === 1) return { outcome: "mono", vars: {} };
    if (n > 2) return { outcome: "multi", vars: { count: n } };

    const [left, right] = d.meter.channels.map((c) => c.meanSquare);
    const louder = Math.max(left, right);
    if (louder === 0) return { outcome: "stereoSame", vars: {} };
    const quieter = Math.min(left, right);
    if (meanSquareToDb(quieter / louder) < cfg.oneSideDb) {
      return { outcome: "stereoOneSide", vars: { side: left >= right ? "左" : "右" } };
    }
    if (meanSquareToDb(d.meter.diffMeanSquare / (left + right)) < cfg.sameDb) {
      return { outcome: "stereoSame", vars: {} };
    }
    return { outcome: "stereoDifferent", vars: {} };
  },
};

function judgeFormat(cfg, analysis) {
  const { sniff, wav } = analysis;
  const kind = sniff.kind;
  // 拡張子と中身が同じなら拡張子の書き方（mp4 など）、違えば中身の形式名を出す
  const name = sniff.ext && !sniff.mismatch ? sniff.ext : kind;
  let key = kind;
  if (kind === "wav") key = wav && !wav.decodable ? "wavCompressed" : "wav";
  const outcome = cfg.outcomes[key] ? key : "other";
  const notes = [];
  if (sniff.mismatch) notes.push(fill(cfg.mismatch, { ext: sniff.ext, name: kind }));
  return { outcome, vars: { name }, notes };
}

/**
 * @param {object} analysis analyzeFile の結果
 * @param {{duration: number|null}|null} inst 伴奏（入れていなければ null）
 * @param {object} config 設定ファイル
 */
export function judge(analysis, inst, config) {
  if (analysis.error) {
    return { error: config.messages[analysis.error] || config.messages.failed };
  }

  const measurable = Boolean(analysis.wav && analysis.wav.decodable && analysis.meter);
  let skipReason = null;
  if (analysis.sniff.kind !== "wav") skipReason = "notWav";
  else if (!measurable) skipReason = "undecodableWav";

  const d = measurable ? derive(analysis, config) : null;

  const items = config.items.map((cfg) => {
    let r;
    if (cfg.id === "format") r = judgeFormat(cfg, analysis);
    else if (!RULES[cfg.id]) r = { skip: "failed" };
    else if (skipReason) r = { skip: skipReason };
    else r = RULES[cfg.id](cfg, d, inst);

    const base = { id: cfg.id, group: cfg.group, name: cfg.name, note: cfg.note || "", notes: r.notes || [] };
    if (r.skip) {
      return { ...base, stage: "skip", detail: config.messages[r.skip] || "", fix: "", hint: "" };
    }
    const o = cfg.outcomes[r.outcome];
    if (!o) {
      return { ...base, stage: "skip", detail: config.messages.failed, fix: "", hint: "" };
    }
    return {
      ...base,
      outcome: r.outcome,
      stage: o.stage,
      detail: fill(o.detail, r.vars),
      fix: fill(o.fix, r.vars),
      hint: r.hint != null ? r.hint : fill(o.hint, r.vars),
    };
  });

  const counts = { 3: 0, 2: 0, check: 0, 1: 0, skip: 0 };
  let worst = "skip";
  for (const it of items) {
    counts[it.stage] = (counts[it.stage] || 0) + 1;
    if ((SEVERITY[it.stage] ?? 0) > SEVERITY[worst]) worst = it.stage;
  }

  return {
    items,
    worst,
    counts,
    summary: config.summary[worst] || "",
    duration: analysis.wav ? analysis.wav.duration : null,
  };
}
