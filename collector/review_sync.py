"""Bring the cards of the Telegram mini app «Согласования» (site/review/) from the private channel repos.

Each channel repo writes its cards, already encrypted, to review/public on its branch claude/review (tools/review.py
there). This script looks at those branches every --every seconds for --minutes minutes and, when one has moved,
copies review/public to this repo's branch review-<slug> as a single commit without history. The mini app reads those
branches through raw.githubusercontent.com.

Access: the read-only deploy keys the calendar already uses (env named in channels.json calendar.deploy_key_env).
Only ciphertext passes through here — the key lives in the channel repos' tools/config.json and in the phone.

  review_sync.py [--minutes 325] [--every 45]      # --minutes 0 = one pass
"""
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC_BRANCH = "claude/review"


def sh(*cmd, cwd=ROOT, env=None):
    return subprocess.run([str(c) for c in cmd], cwd=cwd, env=env, check=True, capture_output=True, text=True).stdout.strip()


def published(slug):
    """Source commit already copied to branch review-<slug> (the last word of its commit message)."""
    if not sh("git", "ls-remote", "origin", f"refs/heads/review-{slug}"):
        return None
    sh("git", "fetch", "-q", "--depth", "1", "origin", f"review-{slug}")
    return sh("git", "log", "-1", "--format=%s", "FETCH_HEAD").split()[-1]


def copy(slug, repo, ssh):
    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / "src"
        sh("git", "init", "-q", src)
        sh("git", "fetch", "-q", "--depth", "1", f"git@github.com:{repo}.git", SRC_BRANCH, cwd=src, env=ssh)
        sha = sh("git", "rev-parse", "FETCH_HEAD", cwd=src)
        sh("git", "checkout", "-q", "FETCH_HEAD", "--", "review/public", cwd=src)
        pub = src / "review" / "public"
        env = {**os.environ, "GIT_DIR": str(ROOT / ".git"), "GIT_WORK_TREE": str(pub), "GIT_INDEX_FILE": str(Path(tmp) / "index")}
        sh("git", "add", "-A", "-f", ".", cwd=pub, env=env)
        commit = sh("git", "-c", "user.name=review", "-c", "user.email=review@users.noreply.github.com", "commit-tree",
                    sh("git", "write-tree", cwd=pub, env=env), "-m", f"cards of {slug} from {sha}", cwd=pub, env=env)
        sh("git", "push", "-q", "-f", "origin", f"{commit}:refs/heads/review-{slug}")
        return sha, sum(1 for _ in pub.iterdir())


def main(minutes, every):
    keys = Path(tempfile.mkdtemp())
    chans = []
    for c in json.loads((ROOT / "channels.json").read_text())["channels"]:
        cal = c.get("calendar") or {}
        key = os.environ.get(cal.get("deploy_key_env") or "")
        if not (cal.get("repo") and key):
            print(f"{c['slug']}: no pipeline repo or deploy key — skipped", flush=True)
            continue
        kf = keys / c["slug"]
        kf.write_text(key.strip() + "\n")
        kf.chmod(0o600)
        ssh = {**os.environ, "GIT_SSH_COMMAND": f"ssh -i {kf} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"}
        chans.append({"slug": c["slug"], "repo": cal["repo"], "ssh": ssh, "done": published(c["slug"])})
        print(f"{c['slug']}: published so far {chans[-1]['done']}", flush=True)
    deadline = time.time() + minutes * 60
    while chans:
        for c in chans:
            try:
                head = sh("git", "ls-remote", f"git@github.com:{c['repo']}.git", f"refs/heads/{SRC_BRANCH}", env=c["ssh"]).split()[:1]
                if head and head[0] != c["done"]:
                    c["done"], n = copy(c["slug"], c["repo"], c["ssh"])
                    print(f"{time.strftime('%H:%M:%S')} {c['slug']}: {n} file(s) copied from {c['done'][:10]}", flush=True)
            except subprocess.CalledProcessError as e:  # a network hiccup must not stop the watch
                print(f"{time.strftime('%H:%M:%S')} {c['slug']}: {(e.stderr or '').strip()[-300:]}", flush=True)
        if time.time() >= deadline:
            break
        time.sleep(every)


if __name__ == "__main__":
    def arg(name, default):
        return float(sys.argv[sys.argv.index(name) + 1]) if name in sys.argv else default

    main(arg("--minutes", 325), arg("--every", 45))
