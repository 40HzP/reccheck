/**
 * サンプルを少しずつ受け取って、判定に使う数値を貯めていく。
 * ファイル全体を一度にメモリへ載せずに済むよう、分割して流し込める作りにしている。
 *
 * 計るもの
 * - チャンネルごとの最大値（プラス側・マイナス側を別々に）
 * - 最大値に張り付いて続いているサンプルの箇所数（音割れ）
 * - 0dBFS を超えたサンプル数（32bit float 用）
 * - 短い区間ごとの平均の音量（頭出し・ノイズ・中身の判定に使う）
 * - 左右の差（ステレオのとき）
 */
export class Meter {
  /**
   * @param {{channels: number, sampleRate: number, windowMs: number, minRunSamples: number}} opts
   */
  constructor({ channels, sampleRate, windowMs, minRunSamples }) {
    this.channels = channels;
    this.sampleRate = sampleRate;
    this.windowFrames = Math.max(1, Math.round((sampleRate * windowMs) / 1000));
    this.minRun = Math.max(1, minRunSamples | 0);

    this.windows = new Float32Array(1024);
    this.windowCount = 0;
    this.winSum = 0;
    this.winFrames = 0;

    this.ch = [];
    for (let c = 0; c < channels; c++) {
      this.ch.push({
        posPeak: -Infinity,
        posRun: 0,
        posEvents: 0,
        posFirst: -1,
        negPeak: Infinity,
        negRun: 0,
        negEvents: 0,
        negFirst: -1,
        sumSq: 0,
      });
    }
    this.diffSq = 0;
    this.overCount = 0;
    this.firstOver = -1;
    this.frame = 0;
  }

  pushWindow(meanSquare) {
    if (this.windowCount === this.windows.length) {
      const grown = new Float32Array(this.windows.length * 2);
      grown.set(this.windows);
      this.windows = grown;
    }
    this.windows[this.windowCount++] = meanSquare;
  }

  /**
   * @param {ArrayLike<number>} values 左右が交互に並んだサンプル（元の値のまま）
   * @param {number} scale 掛けると -1〜1 になる係数
   */
  push(values, scale) {
    const C = this.channels;
    const minRun = this.minRun;
    const winLen = this.windowFrames;
    const n = values.length - (values.length % C);
    const ch = this.ch;
    let frame = this.frame;
    let winSum = this.winSum;
    let winFrames = this.winFrames;
    let diffSq = this.diffSq;
    let overCount = this.overCount;

    for (let i = 0; i < n; i += C) {
      let frameSq = 0;
      for (let c = 0; c < C; c++) {
        const raw = values[i + c];
        const st = ch[c];
        const v = raw * scale;
        const sq = v * v;
        frameSq += sq;
        st.sumSq += sq;

        // プラス側の最大値と、そこに張り付いている長さ
        if (raw >= st.posPeak) {
          if (raw > st.posPeak) {
            st.posPeak = raw;
            st.posRun = 0;
            st.posEvents = 0;
            st.posFirst = -1;
          }
          st.posRun++;
          if (st.posRun === minRun) {
            st.posEvents++;
            if (st.posFirst < 0) st.posFirst = frame - minRun + 1;
          }
        } else {
          st.posRun = 0;
        }

        // マイナス側
        if (raw <= st.negPeak) {
          if (raw < st.negPeak) {
            st.negPeak = raw;
            st.negRun = 0;
            st.negEvents = 0;
            st.negFirst = -1;
          }
          st.negRun++;
          if (st.negRun === minRun) {
            st.negEvents++;
            if (st.negFirst < 0) st.negFirst = frame - minRun + 1;
          }
        } else {
          st.negRun = 0;
        }

        if (sq > 1) {
          if (overCount === 0) this.firstOver = frame;
          overCount++;
        }
      }

      if (C >= 2) {
        const d = (values[i] - values[i + 1]) * scale;
        diffSq += d * d;
      }

      winSum += frameSq / C;
      winFrames++;
      if (winFrames === winLen) {
        this.pushWindow(winSum / winLen);
        winSum = 0;
        winFrames = 0;
      }
      frame++;
    }

    this.frame = frame;
    this.winSum = winSum;
    this.winFrames = winFrames;
    this.diffSq = diffSq;
    this.overCount = overCount;
  }

  /**
   * @param {number} scale push と同じ係数（最大値を -1〜1 に直すため）
   */
  result(scale) {
    if (this.winFrames > 0) {
      this.pushWindow(this.winSum / this.winFrames);
      this.winSum = 0;
      this.winFrames = 0;
    }
    const frames = this.frame;
    const channels = this.ch.map((st) => {
      const pos = st.posPeak === -Infinity ? 0 : Math.max(0, st.posPeak * scale);
      const neg = st.negPeak === Infinity ? 0 : Math.max(0, -st.negPeak * scale);
      return {
        // 張り付き判定はプラス側・マイナス側それぞれの最大値で行う
        pos: { peak: pos, events: st.posEvents, firstFrame: st.posFirst },
        neg: { peak: neg, events: st.negEvents, firstFrame: st.negFirst },
        peak: Math.max(pos, neg),
        meanSquare: frames > 0 ? st.sumSq / frames : 0,
      };
    });
    return {
      frames,
      sampleRate: this.sampleRate,
      windowSec: this.windowFrames / this.sampleRate,
      windows: this.windows.slice(0, this.windowCount),
      channels,
      diffMeanSquare: frames > 0 ? this.diffSq / frames : 0,
      overCount: this.overCount,
      firstOverFrame: this.firstOver,
    };
  }
}
