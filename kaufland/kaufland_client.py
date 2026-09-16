#!/usr/bin/env python3
"""
Referenz-Client für die inoffizielle Kaufland-App-API (Login + digitale Kassenbons).

Nur für den Zugriff auf den eigenen Account gedacht. Siehe api-kaufland.md fuer die
vollstaendige Spezifikation und den Vertrauensstand der einzelnen Endpunkte (mehrere
Details sind als "unverifiziert" markiert, weil diese Spec rein aus statischer
APK-Analyse stammt).

Login-Ablauf (manuell, analog zum Lidl-Plus-Client):
  1. `python3 kaufland_client.py login` gibt eine Authorize-URL aus.
  2. URL im Browser oeffnen, mit dem Kaufland-Account einloggen.
  3. Der Login schlaegt am Ende sichtbar fehl, weil der Browser das Custom-Schema
     `com.kaufland.Kaufland://oauth/callback` nicht oeffnen kann. In den
     Browser-DevTools (Network-Tab, "Preserve log" aktivieren) nach diesem
     fehlgeschlagenen Request suchen und die volle URL kopieren.
  4. Die kopierte Callback-URL (oder nur den `code`-Parameter) hier eingeben.
  5. Tokens werden in `kaufland_tokens.json` gespeichert.

Danach:
  python3 kaufland_client.py userinfo
  python3 kaufland_client.py receipts --country DE --limit 20
  python3 kaufland_client.py refresh
"""
import argparse
import base64
import hashlib
import json
import os
import secrets
import sys
import urllib.parse
import urllib.request
import urllib.error

CIDAAS_BASE = "https://account.kaufland.com"
ACARDO_BASE = "https://kaufland-app-backend-production.acardo.io"

CLIENT_ID = "fb1b425b-ab2f-4140-aef9-20263b6cfa49"          # BuildConfig.CidaasClientId
LOYALTY_CLIENT_ID = "88207bfc-780b-400d-92ee-893ae72dab40"  # BuildConfig.LoyaltyClientId
REDIRECT_URI = "com.kaufland.Kaufland://oauth/callback"
APP_VERSION = "6.17.0"
CIDAAS_SDK_V = "1.5.22"

TOKEN_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "kaufland_tokens.json")


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def make_pkce():
    verifier = b64url(secrets.token_bytes(32))
    challenge = b64url(hashlib.sha256(verifier.encode("ascii")).digest())
    return verifier, challenge


def http_request(method, url, headers=None, data=None):
    req = urllib.request.Request(url, data=data, headers=headers or {}, method=method)
    try:
        with urllib.request.urlopen(req) as resp:
            body = resp.read()
            return resp.status, dict(resp.getheaders()), body
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


def save_tokens(tokens):
    with open(TOKEN_FILE, "w") as f:
        json.dump(tokens, f, indent=2)
    print(f"[i] Tokens gespeichert in {TOKEN_FILE}")


def load_tokens():
    if not os.path.exists(TOKEN_FILE):
        print(f"[!] Keine Tokens gefunden ({TOKEN_FILE}). Erst 'login' ausfuehren.", file=sys.stderr)
        sys.exit(1)
    with open(TOKEN_FILE) as f:
        return json.load(f)


def cmd_login(args):
    verifier, challenge = make_pkce()
    state = b64url(secrets.token_bytes(16))

    params = {
        "client_id": CLIENT_ID,
        "response_type": "code",
        "redirect_uri": REDIRECT_URI,
        "ui_locales": args.locale,
        "v": CIDAAS_SDK_V,
        "view_type": "",
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "state": state,
    }
    if args.store:
        params["preferredStore"] = args.store

    url = f"{CIDAAS_BASE}/authz-srv/authz?" + urllib.parse.urlencode(params)

    print("=" * 78)
    print("1) Diese URL in einem normalen Browser oeffnen und einloggen:\n")
    print(url)
    print()
    print("2) Der Login endet mit einem fehlgeschlagenen Sprung nach:")
    print(f"   {REDIRECT_URI}?code=...&state=...")
    print("   -> DevTools Network-Tab ('Preserve log') durchsuchen, die volle URL")
    print("      (oder nur den 'code'-Query-Parameter) kopieren.")
    print("=" * 78)

    pasted = input("\nCallback-URL oder code=... hier einfuegen: ").strip()

    if "code=" in pasted:
        qs = urllib.parse.urlsplit(pasted).query or pasted.split("?", 1)[-1]
        code = urllib.parse.parse_qs(qs).get("code", [None])[0]
        returned_state = urllib.parse.parse_qs(qs).get("state", [None])[0]
        if returned_state and returned_state != state:
            print("[!] WARNUNG: 'state' in der Callback-URL stimmt nicht mit dem "
                  "gesendeten state ueberein (CSRF-Check fehlgeschlagen).", file=sys.stderr)
    else:
        code = pasted

    if not code:
        print("[!] Kein 'code' gefunden.", file=sys.stderr)
        sys.exit(1)

    body = urllib.parse.urlencode({
        "grant_type": "authorization_code",
        "client_id": CLIENT_ID,
        "code": code,
        "redirect_uri": REDIRECT_URI,
        "code_verifier": verifier,
    }).encode("ascii")

    status, _, resp_body = http_request(
        "POST", f"{CIDAAS_BASE}/token-srv/token",
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        data=body,
    )
    print(f"\n[i] Token-Exchange Status: {status}")
    print(resp_body.decode("utf-8", "replace"))

    if status != 200:
        sys.exit(1)

    tokens = json.loads(resp_body)
    save_tokens(tokens)


def cmd_refresh(args):
    tokens = load_tokens()
    refresh_token = tokens.get("refresh_token")
    if not refresh_token:
        print("[!] Kein refresh_token vorhanden.", file=sys.stderr)
        sys.exit(1)

    body = urllib.parse.urlencode({
        "grant_type": "refresh_token",
        "client_id": CLIENT_ID,
        "refresh_token": refresh_token,
    }).encode("ascii")

    status, _, resp_body = http_request(
        "POST", f"{CIDAAS_BASE}/token-srv/token",
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        data=body,
    )
    print(f"[i] Refresh Status: {status}")
    print(resp_body.decode("utf-8", "replace"))
    if status != 200:
        sys.exit(1)
    save_tokens(json.loads(resp_body))


def cmd_userinfo(args):
    tokens = load_tokens()
    status, _, body = http_request(
        "GET", f"{CIDAAS_BASE}/users-srv/userinfo",
        headers={"Authorization": f"Bearer {tokens['access_token']}", "Accept": "application/json"},
    )
    print(f"[i] Status: {status}")
    print(body.decode("utf-8", "replace"))
    if status == 200:
        info = json.loads(body)
        sub = info.get("sub")
        if sub:
            tokens["username"] = sub
            save_tokens(tokens)
            print(f"\n[i] 'sub' ({sub}) als 'username' fuer /transactions gespeichert.")


def cmd_receipts(args):
    tokens = load_tokens()
    username = tokens.get("username")
    if not username:
        print("[!] Kein 'username' (cidaas sub) bekannt — zuerst 'userinfo' ausfuehren.", file=sys.stderr)
        sys.exit(1)

    params = {
        "start": args.start,
        "limit": args.limit,
        "country": args.country,
        "version": args.version,
    }
    url = (f"{ACARDO_BASE}/api/v2/customers/{urllib.parse.quote(username)}/transactions?"
           + urllib.parse.urlencode(params))

    headers = {
        "Authorization": f"Bearer {tokens['access_token']}",
        "client-id": LOYALTY_CLIENT_ID,
        "app-platform": "Android",
        "app-version": APP_VERSION,
        "Accept": "application/json",
    }

    status, _, body = http_request("GET", url, headers=headers)
    print(f"[i] GET {url}")
    print(f"[i] Status: {status}")
    text = body.decode("utf-8", "replace")
    try:
        parsed = json.loads(text)
        print(json.dumps(parsed, indent=2, ensure_ascii=False)[:8000])
    except json.JSONDecodeError:
        print(text[:2000])

    if status != 200:
        print("\n[!] Fehlgeschlagen. Moegliche Ursachen: 'client-id'-Header braucht "
              "eigenen Token-Exchange (siehe api-kaufland.md Abschnitt 3), 'version' "
              "oder 'country' falsch, oder Token abgelaufen ('refresh' probieren).",
              file=sys.stderr)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_login = sub.add_parser("login", help="Manuellen PKCE-Login durchfuehren")
    p_login.add_argument("--locale", default="de-DE")
    p_login.add_argument("--store", default=None, help="preferredStore (optional)")
    p_login.set_defaults(func=cmd_login)

    p_refresh = sub.add_parser("refresh", help="Access-Token per refresh_token erneuern")
    p_refresh.set_defaults(func=cmd_refresh)

    p_userinfo = sub.add_parser("userinfo", help="UserInfo abrufen (liefert 'sub'/username)")
    p_userinfo.set_defaults(func=cmd_userinfo)

    p_receipts = sub.add_parser("receipts", help="Transaktionen/Kassenbons abrufen")
    p_receipts.add_argument("--start", type=int, default=0)
    p_receipts.add_argument("--limit", type=int, default=20)
    p_receipts.add_argument("--country", default="DE")
    p_receipts.add_argument("--version", type=int, default=2)
    p_receipts.set_defaults(func=cmd_receipts)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
