/**
 * 画面の動き。ファイルを受け取り、解析を Web Worker に頼み、結果を並べる。
 * 文言と数値は config.js から読む。ファイルはどこにも送らない。
 */
import config from "../config.js";
import { analyzeFile, wavDurationOf } from "./analyze.js";
import { judge, fill, appVersion, formatDb, formatRate, formatSec, formatSize } from "./judge.js";
import { store } from "./store.js";
import { renderRecordForm, renderRecordInfo } from "./record.js";

const $ = (id) => document.getElementById(id);

const params = {
  windowMs: config.windowMs,
  minRunSamples: (config.items.find((i) => i.id === "clipping") || {}).minRunSamples || 4,
};

const STAGE_MARK = { 1: "✓", 2: "△", 3: "×", check: "?", skip: "−" };

const state = {
  vocal: null, // { file, analysis }
  inst: null, // { file, duration }
  result: null, // いちばん新しい判定（記録はこれを送る）
  previous: null, // このブラウザに残っていた前回の結果（比べるため）
  savedAt: null, // 今回の結果を残した日時
  run: 0,
  instRun: 0,
  worker: null,
};

/* ---------------- 小さな道具 ---------------- */

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of [].concat(children)) if (c) node.append(c);
  return node;
}

/** 読み上げ用の一文（画面には出ない） */
function announce(text) {
  $("live").textContent = text;
}

/** 読み込みの進み具合。null で隠す */
function setProgress(ratio) {
  const box = $("status");
  if (ratio == null) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  $("status-text").textContent = `読み込んでいます… ${Math.round(ratio * 100)}%`;
  $("status-bar").value = ratio;
}

function showError(message) {
  const box = $("error");
  box.textContent = message;
  box.hidden = !message;
}

function prefersReducedMotion() {
  return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/* ---------------- ファイル選択の表示 ---------------- */

function showChosen(pickerId, file, extra = "") {
  const picker = $(pickerId);
  const fileSlot = picker.querySelector('[data-slot="file"]');
  const helpSlot = picker.querySelector('[data-slot="help"]');
  if (!picker.dataset.help) picker.dataset.help = helpSlot.textContent;
  if (file) {
    fileSlot.textContent = file.name;
    helpSlot.textContent = [formatSize(file.size), extra, "押すと選び直せます"].filter(Boolean).join(" ・ ");
    picker.classList.add("is-chosen");
  } else {
    fileSlot.textContent = "ファイルを選ぶ";
    helpSlot.textContent = picker.dataset.help;
    picker.classList.remove("is-chosen");
  }
}

/* ---------------- 解析 ---------------- */

function stopWorker() {
  if (state.worker) {
    state.worker.terminate();
    state.worker = null;
  }
}

/** Web Worker が使えない環境では、画面の中で少しずつ読む */
function analyzeInPage(file, onProgress) {
  return analyzeFile(file, params, {
    onProgress,
    yieldEvery: () => new Promise((r) => setTimeout(r, 0)),
  });
}

function analyzeInWorker(file, onProgress) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    } catch {
      analyzeInPage(file, onProgress).then(resolve, reject);
      return;
    }
    state.worker = worker;
    let started = false;
    worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === "progress") {
        started = true;
        onProgress(msg.ratio);
      } else if (msg.type === "done") {
        stopWorker();
        resolve(msg.result);
      } else if (msg.type === "error") {
        stopWorker();
        reject(new Error(msg.message));
      }
    };
    worker.onerror = (e) => {
      e.preventDefault();
      stopWorker();
      // モジュール形式の Worker に対応していない古いブラウザでは、ここに来る
      if (!started) analyzeInPage(file, onProgress).then(resolve, reject);
      else reject(new Error("worker failed"));
    };
    worker.postMessage({ file, params });
  });
}

async function onVocal(file) {
  if (!file) return;
  stopWorker();
  const run = ++state.run;
  state.vocal = null;
  state.result = null;
  showChosen("vocal-picker", file);
  showError("");
  $("result").hidden = true;
  $("record").hidden = true;
  $("next").hidden = true;

  const limit = config.maxFileMB * 1024 * 1024;
  if (file.size > limit) {
    setProgress(null);
    showError(fill(config.messages.tooLarge, { size: formatSize(file.size), limit: `${config.maxFileMB}MB` }));
    return;
  }

  setProgress(0);
  announce("読み込んでいます");
  try {
    const analysis = await analyzeInWorker(file, (ratio) => {
      if (run === state.run) setProgress(ratio);
    });
    if (run !== state.run) return;
    state.vocal = { file, analysis };
    // 前回の結果は、今回の結果で上書きする前に読んでおく
    state.previous = store.loadLast();
    state.savedAt = new Date().toISOString();
    render({ focus: true, fresh: true });
  } catch (e) {
    if (run !== state.run) return;
    console.error(e);
    setProgress(null);
    showError(config.messages.failed);
  }
}

/** wav 以外の伴奏は、ブラウザに長さだけ読ませる（中身は読まない） */
function mediaDuration(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const audio = document.createElement("audio");
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      resolve(value);
    };
    const timer = setTimeout(() => done(null), 8000);
    audio.preload = "metadata";
    audio.addEventListener("loadedmetadata", () => done(Number.isFinite(audio.duration) ? audio.duration : null));
    audio.addEventListener("error", () => done(null));
    audio.src = url;
  });
}

async function onInst(file) {
  if (!file) return;
  const run = ++state.instRun;
  showChosen("inst-picker", file, "長さを読んでいます…");
  $("inst-clear").hidden = false;
  let duration = null;
  try {
    const r = await wavDurationOf(file);
    duration = r.sniff.kind === "wav" ? r.duration : r.sniff.kind ? await mediaDuration(file) : null;
  } catch {
    duration = null;
  }
  if (run !== state.instRun) return; // 読んでいるあいだに選び直された・外された
  state.inst = { file, duration };
  showChosen("inst-picker", file, duration != null ? `長さ ${formatSec(duration)}` : "長さを読み取れませんでした");
  if (state.vocal) render({ focus: false, fresh: false });
}

function clearInst() {
  state.instRun++;
  state.inst = null;
  $("inst-input").value = "";
  showChosen("inst-picker", null);
  $("inst-clear").hidden = true;
  $("inst-input").focus();
  if (state.vocal) render({ focus: false, fresh: false });
}

/* ---------------- 結果の表示 ---------------- */

function renderItem(item) {
  const children = [
    el("div", { class: "item__head" }, [
      el("p", { class: "item__name", text: item.name }),
      el("p", { class: "badge" }, [
        el("span", { class: "badge__mark", "aria-hidden": "true", text: STAGE_MARK[item.stage] || "" }),
        config.stages[item.stage] || "",
      ]),
    ]),
    el("p", { class: "item__detail", text: item.detail }),
  ];
  if (item.fix) {
    children.push(el("p", { class: "item__fix" }, [el("span", { class: "item__label", text: config.fixLabel }), item.fix]));
  }
  if (item.hint) {
    children.push(el("p", { class: "item__fix" }, [el("span", { class: "item__label", text: config.hintLabel }), item.hint]));
  }
  for (const note of item.notes) children.push(el("p", { class: "item__note", text: note }));
  if (item.note && item.stage !== "skip") children.push(el("p", { class: "item__note", text: item.note }));
  return el("li", { class: "item", "data-stage": String(item.stage) }, children);
}

/* ---------------- 前回との比較 ---------------- */

function formatMeasure(key, value) {
  const C = config.compare;
  if (value == null) return C.empty;
  const item = (id) => config.items.find((i) => i.id === id) || { outcomes: {} };
  switch (key) {
    case "format":
      return value === "wav-compressed" ? "wav（圧縮）" : String(value);
    case "sample_rate":
      return formatRate(value);
    case "channels": {
      const o = item("channels").outcomes;
      if (value === 1) return o.mono ? o.mono.detail : "モノラル";
      if (value === 2) return "ステレオ";
      return fill(o.multi ? o.multi.detail : "{count}チャンネル", { count: value });
    }
    case "duration_sec":
      return formatSec(value);
    case "peak_dbfs":
    case "noise_dbfs":
      return formatDb(value);
    case "room": {
      const o = item("room").outcomes[value];
      return o ? o.detail : String(value);
    }
    default:
      return String(value);
  }
}

function formatWhen(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function renderCompare(previous, current) {
  const box = $("result-compare");
  if (!previous) {
    box.replaceChildren();
    return;
  }
  const C = config.compare;
  const rows = C.rows.map((row) => {
    const before = formatMeasure(row.key, previous.measures[row.key]);
    const now = formatMeasure(row.key, current.measures[row.key]);
    return el("tr", { "data-changed": before !== now ? "true" : null }, [
      el("th", { scope: "row", text: row.label }),
      el("td", { text: before }),
      el("td", { text: now }),
    ]);
  });
  box.replaceChildren(
    el("section", { class: "group compare", "aria-labelledby": "compare-heading" }, [
      el("h3", { class: "h3", id: "compare-heading", text: C.heading }),
      el("p", {
        class: "group__lead",
        text: fill(C.lead, { date: formatWhen(previous.savedAt), file: previous.fileName || "" }),
      }),
      el("table", { class: "compare__table" }, [
        el("thead", {}, [
          el("tr", {}, [
            el("th", { scope: "col" }, [el("span", { class: "visually-hidden", text: "項目" })]),
            ...C.columns.map((c) => el("th", { scope: "col", text: c })),
          ]),
        ]),
        el("tbody", {}, rows),
      ]),
    ])
  );
}

function render({ focus, fresh }) {
  const { file, analysis } = state.vocal;
  const result = judge(analysis, state.inst ? { duration: state.inst.duration } : null, config);

  setProgress(null);
  if (result.error) {
    state.result = null;
    $("result").hidden = true;
    $("record").hidden = true;
    $("next").hidden = true;
    showError(result.error);
    return;
  }
  showError("");
  state.result = result;

  // 今回の結果をこのブラウザに残す（次に確かめたときの「前回」になる）
  store.saveLast({ savedAt: state.savedAt, fileName: file.name, measures: result.measures, stages: result.stages });

  const info = [file.name];
  if (result.duration != null) info.push(formatSec(result.duration));
  info.push(formatSize(file.size));
  let fileLine = info.join(" ・ ");
  if (state.inst) {
    const d = state.inst.duration;
    fileLine += `　伴奏：${state.inst.file.name}${d != null ? `（${formatSec(d)}）` : ""}`;
  }
  $("result-file").textContent = fileLine;

  const summary = $("result-summary");
  summary.textContent = result.summary;
  summary.dataset.stage = String(result.worst);

  const groups = $("result-groups");
  groups.replaceChildren(
    ...config.groups.map((g) => {
      const items = result.items.filter((it) => it.group === g.id);
      if (!items.length) return "";
      return el("section", { class: "group", "aria-labelledby": `group-${g.id}` }, [
        el("h3", { class: "h3", id: `group-${g.id}`, text: g.heading }),
        g.lead ? el("p", { class: "group__lead", text: g.lead }) : null,
        el("ul", { class: "items" }, items.map(renderItem)),
      ]);
    })
  );

  renderCompare(state.previous, result);

  $("result-notes").replaceChildren(...config.notes.map((n) => el("li", {}, [el("span", { text: n })])));

  // 記録の欄は、ファイルを選び直したときだけ作り直す（伴奏の出し入れで入力が消えないように）
  if (fresh) {
    renderRecordForm($("record"), {
      getCurrent: () => state.result,
      hasPrevious: Boolean(state.previous),
      appVersion: appVersion(config),
    });
  }

  $("next-heading").textContent = config.exits.heading;
  $("exits").replaceChildren(
    ...config.exits.links.map((link) =>
      el("li", { class: "exit" }, [
        el("a", { class: `btn ${link.primary ? "btn--solid" : "btn--ghost"}`, href: link.href, text: link.label }),
        link.body ? el("p", { class: "exit__body", text: link.body }) : null,
      ])
    )
  );

  $("result").hidden = false;
  $("next").hidden = false;
  announce("確認が終わりました。結果を下に出しています。");

  if (focus) {
    const section = $("result");
    section.focus({ preventScroll: true });
    section.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
  }
}

function renderFooter() {
  const f = config.footer;
  const parts = [el("a", { href: f.credit.href, text: f.credit.label })];
  for (const l of f.links || []) parts.push(el("a", { href: l.href, text: l.label }));
  if (f.support && f.support.length) {
    parts.push(
      el("span", { class: "site-footer__support" }, [
        `${f.supportLabel}：`,
        ...f.support.flatMap((s, i) => [i ? " / " : "", el("a", { href: s.href, text: s.label })]),
      ])
    );
  }
  $("footer").replaceChildren(...parts);
}

/* ---------------- ファイルの受け取り ---------------- */

function wirePicker(pickerId, inputId, handler) {
  const picker = $(pickerId);
  const input = $(inputId);
  const drop = picker.querySelector(".picker__drop");

  input.addEventListener("change", () => {
    const file = input.files && input.files[0];
    // 空に戻しておくと、書き出し直した同じ名前のファイルを選んだときも読み直せる
    input.value = "";
    if (file) handler(file);
  });

  drop.addEventListener("dragover", (e) => {
    e.preventDefault();
    picker.classList.add("is-dragover");
  });
  drop.addEventListener("dragleave", () => picker.classList.remove("is-dragover"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    picker.classList.remove("is-dragover");
    const file = e.dataTransfer && e.dataTransfer.files[0];
    if (file) handler(file);
  });
}

// 枠の外に落としたファイルを、ブラウザが開いてしまわないようにする
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());

renderRecordInfo($("record-info"));
wirePicker("vocal-picker", "vocal-input", onVocal);
wirePicker("inst-picker", "inst-input", onInst);
$("inst-clear").addEventListener("click", clearInst);
renderFooter();
