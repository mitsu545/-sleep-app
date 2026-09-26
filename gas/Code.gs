// ショートカットから届いた睡眠データを「睡眠日別」シートに1日1行で反映する受付係
const SHEET_NAME = "睡眠日別";
const TZ = "Asia/Tokyo";

// ブラウザで開いたときの動作確認用
function doGet() {
  return out("OK: 受付係は動いています");
}

function doPost(e) {
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

const round1 = x => Math.round(x * 10) / 10;
const out = msg => ContentService.createTextOutput(msg);
