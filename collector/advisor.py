"""Improvement advisor: one rule set for every channel of the dashboard.

Input  = a channel's collected data (collect.py) + what its pipeline repo says was already changed
         (docs/IMPROVEMENTS.md experiments, Short-cover and pinned-comment ledgers, the analyst's last decisions).
Output = `advice`, shown on the dashboard tab «Улучшения» and sent to Telegram by the pipeline's tools/dashboard.py:
  zones        weak spots against the norms: value, which videos, likely causes, the way out, when to escalate;
               `covered_by` lists running experiments on that metric — «исправлено, ждём проверки», not a new idea
  quick        things that can be changed on what is already published and pay off at once (repackage a low-CTR
               video, covers, pins, a continuation of an outlier) — requests for Evgenii's «да», nothing is auto-fixed
  experiments  the ledger with a computed state: waiting for data / first data / time for a verdict (+ evidence)
  risks        operational and platform risks with the way out
Rules of judgement (same as the daily analysis): a video counts when it is >= 3 days old with >= 50 impressions or
>= 20 engaged views; a Short when >= 2 days old with >= 100 views; Analytics lags 2-3 days. One video is not a
conclusion; three in a row with the same failure is.
"""
import datetime as dt
import re
import statistics

NORMS = {"ctr": (3.0, 6.0), "r30": (60.0, 70.0), "avg_pct": (30.0, 40.0), "short_engaged": (70.0, 80.0),
         "short_avg_pct": (80.0, 100.0), "sub_rate": (0.2, 1.0)}
NORM_TEXT = {"ctr": "3–6%", "r30": "60–70%", "avg_pct": "30–40%", "short_engaged": "70%+", "short_avg_pct": "80%+",
             "sub_rate": "0,2–1%"}

# The shared risk register: signal -> likely causes -> what to do -> when to escalate (from the Chalkonaut
# risk-management notes of 2026-10-08, generalised for every channel).
PLAYBOOK = {
    "ctr": {
        "title": "CTR видео (показ → просмотр)", "area": "видео",
        "causes": ["обложка не читается на телефоне", "заголовок и обложка повторяют друг друга", "тема без спроса"],
        "steps": ["перепаковать одно вышедшее видео: новая обложка ИЛИ заголовок, не вместе; сравнить через 48–72 ч",
                  "следующее видео — обложка-сравнение и заголовок из знакомых слов",
                  "проверить обложку в мелком размере и её верхнюю половину (ТВ)"],
        "escalate": "CTR ниже 3% на 3 видео подряд — менять шаблон обложки целиком"},
    "r30": {
        "title": "Досмотр до 0:30", "area": "видео",
        "causes": ["первые 30 секунд не подтверждают обложку", "медленный вход", "первый кадр не тот, что на обложке"],
        "steps": ["первые 5–6 секунд = объект с обложки; часть ответа в первые 30–45 секунд",
                  "смотреть секунду провала на кривой удержания каждого нового видео",
                  "никакой «служебной» вводной в начале"],
        "escalate": "ниже 50% три раза подряд — менять тип начала"},
    "avg_pct": {
        "title": "Средний % просмотра", "area": "видео",
        "causes": ["провисание в середине", "блоки длиннее 90 секунд", "формальные «перезацепки»"],
        "steps": ["найти блок, где обрыв, сократить или убрать слабые блоки",
                  "видео 8–10 минут вместо 11–12, пока удержание низкое"],
        "escalate": "ниже 25% на 3 видео — сократить формат до 7–8 минут"},
    "impressions": {
        "title": "Показы падают", "area": "видео",
        "causes": ["тема без спроса или ниша переполнена", "предыдущие видео не удержали — YouTube показывает меньше"],
        "steps": ["темы — по выбросам и запросам, продолжения выстреливших тем", "плейлисты-серии из близких видео"],
        "escalate": "две недели без роста показов — пересмотр списка тем"},
    "sub_rate": {
        "title": "Просмотр → подписка (видео)", "area": "видео",
        "causes": ["нет причины подписаться: серия и следующий выпуск не названы", "случайная аудитория из шортсов"],
        "steps": ["в конце называть следующее видео серии и просить подписаться одной фразой",
                  "конечная заставка: следующее видео + подписка"],
        "escalate": "—"},
    "short_engaged": {
        "title": "Шортсы: смотрят, а не листают", "area": "шортсы",
        "causes": ["слабые первые 1–3 секунды", "горизонтальная картинка в вертикальном кадре", "нет обложки-вопроса"],
        "steps": ["первый кадр = вопрос или самый сильный факт", "только вертикальные кадры",
                  "обложка шортса в Studio сразу после выхода"],
        "escalate": "ниже 50% на 5 новых шортсах — менять принцип выбора фрагментов"},
    "short_avg_pct": {
        "title": "Шортсы: средний % просмотра", "area": "шортсы",
        "causes": ["фрагмент начинается «с середины»", "слишком длинный"],
        "steps": ["фрагмент понятен без контекста, 45–58 секунд", "концовка закольцована на начало"],
        "escalate": "—"},
    "shorts_subs": {
        "title": "Подписчики приходят в основном из шортсов", "area": "рост",
        "causes": ["шортсы набирают быстрее видео — это другая аудитория"],
        "steps": ["на 7-й и 28-й день смотреть долю; выше 50% — меньше шортсов, ставка на видео",
                  "в шортсах вести на полное видео"],
        "escalate": "такие подписчики реже смотрят видео и тянут вниз CTR"},
    "cadence": {
        "title": "Выпуск ниже плана", "area": "производство",
        "causes": ["видео ждёт «Ок»", "сбой облачного запуска или публикации", "кончились кредиты или лимит Claude"],
        "steps": ["проверить «Ждут твоего Ок» и журнал публикаций", "см. риски ниже"],
        "escalate": "—"},
}
STATUS_RUNNING, STATUS_DONE, STATUS_PLAN = "идёт", "внедрено", "заплан"


def ru(x, nd=1):
    if x is None:
        return "—"
    s = f"{x:.{nd}f}"
    if "." in s:
        s = s.rstrip("0").rstrip(".")
    return s.replace(".", ",")


def short(title, n=46):
    t = re.sub(r"\s*#\w+", "", title or "").strip()
    return t if len(t) <= n else t[:n - 1].rsplit(" ", 1)[0] + "…"


def parse_iso(s):
    return dt.datetime.fromisoformat(s.replace("Z", "+00:00"))


def retention_at(v, sec):
    r, dur = v.get("retention") or [], v.get("duration") or 0
    if not r or not dur:
        return None
    x = sec / dur
    pts = [(p[0], p[1]) for p in r]
    if x <= pts[0][0]:
        return round(100 * pts[0][1], 1)
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        if x0 <= x <= x1:
            return round(100 * (y0 + (y1 - y0) * (x - x0) / ((x1 - x0) or 1)), 1)
    return round(100 * pts[-1][1], 1)


def reach_between(v, start=None, end=None):
    imp = clk = 0.0
    for day, (i, c) in (v.get("reach") or {}).items():
        if (start is None or day >= start) and (end is None or day <= end):
            imp += i
            clk += c
    return imp, clk


def video_rows(data, now):
    rows = []
    for vid, v in (data.get("videos") or {}).items():
        if v.get("privacy") != "public" or not v.get("published_at"):
            continue
        a = v.get("a") or {}
        pub = parse_iso(v["published_at"])
        age = (now - pub).total_seconds() / 86400
        imp, clk = reach_between(v)
        views = max((v.get("stats") or {}).get("viewCount") or 0, a.get("views") or 0)
        eng = a.get("engagedViews") or 0
        is_short = v.get("format") == "short"
        row = {"id": vid, "title": v.get("title", vid), "short": is_short, "age": age, "pub": pub, "views": views,
               "eng": eng, "impr": imp, "ctr": 100 * clk / imp if imp >= 1 else None,
               "avg_pct": a.get("averageViewPercentage") if a.get("views") else None,
               "subs": a.get("subscribersGained") or 0, "duration": v.get("duration") or 0,
               "r15": None if is_short else retention_at(v, 15), "r30": None if is_short else retention_at(v, 30),
               "engaged_share": 100 * eng / a["views"] if is_short and a.get("views") else None,
               "first_views": first_window(v, pub)}
        row["enough"] = (age >= 2 and views >= 100) if is_short else (age >= 3 and (imp >= 50 or eng >= 20))
        rows.append(row)
    return sorted(rows, key=lambda r: r["pub"], reverse=True)


def first_window(v, pub, days=7):
    """Views of the first `days` days (Analytics), else None."""
    rows = (v.get("daily") or {}).get("rows") or []
    if not rows:
        return None
    end = (pub + dt.timedelta(days=days - 1)).date().isoformat()
    return sum(r[1] or 0 for r in rows if r[0] <= end)


# ---------------------------------------------------------------- experiments ledger (docs/IMPROVEMENTS.md)
def parse_experiments(md):
    out = []
    for line in (md or "").splitlines():
        if not line.startswith("|"):
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) < 8 or cells[0] in ("ID", "") or set(cells[0]) <= set("-: "):
            continue
        eid, date, change, hyp, metric, base, check, status = cells[:8]
        out.append({"id": eid, "date": date, "change": change, "hypothesis": hyp, "metric": metric, "baseline": base,
                    "check": check, "status": status})
    return out


def metric_keys(text):
    t = (text or "").lower()
    keys = set()
    if "ctr" in t:
        keys.add("ctr")
    if "0:30" in t or "0:15" in t or "досмотр" in t:
        keys.add("r30")
    if "средний %" in t or "средний процент" in t or "кривая после" in t:
        keys.add("avg_pct")
    if "engaged" in t or "пролист" in t or "смотрят" in t:
        keys.add("short_engaged")
    if "шортс" in t and "средний" in t:
        keys.add("short_avg_pct")
    if "показ" in t:
        keys.add("impressions")
    return keys


def experiment_state(e, rows_by_id, today):
    status = e["status"].lower()
    ids = [x for x in re.findall(r"[\w-]{11}", e["check"]) if x in rows_by_id]
    due = (re.search(r"итог\s+(\d{4}-\d{2}-\d{2})", e["check"] + " " + e["status"]) or [None, None])[1]
    start = (re.search(r"\d{4}-\d{2}-\d{2}", e["date"]) or [None])[0]
    keys = metric_keys(e["metric"])
    evidence, n_enough = [], 0
    repack = bool(re.search(r"переупаков|перепаков", e["change"].lower()))
    for vid in ids:
        r = rows_by_id[vid]
        if repack and start:  # CTR before vs after the change date, from the daily reach reports
            bi, bc = reach_between(r["raw"], end=(dt.date.fromisoformat(start) - dt.timedelta(days=1)).isoformat())
            ai, ac = reach_between(r["raw"], start=start)
            if ai >= 50:
                n_enough += 1
            before = f"{ru(100 * bc / bi)}% на {int(bi)} показах" if bi >= 1 else "нет данных"
            after = f"{ru(100 * ac / ai)}% на {int(ai)} показах" if ai >= 1 else "показов после смены ещё нет"
            evidence.append(f"{short(r['title'], 34)}: CTR до {before} → после {after}")
            continue
        if r["enough"]:
            n_enough += 1
        parts = []
        if "ctr" in keys and not r["short"]:
            parts.append(f"CTR {ru(r['ctr'])}% ({int(r['impr'])} показов)")
        if "r30" in keys and not r["short"]:
            parts.append(f"0:15 {ru(r['r15'], 0)}% · 0:30 {ru(r['r30'], 0)}%")
        if "avg_pct" in keys and not r["short"]:
            parts.append(f"средний {ru(r['avg_pct'], 0)}%")
        if "short_engaged" in keys and r["short"]:
            parts.append(f"смотрят {ru(r['engaged_share'], 0)}%")
        if parts:
            evidence.append(f"{short(r['title'], 34)}: {' · '.join(parts)}" + ("" if r["enough"] else " — данных пока мало"))
    if STATUS_PLAN in status:
        state, text = "planned", "запланировано, ещё не внедрено"
    elif STATUS_RUNNING not in status:
        state, text = ("done", "внедрено, итог не подводился") if STATUS_DONE in status else ("closed", e["status"])
    elif due and today.isoformat() >= due:
        state, text = "verdict", f"срок итога {due} наступил — пора подводить итог"
    elif n_enough >= 2:
        state, text = "verdict", f"данные есть по {n_enough} — пора подводить итог"
    elif n_enough == 1:
        state, text = "partial", "первые данные по 1, ждём ещё" + (f" (итог {due})" if due else "")
    else:
        state, text = "waiting", "ждём данных: проверочные видео ещё не набрали показов" + (f" (итог {due})" if due else "")
    return {**e, "state": state, "state_text": text, "evidence": evidence[:6], "due": due, "videos": ids,
            "metrics": sorted(keys), "repack": repack}


# ---------------------------------------------------------------- zones
def zone(key, values, lo, hi, exps, rows, value_key, unit="%", extra=None):
    """values = judged rows (newest first). Median of the newest 5; streak = the newest 3 all below the norm."""
    pb = PLAYBOOK[key]
    vals = [r[value_key] for r in rows if r.get(value_key) is not None][:5]
    z = {"key": key, "title": pb["title"], "area": pb["area"], "norm": NORM_TEXT.get(key, ""), "unit": unit,
         "causes": pb["causes"], "steps": pb["steps"], "escalate": pb["escalate"], "n": len(vals),
         "covered_by": [e["id"] for e in exps if e["state"] in ("waiting", "partial", "verdict") and key in e["metrics"]]}
    if not vals:
        return {**z, "level": "na", "value": None, "detail": "данных пока мало — судить рано", "weak": [], "streak": False}
    med = statistics.median(vals)
    weak = [r for r in rows if r.get(value_key) is not None and r[value_key] < lo][:5]
    newest3 = [r[value_key] for r in rows if r.get(value_key) is not None][:3]
    streak = len(newest3) == 3 and all(x < lo for x in newest3)
    level = "weak" if med < lo else ("good" if med >= hi else "norm")
    detail = f"медиана {ru(med)}{unit} по {len(vals)} (норма {NORM_TEXT.get(key, '')})"
    if streak:
        detail += " · три подряд ниже нормы — это уже вывод"
    elif level == "weak" and len(vals) < 3:
        detail += " · выборка мала, это сигнал, а не вывод"
    return {**z, "level": level, "value": round(med, 2), "detail": detail, "streak": streak,
            "weak": [{"id": r["id"], "title": short(r["title"]), "value": round(r[value_key], 2)} for r in weak], **(extra or {})}


def build(data, extras=None, now=None):
    extras = extras or {}
    now = now or dt.datetime.now(dt.timezone.utc)
    today = now.date()
    rows = video_rows(data, now)
    for r in rows:
        r["raw"] = data["videos"][r["id"]]
    by_id = {r["id"]: r for r in rows}
    vids = [r for r in rows if not r["short"] and r["enough"]]
    shorts = [r for r in rows if r["short"] and r["enough"]]
    exps = [experiment_state(e, by_id, today) for e in parse_experiments(extras.get("improvements_md"))]

    zones = [zone("ctr", None, *NORMS["ctr"], exps, [r for r in vids if r["impr"] >= 200], "ctr"),
             zone("r30", None, *NORMS["r30"], exps, vids, "r30"),
             zone("avg_pct", None, *NORMS["avg_pct"], exps, vids, "avg_pct"),
             zone("short_engaged", None, *NORMS["short_engaged"], exps, shorts, "engaged_share"),
             zone("short_avg_pct", None, *NORMS["short_avg_pct"], exps, shorts, "avg_pct")]
    for r in vids:
        r["sub_rate"] = 100 * r["subs"] / r["eng"] if r["eng"] >= 100 else None
    zones.append(zone("sub_rate", None, *NORMS["sub_rate"], exps, vids, "sub_rate"))
    zones += [z for z in (impressions_zone(data, today, exps), shorts_subs_zone(data, today), cadence_zone(data, now)) if z]

    quick = quick_actions(data, rows, vids, exps, extras, now)
    risks = risk_list(data, now)
    for r in rows:
        r.pop("raw", None)
    return {"generated_at": now.isoformat(timespec="seconds"), "judged": {"videos": len(vids), "shorts": len(shorts)},
            "zones": zones, "quick": quick, "experiments": exps, "risks": risks, "decisions": extras.get("decisions"),
            "handled": handled_list(extras, now)}


def channel_reach_by_day(data):
    days = {}
    for v in (data.get("videos") or {}).values():
        if v.get("format") == "short":
            continue
        for day, (i, _c) in (v.get("reach") or {}).items():
            days[day] = days.get(day, 0) + i
    return days


def impressions_zone(data, today, exps):
    days = channel_reach_by_day(data)
    if not days:
        return None
    last = max(days)
    end = dt.date.fromisoformat(last)
    cur = sum(v for d, v in days.items() if d > (end - dt.timedelta(days=7)).isoformat())
    prev = sum(v for d, v in days.items() if (end - dt.timedelta(days=14)).isoformat() < d <= (end - dt.timedelta(days=7)).isoformat())
    if prev < 300:
        return None
    change = 100 * (cur - prev) / prev
    pb = PLAYBOOK["impressions"]
    level = "weak" if change <= -30 else ("good" if change >= 30 else "norm")
    return {"key": "impressions", "title": pb["title"] if level == "weak" else "Показы видео за 7 дней", "area": pb["area"],
            "norm": "без падения", "unit": "%", "level": level, "value": round(change, 1), "n": 2, "streak": False, "weak": [],
            "detail": f"{int(cur)} показов за 7 дней против {int(prev)} неделей раньше ({'+' if change > 0 else ''}{ru(change, 0)}%)",
            "causes": pb["causes"], "steps": pb["steps"], "escalate": pb["escalate"],
            "covered_by": [e["id"] for e in exps if e["state"] in ("waiting", "partial", "verdict") and "impressions" in e["metrics"]]}


def daily_sum(data, key, col, days, today):
    r = (data.get("daily") or {}).get(key) or {}
    cols, rows = r.get("cols") or [], r.get("rows") or []
    if col not in cols or not rows:
        return 0
    i, start = cols.index(col), (dt.date.fromisoformat(rows[-1][0]) - dt.timedelta(days=days - 1)).isoformat()
    return sum(x[i] or 0 for x in rows if x[0] >= start)


def shorts_subs_zone(data, today):
    s, l = daily_sum(data, "SHORTS", "subscribersGained", 28, today), daily_sum(data, "VIDEO_ON_DEMAND", "subscribersGained", 28, today)
    if s + l < 20:
        return None
    share = 100 * s / (s + l)
    pb = PLAYBOOK["shorts_subs"]
    return {"key": "shorts_subs", "title": pb["title"] if share > 50 else "Доля подписчиков из шортсов", "area": pb["area"],
            "norm": "до 50%", "unit": "%", "level": "weak" if share > 50 else "norm", "value": round(share, 1), "n": int(s + l),
            "streak": False, "weak": [], "detail": f"{int(s)} из {int(s + l)} новых подписчиков за 28 дней пришли из шортсов ({ru(share, 0)}%)",
            "causes": pb["causes"], "steps": pb["steps"], "escalate": pb["escalate"], "covered_by": []}


def cadence_zone(data, now):
    items = [i for i in ((data.get("calendar") or {}).get("items") or []) if i.get("format") != "short" and i.get("date")]
    if not items:
        return None
    week_ago = (now - dt.timedelta(days=7)).isoformat()
    due = [i for i in items if week_ago[:10] <= i["date"][:10] <= now.date().isoformat()]
    if not due:
        return None
    norm = lambda t: re.sub(r"[^a-z0-9а-яё]+", " ", (t or "").lower()).strip()
    live = {vid: v for vid, v in (data.get("videos") or {}).items() if v.get("privacy") == "public"}
    live_titles = {norm(v.get("title")) for v in live.values()}
    out = lambda i: i.get("status") == "published" or i.get("youtube_id") in live or norm(i.get("title")) in live_titles
    done = [i for i in due if out(i)]
    late = [i for i in due if not out(i) and i["date"][:10] < now.date().isoformat()]
    pb = PLAYBOOK["cadence"]
    return {"key": "cadence", "title": pb["title"] if late else "Выпуск по плану", "area": pb["area"], "norm": "по плану",
            "unit": "", "level": "weak" if late else "good", "value": len(done), "n": len(due), "streak": False,
            "weak": [{"id": i.get("youtube_id"), "title": short(i["title"]), "value": None} for i in late[:5]],
            "detail": f"за 7 дней вышло {len(done)} из {len(due)} видео по плану" + (f"; не вышло: {len(late)}" if late else ""),
            "causes": pb["causes"], "steps": pb["steps"], "escalate": pb["escalate"], "covered_by": []}


# ---------------------------------------------------------------- quick actions (effect right away; requests only)
def quick_actions(data, rows, vids, exps, extras, now):
    out = []
    running = [e for e in exps if e["state"] in ("waiting", "partial", "verdict")]
    repacked = {v for e in running if e["repack"] for v in e["videos"]}
    ctrs = [r["ctr"] for r in vids if r["impr"] >= 300 and r["ctr"] is not None]
    med = statistics.median(ctrs) if len(ctrs) >= 4 else None
    for r in vids:
        if r["ctr"] is None or r["impr"] < 300 or r["age"] > 60:
            continue
        low = r["ctr"] < NORMS["ctr"][0] or (med and med >= NORMS["ctr"][0] and r["ctr"] < 0.7 * med)
        if not low:
            continue
        if r["id"] in repacked:
            continue  # already repackaged — it sits in «исправлено, ждём проверки»
        other = [e for e in running if e["repack"]]
        note = (f"уже идёт {other[0]['id']} (перепаковка других видео" + (f", итог {other[0]['due']}" if other[0].get("due") else "") +
                ") — можно дождаться итога, чтобы знать, что работает") if other else ""
        out.append({"key": f"repack:{r['id']}", "kind": "repack", "video": r["id"], "needs_yes": True, "note": note,
                    "title": f"Перепаковать «{short(r['title'], 40)}»",
                    "why": f"CTR {ru(r['ctr'])}% на {int(r['impr'])} показах (норма 3–6%" + (f", медиана канала {ru(med)}%" if med else "") + ")",
                    "action": "новая обложка ИЛИ новый заголовок (одно за раз), сравнить CTR через 48–72 ч"})
    for r in vids:  # the thumbnail burns out: CTR of days 3-7 far below the first 48 h
        if r["id"] in repacked or r["age"] > 30:
            continue
        pub = r["pub"].date()
        ei, ec = reach_between(data["videos"][r["id"]], pub.isoformat(), (pub + dt.timedelta(days=1)).isoformat())
        li, lc = reach_between(data["videos"][r["id"]], (pub + dt.timedelta(days=2)).isoformat(), (pub + dt.timedelta(days=6)).isoformat())
        if ei >= 200 and li >= 200 and ec > 0 and (lc / li) / (ec / ei) < 0.6 and not any(q["video"] == r["id"] for q in out):
            out.append({"key": f"burnout:{r['id']}", "kind": "repack", "video": r["id"], "needs_yes": True,
                        "title": f"Сменить обложку «{short(r['title'], 40)}»",
                        "why": f"CTR упал с {ru(100 * ec / ei)}% (первые 48 ч) до {ru(100 * lc / li)}% (дни 3–7)",
                        "action": "обложка «выгорела» на холодной аудитории — новая обложка, заголовок не трогать"})
    covers = extras.get("covers")
    if covers is not None:
        missing = [r for r in rows if r["short"] and r["id"] not in (covers.get("done") or {})]
        if missing:
            out.append({"key": "covers", "kind": "studio", "video": None, "needs_yes": False,
                        "title": f"Поставить обложки шортсам — {len(missing)}",
                        "why": "без обложки-вопроса шортс чаще пролистывают; Upload-Post обложки не ставит",
                        "action": "в Claude на Mac: «поставь обложки шортсам» (YouTube Studio)"})
    pins = extras.get("pins")
    if pins is not None:
        gate = ((pins.get("pin_unavailable") or {}).get("checked"))
        gated = bool(gate) and (now.date() - dt.date.fromisoformat(gate)).days < 7
        posted = pins.get("posted_not_pinned") or {}
        missing = [r for r in rows if not r["short"] and r["id"] not in (pins.get("done") or {}) and not (gated and r["id"] in posted)]
        if missing:
            out.append({"key": "pins", "kind": "studio", "video": None, "needs_yes": False,
                        "title": f"Закрепить комментарий под видео — {len(missing)}",
                        "why": "вопрос о следующей теме в закрепе даёт комментарии и идеи тем",
                        "action": "в Claude на Mac: «поставь обложки и закрепы»"})
    for fmt in (False, True):  # outliers: 5x the channel median of the first week
        peers = [r for r in rows if r["short"] == fmt and r["first_views"] is not None and r["age"] >= 2]
        if len(peers) < 4:
            continue
        m = statistics.median(r["first_views"] for r in peers)
        for r in peers:
            if m and r["first_views"] >= 5 * m and r["age"] <= 21:
                out.append({"key": f"outlier:{r['id']}", "kind": "sequel", "video": r["id"], "needs_yes": False,
                            "title": f"Сделать продолжение: «{short(r['title'], 40)}»",
                            "why": f"{int(r['first_views'])} просмотров за первую неделю — в {ru(r['first_views'] / m, 0)} раз выше медианы канала",
                            "action": "тема и подача попали — поставить продолжение первым в список тем"})
    cal = {i.get("id"): i for i in ((data.get("calendar") or {}).get("items") or [])}
    for slug, c in (((data.get("costs") or {}).get("videos")) or {}).items():
        rv = c.get("review") or {}
        out_already = c.get("youtube_id") or (cal.get(slug) or {}).get("status") in ("published", "scheduled")
        if rv.get("waiting") and rv.get("last_sent") and not out_already:
            hours = (now - parse_iso(rv["last_sent"])).total_seconds() / 3600
            if hours >= 24:
                out.append({"key": f"ok:{slug}", "kind": "approve", "video": None, "needs_yes": False,
                            "title": f"Ответить «Ок» на превью: «{short((cal.get(slug) or {}).get('title') or slug, 36)}»",
                            "why": f"видео ждёт {int(hours)} ч — слот публикации сдвигается",
                            "action": "посмотреть превью в чате с ботом и ответить «Ок» или правки"})
    handled = extras.get("handled") or {}
    return [q for q in out if q["key"] not in handled]


def handled_list(extras, now, days=21):
    """Quick actions already carried out (docs/advice_handled.json in the pipeline repo): shown as done, not re-proposed."""
    out = []
    for key, h in (extras.get("handled") or {}).items():
        date = (h or {}).get("date") or ""
        if not date or (now.date() - dt.date.fromisoformat(date[:10])).days <= days:
            out.append({"key": key, "date": date[:10], "note": (h or {}).get("note", "")})
    return sorted(out, key=lambda x: x["date"], reverse=True)


# ---------------------------------------------------------------- risks
def risk_list(data, now):
    out = []
    costs = data.get("costs") or {}
    bal = (costs.get("hf_balance") or [[None, None]])[-1][1]
    facts = [v["hf"]["fact"] for v in (costs.get("videos") or {}).values() if not v.get("trial") and (v.get("hf") or {}).get("fact")]
    if bal is not None and facts:
        per = statistics.median(facts)
        n = int(bal // per) if per else None
        if n is not None and n < 3:
            out.append({"key": "hf_credits", "severity": "critical" if n < 2 else "warning", "shared": True,
                        "title": "Кредиты Higgsfield заканчиваются", "detail": f"баланс {ru(bal, 0)} — это примерно {n} видео (одно ≈ {ru(per, 0)} кредитов)",
                        "way_out": "пополнить до следующих запусков; баланс общий на все каналы"})
    lim = (costs.get("claude_limits") or [None])[-1]
    if lim and (lim.get("weekly") or 0) >= 80 and (now - parse_iso(lim["t"])).days < 3:
        out.append({"key": "claude_limit", "severity": "warning", "shared": True, "title": "Недельный лимит Claude почти исчерпан",
                    "detail": f"использовано {ru(lim['weekly'], 0)}% (снимок {lim['t'][:10]})",
                    "way_out": "облачные запуски могут остановиться: перенести создание видео или поднять тариф"})
    cal = (data.get("calendar") or {}).get("items") or []
    for i in cal:
        if i.get("status") == "failed":
            out.append({"key": f"failed:{i.get('id')}", "severity": "critical", "title": "Публикация не прошла",
                        "detail": f"«{short(i.get('title', ''))}» — причина в publish_log.md",
                        "way_out": "разобрать причину; с Mac не перезаливать без решения"})
    soon = [i for i in cal if i.get("format") != "short" and i.get("date") and now.isoformat()[:10] <= i["date"][:10]
            <= (now + dt.timedelta(days=7)).isoformat()[:10]]
    if cal and not soon:
        out.append({"key": "empty_schedule", "severity": "warning", "title": "Пустое расписание",
                    "detail": "на ближайшие 7 дней нет ни одного видео в плане", "way_out": "проверить список тем и облачные запуски"})
    if data.get("errors"):
        out.append({"key": "collector", "severity": "info", "title": "Сбор данных прошёл с предупреждениями",
                    "detail": "; ".join(str(e)[:80] for e in data["errors"][:2]), "way_out": "смотреть журнал collect в GitHub Actions"})
    ypp = data.get("ypp") or {}
    subs, gained = ypp.get("subscribers") or 0, daily_sum(data, "all", "subscribersGained", 28, now.date()) - daily_sum(data, "all", "subscribersLost", 28, now.date())
    if subs < 1000 and gained > 0:
        days = (1000 - subs) / (gained / 28)
        eta = now.date() + dt.timedelta(days=int(min(days, 36500)))
        if eta > dt.date(2027, 2, 1):
            out.append({"key": "ypp_pace", "severity": "info", "title": "Монетизация: порог вырастет 01.02.2027",
                        "detail": f"при темпе +{int(gained)} подписчиков за 28 дней 1000 наберётся к {eta.isoformat()} — уже по новым правилам (8000 часов вместо 4000)",
                        "way_out": "ставка на удержание видео и продолжения выбросов, плейлисты-серии"})
    return out
