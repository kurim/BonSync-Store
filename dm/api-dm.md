# dm (Mein dm) App – Login & eBon-API

Reverse-engineert aus `de.dm.meindm.android` 6.18.0 (versionCode 192224) plus Live-Analyse
des Web-Logins auf `signin.dm.de`/`account.dm.de`. eBon-Abruf **mit echtem Account
verifiziert** (2026-09-16, Browser-DevTools-Mitschnitt + Live-Tests). **Login-Automatisierung
ist NICHT möglich** — alle drei getesteten Wege sind bewusst dagegen abgesichert (siehe
Abschnitt "Login"). Praktische Konsequenz: kein "install-and-forget"-Modul, siehe
`dm-module/`.

## Architektur

Die App ist ein Hybrid: natives Kotlin-Login (Curity HAAPI SDK) + React-Native-UI. Für die
eigentliche API-Nutzung ist das aber nebensächlich — die eBon-Endpunkte sind eigenständige
REST-Services (`ebon-prod.services.dmtech.com`, `purchasehistory-prod.services.dmtech.com`),
die unabhängig vom Client (native App, Website) per Bearer-Token angesprochen werden.
`www.dm.de` selbst nutzt einen separaten, öffentlich zugänglichen Web-Login (Client-ID
`webshop`), der nicht mit der App-Anmeldung identisch ist.

## Login

Es gibt drei getestete Wege, alle über Curity Identity Server (`signin.dm.de/dm-de`,
OIDC-Discovery unter
`https://signin.dm.de/dm-de/oauth-anonymous/.well-known/openid-configuration`), und **alle
drei sind abgesichert — dieses Projekt versucht nicht, das zu umgehen.**

### Weg A: Native App — Dynamic Client Registration + Geräte-Attestierung

App-Client registriert sich dynamisch (`POST /dm-de/dynamic-client-registration`,
Curity-Template `haapi-droid-template-client`) bevor überhaupt ein Login möglich ist. Live-Test:

```
POST https://signin.dm.de/dm-de/dynamic-client-registration
{"software_id":"haapi-droid-template-client"}

HTTP/2 401
www-authenticate: Bearer realm="dm-de-token-service-profile", error="invalid_token"
```

Der dafür nötige Bearer-Bootstrap-Token ist nach allen Indizien im Bytecode
(`HaapiError$KeyStoreException`, `validateAttestationCapability`, `se.curity...haapi.android`
SDK) ein **hardware-attestierter Client-Assertion-Token** aus dem Android Keystore (ggf. plus
Play Integrity). Das kann kein reiner HTTP-Client erzeugen — architektonische Grenze, kein
Bytecode-Analyse-Problem.

### Weg B: Web-Login (`account.dm.de`) — reCAPTCHA Enterprise

Client-ID **`nextaccount`** (live aus einem echten Token-Exchange bestätigt — nicht
`webshop`, das war eine falsche Vermutung aus einem früheren Test), Standard-
Authorization-Code-Flow mit PKCE, `redirect_uri: https://account.dm.de/callback`:

```
GET  https://signin.dm.de/dm-de/oauth-authorize
     ?client_id=nextaccount&response_type=code&redirect_uri=https://account.dm.de/callback
     &scope=openid email customerId roles
     &code_challenge=<S256>&code_challenge_method=S256&state=<state>
     &acr_values=web-login-page
POST https://signin.dm.de/dm-de/authentication/web-login
     {recaptchaToken, username, password, rememberMe}
GET  https://signin.dm.de/dm-de/oauth-authorize?token=<continuation>&state=<state>
     -> 302 redirect zu https://account.dm.de/callback?code=...&state=...&iss=...&session_state=...
POST https://signin.dm.de/dm-de/oauth-token
     client_id=nextaccount&grant_type=authorization_code&code=<code>
     &code_verifier=<verifier>&redirect_uri=https://account.dm.de/callback
     -> {id_token, access_token, token_type: "bearer", scope, expires_in: 150}
```

`nextaccount` ist ein **Public Client** (kein `client_secret`, nur PKCE). Der `authentication/
web-login`-Schritt lädt serverseitig **Google reCAPTCHA Enterprise** (invisible, sitekey
`6LfqJy0sAAAAAP_XsW1Oo9ZQIPPa6V8R3F_7sQqg`, Action `login`, `recaptchaEnabled: true` im
`baseConfig`-Block der Seite). Ohne gültiges `recaptchaToken` liefert der Login-Endpunkt für
JEDEN Request (auch komplett kaputten/leeren Body) identisch `400 {}` — verifiziert per
Live-Test mit mehreren Body-Varianten. Das ist bewusste Bot-Abwehr und wird hier nicht
umgangen.

**Kein `refresh_token`, nur 150 Sekunden Gültigkeit:** Ein live mitgeschnittener
Token-Exchange lieferte `expires_in: 150` und **kein** `refresh_token`-Feld.

### Weg C: Session-Cookie-Replay für stillen Re-Login — getestet, funktioniert NICHT

Naheliegende Hypothese war: die Website hält sich dauerhaft eingeloggt, indem sie den
`oauth-authorize`-Schritt bei Bedarf automatisch wiederholt und sich dabei auf die
bestehende Curity-**Session** (Cookies auf `signin.dm.de`, z. B. `sessionid`/`_sessionid`)
statt auf einen OAuth-`refresh_token` verlässt (klassisches SSO-Verhalten).

**Live getestet und in allen Varianten gescheitert** (2026-09-16, drei Versuche mit
`dm_login_test.py --cookie`):
1. Mit `acr_values=web-login-page` im `oauth-authorize`-Request → landet immer auf der
   Login-Seite, unabhängig von der Cookie-Gültigkeit (dieser Parameter erzwingt vermutlich
   die interaktive Login-UI).
2. Mit `prompt=none` statt `acr_values` (Standard-OIDC für stille Auth-Versuche) → der
   interne Redirect bekommt zwar sichtbar `sso=force` angehängt, landet aber immer noch auf
   der Login-Seite.
3. Mit einem **frisch aus dem Browser kopierten, korrekt von `signin.dm.de/dm-de/
   oauth-session` stammenden** Cookie-Header (Domain und Aktualität explizit verifiziert)
   → gleiches Ergebnis.

Plausibelste Erklärung: eine bewusste Geräte-/Request-Fingerprint-Bindung der Session (z. B.
über die `_oq`-Cookie oder TLS/User-Agent-Abgleich), die genau solche Cookie-Replays von
einem anderen Client aus verhindern soll — eine legitime Anti-Session-Hijacking-Maßnahme,
die hier nicht weiter umgangen wird.

### Praktischer Weg: manuelles Token pro Sync

Da keiner der drei Wege automatisierbar ist, bleibt nur: **als Mensch im Browser einloggen**,
den `Authorization: Bearer <access_token>`-Header eines echten API-Requests aus den DevTools
kopieren und **unmittelbar danach** (innerhalb von ~150s) synchronisieren. Für Skript-Tests:
`dm_login_test.py --token "<access_token>" --list/--detail/--pdf`. Ein "install-and-forget"-
BonSync-Modul mit automatischem Hintergrund-Sync ist damit **nicht** realistisch — siehe
`dm-module/index.js`, das diese Einschränkung explizit abbildet (`ensureFreshCredentials`
wirft nach Ablauf einen Fehler statt einen Refresh vorzutäuschen).

## eBon-Abruf — live verifiziert (2026-09-16)

Zwei unabhängige Services, beide per `Authorization: Bearer <access_token>`:

### 1) Liste

```
GET https://purchasehistory-prod.services.dmtech.com/v1/purchasehistory?size=20
Authorization: Bearer <access_token>
```

Antwort (live bestätigt per `dm_login_test.py --list`):
```json
{
  "purchaseHistoryItems": [
    {
      "id": "daa167cb-10cd-47c6-9cc1-f9d72bdfe5bc_2025",
      "purchaseType": "MARKET",
      "dateTimePlaced": "2025-05-03T12:38:31Z",
      "currency": "EUR",
      "totalAmount": 14.85,
      "ebonData": { "followUpOrder": false }
    }
  ]
}
```

`size` ist der einzige bestätigte Query-Parameter; Pagination über `size=20` hinaus (weiteres
`page`/`offset`/Cursor) ist **nicht getestet**. Kein `market`/Adressfeld in der Liste — dafür
muss pro Beleg der Detail-Endpunkt (unten) aufgerufen werden.

### 2) Detail

```
GET https://ebon-prod.services.dmtech.com/api/customer/ebons/{id}
Authorization: Bearer <access_token>
```

(`{id}` = die `id` aus der Liste, z. B. `daa167cb-10cd-47c6-9cc1-f9d72bdfe5bc_2025` —
enthält offenbar das Jahr als Suffix.)

Antwort:
```json
{
  "id": "daa167cb-10cd-47c6-9cc1-f9d72bdfe5bc_2025",
  "date": "2025-05-03",
  "time": "14:38:31",
  "currency": "EUR",
  "totalAmount": 14.85,
  "discount": 0,
  "totalPaybackPoints": 0,
  "cashRegisterId": 2,
  "followUpOrder": false,
  "hasDownloadableReceipt": true,
  "address": {
    "name": "dm-drogerie markt",
    "street": "Mittelstraße 63",
    "streetAdditional": null,
    "zip": "40721",
    "city": "Hilden"
  },
  "bonItems": [
    { "dan": "1685693", "description": "" }
  ]
}
```

**Wichtig für ein BonSync-Modul:** Das Adressfeld heißt `zip`, nicht `zipCode` — muss beim
Mapping ins `market`-Format (`module-format.md` Abschnitt 4.1) explizit umbenannt werden,
sonst bleibt `market_zip` in der DB `NULL` (genau der in `module-format.md` beschriebene
Stolperstein). `bonItems[].description` war im Testbeleg durchgehend leer — nur `dan`
(Artikelnummer) war befüllt; für `fetchReceiptItems` bräuchte es vermutlich eine separate
Produktnamen-Auflösung, die hier nicht implementiert wurde (optional in der Contract).

### 3) PDF-Export

```
GET https://ebon-prod.services.dmtech.com/api/customer/ebons/{id}/download
Authorization: Bearer <access_token>
```

Live bestätigt per `dm_login_test.py --pdf` — liefert die PDF-Bytes.

## Zusammenfassung des Flows

```
Manueller Browser-Login -> access_token kopieren (nur ~150s gültig)
  ├─> GET purchasehistory-prod.../v1/purchasehistory?size=N     (Liste, live bestätigt)
  ├─> GET ebon-prod.../api/customer/ebons/{id}                  (Detail, live bestätigt)
  └─> GET ebon-prod.../api/customer/ebons/{id}/download         (PDF, live bestätigt)

Kein automatischer Refresh möglich (siehe Abschnitt "Login", Weg A/B/C alle abgesichert) -
vor jedem Sync ein neues Token manuell einfügen.
```

Alle drei eBon-Endpunkte (Liste, Detail, PDF) sind mit echtem Account, echtem Bearer-Token
und Origin/Referer-Headern (`https://account.dm.de`) erfolgreich getestet — `dm_login_test.py
--token ... --list/--detail/--pdf` funktioniert end-to-end.

## Offene Punkte

1. **Pagination der Liste über `size=20` hinaus** ungeklärt (mehr Belege als eine Seite).
2. **`cancelled`/Storno-Status**: im Testbeleg nicht beobachtbar (kein stornierter Beleg im
   Account) — Feld dafür unbekannt, `dm-module/index.js` setzt aktuell immer `cancelled:
   false`.
3. **`priceInfo`/Artikel-Auflösung**: `bonItems[].description` war im Testbeleg leer, nur
   `dan` (Artikelnummer) befüllt — für `fetchReceiptItems` bräuchte es vermutlich eine
   separate Produktnamen-Auflösung, nicht implementiert (optionaler Teil der Contract).

Referenz-Implementierung: `dm_login_test.py` (eBon-Liste/-Detail/-PDF per `--token`; die
`--cookie`/`--refresh-token`/`--email`+`--password`-Modi bleiben im Skript als dokumentierte,
nachweislich nicht funktionierende Login-Versuche stehen) und `dm-module/` (BonSync-Modul,
`loginStrategy: credentials` — Nutzer fügt vor jedem Sync manuell ein frisches Token ein,
kein automatischer Login/Refresh).
