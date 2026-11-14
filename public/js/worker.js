/**
 * 解析を画面とは別の流れ（Web Worker）で行う。
 * 大きいファイルでも画面が固まらないようにするため。
 */
import { analyzeFile } from "./analyze.js";

self.onmessage = async (event) => {
  const { file, params } = event.data;
  try {
    let last = 0;
    const result = await analyzeFile(file, params, {
      onProgress(ratio) {
        // 細かく送りすぎない
        if (ratio - last >= 0.02 || ratio === 1) {
          last = ratio;
          self.postMessage({ type: "progress", ratio });
        }
      },
    });
    const transfer = result.meter ? [result.meter.windows.buffer] : [];
    self.postMessage({ type: "done", result }, transfer);
  } catch (e) {
    self.postMessage({ type: "error", message: String((e && e.message) || e) });
  }
};
