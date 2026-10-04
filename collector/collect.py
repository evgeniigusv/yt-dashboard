"""Collect YouTube numbers for every channel in channels.json and write encrypted site/data/<slug>.enc.

Runs in GitHub Actions every 3 hours (.github/workflows/collect.yml); locally: `python collector/collect.py`
with the same env vars. Each channel file is both the site's data and the collector's state: the previous file
is decrypted first, so reach reports, per-video history and retention accumulate between runs.

Env: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, YT_TOKENS (JSON {channel_id: refresh_token}), DASH_PASSWORD,
     DEPLOY_KEY_<SLUG> (optional, SSH key with read access to the channel's pipeline repo for the calendar).
"""
import csv
import datetime as dt
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import traceback
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).parent))
from crypto import decrypt, encrypt  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "site" / "data"
DATA_API = "https://www.googleapis.com/youtube/v3"
ANALYTICS = "https://youtubeanalytics.googleapis.com/v2/reports"
REPORTING = "https://youtubereporting.googleapis.com/v1"
REACH_REPORTS = ("channel_reach_basic_a1", "channel_reach_combined_a1")
CORE = "views,engagedViews,estimatedMinutesWatched,averageViewDuration,subscribersGained,subscribersLost,likes,comments,shares"
VIDEO = CORE + ",averageViewPercentage"
REVENUE = "estimatedRevenue,estimatedAdRevenue,grossRevenue,cpm,playbackBasedCpm,adImpressions,monetizedPlaybacks"
TODAY = dt.datetime.now(dt.timezone.utc).date()


def iso(d):
    return d.isoformat()


def parse_duration(s):
    m = re.fullmatch(r"P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", s or "")
    if not m:
        return 0
    d, h, mi, se = (int(x or 0) for x in m.groups())
    return d * 86400 + h * 3600 + mi * 60 + se


class Channel:
    def __init__(self, cfg, refresh_token, prev):
        self.cfg, self.prev = cfg, prev or {}
        self.errors = []
        self.s = requests.Session()
        r = requests.post("https://oauth2.googleapis.com/token", data={
            "client_id": os.environ["GOOGLE_CLIENT_ID"], "client_secret": os.environ["GOOGLE_CLIENT_SECRET"],
            "refresh_token": refresh_token, "grant_type": "refresh_token"}, timeout=30)
        if r.status_code != 200:
            raise RuntimeError(f"token refresh failed: {r.status_code} {r.text[:300]}")
        self.s.headers["Authorization"] = "Bearer " + r.json()["access_token"]

    # ---------- HTTP helpers ----------
    def get(self, url, **params):
        r = self.s.get(url, params=params, timeout=60)
        if r.status_code != 200:
            raise RuntimeError(f"{r.status_code} {url.split('/')[-1]}: {r.text[:300]}")
        return r.json()

    def report(self, metrics, start, end=None, **kw):
        """YouTube Analytics API query -> {"cols": [...], "rows": [...]}."""
        params = {"ids": "channel==MINE", "startDate": iso(start), "endDate": iso(end or TODAY), "metrics": metrics}
        params.update({k: v for k, v in kw.items() if v is not None})
        d = self.get(ANALYTICS, **params)
        return {"cols": [c["name"] for c in d.get("columnHeaders", [])], "rows": d.get("rows", [])}

    def safe(self, label, fn, default=None):
        try:
            return fn()
        except Exception as e:  # one failing query must not kill the whole channel
            self.errors.append(f"{label}: {e}"[:400])
            return default

    # ---------- collection ----------
    def run(self):
        out = {"v": 1, "slug": self.cfg["slug"], "name": self.cfg["name"], "channel_id": self.cfg["channel_id"],
               "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), "demo": False}
        ch = self.get(f"{DATA_API}/channels", part="snippet,statistics,contentDetails,status", mine="true")["items"][0]
        if ch["id"] != self.cfg["channel_id"]:
            self.errors.append(f"token belongs to {ch['id']}, config says {self.cfg['channel_id']}")
        st = ch["statistics"]
        out["channel"] = {
            "id": ch["id"], "title": ch["snippet"]["title"], "handle": ch["snippet"].get("customUrl"),
            "thumbnail": ch["snippet"]["thumbnails"].get("default", {}).get("url"),
            "published_at": ch["snippet"]["publishedAt"], "subscribers": int(st.get("subscriberCount", 0)),
            "views": int(st.get("viewCount", 0)), "video_count": int(st.get("videoCount", 0))}
        hist = dict(self.prev.get("subs_history", []))
        hist[iso(TODAY)] = out["channel"]["subscribers"]
        out["subs_history"] = sorted(hist.items())[-800:]

        created = dt.date.fromisoformat(out["channel"]["published_at"][:10])
        start = max(created, TODAY - dt.timedelta(days=730))
        heavy = self.prev.get("daily_refresh") != iso(TODAY)  # per-video deep data once a day
        out["daily_refresh"] = iso(TODAY) if heavy else self.prev.get("daily_refresh")

        videos = self.videos(ch["contentDetails"]["relatedPlaylists"]["uploads"])
        out["daily"] = self.daily(start)
        self.video_analytics(videos, start)
        if heavy:
            self.video_deep(videos)
        out["videos"] = videos
        out["traffic"] = {k: self.safe(f"traffic {k}", lambda f=f: self.report(
            "views,estimatedMinutesWatched", TODAY - dt.timedelta(days=28), dimensions="insightTrafficSourceType",
            filters=f, sort="-views")) for k, f in (("all", None), ("SHORTS", "creatorContentType==shorts"),
                                                    ("VIDEO_ON_DEMAND", "creatorContentType==videoOnDemand"))}
        out["audience"] = self.audience() if heavy or "audience" not in self.prev else self.prev["audience"]
        out["ypp"] = self.ypp(out["channel"]["subscribers"], videos)
        out["reach_state"] = self.reach(videos)
        self.costs = self.pstate = None
        out["calendar"] = self.safe("calendar", self.calendar, self.prev.get("calendar"))
        out["costs"] = self.costs or self.prev.get("costs")
        out["pipeline_state"] = self.pstate or self.prev.get("pipeline_state")
        out["telegram_bot"] = (self.cfg.get("calendar") or {}).get("telegram_bot")
        out["errors"] = self.errors
        return out

    def videos(self, uploads):
        ids, token = [], None
        while len(ids) < 1000:
            d = self.get(f"{DATA_API}/playlistItems", part="contentDetails", playlistId=uploads, maxResults=50,
                         **({"pageToken": token} if token else {}))
            ids += [i["contentDetails"]["videoId"] for i in d.get("items", [])]
            token = d.get("nextPageToken")
            if not token:
                break
        prev = self.prev.get("videos", {})
        vids = {}
        for i in range(0, len(ids), 50):
            d = self.get(f"{DATA_API}/videos", part="snippet,contentDetails,status,statistics", id=",".join(ids[i:i + 50]))
            for v in d.get("items", []):
                p = prev.get(v["id"], {})
                dur = parse_duration(v["contentDetails"].get("duration"))
                sn, sta, s = v["snippet"], v["status"], v.get("statistics", {})
                vids[v["id"]] = {**p,
                    "title": sn["title"], "published_at": sn.get("publishedAt"), "publish_at": sta.get("publishAt"),
                    "privacy": sta.get("privacyStatus"), "upload_status": sta.get("uploadStatus"), "duration": dur,
                    "thumb": (sn.get("thumbnails", {}).get("medium") or sn.get("thumbnails", {}).get("default") or {}).get("url"),
                    "tags": sn.get("tags", [])[:15], "live": sn.get("liveBroadcastContent"),
                    "stats": {k: int(s[k]) for k in ("viewCount", "likeCount", "commentCount") if k in s},
                    "format": p.get("format") or ("short" if dur <= 180 else "long")}
        return vids

    def daily(self, start):
        out = {}
        for key, f in (("all", None), ("SHORTS", "creatorContentType==shorts"),
                       ("VIDEO_ON_DEMAND", "creatorContentType==videoOnDemand")):
            out[key] = self.safe(f"daily {key}", lambda f=f: self.report(CORE, start, dimensions="day", filters=f, sort="day"))
        out["revenue"] = self.safe("revenue (needs monetization + monetary scope)",
                                   lambda: self.report(REVENUE, start, dimensions="day", sort="day"))
        return out

    def video_analytics(self, vids, start):
        """Lifetime totals per video; the SHORTS / VOD filtered lists also tell the real format."""
        for key, f in (("SHORTS", "creatorContentType==shorts"), ("VIDEO_ON_DEMAND", "creatorContentType==videoOnDemand"),
                       ("LIVE_STREAM", "creatorContentType==liveStream")):
            r = self.safe(f"videos {key}", lambda f=f: self.report(VIDEO, start, dimensions="video", filters=f,
                                                                    sort="-views", maxResults=200))
            if not r:
                continue
            for row in r["rows"]:
                v = vids.get(row[0])
                if v is not None:
                    v["a"] = dict(zip(r["cols"][1:], row[1:]))
                    v["format"] = {"SHORTS": "short", "VIDEO_ON_DEMAND": "long", "LIVE_STREAM": "live"}[key]
        rev = self.safe("video revenue", lambda: self.report("estimatedRevenue,cpm,playbackBasedCpm", start,
                                                             dimensions="video", sort="-estimatedRevenue", maxResults=200))
        for row in (rev or {}).get("rows", []):
            if row[0] in vids:
                vids[row[0]]["rev"] = dict(zip(rev["cols"][1:], row[1:]))

    def video_deep(self, vids):
        """Once a day: day-by-day history (first 35 days), traffic sources, retention curve."""
        for vid, v in vids.items():
            pub = (v.get("published_at") or "")[:10]
            if v.get("privacy") != "public" or not pub:
                continue
            age = (TODAY - dt.date.fromisoformat(pub)).days
            p0 = dt.date.fromisoformat(pub)
            if age <= 40 or "daily" not in v:
                r = self.safe(f"video daily {vid}", lambda: self.report(
                    "views,engagedViews,estimatedMinutesWatched,subscribersGained,likes,comments,shares",
                    p0, min(TODAY, p0 + dt.timedelta(days=60)), dimensions="day", filters=f"video=={vid}", sort="day"))
                if r:
                    v["daily"] = r
            if age <= 40 or "traffic" not in v:
                r = self.safe(f"video traffic {vid}", lambda: self.report(
                    "views,estimatedMinutesWatched", p0, dimensions="insightTrafficSourceType",
                    filters=f"video=={vid}", sort="-views"))
                if r:
                    v["traffic"] = r["rows"]
            if age <= (60 if v["format"] != "short" else 14) or "retention" not in v:
                r = self.safe(f"retention {vid}", lambda: self.report(
                    "audienceWatchRatio,relativeRetentionPerformance", p0, dimensions="elapsedVideoTimeRatio",
                    filters=f"video=={vid}"))
                if r and r["rows"]:
                    v["retention"] = r["rows"]

    def audience(self):
        d28 = TODAY - dt.timedelta(days=28)
        q = lambda label, **kw: self.safe(label, lambda: self.report(kw.pop("metrics", "views,estimatedMinutesWatched"), d28, **kw))
        return {
            "subscribed": q("subscribed", dimensions="subscribedStatus", metrics="views,estimatedMinutesWatched,averageViewDuration"),
            "device": q("device", dimensions="deviceType", sort="-views"),
            "country": q("country", dimensions="country", sort="-views", maxResults=15),
            "demographics": q("demographics", dimensions="ageGroup,gender", metrics="viewerPercentage"),
            "content_type": q("content type", dimensions="creatorContentType", metrics=CORE)}

    def ypp(self, subs, vids):
        y365, d90 = TODAY - dt.timedelta(days=365), TODAY - dt.timedelta(days=90)
        tot = lambda label, m, start, f=None: self.safe(label, lambda: (self.report(m, start, filters=f)["rows"] or [[0]])[0][0], None)
        all_min = tot("ypp minutes", "estimatedMinutesWatched", y365)
        shorts_min = tot("ypp shorts minutes", "estimatedMinutesWatched", y365, "creatorContentType==shorts") or 0
        uploads90 = sum(1 for v in vids.values() if v.get("privacy") == "public" and (v.get("published_at") or "")[:10] >= iso(d90))
        return {"subscribers": subs,
                "long_watch_hours_365": None if all_min is None else round((all_min - shorts_min) / 60, 1),
                "shorts_views_90": tot("ypp shorts views", "views", d90, "creatorContentType==shorts"),
                "shorts_engaged_90": tot("ypp shorts engaged", "engagedViews", d90, "creatorContentType==shorts"),
                "public_uploads_90": uploads90}

    def reach(self, vids):
        """Thumbnail impressions + CTR exist only in the Reporting API (daily CSVs, ~2 days delay)."""
        st = self.prev.get("reach_state", {"jobs": {}, "seen": []})
        seen = set(st.get("seen", []))
        try:
            jobs = {j["reportTypeId"]: j["id"] for j in self.get(f"{REPORTING}/jobs").get("jobs", [])}
            for rt in REACH_REPORTS:
                if rt not in jobs:
                    r = self.s.post(f"{REPORTING}/jobs", json={"reportTypeId": rt, "name": f"dashboard {rt}"}, timeout=30)
                    r.raise_for_status()
                    jobs[rt] = r.json()["id"]
            st["jobs"] = jobs
            for rt, job in jobs.items():
                if rt not in REACH_REPORTS:
                    continue
                token = None
                while True:
                    d = self.get(f"{REPORTING}/jobs/{job}/reports", **({"pageToken": token} if token else {}))
                    for rep in d.get("reports", []):
                        if rep["id"] in seen:
                            continue
                        csv_text = self.s.get(rep["downloadUrl"], timeout=120).text
                        rows = list(csv.DictReader(io.StringIO(csv_text)))
                        ctrs = [float(r.get("video_thumbnail_impressions_ctr") or 0) for r in rows]
                        if any(c > 1 for c in ctrs):
                            st["ctr_unit"] = "percent"
                        elif any(c > 0 for c in ctrs) and "ctr_unit" not in st:
                            self.errors.append("reach: CTR unit unclear (all values ≤ 1) — treated as percent per docs; compare with Studio")
                        self.ingest(rt, rows, vids, st.get("ctr_unit", "percent"))
                        seen.add(rep["id"])
                    token = d.get("nextPageToken")
                    if not token:
                        break
        except Exception as e:
            self.errors.append(f"reach reports: {e}"[:400])
        st["seen"] = sorted(seen)[-3000:]
        return st

    @staticmethod
    def ingest(rt, rows, vids, unit="percent"):
        """Docs: ctr = "the percentage of impressions that resulted in a click" -> fraction = value / 100."""
        for row in rows:
            v = vids.get(row.get("video_id"))
            if v is None:
                continue
            impr = float(row.get("video_thumbnail_impressions") or 0)
            ctr = float(row.get("video_thumbnail_impressions_ctr") or 0)
            ctr = ctr / 100 if unit == "percent" else ctr
            clicks = impr * ctr
            date = row["date"]
            date = f"{date[:4]}-{date[4:6]}-{date[6:]}" if len(date) == 8 else date
            if rt == "channel_reach_basic_a1":
                v.setdefault("reach", {})[date] = [impr, round(clicks, 2)]
            else:  # combined: keep impressions/clicks per traffic source, summed over days
                src = row.get("traffic_source_type") or "?"
                per = v.setdefault("reach_src_days", {}).setdefault(src, {})
                cur = per.get(date, [0, 0])
                per[date] = [cur[0] + impr, round(cur[1] + clicks, 2)]

    def calendar(self):
        cal = self.cfg.get("calendar")
        key = os.environ.get(cal.get("deploy_key_env", "")) if cal else None
        if not cal or not key:
            return self.prev.get("calendar")
        with tempfile.TemporaryDirectory() as tmp:
            kf = Path(tmp) / "key"
            kf.write_text(key.strip() + "\n")
            kf.chmod(0o600)
            env = {**os.environ, "GIT_SSH_COMMAND": f"ssh -i {kf} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"}
            for branch in cal.get("branches", ["main"]):
                dst = Path(tmp) / re.sub(r"\W", "_", branch)
                r = subprocess.run(["git", "clone", "-q", "--depth", "1", "-b", branch, f"git@github.com:{cal['repo']}.git",
                                    str(dst)], env=env, capture_output=True, text=True)
                f = dst / cal.get("path", "calendar.json")
                if r.returncode == 0 and f.exists():
                    data = json.loads(f.read_text())
                    data["source"] = f"{cal['repo']}@{branch}"
                    costs = dst / cal.get("costs_path", "costs.json")  # production costs (pipeline tools/costs.py)
                    if costs.exists():
                        self.costs = json.loads(costs.read_text()) | {"source": f"{cal['repo']}@{branch}"}
                    state = dst / "state.json"  # cloud pipeline state (what waits for approval right now)
                    if state.exists():
                        self.pstate = json.loads(state.read_text())
                    return data
        raise RuntimeError(f"calendar.json not found in {cal['repo']} {cal.get('branches')}")


def main():
    cfg = json.loads((ROOT / "channels.json").read_text())
    password = os.environ.get("DASH_PASSWORD", "")
    if len(password) < 8:  # a missing GitHub secret arrives as "" — never encrypt with an empty password
        sys.exit("DASH_PASSWORD is not set (or shorter than 8 chars): gh secret set DASH_PASSWORD -R <repo>")
    tokens = json.loads(os.environ.get("YT_TOKENS") or "{}")
    DATA.mkdir(parents=True, exist_ok=True)
    index = []
    for c in cfg["channels"]:
        f = DATA / f"{c['slug']}.enc"
        prev = None
        if f.exists():
            try:
                prev = decrypt(f.read_text(), password)
            except Exception:
                print(f"{c['slug']}: previous data unreadable (password changed?) — starting fresh")
        if prev and prev.get("demo"):
            prev = None
        token = tokens.get(c["channel_id"])
        if not token:
            print(f"{c['slug']}: no refresh token yet — skipped")
            if prev:
                index.append({k: c[k] for k in ("slug", "name", "channel_id")} | {"status": "stale"})
            continue
        try:
            data = Channel(c, token, prev).run()
            f.write_text(encrypt(data, password))
            index.append({k: c[k] for k in ("slug", "name", "channel_id")} | {"status": "ok", "errors": len(data["errors"])})
            print(f"{c['slug']}: ok, {len(data['videos'])} videos, {len(data['errors'])} errors")
            for e in data["errors"]:
                print("   ", e[:200])
        except Exception:
            traceback.print_exc()
            index.append({k: c[k] for k in ("slug", "name", "channel_id")} | {"status": "failed"})
    (DATA / "index.enc").write_text(encrypt({"channels": index, "economics": cfg.get("economics", {}), "generated_at":
                                             dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")}, password))


if __name__ == "__main__":
    main()
