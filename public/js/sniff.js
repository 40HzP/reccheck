/**
 * ファイルの先頭の数バイト（マジックナンバー）から形式を見分ける。
 * 拡張子は名前を変えるだけで変わるので、判定は中身を優先し、
 * 中身で分からないときだけ拡張子を使う。
 */

/** 拡張子 → 形式 */
const EXT_KIND = {
  wav: "wav",
  wave: "wav",
  mp3: "mp3",
  m4a: "m4a",
  mp4: "m4a",
  aac: "aac",
  aif: "aiff",
  aiff: "aiff",
  aifc: "aiff",
  flac: "flac",
  ogg: "ogg",
  oga: "ogg",
  opus: "ogg",
  caf: "caf",
};

function ascii(bytes, start, end) {
  let s = "";
  for (let i = start; i < end && i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

/** 中身から分かる形式。分からなければ null */
export function kindFromHeader(bytes) {
  const head4 = ascii(bytes, 0, 4);
  if ((head4 === "RIFF" || head4 === "RF64" || head4 === "BW64") && ascii(bytes, 8, 12) === "WAVE") {
    return "wav";
  }
  // MP4 の入れ物（m4a / mp4 / mov）。iPhone のボイスメモなどはこれ。
  if (ascii(bytes, 4, 8) === "ftyp") return "m4a";
  if (head4 === "FORM") {
    const t = ascii(bytes, 8, 12);
    if (t === "AIFF" || t === "AIFC") return "aiff";
  }
  if (head4 === "fLaC") return "flac";
  if (head4 === "OggS") return "ogg";
  if (head4 === "caff") return "caf";
  if (ascii(bytes, 0, 3) === "ID3") return "mp3";
  // フレーム同期（先頭11ビットが1）。MPEG のレイヤー欄が 00 なら AAC（ADTS）。
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) {
    const layer = (bytes[1] >> 1) & 0x03;
    return layer === 0 ? "aac" : "mp3";
  }
  return null;
}

export function extensionOf(fileName) {
  const m = /\.([^./\\]+)$/.exec(fileName || "");
  return m ? m[1].toLowerCase() : "";
}

/**
 * @param {Uint8Array} bytes ファイルの先頭（16バイト以上あれば足りる）
 * @param {string} fileName
 * @returns {{kind: string|null, ext: string, mismatch: boolean}}
 *   kind … "wav" / "mp3" / "m4a" / "aac" / "aiff" / "flac" / "ogg" / "caf" / null（音声として分からない）
 *   mismatch … 拡張子が示す形式と中身が違う
 */
export function sniffFormat(bytes, fileName) {
  const ext = extensionOf(fileName);
  const extKind = EXT_KIND[ext] || null;
  const headerKind = kindFromHeader(bytes);
  const kind = headerKind || extKind;
  return {
    kind,
    ext,
    mismatch: Boolean(headerKind && ext && extKind !== headerKind),
  };
}
