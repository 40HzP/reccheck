/**
 * 短い区間ごとの音量（dB）の並びから、声のある区間と声の無い区間を分け、
 * 雑音の大きさと部屋の響きの目安を出す。
 *
 * 雑音は「歌い出し前・フレーズの間・歌い終わり」の声の無い区間だけで測る。
 * 声の前後は息や響きが残るので、声のある区間を少し広げてから外す。
 * こうすると、歌い方（静かに歌っているところ）の影響をほぼ切り離せる。
 */

function median(values) {
  if (values.length === 0) return NaN;
  const sorted = Float64Array.from(values).sort();
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** onsetDb 以上の区間を「声がある」とする */
export function voiceMask(winDb, onsetDb) {
  const mask = new Uint8Array(winDb.length);
  for (let i = 0; i < winDb.length; i++) mask[i] = winDb[i] >= onsetDb ? 1 : 0;
  return mask;
}

/** 声のある区間を前後 n 区間ずつ広げる */
export function widen(mask, n) {
  const out = new Uint8Array(mask.length);
  let last = -Infinity;
  // 左から：直前の声から n 区間以内なら声扱い
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) last = i;
    if (i - last <= n) out[i] = 1;
  }
  // 右から：直後の声まで n 区間以内なら声扱い
  let next = Infinity;
  for (let i = mask.length - 1; i >= 0; i--) {
    if (mask[i]) next = i;
    if (next - i <= n) out[i] = 1;
  }
  return out;
}

/**
 * 声の無い区間の雑音
 * @returns {{status: "ok"|"noQuiet"|"zeroOnly", db: number|null, excluded: boolean, quietSec: number}}
 *   noQuiet  … 声の無い区間が見つからない（休みなく歌い続けているなど）
 *   zeroOnly … 声の無い区間が完全な無音しかない（ノイズゲートや編集の跡）
 *   excluded … 完全な無音の区間を計算から外したか
 */
export function estimateNoise(winDb, voice, { windowSec, marginSec, minQuietSec, digitalSilenceDb }) {
  const widened = widen(voice, Math.round(marginSec / windowSec));
  const minWindows = Math.max(1, Math.round(minQuietSec / windowSec));
  const quiet = [];
  let zero = 0;
  for (let i = 0; i < winDb.length; i++) {
    if (widened[i]) continue;
    if (winDb[i] < digitalSilenceDb) zero++;
    else quiet.push(winDb[i]);
  }
  const excluded = zero > 0;
  const quietSec = quiet.length * windowSec;
  if (quiet.length + zero < minWindows) return { status: "noQuiet", db: null, excluded, quietSec };
  if (quiet.length < minWindows) return { status: "zeroOnly", db: null, excluded, quietSec };
  return { status: "ok", db: median(quiet), excluded, quietSec };
}

/**
 * 部屋の響きの目安。フレーズの終わりで声が消えていく速さ（dB/秒）を測る。
 * 響く部屋ほど声が止まったあとも音がゆっくり残るので、下がる速さが遅くなる。
 *
 * フレーズの終わりごとに、終わる直前の音量から startDropDb 下がった所と、
 * endDropDb 下がった所（雑音より 6dB 上で打ち切り）のあいだの傾きを取り、
 * その中央値で判断する。歌い方（音の切り方）の影響も混ざるので、目安にとどめる。
 *
 * @returns {{status: "ok"|"notMeasured", level: "low"|"normal"|"high"|null, dbPerSec: number|null, count: number}}
 */
export function estimateRoom(winDb, voice, floorDb, cfg) {
  const { windowSec } = cfg;
  const win = (sec) => Math.max(1, Math.round(sec / windowSec));
  const lookback = win(cfg.lookbackSec);
  const minGap = win(cfg.minGapSec);
  const maxTail = win(cfg.maxTailSec);
  const floor = Number.isFinite(floorDb) ? floorDb : cfg.digitalSilenceDb;
  const rates = [];

  for (let i = 0; i + 1 < voice.length; i++) {
    if (!voice[i] || voice[i + 1]) continue; // フレーズの終わりだけを見る

    // 終わったあと、しばらく声が戻らないこと（息継ぎの短い隙間は使わない）
    let gapOk = i + minGap < voice.length;
    for (let k = 1; gapOk && k <= minGap; k++) if (voice[i + k]) gapOk = false;
    if (!gapOk) continue;

    // 響きが大きいと、消えかけの音もしばらく「声」に数えられる。
    // 終わりから、音量が上がり続けるあいだはさかのぼり、響きが始まった所（フレーズの本当の終わり）を探す
    let end = i;
    while (end > 0 && voice[end - 1] && i - end < maxTail && winDb[end - 1] > winDb[end] + 0.5) end--;

    // 終わる直前の音量（声のある区間の中だけで探す）
    let ref = -Infinity;
    let refAt = end;
    for (let k = end; k >= 0 && k > end - lookback && voice[k]; k--) {
      if (winDb[k] > ref) {
        ref = winDb[k];
        refAt = k;
      }
    }
    if (ref - floor < cfg.minRangeDb) continue; // 雑音との差が小さすぎて測れない

    const startLevel = ref - cfg.startDropDb;
    const endLevel = Math.max(ref - cfg.endDropDb, floor + 6);
    // 次のフレーズが始まる手前までしか見ない
    let limit = Math.min(winDb.length - 1, i + maxTail);
    for (let k = i + 1; k <= limit; k++) {
      if (voice[k]) {
        limit = k - 1;
        break;
      }
    }

    let a = -1;
    for (let k = refAt + 1; k <= limit; k++) {
      if (winDb[k] <= startLevel) {
        a = k;
        break;
      }
    }
    if (a < 0) continue;
    let b = -1;
    for (let k = a; k <= limit; k++) {
      if (winDb[k] <= endLevel) {
        b = k;
        break;
      }
    }

    let rate;
    if (b < 0) {
      // 見ている範囲では下がりきらなかった。範囲の終わりまでの傾きを使う（遅い側）
      rate = (winDb[a] - winDb[limit]) / Math.max(windowSec, (limit - a) * windowSec);
    } else if (b === a) {
      // 1区間のうちに下がりきった。区間の幅で割った値を上限として使う
      rate = (ref - winDb[a]) / windowSec;
    } else {
      rate = (winDb[a] - winDb[b]) / ((b - a) * windowSec);
    }
    if (Number.isFinite(rate)) rates.push(Math.min(rate, 2000));
  }

  if (rates.length < cfg.minCount) return { status: "notMeasured", level: null, dbPerSec: null, count: rates.length };
  const dbPerSec = median(rates);
  let level = "normal";
  if (dbPerSec >= cfg.fastDbPerSec) level = "low";
  else if (dbPerSec <= cfg.slowDbPerSec) level = "high";
  return { status: "ok", level, dbPerSec, count: rates.length };
}
