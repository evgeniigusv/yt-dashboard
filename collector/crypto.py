"""Encrypt / decrypt dashboard data so the public Pages site exposes nothing without the password.

Format (JSON): {"v": 1, "kdf": "pbkdf2-sha256", "iter": N, "salt": b64, "iv": b64, "ct": b64}
plaintext = gzip(JSON). Key = PBKDF2-SHA256(password, salt, N) -> AES-256-GCM. The browser decrypts the
same thing with WebCrypto + DecompressionStream (site/app.js, decrypt()).
"""
import base64
import gzip
import json
import os

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

ITER = 250_000


def _key(password: str, salt: bytes, iterations: int) -> bytes:
    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=iterations)
    return kdf.derive(password.encode())


def encrypt(obj, password: str) -> str:
    salt, iv = os.urandom(16), os.urandom(12)
    plain = gzip.compress(json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode(), 6)
    ct = AESGCM(_key(password, salt, ITER)).encrypt(iv, plain, None)
    b64 = lambda b: base64.b64encode(b).decode()
    return json.dumps({"v": 1, "kdf": "pbkdf2-sha256", "iter": ITER, "salt": b64(salt), "iv": b64(iv), "ct": b64(ct)})


def decrypt(text: str, password: str):
    env = json.loads(text)
    d = lambda k: base64.b64decode(env[k])
    plain = AESGCM(_key(password, d("salt"), env["iter"])).decrypt(d("iv"), d("ct"), None)
    return json.loads(gzip.decompress(plain))
