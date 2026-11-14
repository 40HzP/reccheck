/**
 * このブラウザの中だけに残すもの（localStorage）。外には送らない。
 * - 前回の結果（再チェックのときに並べて出す）
 * - 記録に使う乱数ID（同じ人の前後比較と、記録を消すため）
 * - 前回書いた機材名（次に記録するときの入力の手間を省くため）
 *
 * 設定やプライベートモードで使えないときは、何も残さずに動く。
 */

const KEYS = {
  last: "reccheck:last",
  browserId: "reccheck:browserId",
  recorded: "reccheck:recorded",
  gear: "reccheck:gear",
};

function read(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function randomUuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const store = {
  /** @returns {{savedAt: string, fileName: string, measures: object, stages: object} | null} */
  loadLast() {
    const last = read(KEYS.last);
    return last && typeof last === "object" && last.measures ? last : null;
  },
  saveLast(entry) {
    write(KEYS.last, entry);
  },

  /** 記録に使う乱数ID。無ければ作る。保存できない環境でも、その場限りのIDを返す */
  browserId() {
    let id = read(KEYS.browserId);
    if (typeof id !== "string") {
      id = randomUuid();
      write(KEYS.browserId, id);
    }
    return id;
  },
  existingBrowserId() {
    const id = read(KEYS.browserId);
    return typeof id === "string" ? id : null;
  },

  hasRecorded() {
    return read(KEYS.recorded) === true && Boolean(this.existingBrowserId());
  },
  markRecorded() {
    write(KEYS.recorded, true);
  },

  loadGear() {
    const gear = read(KEYS.gear);
    return gear && typeof gear === "object" ? gear : {};
  },
  saveGear(gear) {
    write(KEYS.gear, gear);
  },

  /** 「このブラウザの記録を消す」のあと。このブラウザに残したものも全部消す */
  clearAll() {
    for (const key of Object.values(KEYS)) {
      try {
        localStorage.removeItem(key);
      } catch {
        /* 使えない環境では何も残っていない */
      }
    }
  },
};
