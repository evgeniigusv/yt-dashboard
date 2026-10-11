"""Keep the dashboard's schedule fresh between the hourly full collections (workflow `ticker`).

Every --every seconds: look at the heads of each channel's pipeline repo (git ls-remote with the read-only deploy key —
branches main, claude/state, claude/video-*). When anything moved — a publish log, the topic list, the state, a new
video branch — or --fast-every seconds passed (changes made directly in YouTube Studio leave no trace in git), run
`collect.py --fast` (schedule only, ~20 s, ~3 YouTube API units per channel) and push branch `data`; the page reads
that branch by commit id, so the calendar follows a change within a minute or two. Every --full-every seconds the
full `collect` workflow is started (analytics, reach, history, Pages deploy).

No new secrets: the deploy keys and YouTube tokens are the ones `collect` already uses.
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "site" / "data"
REPO = os.environ.get("GITHUB_REPOSITORY", "evgeniigusv/yt-dashboard")
WATCHED = ("refs/heads/main", "refs/heads/claude/state", "refs/heads/claude/video-")


def opt(name, default):
    return int(sys.argv[sys.argv.index(name) + 1]) if name in sys.argv else default


def sh(*cmd, cwd=ROOT, env=None, check=True, timeout=600):
    r = subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, text=True, timeout=timeout)
    if check and r.returncode:
        raise RuntimeError(f"{' '.join(cmd[:3])}: {(r.stderr or r.stdout).strip()[-300:]}")
    return r


def signature(channels, keydir):
    """Hash of the watched branch heads of every pipeline repo; None when a repo could not be read (try again later)."""
    parts = []
    for c in channels:
        cal = c.get("calendar") or {}
        key = os.environ.get(cal.get("deploy_key_env", ""))
        if not cal.get("repo") or not key:
            continue
        kf = keydir / f"{c['slug']}.key"
        if not kf.exists():
            kf.write_text(key.strip() + "\n")
            kf.chmod(0o600)
        env = {**os.environ, "GIT_SSH_COMMAND": f"ssh -i {kf} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new",
               "GIT_TERMINAL_PROMPT": "0"}
        r = sh("git", "ls-remote", "--heads", f"git@github.com:{cal['repo']}.git", env=env, check=False, timeout=60)
        if r.returncode:
            print(f"watch: cannot read {cal['repo']}: {r.stderr.strip()[-120:]}", flush=True)
            return None
        parts += sorted(f"{c['slug']} {line}" for line in r.stdout.splitlines() if line.split("\t")[-1].startswith(WATCHED))
    return hashlib.sha256("\n".join(parts).encode()).hexdigest()


def fast():
    """Latest branch `data` -> site/data -> collect.py --fast -> push (only if nobody pushed meanwhile). True = pushed."""
    sh("git", "fetch", "-q", "--depth", "1", "origin", "data")
    base = sh("git", "rev-parse", "FETCH_HEAD").stdout.strip()
    DATA.mkdir(parents=True, exist_ok=True)
    for name in sh("git", "ls-tree", "--name-only", "FETCH_HEAD").stdout.split():
        (DATA / name).write_bytes(subprocess.run(["git", "show", f"FETCH_HEAD:{name}"], cwd=ROOT, capture_output=True, check=True).stdout)
    r = sh(sys.executable, "collector/collect.py", "--fast", check=False)
    print(r.stdout.strip()[-600:], flush=True)
    if r.returncode:
        print("watch: fast collect failed:", r.stderr.strip()[-300:], flush=True)
        return False
    with tempfile.TemporaryDirectory() as tmp:
        for f in DATA.iterdir():
            if f.is_file():
                shutil.copy2(f, Path(tmp) / f.name)
        sh("git", "init", "-q", "-b", "data", cwd=tmp)
        sh("git", "add", "-A", cwd=tmp)
        sh("git", "-c", "user.name=collector", "-c", "user.email=collector@users.noreply.github.com", "commit", "-q", "-m",
           f"data (schedule) {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}", cwd=tmp)
        url = f"https://x-access-token:{os.environ['GH_TOKEN']}@github.com/{REPO}.git"
        p = sh("git", "push", "-q", f"--force-with-lease=data:{base}", url, "data", cwd=tmp, check=False)
        if p.returncode:  # the hourly full run pushed in between: its data is newer, redo on the next tick
            print("watch: data branch moved meanwhile — will retry", flush=True)
            return False
    return True


def main():
    minutes, every = opt("--minutes", 325), opt("--every", 60)
    fast_every, full_every = opt("--fast-every", 600), opt("--full-every", 3600)
    channels = json.loads((ROOT / "channels.json").read_text())["channels"]
    keydir = Path(tempfile.mkdtemp())
    end = time.time() + minutes * 60
    last_sig, last_fast, last_full, hold = None, 0.0, 0.0, 0.0
    while time.time() < end:
        now = time.time()
        try:
            if now - last_full >= full_every:
                sh("gh", "workflow", "run", "collect", "-R", REPO)
                last_full, hold = now, now + 150  # let the full run restore, collect and push before a fast one
                print(f"watch: full collect started {time.strftime('%H:%M:%S', time.gmtime())}", flush=True)
            elif now >= hold:
                sig = signature(channels, keydir)
                changed = sig is not None and sig != last_sig
                if changed or now - last_fast >= fast_every:
                    why = "pipeline repo changed" if changed and last_sig else "periodic"
                    if fast():
                        print(f"watch: schedule refreshed ({why}) {time.strftime('%H:%M:%S', time.gmtime())}", flush=True)
                        last_fast = time.time()
                        if sig is not None:
                            last_sig = sig
        except Exception as e:  # never die on one bad tick
            print(f"watch: {str(e)[:300]}", flush=True)
        time.sleep(every)
    shutil.rmtree(keydir, ignore_errors=True)


if __name__ == "__main__":
    main()
