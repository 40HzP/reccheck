/**
 * 結果と機材の匿名の記録（任意）。
 *
 * 「記録する」を押したときだけ、判定の数値と機材名を送る。音声ファイルは送らない。
 * Turnstile（迷惑送信よけ）の読み込みも、押したときに初めて行う。
 * 押さなければ、このページは外部と一切通信しない。
 */
import config from "../config.js";
import { fill } from "./judge.js";
import { store } from "./store.js";

const R = config.record;
const TURNSTILE_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

export function recordEnabled() {
  return Boolean(R && R.turnstileSiteKey);
}

/**
 * 送る中身を作る。列の定義（config.record.columns）に無いものは入れない。
 * @param {{measures: object, stages: object, gear: object, gearChanged: string|null, browserId: string, appVersion: string}} p
 */
export function buildRecord({ measures, stages, gear, gearChanged, browserId, appVersion }) {
  const source = {
    ...measures,
    ...gear,
    results: stages,
    gear_changed: gearChanged,
    browser_id: browserId,
    app_version: appVersion,
  };
  const out = {};
  for (const c of R.columns) {
    if (c.server) continue;
    out[c.name] = source[c.name] === undefined ? null : source[c.name];
  }
  return out;
}

/* ---------------- Turnstile ---------------- */

let turnstileLoading = null;
function loadTurnstile() {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (!turnstileLoading) {
    turnstileLoading = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = TURNSTILE_SRC;
      s.async = true;
      s.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error("turnstile")));
      s.onerror = () => {
        turnstileLoading = null;
        s.remove();
        reject(new Error("turnstile"));
      };
      document.head.append(s);
    });
  }
  return turnstileLoading;
}

/** 確認を1回だけ行ってトークンを返す。人の操作が要るときだけ枠が出る */
async function getToken(container, action) {
  const turnstile = await loadTurnstile();
  return new Promise((resolve, reject) => {
    let widgetId = null;
    const finish = (fn, value) => {
      clearTimeout(timer);
      try {
        if (widgetId != null) turnstile.remove(widgetId);
      } catch {
        /* 消せなくても次の render で作り直す */
      }
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error("turnstile timeout")), 120000);
    widgetId = turnstile.render(container, {
      sitekey: R.turnstileSiteKey,
      action,
      language: "ja",
      theme: "light",
      appearance: "interaction-only",
      callback: (token) => finish(resolve, token),
      "error-callback": () => finish(reject, new Error("turnstile error")),
      "expired-callback": () => finish(reject, new Error("turnstile expired")),
      "timeout-callback": () => finish(reject, new Error("turnstile timeout")),
    });
  });
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { ok: res.ok && data && data.ok === true, data };
}

/* ---------------- 画面 ---------------- */

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

const columnMax = (name) => (R.columns.find((c) => c.name === name) || {}).max || 60;

/** ページ下部の「記録する内容」。列の定義の label から作る */
export function renderRecordInfo(section) {
  if (!recordEnabled()) {
    section.hidden = true;
    return;
  }
  section.replaceChildren(
    el("h2", { class: "h2", id: "record-info-heading", text: R.listHeading }),
    el("p", { class: "prose record-info__lead", text: R.listLead }),
    el(
      "ul",
      { class: "notes" },
      R.columns.map((c) => el("li", {}, [el("span", { text: c.label })]))
    ),
    el("p", { class: "prose record-info__lead", text: R.notRecordedLead }),
    el(
      "ul",
      { class: "notes notes--no" },
      R.notRecorded.map((t) => el("li", {}, [el("span", { text: t })]))
    )
  );
  section.hidden = false;
}

/**
 * 結果の下の記録の欄を作る。
 * @param {HTMLElement} section
 * @param {{getCurrent: () => {measures: object, stages: object}, hasPrevious: boolean, appVersion: string}} opts
 */
export function renderRecordForm(section, { getCurrent, hasPrevious, appVersion }) {
  if (!recordEnabled()) {
    section.hidden = true;
    return;
  }

  const savedGear = store.loadGear();
  const fields = R.gear.map((g) => {
    const id = `gear-${g.column}`;
    const input = el("input", {
      id,
      name: g.column,
      type: "text",
      maxlength: String(columnMax(g.column)),
      autocomplete: "off",
      enterkeyhint: "next",
    });
    input.value = typeof savedGear[g.column] === "string" ? savedGear[g.column] : "";
    return { column: g.column, input, node: el("div", { class: "field" }, [el("label", { for: id, text: g.label }), input]) };
  });

  let changed = null;
  const changedGroup = hasPrevious
    ? el("fieldset", { class: "choice" }, [
        el("legend", { text: R.changedQuestion }),
        el(
          "div",
          { class: "choice__options" },
          R.changedOptions.map((o) => {
            const radio = el("input", { type: "radio", name: "gear_changed", value: o.value, id: `changed-${o.value}` });
            radio.addEventListener("change", () => {
              changed = o.value;
            });
            return el("label", { class: "choice__option", for: `changed-${o.value}` }, [radio, el("span", { text: o.label })]);
          })
        ),
      ])
    : null;

  const widget = el("div", { class: "record__widget" });
  const submit = el("button", { type: "submit", class: "btn btn--solid record__submit", text: R.submitLabel });
  const status = el("p", { class: "record__status", role: "status", "aria-live": "polite" });
  const form = el("form", { class: "record__form", novalidate: true }, [
    el("fieldset", { class: "gear" }, [
      el("legend", { class: "visually-hidden", text: "機材" }),
      el("div", { class: "gear__fields" }, fields.map((f) => f.node)),
      el("p", { class: "field__help", text: R.gearHelp }),
    ]),
    changedGroup,
    widget,
    submit,
    status,
  ]);

  const deleteBox = renderDelete();

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (submit.disabled) return;
    submit.disabled = true;
    status.dataset.state = "";
    const gear = Object.fromEntries(fields.map((f) => [f.column, f.input.value.trim().slice(0, columnMax(f.column))]));
    status.textContent = R.messages.checking;
    let token;
    try {
      token = await getToken(widget, "record");
    } catch {
      status.textContent = R.messages.turnstile;
      status.dataset.state = "error";
      submit.disabled = false;
      return;
    }
    status.textContent = R.messages.sending;
    const current = getCurrent();
    const record = buildRecord({
      measures: current.measures,
      stages: current.stages,
      gear,
      gearChanged: hasPrevious ? changed || "unanswered" : null,
      browserId: store.browserId(),
      appVersion,
    });
    try {
      const { ok } = await postJson(R.endpoint, { token, record });
      if (!ok) throw new Error("rejected");
      store.markRecorded();
      store.saveGear(gear);
      status.textContent = R.messages.sent;
      status.dataset.state = "done";
      for (const f of fields) f.input.disabled = true;
      deleteBox.refresh();
    } catch {
      status.textContent = R.messages.failed;
      status.dataset.state = "error";
      submit.disabled = false;
    }
  });

  section.replaceChildren(
    el("h2", { class: "h2", id: "record-heading", text: R.heading }),
    el("p", { class: "record__lead", text: R.lead }),
    form,
    deleteBox.node
  );
  section.hidden = false;
}

/** 「このブラウザの記録を消す」。このブラウザから記録したことがあるときだけ出す */
function renderDelete() {
  const widget = el("div", { class: "record__widget" });
  const button = el("button", { type: "button", class: "linkbtn", text: R.deleteLabel });
  const status = el("p", { class: "record__status", role: "status", "aria-live": "polite" });
  const node = el("div", { class: "record__delete" }, [widget, button, status]);

  const refresh = () => {
    button.hidden = !store.hasRecorded();
  };
  refresh();

  button.addEventListener("click", async () => {
    if (!window.confirm(R.deleteConfirm)) return;
    const browserId = store.existingBrowserId();
    if (!browserId) return;
    button.disabled = true;
    status.dataset.state = "";
    status.textContent = R.messages.checking;
    let token;
    try {
      token = await getToken(widget, "delete");
    } catch {
      status.textContent = R.messages.turnstile;
      status.dataset.state = "error";
      button.disabled = false;
      return;
    }
    status.textContent = R.messages.deleting;
    try {
      const { ok, data } = await postJson(R.deleteEndpoint, { token, browser_id: browserId });
      if (!ok) throw new Error("rejected");
      store.clearAll();
      status.textContent = fill(R.messages.deleted, { count: data.deleted });
      status.dataset.state = "done";
      button.hidden = true;
    } catch {
      status.textContent = R.messages.deleteFailed;
      status.dataset.state = "error";
    }
    button.disabled = false;
  });

  return { node, refresh };
}
