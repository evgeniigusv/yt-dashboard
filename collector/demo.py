"""Synthetic demo data in the collector's format (site/demo/*.enc, password "demo"). Open the site with ?demo.

All numbers and titles are made up — only the shape matches real collector output.
"""
import datetime as dt
import json
import math
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from crypto import encrypt  # noqa: E402

OUT = Path(__file__).resolve().parent.parent / "site" / "demo"
TODAY = dt.datetime.now(dt.timezone.utc).date()
CORE = ["views", "engagedViews", "estimatedMinutesWatched", "averageViewDuration", "subscribersGained", "subscribersLost",
        "likes", "comments", "shares"]
RUBRICS = {"A": {"name": "Всё о типах"}, "B": {"name": "Топ-10"}, "C": {"name": "История объекта"},
           "D": {"name": "Что если"}, "E": {"name": "Путешествие по масштабу"}, "F": {"name": "Почему…"}}
TITLES = ["Every Kind of Comet Explained", "10 Loudest Things in the Universe", "The Star That Refused to Die",
          "What If the Moon Doubled in Size?", "From a Grain of Sand to a Galaxy", "Why Do Stars Twinkle?",
          "Every Type of Asteroid Explained", "10 Coldest Places Ever Measured", "The Planet Made of Diamonds",
          "What If Mars Had Oceans Again?", "How Big Is a Light-Year, Really?", "Why Is the Sky Blue on Earth Only?",
          "Every Type of Star Explained", "10 Fastest Objects in Space", "The Moon That Hides an Ocean",
          "What If You Lived on Titan?", "The Edge of the Solar System", "Why Don't Planets Crash Into the Sun?"]


def gen_channel(slug, name, seed, created_days, scale):
    rnd = random.Random(seed)
    created = TODAY - dt.timedelta(days=created_days)
    videos, cal_items = {}, []
    day = created + dt.timedelta(days=3)
    i = 0
    vid_n = 0

    def vid_id():
        nonlocal vid_n
        vid_n += 1
        return f"{slug[:3]}{seed}{vid_n:05d}x"[:11]

    while day <= TODAY + dt.timedelta(days=21):
        if day.weekday() in (1, 3, 5):
            title = TITLES[i % len(TITLES)] + ("" if i < len(TITLES) else f" (Part {i // len(TITLES) + 1})")
            rub = "ABCDEF"[i % 6]
            pid = f"{day}_{i}"
            i += 1
            past = day <= TODAY - dt.timedelta(days=1)
            mult = rnd.lognormvariate(0, 0.7) * scale * (1 + i / 25)
            if past:
                lid = vid_id()
                videos[lid] = video(rnd, title, day, "long", mult, 600 + rnd.randint(0, 300))
                cal_items.append({"id": pid, "format": "long", "title": title, "rubric": rub, "status": "published", "youtube_id": lid})
            elif day <= TODAY + dt.timedelta(days=2):
                lid = vid_id()
                videos[lid] = {"title": title, "published_at": f"{day - dt.timedelta(days=1)}T10:00:00Z",
                               "publish_at": f"{day}T22:00:00Z", "privacy": "private", "duration": 690, "format": "long",
                               "thumb": None, "stats": {}}
                cal_items.append({"id": pid, "format": "long", "title": title, "rubric": rub, "status": "scheduled", "youtube_id": lid})
            else:
                st = "ready" if day <= TODAY + dt.timedelta(days=5) else ("in_production" if day <= TODAY + dt.timedelta(days=8) else "planned")
                cal_items.append({"id": pid, "format": "long", "title": title, "rubric": rub, "status": st,
                                  "date": f"{day}T22:00:00Z" if st != "planned" else str(day)})
            for k, (off, hh) in enumerate(((0, 1), (1, 16), (2, 16))):
                sday = day + dt.timedelta(days=off)
                stitle = f"{title.split(' (')[0]}: fact #{k + 1} #shorts"
                sid = f"{pid}-s{k + 1}"
                if sday <= TODAY - dt.timedelta(days=1):
                    vid = vid_id()
                    videos[vid] = video(rnd, stitle, sday, "short", mult * 3, 35 + rnd.randint(0, 20))
                    cal_items.append({"id": sid, "format": "short", "title": stitle, "rubric": rub, "parent": pid,
                                      "status": "published", "youtube_id": vid})
                else:
                    cal_items.append({"id": sid, "format": "short", "title": stitle, "rubric": rub, "parent": pid,
                                      "status": "scheduled" if sday <= TODAY + dt.timedelta(days=3) else "planned",
                                      "date": f"{sday}T{hh + 1:02d}:00:00Z"})
        day += dt.timedelta(days=1)

    # channel daily = sum of video dailies
    agg = {"all": {}, "SHORTS": {}, "VIDEO_ON_DEMAND": {}}
    for v in videos.values():
        if "daily" not in v:
            continue
        key = "SHORTS" if v["format"] == "short" else "VIDEO_ON_DEMAND"
        for row in v["daily"]["rows"]:
            d = row[0]
            for k in ("all", key):
                cur = agg[k].setdefault(d, [0] * len(CORE))
                views, eng, mins, subs, likes, comm, shares = row[1:]
                vals = [views, eng, mins, 0, subs, round(subs * 0.12), likes, comm, shares]
                agg[k][d] = [a + b for a, b in zip(cur, vals)]
    daily = {}
    for k, rows in agg.items():
        out = []
        for d in sorted(rows):
            r = rows[d]
            r[3] = round(r[2] * 60 / r[0]) if r[0] else 0
            out.append([d] + r)
        daily[k] = {"cols": ["day"] + CORE, "rows": out}
    daily["revenue"] = None
    subs = sum(r[5] - r[6] for r in daily["all"]["rows"])
    long_min = sum(r[3] for r in daily["VIDEO_ON_DEMAND"]["rows"])
    sh90 = sum(r[2] for r in daily["SHORTS"]["rows"] if r[0] >= str(TODAY - dt.timedelta(days=90)))
    traffic = lambda shares: {"cols": ["insightTrafficSourceType", "views", "estimatedMinutesWatched"],
                              "rows": [[k, int(v * 10000), int(v * 30000)] for k, v in shares]}
    # made-up production costs in the pipeline's costs.json shape
    costs = {"videos": {}, "hf_balance": [], "claude_runs": [], "claude_limits": [], "hf_plan": "plus", "hf_unattributed": 12.5}
    bal = 4000.0
    for it in cal_items:
        if it["format"] != "long" or it["status"] not in ("published", "scheduled"):
            continue
        sec = videos[it["youtube_id"]]["duration"]
        fact = round(sec / 60 * rnd.uniform(7, 9.5), 1)
        shorts = [x["youtube_id"] for x in cal_items if x.get("parent") == it["id"] and x.get("youtube_id")]
        costs["videos"][it["id"]] = {"youtube_id": it["youtube_id"], "shorts_ids": shorts, "seconds": sec,
            "hf": {"plan": round(sec / 60 * 8, 1), "fact": fact, "steps": {"voice": round(fact * .4, 1), "images": round(fact * .55, 1), "thumbnails": round(fact * .05, 1)}},
            "minutes": {"fact": rnd.randint(55, 95)},
            "claude": {"fact": {"output": rnd.randint(150000, 260000), "input": 9000, "cache_write": 1200000, "cache_read": 40000000, "turns": 300},
                       "steps": {"make": {"output": 200000, "input": 8000, "cache_write": 1000000, "cache_read": 35000000}, "publish": {"output": 15000, "input": 500, "cache_write": 100000, "cache_read": 3000000}}},
            "claude_plan": {"output": 210000}, "topic_at": (dt.datetime.fromisoformat(videos[it["youtube_id"]]["published_at"].replace("Z", "+00:00")) - dt.timedelta(days=rnd.uniform(1.5, 4))).isoformat(),
            "review": {"rounds": rnd.choice([1, 1, 2]), "edits": rnd.choice([0, 0, 1]), "first_sent": None, "approved_at": None, "waiting": False}}
        bal -= fact
        costs["hf_balance"].append([videos[it["youtube_id"]]["published_at"], round(bal, 2)])
        costs["claude_runs"].append({"slug": it["id"], "step": "make", "t": videos[it["youtube_id"]]["published_at"], "output": 200000})
    ready = [x for x in cal_items if x["format"] == "long" and x["status"] == "ready"][:1]
    for x in ready:
        costs["videos"][x["id"]] = {"review": {"rounds": 2, "edits": 1, "last_sent": (dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=5)).isoformat(), "waiting": True}}
    costs["claude_limits"].append({"t": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), "five_hour": 40.0, "weekly": 63.0})
    return {
        "v": 1, "slug": slug, "name": name, "channel_id": "DEMO" + slug, "demo": True, "costs": costs, "telegram_bot": "example_bot",
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "channel": {"id": "DEMO" + slug, "title": name, "published_at": f"{created}T00:00:00Z", "subscribers": subs,
                    "views": sum(r[1] for r in daily["all"]["rows"]), "video_count": len(videos)},
        "subs_history": [], "daily_refresh": str(TODAY), "daily": daily, "videos": videos,
        "live_history": [[(dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=72 - h)).isoformat(timespec="minutes"),
                          int(sum(r[1] for r in daily["all"]["rows"]) + h * 120 + (h * 37) % 50), subs + h // 6] for h in range(73)],
        "traffic": {"all": traffic([("SHORTS", .41), ("RELATED_VIDEO", .22), ("SUBSCRIBER", .17), ("YT_SEARCH", .12), ("NO_LINK_OTHER", .05), ("EXT_URL", .03)]),
                    "VIDEO_ON_DEMAND": traffic([("RELATED_VIDEO", .38), ("SUBSCRIBER", .27), ("YT_SEARCH", .2), ("SHORTS_CONTENT_LINKS", .06), ("NO_LINK_OTHER", .05), ("EXT_URL", .04)]),
                    "SHORTS": traffic([("SHORTS", .91), ("YT_CHANNEL", .05), ("SUBSCRIBER", .04)])},
        "audience": {
            "subscribed": {"cols": ["subscribedStatus", "views", "estimatedMinutesWatched", "averageViewDuration"],
                           "rows": [["UNSUBSCRIBED", 88000, 210000, 140], ["SUBSCRIBED", 9100, 40000, 260]]},
            "device": {"cols": ["deviceType", "views", "estimatedMinutesWatched"],
                       "rows": [["MOBILE", 70000, 100000], ["TV", 14000, 90000], ["DESKTOP", 11000, 50000], ["TABLET", 3000, 9000]]},
            "country": {"cols": ["country", "views", "estimatedMinutesWatched"],
                        "rows": [["US", 41000, 1], ["GB", 9000, 1], ["CA", 7000, 1], ["AU", 5000, 1], ["IN", 4000, 1], ["DE", 3000, 1], ["PH", 2500, 1]]},
            "demographics": {"cols": ["ageGroup", "gender", "viewerPercentage"],
                             "rows": [["age18-24", "male", 18], ["age25-34", "male", 24], ["age35-44", "male", 14], ["age45-54", "male", 8],
                                      ["age18-24", "female", 7], ["age25-34", "female", 12], ["age35-44", "female", 9], ["age45-54", "female", 8]]}},
        "ypp": {"subscribers": subs, "long_watch_hours_365": round(long_min / 60, 1), "shorts_views_90": int(sh90 * 1.8),
                "shorts_engaged_90": sh90, "public_uploads_90": sum(1 for v in videos.values() if v.get("privacy") == "public")},
        "reach_state": {}, "errors": [],
        "calendar": {"channel": slug, "updated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
                     "rubrics": RUBRICS, "items": cal_items, "source": "demo"},
    }


def video(rnd, title, day, fmt, mult, duration):
    long = fmt == "long"
    rows, reach = [], {}
    total = [0] * 7
    peak = (110 if long else 450) * mult
    for k in range((TODAY - day).days + 1):
        d = day + dt.timedelta(days=k)
        if d > TODAY - dt.timedelta(days=2) or k > 60:
            break
        views = int(peak * math.exp(-k / (9 if long else 3)) * rnd.uniform(0.7, 1.3)) + rnd.randint(0, 5)
        eng = int(views * (rnd.uniform(0.62, 0.9) if long else rnd.uniform(0.5, 0.85)))
        apv = rnd.uniform(0.28, 0.5) if long else rnd.uniform(0.7, 1.1)
        mins = round(eng * duration * apv / 60, 1)
        subs = int(eng * (rnd.uniform(0.003, 0.012) if long else rnd.uniform(0.0008, 0.004)))
        likes, comm, shares = int(eng * rnd.uniform(0.015, 0.045)), int(eng * rnd.uniform(0.001, 0.004)), int(eng * 0.002)
        rows.append([str(d), views, eng, mins, subs, likes, comm, shares])
        total = [a + b for a, b in zip(total, [views, eng, mins, subs, likes, comm, shares])]
        if long:
            impr = int(views / rnd.uniform(0.035, 0.08))
            reach[str(d)] = [impr, views * 0.9]
    views, eng, mins, subs, likes, comm, shares = total
    a = {"views": views, "engagedViews": eng, "estimatedMinutesWatched": mins,
         "averageViewDuration": round(mins * 60 / eng) if eng else 0, "subscribersGained": subs,
         "subscribersLost": int(subs * 0.1), "likes": likes, "comments": comm, "shares": shares,
         "averageViewPercentage": round(mins * 60 / eng / duration * 100, 1) if eng else 0}
    ret = []
    for j in range(1, 101):
        x = j / 100
        w = (0.55 + 0.35 * math.exp(-x * 30)) * math.exp(-x * 1.3) if long else max(0.0, 1.05 - 0.45 * x)
        ret.append([x, round(w * rnd.uniform(0.97, 1.03), 4), round(rnd.uniform(0.8, 1.25), 3)])
    now = dt.datetime.now(dt.timezone.utc)
    vh = [[(now - dt.timedelta(hours=48 - h)).isoformat(timespec="minutes"), int(views * (0.97 + h * 0.0006))] for h in range(49)]
    return {"vh": vh, "title": title, "published_at": f"{day}T22:00:00Z", "publish_at": None, "privacy": "public",
            "duration": duration, "format": fmt, "thumb": None, "stats": {"viewCount": views},
            "a": a, "daily": {"cols": ["day", "views", "engagedViews", "estimatedMinutesWatched", "subscribersGained", "likes", "comments", "shares"], "rows": rows},
            "retention": ret, "reach": reach,
            "traffic": [["RELATED_VIDEO", int(views * .4), 0], ["SUBSCRIBER", int(views * .25), 0], ["YT_SEARCH", int(views * .2), 0], ["NO_LINK_OTHER", int(views * .15), 0]] if long
            else [["SHORTS", int(views * .93), 0], ["YT_CHANNEL", int(views * .07), 0]],
            "reach_src_days": {"7": {str(day): [int(views * 4), views * 0.25]}, "3": {str(day): [int(views * 6), views * 0.3]}, "5": {str(day): [int(views), views * 0.1]}} if long else {}}


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    chans = [gen_channel("demo-space", "Демо-канал 1 (космос)", 1, 75, 1.0),
             gen_channel("demo-history", "Демо-канал 2 (история)", 2, 40, 0.5)]
    for c in chans:
        (OUT / f"{c['slug']}.enc").write_text(encrypt(c, "demo"))
    (OUT / "index.enc").write_text(encrypt({"economics": {"currency": "USD", "usd_per_hf_credit": 0.06, "fixed_monthly_usd": {"Claude Pro": 20, "Higgsfield Plus": 39, "vidIQ": None}}, "channels": [{"slug": c["slug"], "name": c["name"], "channel_id": c["channel_id"],
                                                          "status": "ok"} for c in chans]}, "demo"))
    print("demo written:", [c["slug"] for c in chans])
