"""Connect a YouTube channel to the dashboard (run on the Mac, once per channel).

  python3 collector/auth.py client ~/Downloads/client_secret_XXX.json   # once: store the Google OAuth client
  python3 collector/auth.py add                                        # browser opens -> pick the channel -> Allow
  python3 collector/auth.py list                                       # connected channels

`add` keeps refresh tokens in ~/.config/yt-dashboard/tokens.json and uploads them to the repo's GitHub
secrets (YT_TOKENS, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET) with the gh CLI. Nothing is printed.
Read-only scopes: the dashboard can't change, upload or delete anything on the channel.
"""
import base64
import hashlib
import http.server
import json
import os
import secrets
import subprocess
import sys
import urllib.parse
import webbrowser
from pathlib import Path

import requests

CONF = Path.home() / ".config" / "yt-dashboard"
REPO = os.environ.get("DASH_REPO", "evgeniigusv/yt-dashboard")
SCOPES = ["https://www.googleapis.com/auth/youtube.readonly",
          "https://www.googleapis.com/auth/yt-analytics.readonly",
          "https://www.googleapis.com/auth/yt-analytics-monetary.readonly"]


def load(name, default):
    f = CONF / name
    return json.loads(f.read_text()) if f.exists() else default


def save(name, obj):
    CONF.mkdir(parents=True, exist_ok=True)
    f = CONF / name
    f.write_text(json.dumps(obj, indent=1))
    f.chmod(0o600)


def gh_secret(name, value):
    subprocess.run(["gh", "secret", "set", name, "-R", REPO], input=value, text=True, check=True,
                   stdout=subprocess.DEVNULL)


def client(path):
    raw = json.loads(Path(path).expanduser().read_text())
    c = raw.get("installed") or raw.get("web")
    save("client.json", {"client_id": c["client_id"], "client_secret": c["client_secret"]})
    gh_secret("GOOGLE_CLIENT_ID", c["client_id"])
    gh_secret("GOOGLE_CLIENT_SECRET", c["client_secret"])
    print("OAuth client saved and uploaded to GitHub secrets.")


def add():
    c = load("client.json", None) or sys.exit("first: auth.py client <client_secret.json>")
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    state = secrets.token_urlsafe(16)
    got = {}

    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            q = dict(urllib.parse.parse_qsl(urllib.parse.urlparse(self.path).query))
            if "code" in q or "error" in q:
                got.update(q)
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write("Готово — можно закрыть вкладку и вернуться в терминал.".encode())

        def log_message(self, *a):
            pass

    srv = http.server.HTTPServer(("127.0.0.1", 0), H)
    redirect = f"http://127.0.0.1:{srv.server_port}"
    url = "https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode({
        "client_id": c["client_id"], "redirect_uri": redirect, "response_type": "code", "scope": " ".join(SCOPES),
        "access_type": "offline", "prompt": "select_account consent", "state": state,
        "code_challenge": challenge, "code_challenge_method": "S256"})
    print("Opening the browser. Pick the Google account / brand channel you want to add, then Allow.")
    print("If it opened in the wrong browser or account, paste this link into the right one (same Mac):")
    print(url, flush=True)
    if "--no-open" not in sys.argv:
        webbrowser.open(url)
    while "code" not in got and "error" not in got:
        srv.handle_request()
    if got.get("error") or got.get("state") != state:
        sys.exit(f"authorization failed: {got.get('error', 'state mismatch')}")
    r = requests.post("https://oauth2.googleapis.com/token", data={
        "client_id": c["client_id"], "client_secret": c["client_secret"], "code": got["code"],
        "code_verifier": verifier, "grant_type": "authorization_code", "redirect_uri": redirect}, timeout=30)
    r.raise_for_status()
    tok = r.json()
    if "refresh_token" not in tok:
        sys.exit("Google returned no refresh token — remove the app at myaccount.google.com/permissions and retry")
    me = requests.get("https://www.googleapis.com/youtube/v3/channels", params={"part": "snippet", "mine": "true"},
                      headers={"Authorization": "Bearer " + tok["access_token"]}, timeout=30).json()
    if not me.get("items"):
        sys.exit("this Google account has no YouTube channel — pick the brand account of the channel")
    ch = me["items"][0]
    tokens = load("tokens.json", {})
    tokens[ch["id"]] = tok["refresh_token"]
    save("tokens.json", tokens)
    gh_secret("YT_TOKENS", json.dumps(tokens))
    print(f"Connected: {ch['snippet']['title']} ({ch['id']}). Add it to channels.json if it's new.")


def list_():
    for cid in load("tokens.json", {}):
        print(cid)


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "add"
    {"client": lambda: client(sys.argv[2]), "add": add, "list": list_}[cmd]()
