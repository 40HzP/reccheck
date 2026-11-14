/**
 * ファイル1本を読んで、判定に使う数値を返す。
 * 画面（app.js）からは Web Worker 経由で呼ぶ。テストからは直接呼ぶ。
 *
 * ファイルはこの関数の中で読むだけで、どこにも送らない。
 */
import { sniffFormat } from "./sniff.js";
import { parseWav, decodeSamples, WavError } from "./wav.js";
import { Meter } from "./meter.js";

/** 一度に読む大きさ。大きいファイルでもメモリを食いすぎないように分割する。 */
const CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * @param {Blob & {name?: string}} blob
 * @param {{windowMs: number, minRunSamples: number}} params
 * @param {{onProgress?: (ratio: number) => void, yieldEvery?: () => Promise<void>}} [hooks]
 */
export async function analyzeFile(blob, params, hooks = {}) {
  const read = async (offset, length) => blob.slice(offset, offset + length).arrayBuffer();
  const name = blob.name || "";
  const head = new Uint8Array(await read(0, 16));
  const sniff = sniffFormat(head, name);

  const result = { name, size: blob.size, sniff, wav: null, meter: null, error: null };

  if (!sniff.kind) {
    result.error = "unreadable";
    return result;
  }
  if (sniff.kind !== "wav") return result;

  let wav;
  try {
    wav = await parseWav(read, blob.size);
  } catch (e) {
    if (e instanceof WavError) {
      result.error = "brokenWav";
      return result;
    }
    throw e;
  }
  result.wav = wav;
  if (!wav.decodable) return result;

  const meter = new Meter({
    channels: wav.channels,
    sampleRate: wav.sampleRate,
    windowMs: params.windowMs,
    minRunSamples: params.minRunSamples,
  });

  const step = Math.max(wav.blockAlign, CHUNK_BYTES - (CHUNK_BYTES % wav.blockAlign));
  let scale = 1;
  for (let done = 0; done < wav.dataSize; done += step) {
    const length = Math.min(step, wav.dataSize - done);
    const buffer = await read(wav.dataOffset + done, length);
    const usable = buffer.byteLength - (buffer.byteLength % wav.blockAlign);
    if (usable <= 0) break;
    const decoded = decodeSamples(buffer, usable, wav);
    scale = decoded.scale;
    meter.push(decoded.values, decoded.scale);
    if (hooks.onProgress) hooks.onProgress(Math.min(1, (done + length) / wav.dataSize));
    if (hooks.yieldEvery) await hooks.yieldEvery();
  }

  result.meter = meter.result(scale);
  return result;
}

/**
 * 伴奏の長さ（秒）を、wav ならヘッダから読む。wav 以外は null を返すので、
 * 画面側でブラウザの <audio> に読ませる。
 */
export async function wavDurationOf(blob) {
  const read = async (offset, length) => blob.slice(offset, offset + length).arrayBuffer();
  const sniff = sniffFormat(new Uint8Array(await read(0, 16)), blob.name || "");
  if (sniff.kind !== "wav") return { sniff, duration: null };
  try {
    const wav = await parseWav(read, blob.size);
    return { sniff, duration: wav.duration };
  } catch {
    return { sniff, duration: null };
  }
}
