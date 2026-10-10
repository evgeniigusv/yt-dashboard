/* YouTube-пульт: decrypts data/<slug>.enc (written by collector/collect.py) and renders the dashboard. */
"use strict";

const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const DEMO = new URLSearchParams(location.search).has("demo");
const BASE = DEMO ? "demo/" : "data/";
const PW_KEY = "ytdash.pw";
const S = { index: null, ch: {}, view: null, tab: null, period: 28, charts: [], vfilter: "all", vsort: ["published", -1], calMonth: null };

// ---------------------------------------------------------------- storage (per-device conveniences only)
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

// ---------------------------------------------------------------- crypto (mirror of collector/crypto.py)
async function decrypt(text, pw) {
  const env = JSON.parse(text);
  const b = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey({ name: "PBKDF2", salt: b(env.salt), iterations: env.iter, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b(env.iv) }, key, b(env.ct));
  const stream = new Blob([plain]).stream().pipeThrough(new DecompressionStream("gzip"));
  return JSON.parse(await new Response(stream).text());
}

async function fetchText(path) {
  const r = await fetch(BASE + path + "?t=" + Date.now(), { cache: "no-store" });
  if (!r.ok) throw new Error(r.status);
  return r.text();
}

// ---------------------------------------------------------------- formatting
const nf = new Intl.NumberFormat("ru-RU");
function fmt(n, d = 0) {
  if (n == null || !isFinite(n)) return "—";
  const a = Math.abs(n);
  if (a >= 1e6) return (n / 1e6).toLocaleString("ru-RU", { maximumFractionDigits: 1 }) + " млн";
  if (a >= 1e4) return (n / 1e3).toLocaleString("ru-RU", { maximumFractionDigits: 1 }) + " тыс.";
  return n.toLocaleString("ru-RU", { maximumFractionDigits: d });
}
const pct = (n, d = 1) => (n == null || !isFinite(n) ? "—" : n.toLocaleString("ru-RU", { maximumFractionDigits: d, minimumFractionDigits: n < 10 && d ? 1 : 0 }) + "%");
const money = n => (n == null || !isFinite(n) ? "—" : "$" + n.toLocaleString("ru-RU", { maximumFractionDigits: n < 100 ? 2 : 0 }));
function dur(sec) {
  if (sec == null || !isFinite(sec)) return "—";
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}
const hours = min => (min == null ? null : min / 60);
const dayStr = d => d.toISOString().slice(0, 10);
const addDays = (s, n) => { const d = new Date(s + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return dayStr(d); };
const daysBetween = (a, b) => Math.round((new Date(b + "T00:00:00Z") - new Date(a + "T00:00:00Z")) / 864e5);
const fmtDate = (iso, withTime = true) => {
  const d = new Date(iso);
  return d.toLocaleString("ru-RU", withTime ? { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" } : { day: "numeric", month: "short" });
};
function delta(cur, prev, invert = false) {
  if (cur == null || prev == null || !prev) return `<span class="muted">нет базы для сравнения</span>`;
  const ch = (cur - prev) / Math.abs(prev) * 100;
  if (Math.abs(ch) < 0.5) return `<span class="delta flat">≈ 0%</span> <span class="muted">к прошлому периоду</span>`;
  const good = invert ? ch < 0 : ch > 0;
  return `<span class="delta ${good ? "up" : "down"}">${ch > 0 ? "↑" : "↓"} ${pct(Math.abs(ch), 0)}</span> <span class="muted">к прошлому периоду</span>`;
}
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

// ---------------------------------------------------------------- dictionaries
const TRAFFIC = {
  YT_SEARCH: "Поиск YouTube", RELATED_VIDEO: "Рекомендации (рядом с видео)", SUBSCRIBER: "Главная и лента подписок",
  SHORTS: "Лента Shorts", EXT_URL: "Внешние сайты", NO_LINK_OTHER: "Прямые / неизвестные", NOTIFICATION: "Уведомления",
  PLAYLIST: "Плейлисты", YT_CHANNEL: "Страница канала", YT_OTHER_PAGE: "Другие страницы YouTube", END_SCREEN: "Конечные заставки",
  HASHTAGS: "Хэштеги", ANNOTATION: "Подсказки", CAMPAIGN_CARD: "Карточки кампаний", ADVERTISING: "Реклама", PROMOTED: "Продвижение",
  SHORTS_CONTENT_LINKS: "Ссылка из Shorts на ролик", SOUND_PAGE: "Страницы звуков", YT_PLAYLIST_PAGE: "Страницы плейлистов",
  NO_LINK_EMBEDDED: "Встроенный плеер", VIDEO_REMIXES: "Ремиксы", LIVE_REDIRECT: "Перенаправление с эфира", PRODUCT_PAGE: "Страницы товаров",
  IMMERSIVE_LIVE: "Лента эфиров",
  // Reporting API numeric codes (reach_combined)
  0: "Прямые / неизвестные", 1: "Реклама", 3: "Главная и лента подписок", 4: "Страница канала", 5: "Поиск YouTube",
  7: "Рекомендации (рядом с видео)", 8: "Другие страницы YouTube", 9: "Внешние сайты", 11: "Карточки и подсказки", 14: "Плейлисты",
  17: "Уведомления", 18: "Страницы плейлистов", 20: "Конечные заставки", 24: "Лента Shorts", 26: "Хэштеги", 27: "Страницы звуков",
  28: "Перенаправление с эфира", 30: "Ремиксы", 32: "Ссылка из Shorts на ролик",
};
const DEVICE = { MOBILE: "Телефон", DESKTOP: "Компьютер", TV: "Телевизор", TABLET: "Планшет", GAME_CONSOLE: "Консоль", UNKNOWN_PLATFORM: "Неизвестно" };
const STATUS = { published: "вышло", scheduled: "в расписании", uploaded: "загружено, приват", ready: "готово, ждёт ОК",
  in_production: "в работе", planned: "в плане", idea: "идея", failed: "ошибка выгрузки" };
const AGE = { "age13-17": "13–17", "age18-24": "18–24", "age25-34": "25–34", "age35-44": "35–44", "age45-54": "45–54", "age55-64": "55–64", "age65-": "65+" };
let regionNames;
try { regionNames = new Intl.DisplayNames(["ru"], { type: "region" }); } catch { regionNames = null; }

// ---------------------------------------------------------------- norms (research/benchmarks-dashboard.md, 04.10.2026)
// [weak below, good from, strong from]; between weak and good = норма. null strong = no "сильно" level.
const NORMS = {
  long: {
    ctr: { t: [3, 6, 10], src: "A/B: у половины каналов 2–10%; <3% почти не продвигается" },
    ret30: { t: [50, 70, 75], src: "B: в среднем теряют ~40% за 30 с; топы держат 75–85%" },
    apv: { t: [30, 40, 50], src: "A/B: среднее 23,7%, образовательные ~42%" },
    like: { t: [1, 3, 5], src: "C/B: 1–3% на engaged-просмотр" },
    comment: { t: [0.05, 0.3, 1], src: "C: 0,05–0,3%" },
    sub: { t: [0.2, 1, 2], src: "B: в среднем 0,22%, образовательные 1–3%" },
  },
  short: {
    stay: { t: [60, 75, 80], src: "B: «остались смотреть» 70% — порог, 80% — вирусный уровень. Здесь — engaged / все просмотры" },
    like: { t: [2, 5, null], src: "B/C: норма 3–5%" },
    sub: { t: [0.1, 0.5, null], src: "B: в среднем 0,17%, кейсы 0,2–0,46%" },
    comment: { t: [0.2, 0.5, 1], src: "C: комментарии + репосты ≥0,5%" },
  },
};
function shortApvNorm(sec) { return sec < 20 ? [90, 120, null] : sec <= 40 ? [80, 100, null] : [70, 90, null]; }
function level(t, v) {
  if (v == null || !isFinite(v)) return "na";
  if (v < t[0]) return "weak";
  if (t[2] != null && v >= t[2]) return "strong";
  if (v >= t[1]) return "good";
  return "norm";
}
const LVL = { weak: "слабо", norm: "норма", good: "хорошо", strong: "сильно", na: "мало данных" };
const badge = l => `<span class="badge b-${l}">${LVL[l]}</span>`;

// ---------------------------------------------------------------- data shaping
function objs(r) {
  if (!r || !r.rows) return [];
  return r.rows.map(row => Object.fromEntries(r.cols.map((c, i) => [c, row[i]])));
}
function daily(ch, key = "all") { return objs(ch.daily && ch.daily[key]); }
function lastDay(ch) {
  const d = daily(ch);
  return d.length ? d[d.length - 1].day : dayStr(new Date());
}
function range(ch, days, offset = 0) {
  const end = addDays(lastDay(ch), -offset * days);
  return [addDays(end, -(days - 1)), end];
}
function sum(rows, k, [from, to]) {
  let s = 0, any = false;
  for (const r of rows) if (r.day >= from && r.day <= to && r[k] != null) { s += r[k]; any = true; }
  return any ? s : null;
}
function totals(ch, key, rg) {
  const rows = daily(ch, key);
  const t = {};
  for (const k of ["views", "engagedViews", "estimatedMinutesWatched", "subscribersGained", "subscribersLost", "likes", "comments", "shares"]) t[k] = sum(rows, k, rg);
  return t;
}
function reachTotals(ch, [from, to], fmtFilter) {
  let impr = 0, clicks = 0, any = false;
  for (const v of Object.values(ch.videos || {})) {
    if (fmtFilter && v.format !== fmtFilter) continue;
    for (const [d, [i, c]] of Object.entries(v.reach || {})) if (d >= from && d <= to) { impr += i; clicks += c; any = true; }
  }
  return any ? { impr, clicks, ctr: impr ? clicks / impr * 100 : null } : null;
}
function revenue(ch, rg) {
  const rows = objs(ch.daily && ch.daily.revenue);
  return rows.length ? { rev: sum(rows, "estimatedRevenue", rg), ad: sum(rows, "estimatedAdRevenue", rg) } : null;
}

const VM = new WeakMap();
function vm(v, ch) {
  if (VM.has(v)) return VM.get(v);
  const a = v.a || {};
  const views = Math.max(v.stats?.viewCount ?? 0, a.views ?? 0);  // live counter; Analytics lags 2–3 days
  const eng = a.engagedViews || null;
  const has = !!a.views;  // no analytics yet (fresh video / API lag): show "мало данных", not zeros
  const per = (x) => (x != null && eng ? x / eng * 100 : null);
  let impr = 0, clicks = 0;
  for (const [i, c] of Object.values(v.reach || {})) { impr += i; clicks += c; }
  let ret30 = null;
  if (v.retention && v.duration > 45) {
    const target = 30 / v.duration;
    let best = null;
    for (const [r, w] of v.retention) if (best == null || Math.abs(r - target) < Math.abs(best[0] - target)) best = [r, w];
    if (best) ret30 = best[1] * 100;
  }
  const pub = (v.published_at || "").slice(0, 10);
  const dd = objs(v.daily);
  const win = n => (dd.length && pub ? sum(dd, "views", [pub, addDays(pub, n - 1)]) : null);
  const age = pub ? daysBetween(pub, lastDay(ch)) : null;
  const m = {
    views, eng, minutes: has ? a.estimatedMinutesWatched : null, avd: has ? a.averageViewDuration : null, apv: has ? a.averageViewPercentage : null,
    like: per(a.likes), comment: per(a.comments != null ? a.comments + (v.format === "short" ? a.shares || 0 : 0) : null),
    sub: per(a.subscribersGained), subs: a.subscribersGained ?? null, likes: Math.max(a.likes ?? 0, v.stats?.likeCount ?? 0) || null,
    comments: Math.max(a.comments ?? 0, v.stats?.commentCount ?? 0) || null, shares: a.shares ?? null, live24: liveDelta(v.vh),
    impr: impr || null, ctr: impr >= 1 ? clicks / impr * 100 : null, ret30,
    stay: eng != null && views ? eng / views * 100 : null,
    d2: win(2), d7: age >= 7 ? win(7) : null, d28: age >= 28 ? win(28) : null, age,
    rev: v.rev?.estimatedRevenue ?? null, pub,
  };
  VM.set(v, m);
  return m;
}
function publicVideos(ch, fmtFilter) {
  return Object.entries(ch.videos || {}).filter(([, v]) => v.privacy === "public" && (!fmtFilter || v.format === fmtFilter))
    .map(([id, v]) => ({ id, v, m: vm(v, ch) }));
}
function median(xs) {
  const a = xs.filter(x => x != null && isFinite(x)).sort((p, q) => p - q);
  if (!a.length) return null;
  const k = Math.floor(a.length / 2);
  return a.length % 2 ? a[k] : (a[k - 1] + a[k]) / 2;
}
function quantile(xs, q) {
  const a = xs.filter(x => x != null && isFinite(x)).sort((p, r) => p - r);
  if (!a.length) return null;
  return a[Math.min(a.length - 1, Math.floor(q * (a.length - 1)))];
}
function outliers(ch) {
  const out = [];
  for (const f of ["long", "short"]) {
    const list = publicVideos(ch, f);
    const med7 = median(list.map(x => x.m.d7)), med2 = median(list.map(x => x.m.d2));
    for (const x of list) {
      if (x.m.d7 != null && med7 && list.length >= 4 && x.m.d7 >= 2 * med7) out.push({ ...x, ratio: x.m.d7 / med7, win: "7 дней" });
      else if (x.m.d7 == null && x.m.d2 != null && med2 && list.length >= 4 && x.m.d2 >= 2 * med2) out.push({ ...x, ratio: x.m.d2 / med2, win: "48 ч" });
    }
  }
  return out.sort((a, b) => b.ratio - a.ratio);
}

// ---------------------------------------------------------------- calendar merge (YouTube + pipeline calendar.json)
const norm = s => String(s || "").toLowerCase().replace(/#\w+/g, "").replace(/[^a-z0-9а-яё]+/g, " ").trim();
function rubricColors(ch) {
  const keys = Object.keys(ch.calendar?.rubrics || {});
  return Object.fromEntries(keys.map((k, i) => [k, `var(--s${(i % 8) + 1})`]));
}
function calendarItems(ch) {
  const items = [], byYt = {}, byTitle = {};
  for (const [id, v] of Object.entries(ch.videos || {})) {
    let status, date;
    if (v.privacy === "public") { status = "published"; date = v.published_at; }
    else if (v.publish_at) { status = "scheduled"; date = v.publish_at; }
    else { status = "uploaded"; date = v.published_at; }
    const it = { key: id, youtube_id: id, title: v.title, format: v.format, status, date, dateOnly: false,
      url: v.format === "short" ? `https://youtube.com/shorts/${id}` : `https://youtu.be/${id}`, slug: ch.slug };
    items.push(it); byYt[id] = it; byTitle[norm(v.title)] = it;
  }
  const pipeById = {};
  const claimed = new Set();
  const onYouTube = new Set(["published", "scheduled", "uploaded"]);
  for (const p of ch.calendar?.items || []) {
    // by id first; by title only for things that should already be on YouTube, each video claimed once
    let it = p.youtube_id && byYt[p.youtube_id];
    if (!it && onYouTube.has(p.status)) it = [p.title, ...(p.alt_titles || [])].map(t => byTitle[norm(t)]).find(x => x && !claimed.has(x.key));
    if (it && claimed.has(it.key)) it = null;
    if (it) {
      claimed.add(it.key);
      Object.assign(it, { rubric: p.rubric, pid: p.id, parent: p.parent, note: p.note });
    } else {
      it = { key: "p:" + p.id, pid: p.id, title: p.title, format: p.format || "long", status: p.status || "planned",
        date: p.date, dateOnly: !!p.date && p.date.length <= 10, rubric: p.rubric, parent: p.parent, note: p.note, slug: ch.slug,
        url: p.youtube_id ? `https://youtu.be/${p.youtube_id}` : null };
      items.push(it);
    }
    pipeById[p.id] = it;
  }
  for (const it of items) it.parentTitle = it.parent && pipeById[it.parent] ? pipeById[it.parent].title : null;
  return items.filter(it => it.date);
}
const localDay = iso => {
  if (iso.length <= 10) return iso;
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const evTime = it => (it.dateOnly ? "" : new Date(it.date).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }));

// ---------------------------------------------------------------- alerts
function alerts(ch) {
  const out = [];
  const now = Date.now();
  const gen = new Date(ch.generated_at).getTime();
  if (now - gen > 12 * 3600e3) out.push(["warning", "Данные устарели", `Последний сбор ${fmtDate(ch.generated_at)}. Проверьте GitHub Actions → collect.`]);
  if (ch.errors?.length) out.push(["info", `Сбор прошёл с ${ch.errors.length} предупреждениями`, esc(ch.errors.slice(0, 3).join(" · ")).slice(0, 400)]);
  const longs = publicVideos(ch, "long"), shorts = publicVideos(ch, "short");
  const ctrs = longs.filter(x => x.m.impr >= 1000).map(x => x.m.ctr);
  const p25 = ctrs.length >= 4 ? quantile(ctrs, 0.25) : null;
  for (const x of longs) {
    if (x.m.age != null && x.m.age <= 7 && x.m.impr >= 300 && x.m.ctr != null && x.m.ctr < (p25 ?? 3))
      out.push(["critical", "Низкий CTR — перепаковать", `«${esc(x.v.title)}»: CTR ${pct(x.m.ctr)} на ${fmt(x.m.impr)} показах (${p25 ? "ниже 25-го перцентиля канала" : "ниже 3%"}). Сменить превью / заголовок.`, x.id]);
    if (x.m.age != null && x.m.age <= 30 && x.m.ret30 != null && x.m.ret30 < 50)
      out.push(["critical", "Провал на 30-й секунде — разобрать хук", `«${esc(x.v.title)}»: досмотр до 0:30 — ${pct(x.m.ret30, 0)} (норма 60–70%).`, x.id]);
  }
  for (const x of shorts) if (x.m.age != null && x.m.age <= 14 && x.m.views >= 300 && x.m.stay != null && x.m.stay < 60)
    out.push(["warning", "Shorts пролистывают", `«${esc(x.v.title)}»: engaged только ${pct(x.m.stay, 0)} просмотров (порог ~70%). Усилить первую секунду.`, x.id]);
  for (const o of outliers(ch).slice(0, 5))
    out.push(["good", `Выброс ×${o.ratio.toFixed(1)} — делать продолжение`, `«${esc(o.v.title)}»: ${fmt(o.v.format === "short" ? o.m.d2 ?? o.m.d7 : o.m.d7 ?? o.m.d2)} просмотров за ${o.win} — в ${o.ratio.toFixed(1)} раза выше медианы канала.`, o.id]);
  out.push(...decayAlerts(ch));
  for (const w of waitingOk(ch)) if (w.sent && Date.now() - new Date(w.sent) > 24 * 36e5)
    out.push(["warning", "Превью ждёт «Ок» больше суток", `«${esc(w.title)}» — ответь в Telegram, иначе слот публикации сдвинется.`]);
  const t = totals(ch, "all", range(ch, 28));
  if (t.subscribersGained >= 20 && t.subscribersLost / t.subscribersGained > 0.3)
    out.push(["warning", "Высокий отток подписчиков", `За 28 дней отписались ${fmt(t.subscribersLost)} на ${fmt(t.subscribersGained)} новых (${pct(t.subscribersLost / t.subscribersGained * 100, 0)}; норма 10–20%).`]);
  const cal = calendarItems(ch);
  const soon = cal.filter(it => it.format !== "short" && new Date(it.date) > new Date() && new Date(it.date) - new Date() < 7 * 864e5);
  if (ch.calendar && !soon.length) out.push(["warning", "Пустое расписание", "На ближайшие 7 дней нет ни одного запланированного ролика."]);
  return out;
}
function alertsHtml(list, chSlug) {
  if (!list.length) return `<div class="empty">Тревог нет</div>`;
  const ic = { critical: "!", warning: "!", good: "★", info: "i" };
  return `<div class="alerts">${list.map(([lv, title, text, vid, slug]) => `<div class="alert ${lv}" ${vid ? `data-video="${esc(vid)}" data-ch="${esc(slug || chSlug || "")}" style="cursor:pointer"` : ""}><span class="ic">${ic[lv]}</span><div><b>${title}</b><div class="small ink2">${text}</div></div></div>`).join("")}</div>`;
}

// ---------------------------------------------------------------- charts
function killCharts() { S.charts.forEach(c => c.destroy()); S.charts = []; }
function chartBase() {
  const grid = css("--grid"), muted = css("--muted"), ink = css("--ink");
  if (window.Chart) { Chart.defaults.font.family = css("--font"); Chart.defaults.font.size = 11; }
  return {
    responsive: true, maintainAspectRatio: false, animation: false,
    interaction: { mode: "index", intersect: false },
    plugins: { legend: { display: false }, tooltip: { backgroundColor: css("--surface"), titleColor: muted, bodyColor: ink, borderColor: css("--axis"), borderWidth: 1, padding: 12, boxPadding: 5, cornerRadius: 10, usePointStyle: true, titleFont: { weight: "500" }, bodyFont: { weight: "600" } } },
    scales: {
      x: { grid: { display: false }, border: { display: false }, ticks: { color: muted, maxRotation: 0, autoSkipPadding: 18, padding: 6 } },
      y: { grid: { color: grid, drawTicks: false }, border: { display: false }, ticks: { color: muted, padding: 8, maxTicksLimit: 5, callback: v => fmt(v) }, beginAtZero: true },
    },
  };
}
function lineChart(el, labels, series, yfmt) {
  if (!window.Chart || !el) return;
  const opt = chartBase();
  if (yfmt) { opt.scales.y.ticks.callback = yfmt; opt.plugins.tooltip.callbacks = { label: c => `${c.dataset.label}: ${yfmt(c.parsed.y)}` }; }
  const fill = color => c => {  // soft vertical gradient under the line
    const { chartArea, ctx } = c.chart;
    if (!chartArea) return "transparent";
    const g = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
    g.addColorStop(0, color + (series.length > 1 ? "26" : "38")); g.addColorStop(1, color + "00");
    return g;
  };
  S.charts.push(new Chart(el, { type: "line", data: { labels, datasets: series.map(s => ({ label: s.label, data: s.data, borderColor: s.color, backgroundColor: fill(s.color), fill: s.dash ? false : "origin", borderWidth: 2, pointRadius: 0, pointHoverRadius: 5, pointHoverBorderWidth: 2, pointHoverBorderColor: css("--surface"), pointBackgroundColor: s.color, tension: 0.25, spanGaps: true, borderDash: s.dash || [] })) }, options: opt }));
}
function barChart(el, labels, series, stacked = false) {
  if (!window.Chart || !el) return;
  const opt = chartBase();
  if (stacked) { opt.scales.x.stacked = true; opt.scales.y.stacked = true; }
  S.charts.push(new Chart(el, { type: "bar", data: { labels, datasets: series.map(s => ({ label: s.label, data: s.data, backgroundColor: s.colors || s.color, borderRadius: 6, borderSkipped: "start", maxBarThickness: 16, categoryPercentage: 0.7, borderColor: css("--surface"), borderWidth: stacked ? { top: 2 } : 0 })) }, options: opt }));
}
const legend = items => `<div class="legend">${items.map(([c, t, dash]) => `<span><i style="background:${dash ? `repeating-linear-gradient(90deg,${c} 0 4px,transparent 4px 7px)` : c}"></i>${t}</span>`).join("")}</div>`;
const shortLabel = d => new Date(d + "T00:00:00Z").toLocaleDateString("ru-RU", { day: "numeric", month: "short", timeZone: "UTC" });
function hbars(rows, valFmt = fmt, color = "var(--s1)") {
  if (!rows.length) return `<div class="empty">Нет данных</div>`;
  const max = Math.max(...rows.map(r => r[1])) || 1;
  const total = rows.reduce((s, r) => s + r[1], 0) || 1;
  return `<div class="hbars">${rows.map(([t, v]) => `<div class="hbar" title="${esc(t)}: ${valFmt(v)}"><span class="t">${esc(t)}</span><span class="track"><span class="fill" style="width:${(v / max * 100).toFixed(1)}%;background:${color}"></span></span><span class="x">${pct(v / total * 100, 0)}</span></div>`).join("")}</div>`;
}

// ---------------------------------------------------------------- rendering: shell
function channelsList() { return (S.index?.channels || []).filter(c => S.ch[c.slug]); }
function renderShell() {
  const sel = $("#channel");
  const list = channelsList();
  sel.innerHTML = `<option value="__all">Сводка · все каналы (${list.length})</option>` +
    list.map(c => `<option value="${esc(c.slug)}">${esc(S.ch[c.slug].channel?.title || c.name)}</option>`).join("");
  if (!S.view || (S.view !== "__all" && !S.ch[S.view])) S.view = "__all";
  sel.value = S.view;
  const tabs = S.view === "__all" ? [["summary", "Сводка"], ["improve", "Улучшения"], ["calendar", "Календарь"], ["videos", "Ролики"], ["costs", "Затраты"]]
    : [["overview", "Обзор"], ["improve", "Улучшения"], ["videos", "Ролики"], ["calendar", "Календарь"], ["costs", "Затраты"], ["audience", "Аудитория"], ["money", "Монетизация"]];
  if (!tabs.some(t => t[0] === S.tab)) S.tab = tabs[0][0];
  $("#tabs").innerHTML = tabs.map(([k, t]) => `<button role="tab" data-tab="${k}" aria-selected="${k === S.tab}">${t}</button>`).join("");
  document.querySelectorAll("#period button").forEach(b => b.setAttribute("aria-pressed", String(+b.dataset.d === S.period)));
  const gens = list.map(c => S.ch[c.slug].generated_at).sort();
  const lastA = list.map(c => daily(S.ch[c.slug]).filter(r => r.views).map(r => r.day).pop()).filter(Boolean).sort()[0];
  S.freshAt = gens[0] || null; S.lastA = lastA;
  paintFresh();
  $("#demo").classList.toggle("hidden", !list.some(c => S.ch[c.slug].demo));
  store.set("ytdash.view", S.view); store.set("ytdash.tab", S.tab); store.set("ytdash.period", String(S.period));
  render();
}
function render() {
  killCharts();
  const m = $("#main");
  if (!channelsList().length) { m.innerHTML = `<div class="empty">Данных пока нет — сборщик ещё не отработал.</div>`; return; }
  const ch = S.view === "__all" ? null : S.ch[S.view];
  const fn = {
    summary: renderSummary, overview: renderOverview, videos: renderVideos, calendar: renderCalendar,
    audience: renderAudience, money: renderMoney, costs: renderCosts, improve: renderImprove,
  }[S.tab];
  fn(m, ch);
}

// ---------------------------------------------------------------- live counters (Data API snapshots, one per collector run)
function liveDelta(hist, hours = 24, col = 1) {
  if (!hist || hist.length < 2) return null;
  const last = hist[hist.length - 1], now = new Date(last[0]).getTime(), cut = now - hours * 36e5;
  let base = null;
  for (const h of hist) if (new Date(h[0]).getTime() <= cut) base = h;
  if (!base) { base = hist[0]; if (now - new Date(base[0]).getTime() < 3 * 36e5) return null; }
  return { d: last[col] - base[col], hours: Math.round((now - new Date(base[0]).getTime()) / 36e5), at: last[0] };
}
const plusH = x => (x ? `<span class="delta ${x.d > 0 ? "up" : x.d < 0 ? "down" : "flat"}">${x.d > 0 ? "+" : ""}${fmt(x.d)}</span> <span class="muted">за ${x.hours >= 23 && x.hours <= 25 ? "24 ч" : x.hours + " ч"}</span>` : `<span class="muted">прирост появится после нескольких сборов</span>`);
function liveSpark(hist, col = 1, hours = 72) {  // hourly growth over the last days
  if (!hist || hist.length < 3) return null;
  const end = new Date(hist[hist.length - 1][0]).getTime(), pts = [];
  for (let t = end - hours * 36e5; t <= end; t += 6 * 36e5) {
    let v = null; for (const h of hist) if (new Date(h[0]).getTime() <= t) v = h[col];
    pts.push(v);
  }
  const filled = pts.filter(x => x != null);
  return filled.length >= 3 ? filled.slice(1).map((x, i) => x - filled[i]) : null;
}
function lastAnalyticsDay(ch) { return daily(ch).filter(r => r.views).map(r => r.day).pop() || null; }
function liveTiles(ch) {
  const lh = ch.live_history, vd = liveDelta(lh, 24, 1), sd = liveDelta(lh, 24, 2);
  const top = publicVideos(ch).filter(x => x.m.live24?.d > 0).sort((a, b) => b.m.live24.d - a.m.live24.d)[0];
  const la = lastAnalyticsDay(ch), lag = la ? daysBetween(la, dayStr(new Date())) : null;
  return [
    kpiTile("Просмотров всего", fmt(ch.channel?.views), plusH(vd), "Живой счётчик YouTube (Data API), обновляется при каждом сборе", liveSpark(lh, 1), "var(--s1)"),
    kpiTile("Подписчиков сейчас", fmt(ch.channel?.subscribers), plusH(sd), "YouTube округляет подписчиков у публичного счётчика", liveSpark(lh, 2), "var(--s3)"),
    kpiTile("Быстрее всех за 24 ч", top ? `+${fmt(top.m.live24.d)}` : "—", top ? `<span class="ink2">${esc(top.v.title)}</span>` : "нет прироста за сутки"),
    kpiTile("Подробная статистика", la ? fmtDate(la + "T12:00", false) : "ещё нет", la ? `YouTube Analytics отстаёт на ${lag} дн. — графики и конверсии ниже по эту дату` : "Analytics появится через 2–3 дня после первых просмотров"),
  ].join("");
}
// ---------------------------------------------------------------- tab: overview (one channel)
function kpiTile(k, v, d, title = "", spark = null, color = "var(--s1)") {
  return `<div class="tile" title="${esc(title)}"><div class="k">${k}</div><div class="v num">${v}</div><div class="d">${d}</div>${spark ? sparkline(spark, color) : ""}</div>`;
}
let sparkId = 0;
function sparkline(vals, color) {  // tiny trend under a stat tile: area + 2px line, no axes (decorative; the number above is the data)
  const xs = vals.map(v => (v == null || !isFinite(v) ? 0 : v));
  if (xs.length < 2 || !xs.some(v => v)) return "";
  const W = 200, H = 34, max = Math.max(...xs), lo = Math.min(...xs), min = lo < 0 ? lo : Math.max(0, lo - (max - lo) * 0.35), rng = max - min || 1;
  const pts = xs.map((v, i) => [i / (xs.length - 1) * W, H - 3 - (v - min) / rng * (H - 8)]);
  const line = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join("");
  const id = "sg" + (++sparkId);
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="${id}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".22"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs><path d="${line}L${W} ${H}L0 ${H}Z" fill="url(#${id})"/><path d="${line}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/></svg>`;
}
function series(ch, key, field, rg) {  // daily values over a range (missing days = 0)
  const mp = Object.fromEntries(daily(ch, key).map(r => [r.day, r]));
  const out = [];
  for (let d = rg[0]; d <= rg[1]; d = addDays(d, 1)) out.push(typeof field === "function" ? field(mp[d]) : (mp[d]?.[field] ?? 0));
  return out;
}
function sumSeries(chans, field, N) {
  const all = chans.map(c => series(c, "all", field, range(c, N)));
  return all.length ? all[0].map((_, i) => all.reduce((a, x) => a + (x[i] || 0), 0)) : null;
}
function reachSeries(ch, rg) {
  const imp = {};
  for (const v of Object.values(ch.videos || {})) for (const [d, [i]] of Object.entries(v.reach || {})) imp[d] = (imp[d] || 0) + i;
  const out = [];
  for (let d = rg[0]; d <= rg[1]; d = addDays(d, 1)) out.push(imp[d] || 0);
  return out;
}
function scaleBar(v, t) {  // where the value sits between weak / norm / good / strong
  if (v == null || !isFinite(v) || !t) return "";
  const top = Math.max((t[2] ?? t[1] * 1.6) * 1.25, v * 1.08);
  const edges = [0, t[0], t[1], t[2] ?? top, top].map(x => Math.min(x, top));
  const zones = ["weak", "norm", "good", "strong"].map((z, i) => [z, edges[i + 1] - edges[i]]).filter(([, w]) => w > 0);
  return `<div class="scale" aria-hidden="true">${zones.map(([z, w]) => `<i class="z-${z}" style="flex:${w}"></i>`).join("")}<b style="left:${Math.min(99, v / top * 100).toFixed(1)}%"></b></div>`;
}
function renderOverview(m, ch) {
  const N = S.period, cur = range(ch, N), prev = range(ch, N, 1);
  const t = totals(ch, "all", cur), p = totals(ch, "all", prev);
  const tl = totals(ch, "VIDEO_ON_DEMAND", cur);
  const r = reachTotals(ch, cur), rp = reachTotals(ch, prev);
  const rv = revenue(ch, cur), rvp = revenue(ch, prev);
  const net = (t.subscribersGained ?? 0) - (t.subscribersLost ?? 0), netp = (p.subscribersGained ?? 0) - (p.subscribersLost ?? 0);
  const rpm = rv?.rev != null && t.views ? rv.rev / t.views * 1000 : null;
  const longAvd = tl.views ? tl.estimatedMinutesWatched * 60 / tl.views : null;
  const engShare = t.views && t.engagedViews != null ? t.engagedViews / t.views * 100 : null;
  const noA = !daily(ch).some(r => r.views);
  m.innerHTML = `<section><h2>Сейчас · живые счётчики</h2><div class="tiles">${liveTiles(ch)}</div></section>${noA ? `<div class="alert info" style="margin-bottom:12px"><span class="ic">i</span><div><b>YouTube Analytics ещё не отдал цифры по роликам</b><div class="small ink2">Статистика приходит с задержкой 2–3 дня, а у нового канала — до 3–4 дней. Пока работают счётчики просмотров во вкладке «Ролики» и календарь. Показы и CTR появятся примерно через 2 дня после первого сбора.</div></div></div>` : ""}
  <section><h2>Конверсии · ${N} д</h2><div class="tiles">${convTiles(ch, cur, prev)}</div>
    <div class="note">Конверсии считаются на engaged-просмотры (так их считает YouTube после 24.08.2026). Подробные шаги — в воронках ниже, по каждому ролику — во вкладке «Ролики». Наведите на плитку — источник нормы.</div></section>
  <section><h2>Канал · ${N} д</h2><div class="tiles">
    ${kpiTile("Подписчики", fmt(ch.channel?.subscribers), `<span class="${net >= 0 ? "up" : "down"}">${net >= 0 ? "+" : ""}${fmt(net)}</span> <span class="muted">за ${N} д (+${fmt(t.subscribersGained)} / −${fmt(t.subscribersLost)})</span>`, "", series(ch, "all", r => (r?.subscribersGained || 0) - (r?.subscribersLost || 0), cur), "var(--s3)")}
    ${(() => { const sp = subsSplit(ch, cur), all = sp.long + sp.short; return kpiTile("Подписки: ролики / Shorts", `${fmt(sp.long)} / ${fmt(sp.short)}`, all ? `${pct(sp.short / all * 100, 0)} — из Shorts (такие подписчики реже смотрят длинные ролики)` : "нет новых подписок за период"); })()}
    ${kpiTile("Просмотры", fmt(t.views), delta(t.views, p.views), "С 24.08.2026 YouTube считает просмотр с первого кадра", series(ch, "all", "views", cur))}
    ${kpiTile("Engaged-просмотры", fmt(t.engagedViews), engShare != null ? `${pct(engShare, 0)} от всех · ${delta(t.engagedViews, p.engagedViews).replace(" к прошлому периоду", "")}` : "—", "По ним YouTube считает удержание, CTR и доход", series(ch, "all", "engagedViews", cur), "var(--s7)")}
    ${kpiTile("Часы просмотра", fmt(hours(t.estimatedMinutesWatched)), delta(t.estimatedMinutesWatched, p.estimatedMinutesWatched), "", series(ch, "all", r => (r?.estimatedMinutesWatched || 0) / 60, cur), "var(--s2)")}
    ${kpiTile("Показы превью", fmt(r?.impr), r ? delta(r.impr, rp?.impr) : `<span class="muted">Reporting API: первые данные через ~2 дня</span>`, "", reachSeries(ch, cur), "var(--s5)")}
    ${kpiTile("Ср. время просмотра (ролики)", dur(longAvd), tl.views ? `на ${fmt(tl.views)} просмотрах роликов` : "—")}
    ${kpiTile("Доход", rv?.rev != null ? money(rv.rev) : "—", rv?.rev != null ? `RPM ${money(rpm)} · ${delta(rv.rev, rvp?.rev).replace(" к прошлому периоду", "")}` : `<span class="muted">до монетизации — см. вкладку «Монетизация»</span>`)}
  </div></section>
  <section class="grid g2">
    <div class="card"><h2>Просмотры по дням</h2>${legend([[css("--s1"), "Ролики"], [css("--s2"), "Shorts"]])}<div class="chart"><canvas id="cViews"></canvas></div></div>
    <div class="card"><h2>Подписчики по дням (новые минус отписки)</h2><div class="chart"><canvas id="cSubs"></canvas></div></div>
  </section>
  <section class="grid g2">
    <div class="card"><h2>Воронка роликов · ${N} д</h2>${funnelLong(ch, cur)}</div>
    <div class="card"><h2>Воронка Shorts · ${N} д</h2>${funnelShort(ch, cur)}</div>
  </section>
  <section class="grid g2">
    <div class="card"><h2>Что требует внимания</h2>${alertsHtml(alerts(ch), ch.slug)}</div>
    <div class="card"><h2>Ждут твоего «Ок»</h2>${waitingHtml(waitingOk(ch))}<h2 style="margin-top:16px">Ближайшие выходы</h2>${agendaHtml(calendarItems(ch).filter(it => new Date(it.dateOnly ? it.date + "T23:59:00" : it.date) >= new Date()).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 8), rubricColors(ch), ch)}
      <div class="note">Полный план — вкладка «Календарь».</div></div>
  </section>
  <section class="card"><h2>Путь к монетизации</h2>${yppCompact(ch)}</section>`;
  const days = [];
  for (let d = cur[0]; d <= cur[1]; d = addDays(d, 1)) days.push(d);
  const by = key => { const mp = Object.fromEntries(daily(ch, key).map(r => [r.day, r])); return days.map(d => mp[d]); };
  const L = by("VIDEO_ON_DEMAND"), Sh = by("SHORTS"), A = by("all");
  lineChart($("#cViews"), days.map(shortLabel), [
    { label: "Ролики", data: L.map(r => r?.views ?? 0), color: css("--s1") },
    { label: "Shorts", data: Sh.map(r => r?.views ?? 0), color: css("--s2") }]);
  barChart($("#cSubs"), days.map(shortLabel), [{ label: "Подписчики", data: A.map(r => (r?.subscribersGained ?? 0) - (r?.subscribersLost ?? 0)),
    colors: A.map(r => ((r?.subscribersGained ?? 0) - (r?.subscribersLost ?? 0)) < 0 ? css("--s8") : css("--s1")) }]);
}
function convValues(ch, rg) {
  const r = reachTotals(ch, rg, "long"), L = totals(ch, "VIDEO_ON_DEMAND", rg), Sh = totals(ch, "SHORTS", rg);
  const rate = (a, b) => (a != null && b ? a / b * 100 : null);
  return { ctr: r?.ctr ?? null, impr: r?.impr || 0, stay: rate(Sh.engagedViews, Sh.views), shViews: Sh.views || 0,
    subL: rate(L.subscribersGained, L.engagedViews), engL: L.engagedViews || 0, subS: rate(Sh.subscribersGained, Sh.engagedViews), engS: Sh.engagedViews || 0,
    likeL: rate(L.likes, L.engagedViews), likeS: rate(Sh.likes, Sh.engagedViews) };
}
function convCompareHtml(chans, N) {
  const rows = chans.map(c => ({ c, v: convValues(c, range(c, N)) }));
  const cols = [
    ["Показ → просмотр (CTR)", x => x.ctr, x => (x.impr >= 1000 ? level(NORMS.long.ctr.t, x.ctr) : "na"), 1],
    ["Shorts: смотрят, не листают", x => x.stay, x => (x.shViews >= 300 ? level(NORMS.short.stay.t, x.stay) : "na"), 0],
    ["Просмотр → подписка, ролики", x => x.subL, x => (x.engL >= 300 ? level(NORMS.long.sub.t, x.subL) : "na"), 2],
    ["Просмотр → подписка, Shorts", x => x.subS, x => (x.engS >= 300 ? level(NORMS.short.sub.t, x.subS) : "na"), 2],
    ["Лайк / просмотр, ролики", x => x.likeL, x => (x.engL >= 300 ? level(NORMS.long.like.t, x.likeL) : "na"), 1],
    ["Лайк / просмотр, Shorts", x => x.likeS, x => (x.engS >= 300 ? level(NORMS.short.like.t, x.likeS) : "na"), 1],
  ];
  return `<div class="tablewrap"><table><thead><tr><th>Канал</th>${cols.map(c => `<th class="n">${c[0]}</th>`).join("")}</tr></thead><tbody>
    ${rows.map(r => `<tr data-open="${esc(r.c.slug)}"><td>${esc(r.c.channel?.title || r.c.name)}</td>${cols.map(c => `<td class="n">${lvlCell(pct(c[1](r.v), c[3]), c[2](r.v))}</td>`).join("")}</tr>`).join("")}
    ${rows.length > 1 ? `<tr><td class="muted">Медиана каналов</td>${cols.map(c => `<td class="n muted">${pct(median(rows.map(r => c[1](r.v))), c[3])}</td>`).join("")}</tr>` : ""}
  </tbody></table></div><div class="note">Все конверсии — на engaged-просмотры. Цветная точка — уровень относительно норм (наведите). «Мало данных» — меньше 1000 показов или 300 просмотров за период. Сравнивайте каналы между собой, а не с абсолютами: ниши дают разные нормы.</div>`;
}
function convTiles(ch, cur, prev) {
  const r = reachTotals(ch, cur, "long"), rp = reachTotals(ch, prev, "long");
  const L = totals(ch, "VIDEO_ON_DEMAND", cur), Lp = totals(ch, "VIDEO_ON_DEMAND", prev);
  const Sh = totals(ch, "SHORTS", cur), Shp = totals(ch, "SHORTS", prev);
  const rate = (a, b) => (a != null && b ? a / b * 100 : null);
  const tile = (k, v, l, d, src, raw, t) => `<div class="tile" title="${esc(src)}"><div class="k">${k}</div><div class="v num" style="display:flex;gap:4px 8px;align-items:center;flex-wrap:wrap;white-space:normal">${v}${badge(l)}</div><div class="d">${d}</div>${l !== "na" ? scaleBar(raw, t) : ""}</div>`;
  const ctr = r?.ctr, sl = rate(L.subscribersGained, L.engagedViews), ss = rate(Sh.subscribersGained, Sh.engagedViews), stay = rate(Sh.engagedViews, Sh.views);
  const dl = (c, p) => (c != null && p != null ? delta(c, p).replace(" к прошлому периоду", "") : "");
  return [
    tile("Показ → просмотр (CTR, ролики)", pct(ctr), r && r.impr >= 1000 ? level(NORMS.long.ctr.t, ctr) : "na", r ? `${fmt(r.impr)} показов → ${fmt(r.clicks)} просмотров ${dl(ctr, rp?.ctr)}` : "показы приходят с задержкой ~2 дня", NORMS.long.ctr.src + " · норма 3–6%", ctr, NORMS.long.ctr.t),
    tile("Лента Shorts → смотрят", pct(stay, 0), Sh.views >= 300 ? level(NORMS.short.stay.t, stay) : "na", Sh.views ? `${fmt(Sh.engagedViews)} из ${fmt(Sh.views)} не пролистали ${dl(stay, rate(Shp.engagedViews, Shp.views))}` : "нет просмотров Shorts", NORMS.short.stay.src + " · норма 65–75%", stay, NORMS.short.stay.t),
    tile("Просмотр → подписка (ролики)", pct(sl, 2), L.engagedViews >= 300 ? level(NORMS.long.sub.t, sl) : "na", L.engagedViews ? `+${fmt(L.subscribersGained)} на ${fmt(L.engagedViews)} engaged ${dl(sl, rate(Lp.subscribersGained, Lp.engagedViews))}` : "нет просмотров роликов", NORMS.long.sub.src + " · норма 0,2–1%", sl, NORMS.long.sub.t),
    tile("Просмотр → подписка (Shorts)", pct(ss, 2), Sh.engagedViews >= 300 ? level(NORMS.short.sub.t, ss) : "na", Sh.engagedViews ? `+${fmt(Sh.subscribersGained)} на ${fmt(Sh.engagedViews)} engaged ${dl(ss, rate(Shp.subscribersGained, Shp.engagedViews))}` : "нет просмотров Shorts", NORMS.short.sub.src + " · норма 0,1–0,5%", ss, NORMS.short.sub.t),
  ].join("");
}
function fstep(label, sub, val, lvl, title = "", raw = null, t = null) {
  return `<div class="fstep" title="${esc(title)}"><div class="lbl"><b>${label}</b><span>${sub}</span></div><div class="val">${val}</div><div>${badge(lvl)}</div>${lvl !== "na" ? scaleBar(raw, t) : ""}</div>`;
}
function funnelLong(ch, rg) {
  const t = totals(ch, "VIDEO_ON_DEMAND", rg);
  const r = reachTotals(ch, rg, "long");
  const vids = publicVideos(ch, "long").filter(x => x.m.pub >= rg[0]);
  const ret = median(publicVideos(ch, "long").filter(x => x.m.age <= 90).map(x => x.m.ret30));
  const apvMed = median(publicVideos(ch, "long").filter(x => x.m.age <= 90).map(x => x.m.apv));
  const per = k => (t[k] != null && t.engagedViews ? t[k] / t.engagedViews * 100 : null);
  const N = NORMS.long;
  if (!t.views && !r) return `<div class="empty">Нет данных по роликам за период</div>`;
  return `<div class="funnel">
    ${fstep("Показ → клик (CTR)", r ? `${fmt(r.impr)} показов → ${fmt(r.clicks)} кликов` : "Reporting API — данные с задержкой ~2 дня", pct(r?.ctr), r && r.impr >= 1000 ? level(N.ctr.t, r.ctr) : "na", N.ctr.src, r?.ctr, N.ctr.t)}
    ${fstep("Досмотр до 0:30", "медиана роликов за 90 дней", pct(ret, 0), level(N.ret30.t, ret), N.ret30.src, ret, N.ret30.t)}
    ${fstep("Средний % просмотра", "медиана роликов за 90 дней", pct(apvMed, 0), level(N.apv.t, apvMed), N.apv.src, apvMed, N.apv.t)}
    ${fstep("Просмотр → лайк", `${fmt(t.likes)} лайков на engaged`, pct(per("likes"), 2), level(N.like.t, per("likes")), N.like.src, per("likes"), N.like.t)}
    ${fstep("Просмотр → комментарий", `${fmt(t.comments)} комментариев`, pct(per("comments"), 2), level(N.comment.t, per("comments")), N.comment.src, per("comments"), N.comment.t)}
    ${fstep("Просмотр → подписка", `+${fmt(t.subscribersGained)} подписчиков с роликов`, pct(per("subscribersGained"), 2), level(N.sub.t, per("subscribersGained")), N.sub.src, per("subscribersGained"), N.sub.t)}
  </div><div class="note">Конверсии — на engaged-просмотры. ${vids.length} роликов вышло за период. Наведите на шаг — источник нормы.</div>`;
}
function funnelShort(ch, rg) {
  const t = totals(ch, "SHORTS", rg);
  const N = NORMS.short;
  if (!t.views) return `<div class="empty">Нет данных по Shorts за период</div>`;
  const per = k => (t[k] != null && t.engagedViews ? t[k] / t.engagedViews * 100 : null);
  const stay = t.engagedViews != null ? t.engagedViews / t.views * 100 : null;
  const recent = publicVideos(ch, "short").filter(x => x.m.age <= 90 && x.m.apv != null);
  const apvMed = median(recent.map(x => x.m.apv));
  const apvLvl = recent.length ? level(shortApvNorm(median(recent.map(x => x.v.duration))), apvMed) : "na";
  const cs = (t.comments ?? 0) + (t.shares ?? 0);
  return `<div class="funnel">
    ${fstep("Смотрят, а не листают", `${fmt(t.engagedViews)} engaged из ${fmt(t.views)}`, pct(stay, 0), level(N.stay.t, stay), N.stay.src, stay, N.stay.t)}
    ${fstep("Средний % просмотра", "медиана Shorts за 90 дней (>100% = пересмотры)", pct(apvMed, 0), apvLvl, "B: <20 с — 100%, 20–40 с — 90%, >40 с — 80%", apvMed, recent.length ? shortApvNorm(median(recent.map(x => x.v.duration))) : null)}
    ${fstep("Просмотр → лайк", `${fmt(t.likes)} лайков`, pct(per("likes"), 2), level(N.like.t, per("likes")), N.like.src, per("likes"), N.like.t)}
    ${fstep("Комментарии + репосты", `${fmt(cs)} всего`, pct(t.engagedViews ? cs / t.engagedViews * 100 : null, 2), level(N.comment.t, t.engagedViews ? cs / t.engagedViews * 100 : null), N.comment.src, t.engagedViews ? cs / t.engagedViews * 100 : null, N.comment.t)}
    ${fstep("Просмотр → подписка", `+${fmt(t.subscribersGained)} подписчиков с Shorts`, pct(per("subscribersGained"), 2), level(N.sub.t, per("subscribersGained")), N.sub.src, per("subscribersGained"), N.sub.t)}
  </div><div class="note">«Смотрят vs листают» в API нет — показана близкая метрика: доля engaged-просмотров.</div>`;
}

// ---------------------------------------------------------------- monetization
const YPP_RULES = [
  { name: "Полная монетизация (реклама), правила до 01.02.2027", subs: 1000, hours: 4000, shorts: 10e6 },
  { name: "Полная монетизация с 01.02.2027", subs: 1000, hours: 8000, shorts: 20e6, note: "Анонс YouTube 10.08.2026; что будет с каналами, принятыми раньше, не уточнено" },
  { name: "Ранний уровень (донаты, спонсорство; если доступен в стране)", subs: 500, hours: 3000, shorts: 3e6, uploads: 3 },
];
function pace(ch) {
  const rg = range(ch, 28);
  const t = totals(ch, "all", rg), s = totals(ch, "SHORTS", rg);
  const tm = totals(ch, "VIDEO_ON_DEMAND", rg);
  return { subs: ((t.subscribersGained ?? 0) - (t.subscribersLost ?? 0)) / 28, hours: (tm.estimatedMinutesWatched ?? 0) / 60 / 28, shorts: (s.engagedViews ?? 0) / 28 };
}
function eta(left, perDay) {
  if (left <= 0) return `<span class="up">выполнено</span>`;
  if (!perDay || perDay <= 0) return `<span class="muted">при текущем темпе — не достигается</span>`;
  const days = Math.ceil(left / perDay);
  const d = new Date(Date.now() + days * 864e5);
  return days > 3650 ? `<span class="muted">больше 10 лет при текущем темпе</span>` : `≈ ${fmt(days)} дн. (к ${d.toLocaleDateString("ru-RU", { day: "numeric", month: "short", year: "numeric" })})`;
}
function prog(label, cur, goal, perDay, unit = "") {
  const p = goal ? Math.min(100, (cur ?? 0) / goal * 100) : 0;
  return `<div class="prog"><div class="row"><span>${label}</span><span class="num"><b>${fmt(cur)}</b> / ${fmt(goal)}${unit}</span></div>
    <div class="track"><div class="fill ${p >= 100 ? "done" : ""}" style="width:${p.toFixed(1)}%"></div></div>
    <div class="row small"><span class="muted">${pct(p, 1)}</span><span class="ink2">${perDay !== undefined ? eta(goal - (cur ?? 0), perDay) : ""}</span></div></div>`;
}
function yppCompact(ch) {
  const y = ch.ypp || {}, pc = pace(ch), r = YPP_RULES[0];
  const rv = revenue(ch, range(ch, 28));
  const earning = rv?.rev > 0;
  return `${earning ? `<div class="small" style="margin-bottom:8px">Канал монетизирован: доход за 28 дней <b>${money(rv.rev)}</b>.</div>` : ""}
  <div class="grid g3">
    <div>${prog("Подписчики", y.subscribers, r.subs, pc.subs)}</div>
    <div>${prog("Часы роликов за 365 дней", y.long_watch_hours_365, r.hours, pc.hours, " ч")}</div>
    <div>${prog("Engaged-просмотры Shorts за 90 дней", y.shorts_engaged_90, r.shorts, undefined)}</div>
  </div><div class="note">Нужно: подписчики + (часы ИЛИ просмотры Shorts). Прогноз — по темпу последних 28 дней. Точная цифра — в Studio → «Монетизация».</div>`;
}
function renderMoney(m, ch) {
  const y = ch.ypp || {}, pc = pace(ch);
  const rows = objs(ch.daily?.revenue);
  const N = S.period, cur = range(ch, N);
  const rv = revenue(ch, cur);
  const t = totals(ch, "all", cur);
  const rr = rows.filter(r => r.day >= cur[0] && r.day <= cur[1]);
  const cpmMed = median(rr.filter(r => r.cpm).map(r => r.cpm));
  const top = publicVideos(ch).filter(x => x.m.rev).sort((a, b) => b.m.rev - a.m.rev).slice(0, 10);
  m.innerHTML = `
  <section class="tiles">
    ${kpiTile("Доход за период", money(rv?.rev), rv ? `реклама ${money(rv.ad)}` : "нет данных — канал не в YPP или нет доступа к доходам")}
    ${kpiTile("RPM (на 1000 просмотров)", money(rv?.rev != null && t.views ? rv.rev / t.views * 1000 : null), "сколько получаете вы")}
    ${kpiTile("CPM (медиана)", money(cpmMed), "сколько платит рекламодатель")}
    ${kpiTile("Доход за всё время", money(rows.reduce((s, r) => s + (r.estimatedRevenue || 0), 0) || null), "по данным Analytics")}
  </section>
  ${rows.length ? `<section class="card"><h2>Доход по дням</h2><div class="chart"><canvas id="cRev"></canvas></div></section>` : ""}
  <section class="grid g2">
    <div class="card"><h2>Условия монетизации</h2>
      ${YPP_RULES.map(r => `<div class="rule"><h3>${r.name}</h3>
        ${prog("Подписчики", y.subscribers, r.subs, pc.subs)}
        ${r.uploads ? prog("Публичных роликов за 90 дней", y.public_uploads_90, r.uploads) : ""}
        <div class="small muted" style="margin:4px 0 2px">и одно из двух:</div>
        ${prog("Часы просмотра роликов за 365 дней", y.long_watch_hours_365, r.hours, pc.hours, " ч")}
        ${prog("Просмотры Shorts за 90 дней", y.shorts_engaged_90, r.shorts, undefined)}
        ${r.note ? `<div class="note">${r.note}</div>` : ""}</div>`).join("")}
      <div class="note">Часы считаются только по длинным роликам (Shorts не входят), Shorts — по engaged-просмотрам ленты. Значения из API приблизительные: официальная цифра — Studio → «Монетизация».</div>
    </div>
    <div class="card"><h2>Самые доходные ролики</h2>${top.length ? `<div class="hbars">${top.map(x => `<div class="hbar"><span class="t" title="${esc(x.v.title)}">${esc(x.v.title)}</span><span class="track"><span class="fill" style="width:${(x.m.rev / top[0].m.rev * 100).toFixed(1)}%"></span></span><span class="x">${money(x.m.rev)}</span></div>`).join("")}</div>` : `<div class="empty">Появится после подключения монетизации</div>`}
      <h2 style="margin-top:18px">Темп за 28 дней</h2>
      <div class="small ink2">+${fmt(pc.subs * 28)} подписчиков · ${fmt(pc.hours * 28)} ч роликов · ${fmt(pc.shorts * 28)} engaged-просмотров Shorts</div>
    </div>
  </section>`;
  if (rows.length) {
    const sel = rows.filter(r => r.day >= cur[0]);
    barChart($("#cRev"), sel.map(r => shortLabel(r.day)), [{ label: "Доход, $", data: sel.map(r => r.estimatedRevenue || 0), color: css("--s3") }]);
  }
}

// ---------------------------------------------------------------- tab: videos
const COLS = [
  ["title", "Ролик", null],
  ["published", "Вышел", x => x.m.pub, x => x.m.pub ? fmtDate(x.v.published_at, false) : "—"],
  ["duration", "Длина", x => x.v.duration, x => dur(x.v.duration)],
  ["views", "Просмотры", x => x.m.views, x => fmt(x.m.views)],
  ["live24", "+24 ч", x => x.m.live24?.d ?? null, x => (x.m.live24 ? (x.m.live24.d > 0 ? `<span class="up">+${fmt(x.m.live24.d)}</span>` : "0") : "—")],
  ["d2", "48 ч", x => x.m.d2, x => fmt(x.m.d2)],
  ["d7", "7 дн", x => x.m.d7, x => fmt(x.m.d7)],
  ["impr", "Показы", x => x.m.impr, x => fmt(x.m.impr)],
  ["ctr", "CTR", x => x.m.ctr, x => x.v.format === "short" ? "—" : lvlCell(pct(x.m.ctr), x.m.impr >= 1000 ? level(NORMS.long.ctr.t, x.m.ctr) : "na")],
  ["ret30", "0:30", x => x.m.ret30, x => x.v.format === "short" ? "—" : lvlCell(pct(x.m.ret30, 0), level(NORMS.long.ret30.t, x.m.ret30))],
  ["stay", "Смотрят", x => x.v.format === "short" ? x.m.stay : null, x => x.v.format === "short" ? lvlCell(pct(x.m.stay, 0), level(NORMS.short.stay.t, x.m.stay)) : "—"],
  ["apv", "% просм.", x => x.m.apv, x => lvlCell(pct(x.m.apv, 0), x.v.format === "short" ? level(shortApvNorm(x.v.duration), x.m.apv) : level(NORMS.long.apv.t, x.m.apv))],
  ["avd", "Ср. время", x => x.m.avd, x => dur(x.m.avd)],
  ["hours", "Часы", x => x.m.minutes, x => fmt(hours(x.m.minutes))],
  ["subs", "Подписки", x => x.m.subs, x => fmt(x.m.subs)],
  ["sub", "Подп./просм.", x => x.m.sub, x => pct(x.m.sub, 2)],
  ["like", "Лайки/просм.", x => x.m.like, x => pct(x.m.like, 1)],
  ["rev", "Доход", x => x.m.rev, x => money(x.m.rev)],
];
function lvlCell(v, l) { return l === "na" ? `<span class="muted">${v}</span>` : `${v} <span class="badge b-${l}" title="${LVL[l]}"></span>`; }
function renderVideos(m, ch) {
  const chans = ch ? [ch] : channelsList().map(c => S.ch[c.slug]);
  let list = [];
  for (const c of chans) for (const x of publicVideos(c)) list.push({ ...x, ch: c });
  const rc = Object.fromEntries(chans.map(c => [c.slug, Object.fromEntries((c.calendar?.items || []).filter(p => p.youtube_id).map(p => [p.youtube_id, p.rubric]))]));
  if (S.vfilter !== "all") list = list.filter(x => x.v.format === S.vfilter);
  const col = COLS.find(c => c[0] === S.vsort[0]) || COLS[1];
  list.sort((a, b) => ((col[2](a) ?? -Infinity) > (col[2](b) ?? -Infinity) ? 1 : -1) * S.vsort[1]);
  const priv = chans.reduce((s, c) => s + Object.values(c.videos || {}).filter(v => v.privacy !== "public").length, 0);
  m.innerHTML = `<section style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:10px">
      <div class="seg" id="vf">${[["all", "Все"], ["long", "Ролики"], ["short", "Shorts"]].map(([k, t]) => `<button data-f="${k}" aria-pressed="${S.vfilter === k}">${t}</button>`).join("")}</div>
      <span class="muted small">${list.length} опубликовано${priv ? ` · ${priv} в расписании/приватных — см. «Календарь»` : ""} · нажмите на строку — подробности</span></section>
    <div class="tablewrap"><table><thead><tr>${!ch ? "<th>Канал</th>" : ""}${COLS.map(c => `<th data-sort="${c[0]}" class="${c[0] === "title" ? "" : "n"}">${c[1]}${S.vsort[0] === c[0] ? (S.vsort[1] > 0 ? " ↑" : " ↓") : ""}</th>`).join("")}</tr></thead>
    <tbody>${list.map(x => `<tr data-video="${esc(x.id)}" data-ch="${esc(x.ch.slug)}">${!ch ? `<td>${esc(x.ch.channel?.title || x.ch.name)}</td>` : ""}
      <td class="title">${x.v.thumb ? `<img loading="lazy" src="${esc(x.v.thumb)}" alt="">` : ""}<span class="fmt">${x.v.format === "short" ? "SHORT" : "РОЛИК"}</span>${rc[x.ch.slug][x.id] ? `<span class="chip" style="--rc:${rubricColors(x.ch)[rc[x.ch.slug][x.id]]}">${esc(rc[x.ch.slug][x.id])}</span> ` : ""}${esc(x.v.title)}</td>
      ${COLS.slice(1).map(c => `<td class="n">${c[3](x)}</td>`).join("")}</tr>`).join("") || `<tr><td colspan="20" class="empty">Нет роликов</td></tr>`}</tbody></table></div>
    <div class="note">CTR и показы — из Reporting API (появляются через ~2 дня после публикации). 0:30 — доля зрителей на 30-й секунде. «Смотрят» у Shorts — доля engaged-просмотров. Цветная точка — уровень относительно норм (наведите).</div>`;
}

// ---------------------------------------------------------------- video detail drawer
function openVideo(slug, id) {
  const ch = S.ch[slug], v = ch?.videos?.[id];
  if (!v) return;
  killDrawerCharts();
  const x = vm(v, ch), short = v.format === "short";
  const peers = publicVideos(ch, v.format);
  const rank = (k) => {
    const vals = peers.map(p => p.m[k]).filter(z => z != null);
    if (x[k] == null || !x.views || vals.length < 3) return "";
    return `<span class="muted small">лучше ${Math.round(vals.filter(z => z < x[k]).length / vals.length * 100)}% роликов канала</span>`;
  };
  const cell = (k, label, val, l) => `<div><div class="k">${label}</div><div class="v">${val}${l ? badge(l) : ""}</div>${rank(k)}</div>`;
  const pRub = (ch.calendar?.items || []).find(p => p.youtube_id === id);
  const rub = pRub?.rubric ? ch.calendar.rubrics?.[pRub.rubric] : null;
  const traffic = (v.traffic || []).map(r => [TRAFFIC[r[0]] || r[0], r[1]]);
  const srcCtr = Object.entries(v.reach_src_days || {}).map(([k, days]) => {
    let i = 0, c = 0; for (const [a, b] of Object.values(days)) { i += a; c += b; }
    return [TRAFFIC[k] || k, i, i ? c / i * 100 : null];
  }).filter(r => r[1] > 0).sort((a, b) => b[1] - a[1]);
  $("#panel").innerHTML = `<button class="close" id="dclose">Закрыть</button>
    <div class="small muted">${esc(ch.channel?.title || ch.name)} · ${short ? "Shorts" : "Ролик"} · ${dur(v.duration)} · вышел ${v.published_at ? fmtDate(v.published_at) : "—"}${x.age != null ? ` (${x.age} дн. назад)` : ""}</div>
    <h2 style="font-size:18px;margin:6px 0 4px">${esc(v.title)}</h2>
    <div class="small" style="margin-bottom:12px">${rub ? `<span class="chip" style="--rc:${rubricColors(ch)[pRub.rubric]}">${esc(pRub.rubric)} · ${esc(rub.name || rub)}</span> ` : ""}<a href="https://youtu.be/${esc(id)}" target="_blank" rel="noopener">YouTube ↗</a> · <a href="https://studio.youtube.com/video/${esc(id)}/analytics" target="_blank" rel="noopener">Studio ↗</a></div>
    <div class="kv">
      ${cell("views", "Просмотры", fmt(x.views))}
      ${cell("eng", "Engaged", fmt(x.eng))}
      ${short ? cell("stay", "Смотрят, не листают", pct(x.stay, 0), level(NORMS.short.stay.t, x.stay)) : cell("ctr", "CTR превью", pct(x.ctr), x.impr >= 1000 ? level(NORMS.long.ctr.t, x.ctr) : "na")}
      ${short ? "" : cell("impr", "Показы", fmt(x.impr))}
      ${short ? "" : cell("ret30", "Досмотр до 0:30", pct(x.ret30, 0), level(NORMS.long.ret30.t, x.ret30))}
      ${cell("apv", "Средний % просмотра", pct(x.apv, 0), short ? level(shortApvNorm(v.duration), x.apv) : level(NORMS.long.apv.t, x.apv))}
      ${cell("avd", "Ср. время просмотра", dur(x.avd))}
      ${cell("minutes", "Часы просмотра", fmt(hours(x.minutes), 1))}
      ${cell("like", "Лайки / engaged", pct(x.like, 2), level((short ? NORMS.short : NORMS.long).like.t, x.like))}
      ${cell("comment", short ? "Комм.+репосты / engaged" : "Комментарии / engaged", pct(x.comment, 2), level((short ? NORMS.short : NORMS.long).comment.t, x.comment))}
      ${cell("sub", "Подписки / engaged", pct(x.sub, 2), level((short ? NORMS.short : NORMS.long).sub.t, x.sub))}
      ${(() => { const d = short ? null : ctrDecay(v); return d ? `<div><div class="k">CTR: 48 ч → дни 3–7</div><div class="v">${pct(d.early)} → ${pct(d.late)}</div><span class="muted small">×${d.ratio.toFixed(2)}${d.ratio < 0.6 ? " — превью выгорает" : ""}</span></div>` : ""; })()}
      ${cell("d2", "Просмотры за 48 ч", fmt(x.d2))}
      ${cell("d7", "За 7 дней", fmt(x.d7))}
      ${cell("d28", "За 28 дней", fmt(x.d28))}
      ${x.rev != null ? cell("rev", "Доход", money(x.rev)) : ""}
    </div>
    <section class="card" style="margin-top:14px"><h2>Удержание аудитории</h2>${v.retention ? `<div class="chart"><canvas id="dRet"></canvas></div>${relNote(v)}` : `<div class="empty">Появится, когда наберётся ~100 просмотров</div>`}</section>
    <section class="card" style="margin-top:12px"><h2>Просмотры по дням после выхода</h2>${v.daily ? `<div class="chart"><canvas id="dDaily"></canvas></div>` : `<div class="empty">Нет данных</div>`}</section>
    <section class="grid g2" style="margin-top:12px">
      <div class="card"><h2>Источники трафика</h2>${hbars(traffic)}</div>
      <div class="card"><h2>CTR по источникам</h2>${srcCtr.length ? `<div class="tablewrap"><table><thead><tr><th>Источник</th><th class="n">Показы</th><th class="n">CTR</th></tr></thead><tbody>${srcCtr.map(r => `<tr><td>${esc(r[0])}</td><td class="n">${fmt(r[1])}</td><td class="n">${pct(r[2])}</td></tr>`).join("")}</tbody></table></div><div class="note">Ориентиры: поиск 8–15%, рекомендации 5–10%, главная 3–7% (C).</div>` : `<div class="empty">Reporting API — появится через ~2 дня</div>`}</div>
    </section>`;
  $("#drawer").classList.remove("hidden");
  document.body.style.overflow = "hidden";
  if (v.retention && window.Chart) {
    const lbl = v.retention.map(r => dur(r[0] * v.duration));
    const opt = chartBase();
    opt.scales.y.ticks.callback = val => val + "%";
    opt.plugins.tooltip.callbacks = { label: c => `${c.dataset.label}: ${c.parsed.y.toFixed(0)}%` };
    S.drawerCharts.push(new Chart($("#dRet"), { type: "line", data: { labels: lbl, datasets: [
      { label: "Смотрят", data: v.retention.map(r => +(r[1] * 100).toFixed(1)), borderColor: css("--s1"), backgroundColor: css("--s1") + "26", fill: "origin", borderWidth: 2, pointRadius: 0, tension: 0.2 },
    ] }, options: opt }));
  }
  if (v.daily && window.Chart) {
    const d = objs(v.daily);
    const opt = chartBase();
    S.drawerCharts.push(new Chart($("#dDaily"), { type: "bar", data: { labels: d.map(r => shortLabel(r.day)), datasets: [{ label: "Просмотры", data: d.map(r => r.views), backgroundColor: css(short ? "--s2" : "--s1"), borderRadius: 4, borderSkipped: "start", maxBarThickness: 18 }] }, options: opt }));
  }
}
S.drawerCharts = [];
function relNote(v) {
  const rel = v.retention.map(r => r[2]).filter(x => x != null);
  if (!rel.length) return "";
  const m = rel.reduce((s, x) => s + x, 0) / rel.length;
  const w = m >= 0.6 ? "удерживает лучше" : m <= 0.4 ? "удерживает хуже" : "держит примерно как";
  return `<div class="note">Сравнение с роликами такой же длины на всём YouTube (relativeRetentionPerformance): <b>${m.toFixed(2)}</b> — ${w} типичного ролика (0,5 — медиана, 1 — лучше всех). Пики на графике выше 100% — пересмотры.</div>`;
}
function killDrawerCharts() { S.drawerCharts.forEach(c => c.destroy()); S.drawerCharts = [];
function relNote(v) {
  const rel = v.retention.map(r => r[2]).filter(x => x != null);
  if (!rel.length) return "";
  const m = rel.reduce((s, x) => s + x, 0) / rel.length;
  const w = m >= 0.6 ? "удерживает лучше" : m <= 0.4 ? "удерживает хуже" : "держит примерно как";
  return `<div class="note">Сравнение с роликами такой же длины на всём YouTube (relativeRetentionPerformance): <b>${m.toFixed(2)}</b> — ${w} типичного ролика (0,5 — медиана, 1 — лучше всех). Пики на графике выше 100% — пересмотры.</div>`;
} }
function closeDrawer() {
  $("#drawer").classList.add("hidden"); document.body.style.overflow = ""; killDrawerCharts();
  if (S.pendingRender) { S.pendingRender = false; renderShell(); }
}

// ---------------------------------------------------------------- tab: calendar
function agendaHtml(items, colors, ch) {
  if (!items.length) return `<div class="empty">Ничего не запланировано</div>`;
  return `<div class="agenda">${items.map(it => {
    const when = it.dateOnly ? fmtDate(it.date + "T12:00:00", false) : fmtDate(it.date);
    const click = it.youtube_id && ch.videos?.[it.youtube_id]?.privacy === "public" ? `data-video="${esc(it.youtube_id)}" data-ch="${esc(it.slug)}"` : it.url ? `data-url="${esc(it.url)}"` : "";
    return `<div class="arow ${it.format === "short" && it.parent ? "child" : ""}" style="--rc:${it.cc || colors[it.rubric] || "var(--axis)"}" ${click}>
      <span class="when">${when}</span>
      <span class="what"><span class="fmt">${it.format === "short" ? "SHORT" : "РОЛИК"}</span>${S.view === "__all" ? `<b>${esc(S.ch[it.slug]?.channel?.title || it.slug)}</b> · ` : ""}${it.rubric ? `${esc(it.rubric)} · ` : ""}${esc(it.title)}</span>
      <span class="st st-${it.status}">${STATUS[it.status] || it.status}</span></div>`;
  }).join("")}</div>`;
}
function chColor(slug) { return `var(--s${(channelsList().findIndex(c => c.slug === slug) % 8) + 1})`; }
function allChannelItems() {  // every channel's calendar, coloured by channel
  return channelsList().flatMap(c => calendarItems(S.ch[c.slug]).map(it => ({ ...it, cc: chColor(c.slug), chName: S.ch[c.slug].channel?.title || c.name })));
}
S.calHide = new Set();
function renderCalendar(m, ch) {
  const chans = ch ? [ch] : channelsList().map(c => S.ch[c.slug]);
  let items = ch ? calendarItems(ch) : allChannelItems().filter(it => !S.calHide.has(it.slug));
  const colors = {};
  for (const c of chans) Object.assign(colors, rubricColors(c));
  if (!S.calMonth) { const n = new Date(); S.calMonth = [n.getFullYear(), n.getMonth()]; }
  const [Y, M] = S.calMonth;
  const first = new Date(Y, M, 1);
  const startOff = (first.getDay() + 6) % 7;
  const start = new Date(Y, M, 1 - startOff);
  const byDay = {};
  for (const it of items) (byDay[localDay(it.date)] ||= []).push(it);
  for (const k in byDay) byDay[k].sort((a, b) => (a.format === "short") - (b.format === "short") || (a.dateOnly ? "99" : a.date).localeCompare(b.dateOnly ? "99" : b.date));
  const todayK = localDay(new Date().toISOString());
  let cells = "";
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    if (i >= 35 && d.getMonth() !== M) break;
    cells += `<div class="day ${d.getMonth() !== M ? "out" : ""} ${k === todayK ? "today" : ""}"><span class="dn">${d.getDate()}</span>${(byDay[k] || []).map(it =>
      `<div class="ev ${it.status} ${it.format === "short" ? "short" : ""}" style="--rc:${it.cc || colors[it.rubric] || "var(--axis)"}" title="${esc(`${it.chName ? it.chName + " · " : ""}${STATUS[it.status] || it.status} · ${it.format === "short" ? "Shorts" : "Ролик"}${it.rubric ? " · рубрика " + it.rubric : ""}${it.parentTitle ? " · из ролика «" + it.parentTitle + "»" : ""}\n${it.title}${it.note ? "\n" + it.note : ""}`)}" ${it.youtube_id && S.ch[it.slug]?.videos?.[it.youtube_id]?.privacy === "public" ? `data-video="${esc(it.youtube_id)}" data-ch="${esc(it.slug)}"` : it.url ? `data-url="${esc(it.url)}"` : ""}>${evTime(it) ? `<span class="tm">${evTime(it)}</span> ` : ""}${it.chName ? `<b>${esc(it.chName.length > 12 ? it.chName.slice(0, 10) + "…" : it.chName)}</b> · ` : ""}${it.format === "short" ? "▮ " : ""}${esc(it.title)}</div>`).join("")}</div>`;
  }
  const rubrics = {};
  for (const c of chans) for (const [k, r] of Object.entries(c.calendar?.rubrics || {})) rubrics[k] = r;
  const upcoming = items.filter(it => new Date(it.dateOnly ? it.date + "T23:59:00" : it.date) >= new Date()).sort((a, b) => a.date.localeCompare(b.date));
  const recent = items.filter(it => it.status === "published").sort((a, b) => b.date.localeCompare(a.date)).slice(0, 6);
  const srcs = chans.map(c => c.calendar?.source ? `${esc(c.calendar.source)}, обновлён ${c.calendar.updated ? fmtDate(c.calendar.updated) : "—"}` : `${esc(c.channel?.title || c.slug)}: план конвейера не подключён`).join("; ");
  m.innerHTML = `
    <section class="card">
      <div class="calhead"><button class="ctl" id="calPrev" aria-label="Предыдущий месяц">←</button><span class="m">${first.toLocaleDateString("ru-RU", { month: "long", year: "numeric" })}</span><button class="ctl" id="calNext" aria-label="Следующий месяц">→</button><button class="ctl" id="calToday">Сегодня</button>
        <span class="spacer"></span><span class="small muted">время — ваше местное</span></div>
      ${!ch ? `<div class="rubrics">${channelsList().map(c => `<button class="chip" data-calch="${esc(c.slug)}" style="--rc:${chColor(c.slug)};cursor:pointer;border-top:0;border-right:0;border-bottom:0;${S.calHide.has(c.slug) ? "opacity:.4;text-decoration:line-through" : ""}">${esc(S.ch[c.slug].channel?.title || c.name)}</button>`).join("")}<span class="small muted">— нажмите, чтобы скрыть/показать канал; цвет полоски = канал</span></div>` : ""}
      ${ch && Object.keys(rubrics).length ? `<div class="rubrics">${Object.entries(rubrics).map(([k, r]) => `<span class="chip" style="--rc:${colors[k]}">${esc(k)} · ${esc(r.name || r)}</span>`).join("")}</div>` : ""}
      <div class="rubrics small">${["published", "scheduled", "ready", "in_production", "planned"].map(s => `<span class="st st-${s}">${STATUS[s]}</span>`).join("")}</div>
      <div class="cal">${["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].map(d => `<div class="dow">${d}</div>`).join("")}${cells}</div>
      <div class="calmobile-note note" style="display:none">На телефоне месяц показан списком ниже.</div>
    </section>
    <section class="grid g2">
      <div class="card"><h2>Дальше по плану</h2>${agendaHtml(upcoming.slice(0, 30), colors, ch || S.ch[chans[0].slug])}</div>
      <div class="card"><h2>Недавно вышло</h2>${agendaHtml(recent, colors, ch || S.ch[chans[0].slug])}</div>
    </section>
    <div class="note">Источник плана: ${srcs}. Вышедшие и стоящие в расписании YouTube ролики берутся из YouTube напрямую; планы — из calendar.json конвейера.</div>`;
  $("#calPrev").onclick = () => { S.calMonth = M ? [Y, M - 1] : [Y - 1, 11]; render(); };
  $("#calNext").onclick = () => { S.calMonth = M === 11 ? [Y + 1, 0] : [Y, M + 1]; render(); };
  $("#calToday").onclick = () => { S.calMonth = null; render(); };
}

// ---------------------------------------------------------------- tab: audience
function renderAudience(m, ch) {
  const a = ch.audience || {};
  const tr = k => objs(ch.traffic?.[k]).map(r => [TRAFFIC[r.insightTrafficSourceType] || r.insightTrafficSourceType, r.views]);
  const sub = objs(a.subscribed);
  const subTot = sub.reduce((s, r) => s + r.views, 0);
  const subscribed = sub.find(r => r.subscribedStatus === "SUBSCRIBED");
  const dev = objs(a.device).map(r => [DEVICE[r.deviceType] || r.deviceType, r.views]);
  const tv = objs(a.device).find(r => r.deviceType === "TV");
  const country = objs(a.country).map(r => [regionNames ? (regionNames.of(r.country) || r.country) : r.country, r.views]);
  const demo = objs(a.demographics);
  const ages = {};
  for (const r of demo) ages[r.ageGroup] = (ages[r.ageGroup] || 0) + r.viewerPercentage;
  const male = demo.filter(r => r.gender === "male").reduce((s, r) => s + r.viewerPercentage, 0);
  const female = demo.filter(r => r.gender === "female").reduce((s, r) => s + r.viewerPercentage, 0);
  m.innerHTML = `<div class="note" style="margin:0 0 10px">Последние 28 дней (кроме источников — тоже 28 дней). Период вверху на эту вкладку не влияет.</div>
  <section class="grid g3">
    <div class="card"><h2>Источники трафика · всё</h2>${hbars(tr("all"))}</div>
    <div class="card"><h2>Источники · ролики</h2>${hbars(tr("VIDEO_ON_DEMAND"))}</div>
    <div class="card"><h2>Источники · Shorts</h2>${hbars(tr("SHORTS"), fmt, "var(--s2)")}</div>
  </section>
  <section class="grid g3">
    <div class="card"><h2>Подписчики vs не подписанные</h2>${subTot ? `<div class="tile" style="border:0;padding:0"><div class="v">${pct((subscribed?.views || 0) / subTot * 100, 0)}</div><div class="d">просмотров от подписчиков</div></div>` + hbars(sub.map(r => [r.subscribedStatus === "SUBSCRIBED" ? "Подписчики" : "Не подписаны", r.views])) : `<div class="empty">Нет данных</div>`}
      <div class="note">Для роста широких тем ориентир — 80–90% просмотров от новых зрителей (C).</div></div>
    <div class="card"><h2>Устройства</h2>${hbars(dev)}${tv ? `<div class="note">Телевизор: среднее время там обычно в разы выше — длинные ролики выигрывают.</div>` : ""}</div>
    <div class="card"><h2>Страны</h2>${hbars(country)}</div>
  </section>
  <section class="grid g2">
    <div class="card"><h2>Возраст</h2>${hbars(Object.entries(ages).map(([k, v]) => [AGE[k] || k, v]), v => pct(v, 0))}</div>
    <div class="card"><h2>Пол</h2>${male + female ? hbars([["Мужчины", male], ["Женщины", female]], v => pct(v, 0)) : `<div class="empty">YouTube показывает пол и возраст только при достаточной аудитории</div>`}</div>
  </section>`;
}

// ---------------------------------------------------------------- subscribers by format, CTR decay, review loop
function subsSplit(ch, rg) {
  const L = totals(ch, "VIDEO_ON_DEMAND", rg), Sh = totals(ch, "SHORTS", rg);
  return { long: L.subscribersGained || 0, short: Sh.subscribersGained || 0 };
}
function ctrDecay(v) {  // CTR of the first 48 h vs days 3–7: how fast the thumbnail "burns out" on colder audiences
  const pub = (v.published_at || "").slice(0, 10);
  if (!v.reach || !pub) return null;
  const win = (a, b) => { let i = 0, c = 0; for (const [d, [x, y]] of Object.entries(v.reach)) if (d >= addDays(pub, a) && d <= addDays(pub, b)) { i += x; c += y; } return { i, c }; };
  const e = win(0, 1), l = win(2, 6);
  if (e.i < 200 || l.i < 200) return null;
  return { early: e.c / e.i * 100, late: l.c / l.i * 100, ratio: (l.c / l.i) / (e.c / e.i || 1) };
}
function decayAlerts(ch) {
  const longs = publicVideos(ch, "long").map(x => ({ ...x, d: ctrDecay(x.v) })).filter(x => x.d);
  const med = longs.length >= 3 ? median(longs.map(x => x.d.ratio)) : null;
  return longs.filter(x => x.m.age <= 21 && (med ? x.d.ratio < med * 0.8 : x.d.ratio < 0.6)).map(x =>
    ["warning", "Пора менять превью", `«${esc(x.v.title)}»: CTR упал с ${pct(x.d.early)} (48 ч) до ${pct(x.d.late)} (дни 3–7) — ${med ? `быстрее медианы канала (×${x.d.ratio.toFixed(2)} против ×${med.toFixed(2)})` : "больше чем на 40%"}. Попробовать другое превью или заголовок.`, x.id]);
}
function waitingOk(ch) {  // previews sent to Telegram that still wait for "Ок"
  const out = [];
  const cal = Object.fromEntries((ch.calendar?.items || []).map(i => [i.id, i]));
  for (const [slug, c] of Object.entries(ch.costs?.videos || {})) if (c.review?.waiting && !c.youtube_id && !["published", "scheduled"].includes(cal[slug]?.status) && c.review.last_sent && Date.now() - new Date(c.review.last_sent) < 96 * 36e5)
    out.push({ slug, title: cal[slug]?.title || slug, sent: c.review.last_sent, round: c.review.rounds, edits: c.review.edits });
  const st = ch.pipeline_state;
  if (st?.status === "waiting" && st.slug && !out.some(o => o.slug === st.slug))
    out.push({ slug: st.slug, title: cal[st.slug]?.title || st.slug, sent: st.sent_at ? new Date(st.sent_at * 1000).toISOString() : null, round: null });
  return out.map(o => ({ ...o, ch, bot: ch.telegram_bot }));
}
function waitingHtml(list) {
  if (!list.length) return `<div class="empty">Ничего не ждёт — все превью разобраны</div>`;
  return `<div class="agenda">${list.map(o => {
    const h = o.sent ? (Date.now() - new Date(o.sent)) / 36e5 : null;
    return `<div class="arow" style="--rc:var(--warning)" ${o.bot ? `data-url="https://t.me/${esc(o.bot)}"` : ""}>
      <span class="when">${h != null ? (h < 48 ? `${Math.round(h)} ч назад` : `${Math.round(h / 24)} дн. назад`) : "—"}</span>
      <span class="what">${esc(o.title)}${S.view === "__all" ? ` <span class="muted small">· ${esc(o.ch.channel?.title || o.ch.slug)}</span>` : ""}${o.round ? ` <span class="muted small">· круг ${o.round}${o.edits ? `, правок ${o.edits}` : ""}</span>` : ""}</span>
      <span class="st st-ready">${o.bot ? "открыть в Telegram ↗" : "ждёт «Ок»"}</span></div>`;
  }).join("")}</div><div class="note">Ссылка открывает чат с ботом — превью там последним сообщением с видео. На отдельное сообщение в личном чате Telegram ссылку дать нельзя.</div>`;
}
function leadStats(ch) {  // topic chosen -> published, review rounds
  const rows = [];
  for (const [slug, c] of Object.entries(ch.costs?.videos || {})) {
    if (c.trial) continue;
    const v = c.youtube_id && ch.videos?.[c.youtube_id];
    const pubAt = v?.privacy === "public" ? v.published_at : null;
    rows.push({ slug, lead: c.topic_at && pubAt ? (new Date(pubAt) - new Date(c.topic_at)) / 864e5 : null,
      approve: c.review?.first_sent && c.review?.approved_at ? (new Date(c.review.approved_at) - new Date(c.review.first_sent)) / 36e5 : null,
      rounds: c.review?.rounds ?? null, edits: c.review?.edits ?? null });
  }
  return rows;
}

// ---------------------------------------------------------------- production costs (pipeline tools/costs.py -> costs.json)
const ECON = () => S.index?.economics || {};
const STEP_RU = { research: "Исследование", script: "Сценарий", voice: "Озвучка", timeline: "Тайминг", images: "Картинки", music: "Музыка",
  build: "Сборка", metadata: "Метаданные", thumbnails: "Превью", shorts: "Shorts", qc: "Проверка", upload: "Выгрузка",
  make: "Создание", publish: "Публикация", analytics: "Аналитика", edits: "Правки" };
const tok = n => (n == null ? "—" : fmt(n));
function hfHistory() {  // one Higgsfield account for all channels: merge snapshots
  const all = {};
  for (const c of channelsList()) for (const [t, b] of S.ch[c.slug].costs?.hf_balance || []) all[t] = b;
  return Object.entries(all).sort((a, b) => a[0].localeCompare(b[0]));
}
function hfSpent(from, to) {
  const h = hfHistory().filter(([t]) => t.slice(0, 10) >= from && t.slice(0, 10) <= to);
  let s = 0; for (let i = 1; i < h.length; i++) if (h[i - 1][1] > h[i][1]) s += h[i - 1][1] - h[i][1];
  return h.length > 1 ? s : null;
}
function lastLimits() {
  const l = channelsList().flatMap(c => S.ch[c.slug].costs?.claude_limits || []).sort((a, b) => a.t.localeCompare(b.t));
  return l[l.length - 1] || null;
}
function claudeRuns(from, to) {
  return channelsList().flatMap(c => (S.ch[c.slug].costs?.claude_runs || []).filter(r => r.t.slice(0, 10) >= from && r.t.slice(0, 10) <= to));
}
function costRows(ch) {
  const cal = Object.fromEntries((ch.calendar?.items || []).map(i => [i.id, i]));
  return Object.entries(ch.costs?.videos || {}).map(([slug, c]) => {
    const yv = c.youtube_id && ch.videos?.[c.youtube_id];
    const views = [c.youtube_id, ...(c.shorts_ids || [])].reduce((s, id) => s + (ch.videos?.[id] ? vm(ch.videos[id], ch).views : 0), 0);
    const hf = c.hf?.fact ?? null;
    return { slug, c, title: yv?.title || cal[slug]?.title || slug, status: cal[slug]?.status || (c.trial ? "тест" : "—"),
      hfPlan: c.hf?.plan ?? null, hf, views: c.youtube_id ? views : null, trial: !!c.trial,
      per1k: hf && views >= 100 ? hf / views * 1000 : null, perMin: hf && c.seconds ? hf / (c.seconds / 60) : null,
      out: c.claude?.fact?.output ?? null, outPlan: c.claude_plan?.output ?? null, turns: c.claude?.fact?.turns ?? null };
  }).sort((a, b) => b.slug.localeCompare(a.slug));
}
function perVideoCredits(rows) { return median(rows.filter(r => !r.trial && r.hf).map(r => r.hf)); }
function runway(balance, perVideo) {
  if (!balance || !perVideo) return null;
  const n = Math.floor(balance / perVideo);
  const future = channelsList().flatMap(c => calendarItems(S.ch[c.slug])).filter(it => it.format !== "short" && new Date(it.dateOnly ? it.date + "T23:59" : it.date) > new Date())
    .sort((a, b) => a.date.localeCompare(b.date));
  return { n, until: future[n] ? future[n].date : null };
}
const usd = cr => (ECON().usd_per_hf_credit && cr != null ? cr * ECON().usd_per_hf_credit : null);
function renderCosts(m, ch) {
  const chans = ch ? [ch] : channelsList().map(c => S.ch[c.slug]);
  const rows = chans.flatMap(c => costRows(c).map(r => ({ ...r, ch: c })));
  if (!chans.some(c => c.costs)) { m.innerHTML = `<div class="empty">Конвейер ещё не прислал costs.json (tools/costs.py).</div>`; return; }
  const h = hfHistory(), bal = h.length ? h[h.length - 1] : null;
  const pv = perVideoCredits(rows), rw = runway(bal?.[1], pv);
  const total = rows.reduce((s, r) => s + (r.hf || 0), 0);
  const outside = chans.reduce((s, c) => s + (c.costs?.hf_unattributed || 0), 0);
  const outTok = rows.reduce((s, r) => s + (r.out || 0), 0);
  const lim = lastLimits();
  const steps = {};
  for (const r of rows) for (const [k, v] of Object.entries(r.c.hf?.steps || {})) steps[k] = (steps[k] || 0) + v;
  const N = S.period, rg = ch ? range(ch, N) : [addDays(dayStr(new Date()), -N + 1), dayStr(new Date())];
  m.innerHTML = `
  <section class="tiles">
    ${kpiTile("Баланс Higgsfield, кр.", bal ? fmt(bal[1], 0) : "—", bal ? `на ${fmtDate(bal[0])}${ch?.costs?.hf_plan ? " · план " + esc(ch.costs.hf_plan) : ""}` : "нет снимков", "", h.slice(-30).map(x => x[1]), "var(--s3)")}
    ${kpiTile("Хватит на, роликов", rw ? `≈ ${rw.n}` : "—", rw?.until ? `по календарю — до ${fmtDate(rw.until.length > 10 ? rw.until : rw.until + "T12:00", false)}` : pv ? "" : "нужна история затрат")}
    ${kpiTile("Себестоимость ролика, кр.", pv ? fmt(pv, 0) : "—", pv ? (usd(pv) != null ? money(usd(pv)) + " · медиана, ролик + 3 Shorts" : "медиана, ролик + 3 Shorts") : "")}
    ${kpiTile(`Потрачено за ${N} д, кр.`, hfSpent(...rg) != null ? fmt(hfSpent(...rg), 0) : "—", "по снимкам баланса")}
    ${kpiTile("Потрачено всего, кр.", fmt(total, 0), `по роликам; вне роликов ещё ${fmt(outside, 1)}`)}
    ${kpiTile("Claude: токены вывода", tok(outTok), lim ? `лимит недели ${pct(lim.weekly, 0)} · 5 ч ${pct(lim.five_hour, 0)} (${fmtDate(lim.t)})` : "лимиты снимаются из приложения")}
  </section>
  <section class="card"><h2>План и факт по роликам</h2>
    <div class="tablewrap"><table><thead><tr>${ch ? "" : "<th>Канал</th>"}<th>Ролик</th><th>Статус</th><th class="n">План, кр.</th><th class="n">Факт, кр.</th><th class="n">Δ</th><th class="n">Кр./мин видео</th><th class="n">Работа, мин</th><th class="n">Claude, вывод (план / факт)</th><th class="n">Просмотры (ролик+Shorts)</th><th class="n">Кр. на 1000 просм.</th><th class="n">Тема → выход, дн.</th><th class="n">Круги / правки</th></tr></thead>
    <tbody>${rows.map(r => {
      const d = r.hfPlan && r.hf ? (r.hf - r.hfPlan) / r.hfPlan * 100 : null;
      return `<tr ${r.c.youtube_id ? `data-video="${esc(r.c.youtube_id)}" data-ch="${esc(r.ch.slug)}"` : ""}>${ch ? "" : `<td>${esc(r.ch.channel?.title || r.ch.name)}</td>`}
      <td class="title" title="${esc(r.c.hf?.source || "")}">${esc(r.title)}</td><td>${r.status in STATUS ? `<span class="st st-${r.status}">${STATUS[r.status]}</span>` : esc(r.status)}</td>
      <td class="n">${r.hfPlan != null ? fmt(r.hfPlan, 1) : "—"}</td><td class="n">${r.hf != null ? fmt(r.hf, 1) : "—"}${r.c.hf?.source?.startsWith("manual") ? " ≈" : ""}</td>
      <td class="n">${d != null ? `<span class="${d > 10 ? "down" : d < -10 ? "up" : "muted"}">${d > 0 ? "+" : ""}${pct(d, 0)}</span>` : "—"}</td>
      <td class="n">${r.perMin ? fmt(r.perMin, 1) : "—"}</td><td class="n">${r.c.minutes?.fact ?? "—"}</td>
      <td class="n">${tok(r.outPlan)} / ${tok(r.out)}</td><td class="n">${r.views != null ? fmt(r.views) : "—"}</td><td class="n">${r.per1k ? fmt(r.per1k, 1) : "—"}</td>
      ${(() => { const L = leadStats(r.ch).find(x => x.slug === r.slug) || {}; return `<td class="n">${L.lead != null ? fmt(L.lead, 1) : "—"}</td><td class="n">${L.rounds != null ? `${L.rounds} / ${L.edits}` : "—"}</td>`; })()}</tr>`;
    }).join("")}</tbody></table></div>
    <div class="note">План — по истории канала (кредитов на минуту видео × плановая длина; токены — медиана прошлых роликов). Факт Higgsfield — разница баланса на каждом шаге (journal.py), «≈» — оценка для роликов до появления журнала. Токены Claude — из расшифровки сессий конвейера (ввод и кэш — во всплывающей подсказке на вкладке ниже).</div>
  </section>
  <section class="grid g2">
    <div class="card"><h2>Куда уходят кредиты Higgsfield</h2>${hbars(Object.entries(steps).sort((a, b) => b[1] - a[1]).map(([k, v]) => [STEP_RU[k] || k, v]), v => fmt(v, 1))}</div>
    <div class="card"><h2>Баланс Higgsfield</h2>${h.length > 1 ? `<div class="chart"><canvas id="cBal"></canvas></div>` : `<div class="empty">Нужно хотя бы два снимка баланса</div>`}</div>
  </section>
  <section class="card"><h2>Claude по шагам</h2>${claudeStepsHtml(rows)}</section>`;
  if (h.length > 1) lineChart($("#cBal"), h.map(([t]) => fmtDate(t, false)), [{ label: "Кредиты", data: h.map(x => x[1]), color: css("--s3") }], v => fmt(v, 0));
}
function claudeStepsHtml(rows) {
  const st = {};
  for (const r of rows) for (const [k, v] of Object.entries(r.c.claude?.steps || {})) {
    const a = st[k] ||= { output: 0, input: 0, cache_write: 0, cache_read: 0 };
    for (const f in a) a[f] += v[f] || 0;
  }
  const ks = Object.keys(st);
  if (!ks.length) return `<div class="empty">Появится после первого ролика, сделанного с costs.py (облачные запуски пишут токены сами)</div>`;
  return `<div class="tablewrap"><table><thead><tr><th>Шаг</th><th class="n">Вывод</th><th class="n">Ввод</th><th class="n">Запись в кэш</th><th class="n">Чтение кэша</th></tr></thead><tbody>${ks.map(k =>
    `<tr><td>${STEP_RU[k] || esc(k)}</td><td class="n">${tok(st[k].output)}</td><td class="n">${tok(st[k].input)}</td><td class="n">${tok(st[k].cache_write)}</td><td class="n">${tok(st[k].cache_read)}</td></tr>`).join("")}</tbody></table></div>
    <div class="note">На подписке токены не стоят денег напрямую — они расходуют лимиты (5 часов и неделя). Чтение кэша дешёвое и в лимиты почти не идёт; главный расход — вывод и запись в кэш.</div>`;
}

// ---------------------------------------------------------------- tab: improvements (collector/advisor.py -> ch.advice)
const ZLVL = { weak: "weak", norm: "norm", good: "good", na: "na" };
const EXP_STATE = { waiting: ["ждём данных", "b-na"], partial: ["первые данные", "b-norm"], verdict: ["пора подводить итог", "b-good"],
  planned: ["запланировано", "b-na"], done: ["внедрено", "b-norm"], closed: ["закрыт", "b-na"] };
const chTitle = c => c.channel?.title || c.name;
function quickHtml(list, withChannel) {
  if (!list.length) return `<div class="empty">Сейчас нет действий, которые дали бы эффект сразу</div>`;
  return `<div class="alerts">${list.map(q => `<div class="alert ${q.kind === "sequel" ? "good" : "warning"}" ${q.video ? `data-video="${esc(q.video)}" data-ch="${esc(q.slug || "")}" style="cursor:pointer"` : ""}>
    <span class="ic">${q.kind === "sequel" ? "★" : "⚡"}</span><div><b>${withChannel ? esc(q.chName) + ": " : ""}${esc(q.title)}</b>${q.needs_yes ? ' <span class="st st-ready">нужно твоё «да»</span>' : ""}
    <div class="small ink2">${esc(q.why)}</div><div class="small"><b>Что сделать:</b> ${esc(q.action)}</div>${q.note ? `<div class="small muted">${esc(q.note)}</div>` : ""}</div></div>`).join("")}</div>`;
}
function zoneHtml(z, ch) {
  const exps = (ch.advice.experiments || []).filter(e => (z.covered_by || []).includes(e.id));
  const val = z.value == null ? "—" : (z.key === "cadence" ? `${z.value} из ${z.n}` : pct(z.value, z.value < 10 ? 1 : 0));
  return `<div class="card zone z-${z.level}"><div class="zhead"><div><div class="small muted">${esc(z.area)}</div><h3 style="color:var(--ink);font-size:14px;margin:2px 0 0">${esc(z.title)}</h3></div>
      <div class="zval">${val}${badge(ZLVL[z.level] || "na")}</div></div>
    <div class="small ink2" style="margin:6px 0 8px">${esc(z.detail)}</div>
    ${(z.weak || []).length ? `<div class="small muted" style="margin-bottom:8px">${z.weak.map(w => `${esc(w.title)}${w.value != null ? " — " + pct(w.value, w.value < 10 ? 1 : 0) : ""}`).join(" · ")}</div>` : ""}
    ${exps.length ? `<div class="zfix"><b>Исправление уже внедрено — ждём проверки:</b>${exps.map(e => `<div class="small">${esc(e.id)} · ${esc(e.change.length > 110 ? e.change.slice(0, 108) + "…" : e.change)} <span class="badge ${EXP_STATE[e.state]?.[1] || "b-na"}">${EXP_STATE[e.state]?.[0] || esc(e.state)}</span></div>`).join("")}</div>`
      : `<div class="small"><b>Вероятные причины:</b> ${z.causes.map(esc).join("; ")}.</div>
         <div class="small" style="margin-top:4px"><b>Выход:</b><ul class="zsteps">${z.steps.map(s => `<li>${esc(s)}</li>`).join("")}</ul></div>
         ${z.escalate && z.escalate !== "—" ? `<div class="small muted"><b>Когда менять подход:</b> ${esc(z.escalate)}</div>` : ""}`}
  </div>`;
}
function expHtml(list, withChannel) {
  if (!list.length) return `<div class="empty">Нет внедрённых исправлений, ожидающих проверки</div>`;
  return `<div class="tablewrap"><table><thead><tr>${withChannel ? "<th>Канал</th>" : ""}<th>ID</th><th>С какого дня</th><th>Что изменили</th><th>Метрика</th><th>Точка отсчёта</th><th>Состояние</th></tr></thead><tbody>
    ${list.map(e => `<tr style="cursor:default">${withChannel ? `<td>${esc(e.chName)}</td>` : ""}<td><b>${esc(e.id)}</b></td><td>${esc(e.date)}</td>
      <td style="white-space:normal;min-width:260px">${esc(e.change)}${e.evidence?.length ? `<div class="small muted" style="margin-top:4px">${e.evidence.map(esc).join("<br>")}</div>` : ""}</td>
      <td style="white-space:normal;min-width:150px">${esc(e.metric)}</td><td style="white-space:normal;min-width:170px">${esc(e.baseline)}</td>
      <td style="white-space:normal;min-width:170px"><span class="badge ${EXP_STATE[e.state]?.[1] || "b-na"}">${EXP_STATE[e.state]?.[0] || esc(e.state)}</span><div class="small muted" style="margin-top:3px">${esc(e.state_text)}</div></td></tr>`).join("")}</tbody></table></div>`;
}
function risksHtml(list, withChannel) {
  if (!list.length) return `<div class="empty">Открытых рисков нет</div>`;
  const ic = { critical: "!", warning: "!", info: "i" };
  return `<div class="alerts">${list.map(r => `<div class="alert ${r.severity}"><span class="ic">${ic[r.severity] || "i"}</span><div><b>${withChannel && !r.shared ? esc(r.chName) + ": " : ""}${esc(r.title)}</b>
    <div class="small ink2">${esc(r.detail)}</div><div class="small"><b>Выход:</b> ${esc(r.way_out)}</div></div></div>`).join("")}</div>`;
}
function decisionsHtml(d) {
  if (!d) return "";
  const sec = (k, t) => ((d[k] || []).length ? `<div style="margin-top:8px"><b class="small">${t}</b><ul class="zsteps">${d[k].map(x => `<li>${esc(x)}</li>`).join("")}</ul></div>` : "");
  return `<section class="card"><h2>Решения ежедневного разбора${d.date ? ` · ${esc(d.date)}` : ""}</h2>${sec("today", "Сегодня")}${sec("next", "Дальше")}${sec("needs_yes", "Нужно твоё «да»")}</section>`;
}
function renderImprove(m, ch) {
  const chans = (ch ? [ch] : channelsList().map(c => S.ch[c.slug])).filter(c => c.advice);
  if (!chans.length) { m.innerHTML = `<div class="empty">Советник ещё не посчитал рекомендации — появятся после ближайшего сбора.</div>`; return; }
  const tag = (list, c) => (list || []).map(x => ({ ...x, slug: c.slug, chName: chTitle(c) }));
  const quick = chans.flatMap(c => tag(c.advice.quick, c));
  const seen = new Set();
  const risks = chans.flatMap(c => tag(c.advice.risks, c)).filter(r => !(r.shared && seen.has(r.key)) && seen.add(r.key))
    .sort((a, b) => ["critical", "warning", "info"].indexOf(a.severity) - ["critical", "warning", "info"].indexOf(b.severity));
  const exps = chans.flatMap(c => tag(c.advice.experiments, c));
  const running = exps.filter(e => ["waiting", "partial", "verdict"].includes(e.state));
  const rest = exps.filter(e => ["planned", "done"].includes(e.state));
  const handled = chans.flatMap(c => tag(c.advice.handled, c));
  const multi = !ch;
  const head = `<div class="note" style="margin:0 0 14px">Советник дашборда пересчитывает рекомендации при каждом сборе (раз в час) по одним правилам для всех каналов. Судит только по видео от 3 дней с 50+ показами и шортсам от 2 дней со 100+ просмотрами: одно видео — сигнал, три подряд — вывод. Ничего не исправляет сам: «Сделать сейчас» — это запросы на твоё решение.</div>`;
  let zonesBlock;
  if (multi) {
    const keys = [...new Set(chans.flatMap(c => c.advice.zones.map(z => z.key)))];
    const zt = k => chans.map(c => c.advice.zones.find(z => z.key === k)).find(Boolean)?.title || k;
    zonesBlock = `<section><h2>Западающие зоны по каналам</h2><div class="tablewrap"><table><thead><tr><th>Зона</th>${chans.map(c => `<th class="n">${esc(chTitle(c))}</th>`).join("")}</tr></thead><tbody>
      ${keys.map(k => `<tr style="cursor:default"><td>${esc(PLAY_TITLES[k] || zt(k))}</td>${chans.map(c => { const z = c.advice.zones.find(x => x.key === k);
        return `<td class="n">${z ? `${z.value == null ? "—" : (k === "cadence" ? `${z.value} из ${z.n}` : pct(z.value, z.value < 10 ? 1 : 0))} ${badge(ZLVL[z.level] || "na")}${z.level === "weak" && z.covered_by?.length ? `<div class="small muted">исправлено, ждём: ${z.covered_by.map(esc).join(", ")}</div>` : ""}` : "—"}</td>`; }).join("")}</tr>`).join("")}
      </tbody></table></div><div class="note">Причины и выход по каждой зоне — во вкладке «Улучшения» внутри канала.</div></section>`;
  } else {
    const weak = ch.advice.zones.filter(z => z.level === "weak"), ok = ch.advice.zones.filter(z => z.level !== "weak");
    zonesBlock = `<section><h2>Западающие зоны</h2>${weak.length ? `<div class="grid g2">${weak.map(z => zoneHtml(z, ch)).join("")}</div>` : `<div class="empty">Ни одна зона не западает${ch.advice.judged.videos ? "" : " — данных пока мало, чтобы судить"}</div>`}
      ${ok.length ? `<div class="note">Остальное: ${ok.map(z => `${esc(z.title)} — ${z.level === "na" ? "мало данных" : (z.level === "good" ? "хорошо" : "норма")}${z.value != null && z.key !== "cadence" ? ` (${pct(z.value, z.value < 10 ? 1 : 0)})` : ""}`).join(" · ")}</div>` : ""}</section>`;
  }
  m.innerHTML = `${head}
    <section><h2>Сделать сейчас — даст эффект сразу</h2>${quickHtml(quick, multi)}</section>
    ${zonesBlock}
    <section><h2>Исправлено — ждём проверки</h2>${expHtml(running, multi)}
      ${rest.length ? `<div class="note">Без итога: ${rest.map(e => `${multi ? esc(e.chName) + " " : ""}${esc(e.id)} (${esc(EXP_STATE[e.state][0])}) — ${esc(e.change.length > 70 ? e.change.slice(0, 68) + "…" : e.change)}`).join(" · ")}</div>` : ""}
      ${handled.length ? `<div class="note">Уже сделано по советам: ${handled.map(h => `${multi ? esc(h.chName) + ": " : ""}${esc(h.note || h.key)} (${esc(h.date)})`).join(" · ")}</div>` : ""}</section>
    <section><h2>Риски</h2>${risksHtml(risks, multi)}</section>
    ${chans.map(c => (c.advice.decisions ? (multi ? `<h2 style="margin:0 0 8px 2px">${esc(chTitle(c))}</h2>` : "") + decisionsHtml(c.advice.decisions) : "")).join("")}`;
}
const PLAY_TITLES = { ctr: "CTR видео", r30: "Досмотр до 0:30", avg_pct: "Средний % просмотра", sub_rate: "Просмотр → подписка", impressions: "Показы за 7 дней",
  short_engaged: "Шортсы: смотрят, не листают", short_avg_pct: "Шортсы: средний %", shorts_subs: "Доля подписчиков из шортсов", cadence: "Выпуск по плану" };

// ---------------------------------------------------------------- tab: summary (all channels)
function renderSummary(m) {
  const N = S.period;
  const chans = channelsList().map(c => S.ch[c.slug]);
  const row = ch => {
    const cur = range(ch, N), prev = range(ch, N, 1);
    const t = totals(ch, "all", cur), p = totals(ch, "all", prev), r = reachTotals(ch, cur), rv = revenue(ch, cur);
    const longs = publicVideos(ch, "long").filter(x => x.m.age <= 90);
    const pub = publicVideos(ch).filter(x => x.m.pub >= cur[0]);
    const y = ch.ypp || {};
    const yppP = Math.max(Math.min(1, (y.subscribers || 0) / 1000) * 0.5 + Math.min(1, Math.max((y.long_watch_hours_365 || 0) / 4000, (y.shorts_engaged_90 || 0) / 10e6)) * 0.5, 0) * 100;
    return { ch, t, p, r, rv, net: (t.subscribersGained ?? 0) - (t.subscribersLost ?? 0), longs: pub.filter(x => x.v.format === "long").length, shorts: pub.filter(x => x.v.format === "short").length,
      apv: median(longs.map(x => x.m.apv)), ret: median(longs.map(x => x.m.ret30)), yppP, earning: rv?.rev > 0 };
  };
  const rows = chans.map(row);
  const T = k => rows.reduce((s, r) => s + (r.t[k] || 0), 0), P = k => rows.reduce((s, r) => s + (r.p[k] || 0), 0);
  const rev = rows.reduce((s, r) => s + (r.rv?.rev || 0), 0);
  const allOut = chans.flatMap(ch => outliers(ch).map(o => ({ ...o, ch }))).sort((a, b) => b.ratio - a.ratio).slice(0, 8);
  const allAlerts = chans.flatMap(ch => alerts(ch).filter(a => a[0] !== "good").map(a => [a[0], `${esc(ch.channel?.title || ch.name)}: ${a[1]}`, a[2], a[3], ch.slug]));
  { const h0 = hfHistory(), b0 = h0.length ? h0[h0.length - 1][1] : null, p0 = perVideoCredits(chans.flatMap(costRows)), l0 = lastLimits();
    if (b0 != null && p0 && b0 < p0 * 3) allAlerts.unshift(["critical", "Кредиты Higgsfield заканчиваются", `Баланс ${fmt(b0, 0)} — это примерно ${Math.floor(b0 / p0)} роликов. Пополнить до следующих запусков.`]);
    if (l0 && l0.weekly >= 80) allAlerts.unshift(["warning", "Лимит Claude на неделю почти исчерпан", `Использовано ${pct(l0.weekly, 0)} (снимок ${fmtDate(l0.t)}). Облачные запуски могут остановиться.`]);
    const failed = chans.flatMap(calendarItems).filter(it => it.status === "failed");
    for (const f of failed) allAlerts.unshift(["critical", "Ошибка выгрузки", `«${esc(f.title)}» — не опубликовано, причина в publish_log.md.`]); }
  const upcoming = allChannelItems().filter(it => new Date(it.dateOnly ? it.date + "T23:59" : it.date) >= new Date()).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 14);
  const colors = Object.assign({}, ...chans.map(rubricColors));
  // ---- business block
  const rg = [addDays(dayStr(new Date()), -N + 1), dayStr(new Date())];
  const monetized = rows.filter(r => r.earning).length;
  const revAll = chans.reduce((s, c) => s + objs(c.daily?.revenue).reduce((a, r) => a + (r.estimatedRevenue || 0), 0), 0);
  const h = hfHistory(), bal = h.length ? h[h.length - 1] : null;
  const crows = chans.flatMap(costRows), pv = perVideoCredits(crows), rw = runway(bal?.[1], pv);
  const spent = hfSpent(...rg);
  const runs = claudeRuns(...rg), outTok = runs.reduce((s, r) => s + (r.output || 0), 0), lim = lastLimits();
  const cal = chans.flatMap(calendarItems);
  const inRg = it => localDay(it.date) >= rg[0] && localDay(it.date) <= rg[1];
  const planned = cal.filter(it => it.format !== "short" && inRg(it) && new Date(it.dateOnly ? it.date + "T12:00" : it.date) <= new Date()).length;
  const done = cal.filter(it => it.format !== "short" && inRg(it) && it.status === "published").length;
  const st = k => cal.filter(it => it.status === k).length;
  const E = ECON(), fixed = Object.entries(E.fixed_monthly_usd || {});
  const fixedKnown = fixed.filter(([, v]) => v != null).reduce((a, [, v]) => a + v, 0);
  const missing = fixed.filter(([, v]) => v == null).map(([k]) => k);
  const hfMonthUsd = usd(hfSpent(addDays(dayStr(new Date()), -29), dayStr(new Date())));
  const burn = fixedKnown + (hfMonthUsd || 0);
  const rev30 = chans.reduce((s, c) => s + (revenue(c, range(c, 30))?.rev || 0), 0);
  m.innerHTML = `
  <section><h2>Хозяйство · ${N} дней</h2><div class="tiles">
    ${kpiTile("Каналы", `${chans.length}`, `монетизировано ${monetized} из ${chans.length}`)}
    ${kpiTile("Заработано", money(rows.reduce((s, r) => s + (r.rv?.rev || 0), 0)), `за всё время ${money(revAll)}`)}
    ${kpiTile("Расходы в месяц", burn ? money(burn) : "—", missing.length ? `не указаны цены: ${esc(missing.join(", "))}` : (E.usd_per_hf_credit ? "подписки + кредиты за 30 дней" : "подписки; цена кредита не указана"))}
    ${kpiTile("Окупаемость", burn ? pct(rev30 / burn * 100, 0) : "—", burn ? `доход 30 дней ${money(rev30)} / расходы ${money(burn)}` : "укажите цены в channels.json")}
    ${kpiTile("Higgsfield", bal ? fmt(bal[1], 0) + " кр." : "—", rw ? `хватит на ~${rw.n} роликов${rw.until ? " (до " + fmtDate(rw.until.length > 10 ? rw.until : rw.until + "T12:00", false) + ")" : ""}` : "нет истории затрат")}
    ${kpiTile("Потрачено кредитов", spent != null ? fmt(spent, 1) : "—", pv ? `ролик в среднем ${fmt(pv, 1)} кр.` : "")}
    ${kpiTile(lim ? "Claude · лимит недели" : "Claude · токены вывода", lim ? pct(lim.weekly, 0) : tok(outTok), lim ? `5 ч: ${pct(lim.five_hour, 0)} · снимок ${fmtDate(lim.t)} · вывод за период ${tok(outTok)}` : `токенов вывода за период`)}
    ${kpiTile("Выпуск по плану", planned ? `${done} из ${planned}` : `${done}`, "роликов вышло / должно было выйти за период")}
  </div></section>
  <section class="grid g2">
    <div class="card"><h2>Производство сейчас</h2><div class="mstats">${[["in_production", st("in_production")], ["ready", st("ready")], ["scheduled", st("scheduled")], ["failed", st("failed")], ["planned", st("planned")]].map(([k, n]) =>
      `<div class="mstat ${n ? "" : "zero"}"><b>${n}</b><span class="st st-${k}">${STATUS[k]}</span></div>`).join("")}</div>
      ${(() => { const L = chans.flatMap(leadStats); const ml = median(L.map(x => x.lead)), ma = median(L.map(x => x.approve)), mr = median(L.map(x => x.rounds));
        return `<div class="small ink2" style="margin-top:10px">От темы до выхода: <b>${ml != null ? fmt(ml, 1) + " дн." : "—"}</b> (медиана) · проверка до «Ок»: <b>${ma != null ? fmt(ma, 1) + " ч" : "—"}</b> · кругов проверки: <b>${mr != null ? fmt(mr, 1) : "—"}</b></div>`; })()}
      <h2 style="margin-top:16px">Ждут твоего «Ок»</h2>${waitingHtml(chans.flatMap(waitingOk))}</div>
    <div class="card"><h2>Экономика каналов</h2><div class="tablewrap"><table><thead><tr><th>Канал</th><th class="n">Роликов</th><th class="n">Кредитов всего</th><th class="n">На ролик</th><th class="n">На 1000 просм.</th><th class="n">Claude, вывод</th><th class="n">Доход всего</th></tr></thead><tbody>${chans.map(c => {
      const cr = costRows(c), t = cr.reduce((s, r) => s + (r.hf || 0), 0), vw = cr.reduce((s, r) => s + (r.views || 0), 0);
      const rv = objs(c.daily?.revenue).reduce((a, r) => a + (r.estimatedRevenue || 0), 0);
      return `<tr data-open="${esc(c.slug)}"><td>${esc(c.channel?.title || c.name)}</td><td class="n">${cr.filter(r => !r.trial).length}</td><td class="n">${fmt(t, 1)}</td><td class="n">${fmt(perVideoCredits(cr), 1)}</td><td class="n">${vw >= 100 ? fmt(t / vw * 1000, 1) : "—"}</td><td class="n">${tok(cr.reduce((s, r) => s + (r.out || 0), 0) || null)}</td><td class="n">${money(rv || null)}</td></tr>`;
    }).join("")}</tbody></table></div>
    ${fixed.length ? `<div class="note">Подписки в месяц: ${fixed.map(([k, v]) => `${esc(k)} ${v != null ? money(v) : "— не указано"}`).join(" · ")}. Цена кредита Higgsfield: ${E.usd_per_hf_credit ? money(E.usd_per_hf_credit) : "не указана"}.</div>` : ""}</div>
  </section>
  <section class="card"><h2>Ближайшие выходы по всем каналам</h2>
    <div class="rubrics">${channelsList().map(c => `<span class="chip" style="--rc:${chColor(c.slug)}">${esc(S.ch[c.slug].channel?.title || c.name)}</span>`).join("")}</div>
    ${agendaHtml(upcoming, colors, chans[0])}<div class="note">Цвет полоски — канал. Месяц целиком — вкладка «Календарь» вверху.</div></section>
  <section><h2>Аудитория · ${N} дней</h2><div class="tiles">
    ${(() => { const ds = chans.map(c => liveDelta(c.live_history, 24, 1)).filter(Boolean); const tot = chans.reduce((a, c) => a + (c.channel?.views || 0), 0);
      return kpiTile("Просмотров всего · живые", fmt(tot), ds.length ? plusH({ d: ds.reduce((a, x) => a + x.d, 0), hours: Math.max(...ds.map(x => x.hours)) }) : plusH(null), "Счётчики YouTube; остальные плитки — по Analytics с задержкой 2–3 дня"); })()}
    ${kpiTile("Подписчики, всего", fmt(chans.reduce((s, c) => s + (c.channel?.subscribers || 0), 0)), `<span class="up">+${fmt(T("subscribersGained") - T("subscribersLost"))}</span> <span class="muted">за ${N} д</span>`)}
    ${(() => { const sp = chans.reduce((a, c) => { const x = subsSplit(c, range(c, N)); return { long: a.long + x.long, short: a.short + x.short }; }, { long: 0, short: 0 }), all = sp.long + sp.short;
      return kpiTile("Подписки: ролики / Shorts", `${fmt(sp.long)} / ${fmt(sp.short)}`, all ? `${pct(sp.short / all * 100, 0)} — из Shorts` : "нет новых подписок"); })()}
    ${kpiTile("Просмотры", fmt(T("views")), delta(T("views"), P("views")), "", sumSeries(chans, "views", N))}
    ${kpiTile("Engaged-просмотры", fmt(T("engagedViews")), delta(T("engagedViews"), P("engagedViews")), "", sumSeries(chans, "engagedViews", N), "var(--s7)")}
    ${kpiTile("Часы просмотра", fmt(T("estimatedMinutesWatched") / 60), delta(T("estimatedMinutesWatched"), P("estimatedMinutesWatched")), "", sumSeries(chans, r => (r?.estimatedMinutesWatched || 0) / 60, N), "var(--s2)")}
    ${kpiTile("Доход", rev ? money(rev) : "—", rev ? "сумма по каналам" : "пока ни один канал не монетизирован")}
    ${kpiTile("Вышло за период", `${rows.reduce((s, r) => s + r.longs, 0)} + ${rows.reduce((s, r) => s + r.shorts, 0)}`, "роликов + Shorts")}
  </div></section>
  <section><h2>Конверсии по каналам · ${N} дней</h2>${convCompareHtml(chans, N)}</section>
  <section><h2>Каналы · ${N} дней</h2><div class="tablewrap"><table><thead><tr>
    <th>Канал</th><th class="n">Подписчики</th><th class="n">Прирост</th><th class="n">Подп. ролики / Shorts</th><th class="n">Просмотры</th><th class="n">Δ</th><th class="n">Часы</th><th class="n">CTR</th><th class="n">Просм.→подп.</th><th class="n">0:30 (мед.)</th><th class="n">% просм. (мед.)</th><th class="n">Вышло</th><th class="n">Доход</th><th class="n">До YPP</th></tr></thead>
    <tbody>${rows.map(r => `<tr data-open="${esc(r.ch.slug)}"><td>${esc(r.ch.channel?.title || r.ch.name)}${r.ch.errors?.length ? ' <span class="badge b-na">предупр.</span>' : ""}</td>
      <td class="n">${fmt(r.ch.channel?.subscribers)}</td><td class="n ${r.net >= 0 ? "up" : "down"}">${r.net >= 0 ? "+" : ""}${fmt(r.net)}</td><td class="n">${(() => { const x = subsSplit(r.ch, range(r.ch, N)); return `${fmt(x.long)} / ${fmt(x.short)}`; })()}</td>
      <td class="n">${fmt(r.t.views)}</td><td class="n">${r.p.views ? `<span class="${r.t.views >= r.p.views ? "up" : "down"}">${pct((r.t.views - r.p.views) / r.p.views * 100, 0)}</span>` : "—"}</td>
      <td class="n">${fmt(hours(r.t.estimatedMinutesWatched))}</td><td class="n">${lvlCell(pct(r.r?.ctr), r.r && r.r.impr >= 1000 ? level(NORMS.long.ctr.t, r.r.ctr) : "na")}</td>
      <td class="n">${pct(r.t.engagedViews ? (r.t.subscribersGained || 0) / r.t.engagedViews * 100 : null, 2)}</td>
      <td class="n">${lvlCell(pct(r.ret, 0), level(NORMS.long.ret30.t, r.ret))}</td><td class="n">${lvlCell(pct(r.apv, 0), level(NORMS.long.apv.t, r.apv))}</td>
      <td class="n">${r.longs} + ${r.shorts}</td><td class="n">${r.rv?.rev != null ? money(r.rv.rev) : "—"}</td><td class="n">${r.earning ? '<span class="up">монетизирован</span>' : pct(r.yppP, 0)}</td></tr>`).join("")}</tbody></table></div>
    <div class="note">Сравнивайте каналы по медианам и конверсиям, а не по абсолютам. «До YPP» — грубая сводка: половина — подписчики, половина — часы или Shorts.</div></section>
  <section class="grid g2">
    <div class="card"><h2>Выбросы — кандидаты на продолжение</h2>${allOut.length ? `<div class="alerts">${allOut.map(o => `<div class="alert good" data-video="${esc(o.id)}" data-ch="${esc(o.ch.slug)}" style="cursor:pointer"><span class="ic">★</span><div><b>×${o.ratio.toFixed(1)} к медиане · ${esc(o.ch.channel?.title || o.ch.name)}</b><div class="small ink2">${esc(o.v.title)} — за ${o.win}</div></div></div>`).join("")}</div>` : `<div class="empty">Пока нет роликов в 2+ раза выше медианы канала</div>`}</div>
    <div class="card"><h2>Тревоги по всем каналам</h2>${alertsHtml(allAlerts, null)}</div>
  </section>`;
}

// ---------------------------------------------------------------- events
document.addEventListener("click", e => {
  const tab = e.target.closest("[data-tab]");
  if (tab) { S.tab = tab.dataset.tab; renderShell(); return; }
  const cc = e.target.closest("[data-calch]");
  if (cc) { const k = cc.dataset.calch; S.calHide.has(k) ? S.calHide.delete(k) : S.calHide.add(k); render(); return; }
  const per = e.target.closest("#period button");
  if (per) { S.period = +per.dataset.d; renderShell(); return; }
  const vf = e.target.closest("#vf button");
  if (vf) { S.vfilter = vf.dataset.f; render(); return; }
  const th = e.target.closest("th[data-sort]");
  if (th) { const k = th.dataset.sort; S.vsort = [k, S.vsort[0] === k ? -S.vsort[1] : -1]; render(); return; }
  const open = e.target.closest("[data-open]");
  if (open) { S.view = open.dataset.open; S.tab = "overview"; renderShell(); return; }
  const vid = e.target.closest("[data-video]");
  if (vid) {
    let slug = vid.dataset.ch || S.view;
    if (!S.ch[slug]) slug = Object.keys(S.ch).find(s => S.ch[s].videos?.[vid.dataset.video]);
    openVideo(slug, vid.dataset.video); return;
  }
  const url = e.target.closest("[data-url]");
  if (url) { window.open(url.dataset.url, "_blank", "noopener"); return; }
  if (e.target.id === "dclose" || e.target.id === "drawer") closeDrawer();
});
document.addEventListener("keydown", e => { if (e.key === "Escape") closeDrawer(); });
$("#channel").addEventListener("change", e => { S.view = e.target.value; renderShell(); });
$("#theme").addEventListener("click", () => {
  const cur = document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const next = cur === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next; store.set("ytdash.theme", next); render();
});
matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => render());

// ---------------------------------------------------------------- boot
// ---------------------------------------------------------------- auto refresh: every 10 min + when the tab comes back
function ago(iso) {
  const m = Math.round((Date.now() - new Date(iso)) / 6e4);
  return m < 1 ? "только что" : m < 60 ? `${m} мин назад` : m < 48 * 60 ? `${Math.floor(m / 60)} ч ${m % 60 ? (m % 60) + " мин " : ""}назад` : fmtDate(iso);
}
function paintFresh() {
  const el = $("#fresh");
  if (!S.freshAt) { el.textContent = ""; return; }
  const old = Date.now() - new Date(S.freshAt) > 2.5 * 36e5;
  el.textContent = `${S.refreshing ? "обновляю…" : "данные " + ago(S.freshAt)} · Analytics ${S.lastA ? "по " + fmtDate(S.lastA + "T12:00:00", false) : "ещё без данных"}`;
  el.classList.toggle("stale", old);
  el.title = "Нажмите, чтобы проверить свежие данные. Сбор — каждый час; живые счётчики сразу, YouTube Analytics — с задержкой 2–3 дня.";
}
async function refreshData(force = false) {
  if (S.refreshing || !S.pw || (document.hidden && !force)) return;
  S.refreshing = true; paintFresh();
  try {
    const idx = await decrypt(await fetchText("index.enc"), S.pw);
    if (force || idx.generated_at !== S.index?.generated_at) {
      await unlock(S.pw);
      if (!$("#drawer").classList.contains("hidden")) S.pendingRender = true;
      else { const y = window.scrollY; renderShell(); window.scrollTo(0, y); }
    }
  } catch { /* offline or mid-deploy: try again next tick */ }
  S.refreshing = false; paintFresh();
}
setInterval(() => refreshData(), 10 * 60e3);
setInterval(paintFresh, 60e3);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshData(); });
document.addEventListener("click", e => { if (e.target.closest("#fresh")) refreshData(true); });

async function unlock(pw) {
  S.pw = pw;
  const index = await decrypt(await fetchText("index.enc"), pw);
  S.index = index;
  const results = await Promise.allSettled(index.channels.map(async c => [c.slug, await decrypt(await fetchText(c.slug + ".enc"), pw)]));
  for (const r of results) if (r.status === "fulfilled") S.ch[r.value[0]] = r.value[1];
}
async function boot() {
  const theme = store.get("ytdash.theme");
  if (theme) document.documentElement.dataset.theme = theme;
  S.view = store.get("ytdash.view"); S.tab = store.get("ytdash.tab"); S.period = +(store.get("ytdash.period") || 28);
  let saved = DEMO ? "demo" : store.get(PW_KEY);
  if (saved) {
    try { await unlock(saved); return start(); } catch (e) {
      if (String(e.message) === "404") return noData();
      if (!DEMO) store.del(PW_KEY);
    }
  }
  try { await fetchText("index.enc"); } catch { return noData(); }
  $("#lock").classList.remove("hidden");
  $("#pw").focus();
  $("#lockform").onsubmit = async ev => {
    ev.preventDefault();
    const pw = $("#pw").value;
    try { await unlock(pw); store.set(PW_KEY, pw); $("#lock").classList.add("hidden"); start(); }
    catch { $("#pwerr").classList.remove("hidden"); }
  };
}
function noData() {
  $("#lock").classList.remove("hidden");
  $("#lockform").innerHTML = `<div style="font-weight:650;font-size:17px">YouTube-пульт</div><div class="muted small">Сборщик ещё не записал данные. Как только GitHub Actions отработает (каждые 3 часа), здесь появится дашборд. Пока можно посмотреть <a href="?demo">демо</a>.</div>`;
}
function start() { $("#app").classList.remove("hidden"); renderShell(); }
function whenChart(fn) { if (window.Chart) fn(); else window.addEventListener("load", fn, { once: true }); }
whenChart(boot);
