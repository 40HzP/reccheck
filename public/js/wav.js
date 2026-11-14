/**
 * wav のヘッダ（RIFF）を直接読む。
 *
 * ブラウザ標準の音声デコード（Web Audio API の decodeAudioData）は、
 * 再生用の周波数に変換したうえで 32bit float に揃えてしまうため、
 * 元のサンプリング周波数とビット深度が分からなくなる。だから自前で読む。
 */

export class WavError extends Error {}

const WAVE_FORMAT_PCM = 0x0001;
const WAVE_FORMAT_IEEE_FLOAT = 0x0003;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

function fourcc(view, at) {
  return String.fromCharCode(
    view.getUint8(at),
    view.getUint8(at + 1),
    view.getUint8(at + 2),
    view.getUint8(at + 3)
  );
}

function parseFmt(view) {
  if (view.byteLength < 16) throw new WavError("fmt chunk too short");
  const formatTag = view.getUint16(0, true);
  const channels = view.getUint16(2, true);
  const sampleRate = view.getUint32(4, true);
  const blockAlign = view.getUint16(12, true);
  const bitsPerSample = view.getUint16(14, true);

  let code = formatTag;
  let validBits = bitsPerSample;
  if (formatTag === WAVE_FORMAT_EXTENSIBLE && view.byteLength >= 26) {
    const vb = view.getUint16(18, true);
    if (vb > 0) validBits = vb;
    // SubFormat GUID の先頭2バイトが、実際の形式のコード
    code = view.getUint16(24, true);
  }

  let codec = "other";
  if (code === WAVE_FORMAT_PCM) codec = "pcm";
  else if (code === WAVE_FORMAT_IEEE_FLOAT) codec = "float";

  return {
    formatTag,
    code,
    codec,
    channels,
    sampleRate,
    blockAlign,
    bitsPerSample,
    validBits,
  };
}

/**
 * @param {(offset: number, length: number) => Promise<ArrayBuffer>} read
 * @param {number} fileSize
 */
export async function parseWav(read, fileSize) {
  const head = new DataView(await read(0, 12));
  if (head.byteLength < 12) throw new WavError("file too short");
  const riff = fourcc(head, 0);
  if ((riff !== "RIFF" && riff !== "RF64" && riff !== "BW64") || fourcc(head, 8) !== "WAVE") {
    throw new WavError("not a RIFF/WAVE file");
  }

  let fmt = null;
  let data = null;
  let ds64DataSize = null;
  let pos = 12;

  // チャンクを順にたどる。fmt と data の間に JUNK / LIST / bext などが
  // 挟まっていることがあるので、決め打ちの位置では読まない。
  while (pos + 8 <= fileSize) {
    const h = new DataView(await read(pos, 8));
    if (h.byteLength < 8) break;
    const id = fourcc(h, 0);
    const size = h.getUint32(4, true);
    const body = pos + 8;

    if (id === "ds64") {
      const b = new DataView(await read(body, Math.min(size, 28)));
      if (b.byteLength >= 16) ds64DataSize = b.getUint32(8, true) + b.getUint32(12, true) * 2 ** 32;
    } else if (id === "fmt ") {
      fmt = parseFmt(new DataView(await read(body, Math.min(size, 64))));
    } else if (id === "data") {
      const available = fileSize - body;
      let dataSize = size;
      if (size === 0xffffffff && ds64DataSize != null) dataSize = ds64DataSize;
      // 録音を止め損ねたファイルなどでは、大きさが 0 や最大値のまま残っている
      const sizeUnknown = dataSize === 0 || dataSize === 0xffffffff;
      const truncated = !sizeUnknown && dataSize > available;
      if (sizeUnknown || truncated) dataSize = available;
      data = { offset: body, size: dataSize, truncated };
      if (fmt) break;
    }

    pos = body + size + (size & 1); // チャンクは偶数バイトに揃えられる
  }

  if (!fmt) throw new WavError("no fmt chunk");
  if (!data) throw new WavError("no data chunk");
  if (fmt.channels < 1 || fmt.sampleRate < 1 || fmt.blockAlign < 1) {
    throw new WavError("invalid fmt values");
  }

  const bytesPerSample = fmt.blockAlign / fmt.channels;
  const decodable =
    Number.isInteger(bytesPerSample) &&
    ((fmt.codec === "pcm" && bytesPerSample >= 1 && bytesPerSample <= 4) ||
      (fmt.codec === "float" && (bytesPerSample === 4 || bytesPerSample === 8)));

  const frames = Math.floor(data.size / fmt.blockAlign);
  return {
    ...fmt,
    bytesPerSample,
    decodable,
    dataOffset: data.offset,
    dataSize: frames * fmt.blockAlign,
    truncated: data.truncated,
    frames,
    duration: frames / fmt.sampleRate,
  };
}

/** 画面に出すビット深度の表記。設定ファイルの bitDepth.ok と同じ書き方。 */
export function depthLabel(wav) {
  if (wav.codec === "float") return `${wav.bitsPerSample}bit float`;
  return `${wav.validBits}bit`;
}

const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/**
 * サンプルのバイト列を数値の配列にする。
 * 返す values は「元の整数（または float）のまま」の値で、
 * scale を掛けると -1〜1 の範囲になる。
 * 音割れの判定で「同じ値が続いているか」を見るので、元の値のまま返す。
 */
export function decodeSamples(buffer, byteLength, wav) {
  const bps = wav.bytesPerSample;
  const count = byteLength / bps;

  if (wav.codec === "float") {
    if (LITTLE_ENDIAN) {
      const values = bps === 4 ? new Float32Array(buffer, 0, count) : new Float64Array(buffer, 0, count);
      return { values, scale: 1 };
    }
    const dv = new DataView(buffer);
    const values = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      values[i] = bps === 4 ? dv.getFloat32(i * 4, true) : dv.getFloat64(i * 8, true);
    }
    return { values, scale: 1 };
  }

  if (bps === 2 && LITTLE_ENDIAN) {
    return { values: new Int16Array(buffer, 0, count), scale: 1 / 32768 };
  }
  if (bps === 4 && LITTLE_ENDIAN) {
    return { values: new Int32Array(buffer, 0, count), scale: 1 / 2147483648 };
  }

  const u8 = new Uint8Array(buffer, 0, byteLength);
  const values = new Int32Array(count);
  if (bps === 1) {
    // 8bit だけは符号なし（128 が無音）
    for (let i = 0; i < count; i++) values[i] = u8[i] - 128;
    return { values, scale: 1 / 128 };
  }
  if (bps === 3) {
    for (let i = 0, j = 0; i < count; i++, j += 3) {
      values[i] = ((u8[j] | (u8[j + 1] << 8) | (u8[j + 2] << 16)) << 8) >> 8;
    }
    return { values, scale: 1 / 8388608 };
  }
  // ビッグエンディアン環境用（実際のブラウザではまず通らない）
  const dv = new DataView(buffer);
  for (let i = 0; i < count; i++) {
    values[i] = bps === 2 ? dv.getInt16(i * 2, true) : dv.getInt32(i * 4, true);
  }
  return { values, scale: bps === 2 ? 1 / 32768 : 1 / 2147483648 };
}
