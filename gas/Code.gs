// 睡眠アプリの GAS（Apps Script に貼るコードの控え。本番は Apps Script のエディタ側）
//  ・受付係：iPhone ショートカット「睡眠送る」から届いた睡眠データを「睡眠日別」に 1 日 1 行で反映する
//  ・統合係：元データを読んで「統合」タブ（1 行＝1 日）を毎回まるごと作り直す
//  ・アプリの窓口：アプリ（index.html）からの読み書き
// 更新は「デプロイを管理」から新バージョンで行う（「新しいデプロイ」は URL が変わるので使わない）
const SHEET_NAME = "睡眠日別";
const TZ = "Asia/Tokyo";

// 読むだけの元データ（別のスプシ）。書き換えない
const SRC = {
  temp: { id: "1j2KEg2Zt-DYyGMRcyaLYu-wyJa5uihp_LI3zjFw74M4", sheet: "温湿度ログ", device: "寝室用" },
  sober: { id: "1UbA41TZLzJPTDOPNTnQPIis1DsPAO3PBQREyEYezzbE", sheet: "バックアップ", label: "データ(JSON)" },
  mindful: { id: "1k2farFGFWyqg0AT_ky4BPs1DlaEL5J_Fjq-yiqJQRe8", sheet: "記録" }
};

// アプリと統合係が書くタブ（このスプシの中。なければ自動で作る）
const TAB = { input: "入力", week: "週の記録", advice: "助言", merged: "統合", dict: "項目の説明" };
const DEFAULT_ITEMS = ["耳栓", "アイマスク", "エアコン", "サプリ"];

// 「項目の説明」タブの初期値（AI に渡す取扱説明書）
const DICT = [
  ["日付", "朝起きた日（日本時間）。前夜の睡眠はこの日付の行"],
  ["曜日・週", "週は ISO 週（月曜始まり）。例 2026-W39"],
  ["就床時刻・起床時刻", "布団に入った時刻と出た時刻（Sleep Meister）"],
  ["在床時間_分", "布団にいた時間"],
  ["睡眠時間_分", "眠っていた時間"],
  ["睡眠効率_%", "睡眠時間 ÷ 在床時間。高いほど寝つきがよく、途中で起きていない"],
  ["中途覚醒_回", "夜中に目が覚めた回数（本人が朝に入力）"],
  ["自己評価_1to5", "寝起きの気分。本人の体感で、5 が最高"],
  ["寝室平均温度_℃・寝室平均湿度_%", "寝室のセンサーの、就床〜起床の間の平均"],
  ["前夜の飲酒_1or0", "1＝前日に飲酒、0＝休肝日、空欄＝記録なし"],
  ["前日の瞑想_分", "前日に瞑想した合計時間。0＝しなかった、空欄＝記録を始める前"],
  ["当日の気分_平均", "その日に記録した気分（1〜5、5 が最高）の平均。瞑想直後の記録は除く。空欄＝記録なし"],
  ["〇〇_1or0（耳栓など）", "昨夜それを使ったか。1＝使った、0＝使っていない、空欄＝未入力"],
  ["今週の取り組み", "その週に試していること"],
  ["要確認", "記録ミスの可能性がある行。分析では注意する"]
];

// ブラウザで開いたときの動作確認用
function doGet() {
  return out("OK: 受付係は動いています");
}

// 本文が「{」で始まればアプリから、それ以外は iPhone ショートカット（受付係）から
function doPost(e) {
  const body = e && e.postData ? String(e.postData.contents || "") : "";
  if (body.trim().charAt(0) === "{") return appApi(body);
  return receiveSleep(e);
}

// ==== 受付係（ショートカット用。中身は今までと同じ） ====

function receiveSleep(e) {
  try {
    // 「###」で3つ（開始日 / 終了日 / 値）に分けて、1行ずつのリストにする
    const parts = e.postData.contents.split("###")
      .map(p => p.split(/\r?\n/).map(s => s.trim()).filter(s => s));
    const [starts, ends, values] = parts;
    if (!starts || !ends || !values ||
        starts.length !== ends.length || starts.length !== values.length) {
      return out("NG: データの形が違います 件数=" + parts.map(p => p.length).join("/"));
    }

    // 起床日ごとに「布団にいた時間」と「眠っていた時間」を集計する
    const nights = {};
    starts.forEach((s, i) => {
      const start = parseDate(s), end = parseDate(ends[i]);
      if (!start || !end) return;
      const kind = classify(values[i]);
      if (kind === "awake") return;
      const key = Utilities.formatDate(end, TZ, "yyyy-MM-dd");
      const n = nights[key] || (nights[key] = { bedStart: null, bedEnd: null, sleepMin: 0 });
      if (kind === "inbed") {
        if (!n.bedStart || start < n.bedStart) n.bedStart = start;
        if (!n.bedEnd || end > n.bedEnd) n.bedEnd = end;
      } else {
        n.sleepMin += (end - start) / 60000;
      }
    });

    const keys = Object.keys(nights);
    keys.forEach(k => upsert(k, nights[k]));
    return out("OK: " + keys.length + "日分を更新 " + keys.join(", "));
  } catch (err) {
    return out("NG: " + err.message);
  }
}

// 「2026-09-25T07:17:03+09:00」などを日本時間として読む
function parseDate(s) {
  const m = s.match(/(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const p = n => String(n).padStart(2, "0");
  return new Date(`${m[1]}-${p(m[2])}-${p(m[3])}T${p(m[4])}:${m[5]}:${m[6] || "00"}+09:00`);
}

// 睡眠の「値」を 布団にいた / 起きていた / 眠っていた に分類する
function classify(v) {
  if (/ベッド|in ?bed|^0$/i.test(v)) return "inbed";
  if (/覚醒|awake|^2$/i.test(v)) return "awake";
  return "asleep";
}

// 同じ起床日の行があれば上書き、なければ追加（何回送っても重複しない）
function upsert(key, n) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SHEET_NAME) || ss.getSheets()[0].setName(SHEET_NAME);
  const bedMin = n.bedStart ? (n.bedEnd - n.bedStart) / 60000 : 0;
  const row = [
    key,
    n.bedStart ? Utilities.formatDate(n.bedStart, TZ, "HH:mm") : "",
    n.bedEnd ? Utilities.formatDate(n.bedEnd, TZ, "HH:mm") : "",
    bedMin ? round1(bedMin) : "",
    round1(n.sleepMin),
    bedMin ? round1(n.sleepMin / bedMin * 100) : ""
  ];
  const sheetTz = ss.getSpreadsheetTimeZone();
  const dates = sh.getRange(1, 1, sh.getLastRow(), 1).getValues().flat()
    .map(d => d instanceof Date ? Utilities.formatDate(d, sheetTz, "yyyy-MM-dd") : String(d));
  const idx = dates.indexOf(key);
  if (idx >= 0) sh.getRange(idx + 1, 1, 1, row.length).setValues([row]);
  else sh.appendRow(row);
}

// ==== 最初に 1 回だけ・毎朝のトリガー ====

// 最初に 1 回だけ、Apps Script のエディタから実行する：タブを作る → 統合を作る → 毎朝 9 時台のトリガーを登録
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const warnings = rebuild(ss);
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === "dailyRebuild")
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("dailyRebuild").timeBased().everyDays(1).atHour(9).inTimezone(TZ).create();
  console.log("セットアップ完了：統合タブ " + (ss.getSheetByName(TAB.merged).getLastRow() - 1) + " 行" +
    (warnings.length ? " ／ 注意：" + warnings.join(" ／ ") : ""));
}

// 毎朝 9 時台に動く（setup が登録する）
function dailyRebuild() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    rebuild(SpreadsheetApp.getActiveSpreadsheet());
  } finally {
    lock.releaseLock();
  }
}

// ==== アプリの窓口 ====

function appApi(body) {
  try {
    const req = JSON.parse(body);
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let warnings = [];
    const lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      ensureSheets(ss);
      if (req.action === "saveInput") {
        saveInput(ss, req);
        warnings = rebuild(ss);
      } else if (req.action === "saveWeek") {
        saveWeek(ss, req);
        warnings = rebuild(ss);
      } else if (req.action === "saveAdvice") {
        saveAdvice(ss, req);
      } else if (req.action === "load") {
        if (isStale(ss)) warnings = rebuild(ss);
      } else {
        throw new Error("知らない操作です：" + req.action);
      }
    } finally {
      lock.releaseLock();
    }
    return json(Object.assign({ ok: true }, payload(ss, warnings)));
  } catch (err) {
    return json({ ok: false, error: err.message });
  }
}

// アプリに返す中身（1 回の通信で全画面ぶん）
function payload(ss, warnings) {
  const today = Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd");
  const merged = readTable(ss.getSheetByName(TAB.merged));
  const inp = readInput(ss);
  const weeks = readTable(ss.getSheetByName(TAB.week)).rows
    .map(r => ({ week: String(r[0]), start: toDateKey(r[1]) || "", text: String(r[2]) }))
    .sort((a, b) => (a.week < b.week ? 1 : -1))
    .slice(0, 12);
  const advices = readTable(ss.getSheetByName(TAB.advice)).rows
    .map(r => ({ at: String(r[0]), week: String(r[1]), text: String(r[2]) }))
    .reverse()
    .slice(0, 20);
  const dict = readTable(ss.getSheetByName(TAB.dict)).rows.map(r => [String(r[0]), String(r[1])]);
  return {
    today, thisWeek: isoWeek(today), thisWeekStart: weekStart(today),
    header: merged.header, rows: merged.rows.slice(-35),
    items: inp.items, input: inp.byDate[today] || null,
    weeks, advices, dict, warnings: warnings || []
  };
}

// 今朝の入力を保存（同じ日付は上書き）。新しいチェック項目は列を足す
function saveInput(ss, req) {
  const date = checkDate(req.date);
  const wakeups = optionalInt(req.wakeups, 0, 50, "夜中に目が覚めた回数");
  const rating = optionalInt(req.rating, 1, 5, "寝起きの気分");
  const checks = req.checks && typeof req.checks === "object" ? req.checks : {};
  const sh = ss.getSheetByName(TAB.input);
  const header = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  const added = Object.keys(checks).filter(name => header.indexOf(name + "_1or0") < 0);
  added.forEach(checkItemName);
  added.forEach(name => {
    header.push(name + "_1or0");
    sh.getRange(1, header.length).setValue(name + "_1or0").setFontWeight("bold");
  });
  const row = header.map((h, i) => {
    if (i === 0) return date;
    if (h === "中途覚醒_回") return wakeups;
    if (h === "自己評価_1to5") return rating;
    if (h === "更新日時") return nowText();
    const m = h.match(/^(.+)_1or0$/);
    return m ? (checks[m[1]] ? 1 : 0) : "";
  });
  upsertRow(sh, date, row);
}

// 今週の取り組みを保存（同じ週は上書き）
function saveWeek(ss, req) {
  if (!/^\d{4}-W\d{2}$/.test(String(req.week))) throw new Error("週の形が違います");
  const start = checkDate(req.start);
  const text = String(req.text || "").trim();
  if (text.length > 500) throw new Error("今週の取り組みは 500 文字以内にしてください");
  upsertRow(ss.getSheetByName(TAB.week), req.week, [req.week, start, text, nowText()]);
}

// AI の助言を追加
function saveAdvice(ss, req) {
  if (!/^\d{4}-W\d{2}$/.test(String(req.week))) throw new Error("週の形が違います");
  const text = String(req.text || "").trim();
  if (!text) throw new Error("助言が空です");
  if (text.length > 3000) throw new Error("助言は 3000 文字以内にしてください");
  const sh = ss.getSheetByName(TAB.advice);
  const r = sh.getLastRow() + 1;
  sh.getRange(r, 1, 1, 2).setNumberFormat("@");
  sh.getRange(r, 1, 1, 3).setValues([[nowText(), req.week, text]]);
}

// ==== 統合係 ====

// 統合タブが古いか（睡眠日別の最新日が、統合の最終行より新しい）
function isStale(ss) {
  const m = ss.getSheetByName(TAB.merged);
  if (!m || m.getLastRow() < 2) return true;
  const last = toDateKey(m.getRange(m.getLastRow(), 1).getValue());
  const s = ss.getSheetByName(SHEET_NAME);
  if (!s || s.getLastRow() < 1) return false;
  const latest = s.getRange(1, 1, s.getLastRow(), 1).getValues()
    .map(r => toDateKey(r[0], ss.getSpreadsheetTimeZone())).filter(Boolean).sort().pop();
  return !!latest && (!last || latest > last);
}

// 統合タブをまるごと作り直す。読めなかった元データは空欄にして、注意書きを返す
function rebuild(ss) {
  ensureSheets(ss);
  const warnings = [];
  const safe = (label, fn, fallback) => {
    try { return fn(); } catch (e) { warnings.push(label + "を読めませんでした（" + e.message + "）"); return fallback; }
  };
  const sheetTz = ss.getSpreadsheetTimeZone();

  const sleep = {};
  ss.getSheetByName(SHEET_NAME).getDataRange().getValues().forEach(r => {
    const k = toDateKey(r[0], sheetTz);
    if (!k) return;
    sleep[k] = { bed: toTime(r[1], sheetTz), wake: toTime(r[2], sheetTz), inbed: num(r[3]), sleep: num(r[4]), eff: num(r[5]) };
  });
  const inp = readInput(ss);
  const weeks = {};
  readTable(ss.getSheetByName(TAB.week)).rows.forEach(r => { weeks[String(r[0])] = String(r[2]); });
  const temps = safe("温湿度ログ", readTemps, {});
  const drink = safe("禁酒アプリ_db", readDrink, {});
  const mind = safe("マインドフルネスの記録", readMindful, { start: null, minutes: {}, mood: {} });

  const keys = Object.keys(sleep).concat(Object.keys(inp.byDate))
    .filter((k, i, a) => a.indexOf(k) === i).sort();
  const header = ["日付", "曜日", "週", "就床時刻", "起床時刻", "在床時間_分", "睡眠時間_分", "睡眠効率_%",
    "中途覚醒_回", "自己評価_1to5", "寝室平均温度_℃", "寝室平均湿度_%", "前夜の飲酒_1or0", "前日の瞑想_分", "当日の気分_平均"]
    .concat(inp.items.map(n => n + "_1or0"), ["今週の取り組み", "要確認"]);
  const rows = keys.map(k => {
    const s = sleep[k] || {};
    const i = inp.byDate[k];
    const prev = addDays(k, -1);
    const room = roomAverage(temps, k, s.bed, s.wake);
    const d = drink[prev];
    return [
      k, weekday(k), isoWeek(k), s.bed || "", s.wake || "",
      blank(s.inbed), blank(s.sleep), blank(s.eff),
      i ? blank(i.wakeups) : "", i ? blank(i.rating) : "",
      room.temp, room.hum,
      d === "drank" ? 1 : d === "sober" ? 0 : "",
      mind.start && prev >= mind.start ? (mind.minutes[prev] || 0) : "",
      mind.mood[k] ? round1(mind.mood[k].reduce((a, b) => a + b, 0) / mind.mood[k].length) : ""
    ].concat(
      inp.items.map(n => (i ? blank(i.checks[n]) : "")),
      [weeks[isoWeek(k)] || "", flags(sleep[k])]
    );
  });

  const sh = ss.getSheetByName(TAB.merged) || ss.insertSheet(TAB.merged);
  sh.clear();
  const all = [header].concat(rows);
  [1, 2, 3, 4, 5, header.length - 1, header.length]
    .forEach(c => sh.getRange(1, c, all.length, 1).setNumberFormat("@"));
  sh.getRange(1, 1, all.length, header.length).setValues(all);
  sh.getRange(1, 1, 1, header.length).setFontWeight("bold");
  sh.setFrozenRows(1);
  return warnings;
}

// 寝室用センサーの記録を日付（日本時間）ごとにまとめる
function readTemps() {
  const sh = SpreadsheetApp.openById(SRC.temp.id).getSheetByName(SRC.temp.sheet);
  if (!sh) throw new Error("タブ「" + SRC.temp.sheet + "」がありません");
  const byDate = {};
  sh.getDataRange().getValues().forEach(r => {
    if (String(r[1]).trim() !== SRC.temp.device) return;
    const t = r[0] instanceof Date ? r[0] : parseDate(String(r[0]));
    if (!t) return;
    const temp = parseFloat(r[2]), hum = parseFloat(r[3]);
    const k = Utilities.formatDate(t, TZ, "yyyy-MM-dd");
    (byDate[k] = byDate[k] || []).push({ t: t.getTime(), temp: isNaN(temp) ? null : temp, hum: isNaN(hum) ? null : hum });
  });
  return byDate;
}

// 就床〜起床の間の平均（記録がなければ空欄）
function roomAverage(temps, k, bed, wake) {
  const none = { temp: "", hum: "" };
  if (!bed || !wake) return none;
  const end = parseDate(k + " " + wake);
  let start = parseDate(k + " " + bed);
  if (!start || !end) return none;
  if (start >= end) start = new Date(start.getTime() - 86400000);
  const list = (temps[addDays(k, -1)] || []).concat(temps[k] || [])
    .filter(x => x.t >= start.getTime() && x.t <= end.getTime());
  const mean = key => {
    const v = list.map(x => x[key]).filter(x => x !== null);
    return v.length ? round1(v.reduce((a, b) => a + b, 0) / v.length) : "";
  };
  return { temp: mean("temp"), hum: mean("hum") };
}

// 禁酒アプリの記録（{"2026-09-25": "drank", ...}）
function readDrink() {
  const sh = SpreadsheetApp.openById(SRC.sober.id).getSheetByName(SRC.sober.sheet);
  if (!sh) throw new Error("タブ「" + SRC.sober.sheet + "」がありません");
  const row = sh.getDataRange().getValues().find(r => String(r[0]).trim() === SRC.sober.label);
  if (!row || !row[1]) throw new Error("「" + SRC.sober.label + "」の行がありません");
  return JSON.parse(String(row[1])).log || {};
}

// マインドフルネスの記録：日付ごとの瞑想時間と、気分（quick と pre。瞑想直後の post は除く）
function readMindful() {
  const sh = SpreadsheetApp.openById(SRC.mindful.id).getSheetByName(SRC.mindful.sheet);
  if (!sh) throw new Error("タブ「" + SRC.mindful.sheet + "」がありません");
  const values = sh.getDataRange().getValues();
  const head = values.shift().map(h => String(h).trim());
  const c = { t: head.indexOf("timestamp"), type: head.indexOf("type"), score: head.indexOf("score"),
    sid: head.indexOf("session_id"), dur: head.indexOf("duration_min") };
  if (c.t < 0) throw new Error("timestamp の列がありません");
  const res = { start: null, minutes: {}, mood: {} };
  const sessions = {};
  values.forEach(r => {
    const t = r[c.t] instanceof Date ? r[c.t] : new Date(String(r[c.t]));
    if (isNaN(t.getTime())) return;
    const k = Utilities.formatDate(t, TZ, "yyyy-MM-dd");
    if (!res.start || k < res.start) res.start = k;
    const type = String(r[c.type]).trim();
    const score = num(r[c.score]);
    if ((type === "quick" || type === "pre") && score !== null) (res.mood[k] = res.mood[k] || []).push(score);
    const sid = c.sid >= 0 ? String(r[c.sid]).trim() : "";
    const dur = c.dur >= 0 ? num(r[c.dur]) : null;
    if (sid && dur !== null && !sessions[sid]) sessions[sid] = { k, dur };
  });
  Object.keys(sessions).forEach(id => {
    const s = sessions[id];
    res.minutes[s.k] = (res.minutes[s.k] || 0) + s.dur;
  });
  return res;
}

// 「要確認」の印
function flags(s) {
  if (!s) return "睡眠データなし";
  const f = [];
  if (s.inbed === null) f.push("在床時間なし");
  else if (s.inbed > 960) f.push("在床が長すぎる");
  if (s.eff !== null && s.eff > 100) f.push("効率が100%超");
  if (s.sleep === 0) f.push("睡眠時間0分");
  return f.join("・");
}

// ==== タブの読み書き ====

function ensureSheets(ss) {
  const make = (name, header, textCols) => {
    let sh = ss.getSheetByName(name);
    if (sh) return null;
    sh = ss.insertSheet(name);
    textCols.forEach(c => sh.getRange(1, c, sh.getMaxRows(), 1).setNumberFormat("@"));
    sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight("bold");
    sh.setFrozenRows(1);
    return sh;
  };
  make(TAB.input, ["日付", "中途覚醒_回", "自己評価_1to5", "更新日時"].concat(DEFAULT_ITEMS.map(k => k + "_1or0")), [1, 4]);
  make(TAB.week, ["週", "週の開始日（月曜）", "今週の取り組み", "更新日時"], [1, 2, 4]);
  make(TAB.advice, ["貼り付け日時", "対象の週", "助言"], [1, 2]);
  const dict = make(TAB.dict, ["列名", "説明"], []);
  if (dict) dict.getRange(2, 1, DICT.length, 2).setValues(DICT);
}

// 入力タブ：{ items: ["耳栓", ...], byDate: { "2026-09-27": { wakeups, rating, checks: { 耳栓: 1 } } } }
function readInput(ss) {
  const t = readTable(ss.getSheetByName(TAB.input));
  const items = t.header.filter(h => /_1or0$/.test(h)).map(h => h.replace(/_1or0$/, ""));
  const col = name => t.header.indexOf(name);
  const byDate = {};
  t.rows.forEach(r => {
    const k = toDateKey(r[0]);
    if (!k) return;
    const checks = {};
    items.forEach(n => { checks[n] = num(r[col(n + "_1or0")]); });
    byDate[k] = { wakeups: num(r[col("中途覚醒_回")]), rating: num(r[col("自己評価_1to5")]), checks };
  });
  return { items, byDate };
}

// タブ全体を { header, rows } で読む（日付型は文字に直す）
function readTable(sh) {
  if (!sh || sh.getLastRow() < 1) return { header: [], rows: [] };
  const tz = sh.getParent().getSpreadsheetTimeZone();
  const values = sh.getDataRange().getValues();
  const header = values.shift().map(h => String(h).trim());
  const rows = values
    .filter(r => r.some(v => v !== ""))
    .map(r => r.map(v => (v instanceof Date ? Utilities.formatDate(v, tz, "yyyy-MM-dd HH:mm").replace(/ 00:00$/, "") : v)));
  return { header, rows };
}

// 1 列目が key の行を上書き、なければ末尾に追加
function upsertRow(sh, key, row) {
  const last = sh.getLastRow();
  const keys = last > 1 ? sh.getRange(2, 1, last - 1, 1).getValues().map(r => toDateKey(r[0]) || String(r[0]).trim()) : [];
  const idx = keys.indexOf(key);
  const r = idx >= 0 ? idx + 2 : last + 1;
  sh.getRange(r, 1).setNumberFormat("@");
  sh.getRange(r, 1, 1, row.length).setValues([row]);
}

// ==== 小さな道具 ====

// 日付型・「2026/9/25」・「2026-09-25」などを「2026-09-25」にそろえる（日付でなければ null）
function toDateKey(v, tz) {
  if (v instanceof Date) return Utilities.formatDate(v, tz || TZ, "yyyy-MM-dd");
  const m = String(v).match(/^\s*(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
  return m ? m[1] + "-" + ("0" + m[2]).slice(-2) + "-" + ("0" + m[3]).slice(-2) : null;
}

// 時刻型・「0:19」などを「00:19」にそろえる
function toTime(v, tz) {
  if (v instanceof Date) return Utilities.formatDate(v, tz || TZ, "HH:mm");
  const m = String(v).match(/(\d{1,2}):(\d{2})/);
  return m ? ("0" + m[1]).slice(-2) + ":" + m[2] : "";
}

function num(v) {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

function checkDate(v) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) throw new Error("日付の形が違います");
  return String(v);
}

function optionalInt(v, min, max, label) {
  if (v === null || v === undefined || v === "") return "";
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(label + "は " + min + "〜" + max + " の整数にしてください");
  return n;
}

function checkItemName(name) {
  if (typeof name !== "string" || name !== name.trim() || name.length < 1 || name.length > 10 || /[,"\r\n]/.test(name)) {
    throw new Error("項目名は 1〜10 文字で、カンマや改行を入れないでください：" + name);
  }
}

function addDays(k, n) {
  const p = k.split("-").map(Number);
  return new Date(Date.UTC(p[0], p[1] - 1, p[2] + n)).toISOString().slice(0, 10);
}

function weekday(k) {
  const p = k.split("-").map(Number);
  return "日月火水木金土".charAt(new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay());
}

// ISO 週（月曜始まり）。例 2026-09-27 → 2026-W39
function isoWeek(k) {
  const p = k.split("-").map(Number);
  const t = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const y0 = Date.UTC(t.getUTCFullYear(), 0, 1);
  return t.getUTCFullYear() + "-W" + ("0" + Math.ceil(((t - y0) / 86400000 + 1) / 7)).slice(-2);
}

// その週の月曜日
function weekStart(k) {
  const p = k.split("-").map(Number);
  return addDays(k, 1 - (new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay() || 7));
}

const nowText = () => Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd HH:mm");
const blank = v => (v === null || v === undefined ? "" : v);
const json = obj => ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
const round1 = x => Math.round(x * 10) / 10;
const out = msg => ContentService.createTextOutput(msg);
