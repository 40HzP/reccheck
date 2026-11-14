/**
 * テスト用の wav を作る。信号は関数で渡す（frame, channel → -1〜1 の値）。
 */

export function makeWav({
  sampleRate = 48000,
  channels = 1,
  codec = "pcm", // "pcm" | "float"
  bits = 24,
  extensible = false,
  seconds = 1,
  signal = () => 0,
  chunksBefore = [], // fmt の前に挟むチャンク [{id, size}]
  chunksBetween = [], // fmt と data の間に挟むチャンク
  dataSizeOverride = null, // ヘッダの data の大きさを書き換える（0 や切れたファイルの再現）
  raw = null, // signal の値をそのまま整数で書く（張り付きの再現用）
}) {
  const frames = Math.round(sampleRate * seconds);
  const bps = bits / 8;
  const blockAlign = bps * channels;
  const dataSize = frames * blockAlign;

  const fmtSize = extensible ? 40 : 16;
  const extraBefore = chunksBefore.reduce((s, c) => s + 8 + c.size + (c.size & 1), 0);
  const extraBetween = chunksBetween.reduce((s, c) => s + 8 + c.size + (c.size & 1), 0);
  const total = 12 + extraBefore + 8 + fmtSize + extraBetween + 8 + dataSize;
  const buf = new ArrayBuffer(total);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  let p = 0;
  const str = (s) => {
    for (const ch of s) u8[p++] = ch.charCodeAt(0);
  };
  const u32 = (v) => {
    dv.setUint32(p, v, true);
    p += 4;
  };
  const u16 = (v) => {
    dv.setUint16(p, v, true);
    p += 2;
  };
  const chunk = (c) => {
    str(c.id);
    u32(c.size);
    p += c.size + (c.size & 1);
  };

  str("RIFF");
  u32(total - 8);
  str("WAVE");
  chunksBefore.forEach(chunk);

  str("fmt ");
  u32(fmtSize);
  const tag = codec === "float" ? 3 : 1;
  u16(extensible ? 0xfffe : tag);
  u16(channels);
  u32(sampleRate);
  u32(sampleRate * blockAlign);
  u16(blockAlign);
  u16(bits);
  if (extensible) {
    u16(22);
    u16(bits);
    u32(channels === 1 ? 4 : 3);
    u16(tag);
    // GUID の残り
    for (const b of [0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71]) u8[p++] = b;
  }
  chunksBetween.forEach(chunk);

  str("data");
  u32(dataSizeOverride ?? dataSize);

  const max = 2 ** (bits - 1);
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channels; c++) {
      const v = signal(f, c, sampleRate);
      if (codec === "float") {
        if (bits === 32) dv.setFloat32(p, v, true);
        else dv.setFloat64(p, v, true);
      } else {
        let q = raw ? v : Math.round(v * max);
        q = Math.max(-max, Math.min(max - 1, q));
        if (bits === 8) dv.setUint8(p, q + 128);
        else if (bits === 16) dv.setInt16(p, q, true);
        else if (bits === 24) {
          dv.setUint8(p, q & 0xff);
          dv.setUint8(p + 1, (q >> 8) & 0xff);
          dv.setUint8(p + 2, (q >> 16) & 0xff);
        } else dv.setInt32(p, q, true);
      }
      p += bps;
    }
  }
  return new Uint8Array(buf);
}

export function asFile(bytes, name) {
  return new File([bytes], name);
}

/* ---------------- 信号 ---------------- */

/** 決まった順に並ぶ疑似乱数（テストが毎回同じになるように） */
export function noiseSource(seed = 1) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) / 4294967296) * 2 - 1;
  };
}

/**
 * 歌っているような信号。startSec から endSec まで、2秒歌って0.5秒休むを繰り返す。
 * 声は 220Hz と倍音、休みはノイズだけ。
 */
export function vocalLike({ startSec = 0, endSec = Infinity, amp = 0.3, noiseAmp = 0.0003, seed = 7 } = {}) {
  const rnd = noiseSource(seed);
  return (f, c, sr) => {
    const t = f / sr;
    let v = noiseAmp * rnd();
    if (t >= startSec && t < endSec) {
      const inPhrase = (t - startSec) % 2.5 < 2;
      if (inPhrase) {
        const w = 2 * Math.PI * 220 * t;
        v += amp * (0.7 * Math.sin(w) + 0.2 * Math.sin(2 * w) + 0.1 * Math.sin(3 * w));
      }
    }
    return v;
  };
}
