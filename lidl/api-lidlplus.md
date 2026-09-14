# Lidl Plus API – Referenz-Spezifikation

Saubere, implementierungs-orientierte Zusammenfassung der inoffiziellen Lidl-Plus-API
(Login + Kassenbons), reverse-engineered aus der Android-App `com.lidl.eci.lidlplus`
v17.9.3 und live gegen einen echten Account verifiziert (Stand: 2026-09-11).

**Nur für den Zugriff auf den eigenen Account gedacht.** Kein reCAPTCHA-Bypass, keine
Bot-Detection-Umgehung, keine Massenabfragen fremder Accounts.

Diese Datei ist die **Spezifikation zum Nachbauen**. Die vollständige Herleitung mit
Sackgassen, Beweisen und Zwischenschritten steht in [`API_ANALYSE.md`](./API_ANALYSE.md) -
bei Unklarheiten dort nachschlagen. Eine Referenzimplementierung in Python liegt in
[`lidlplus_client.py`](./lidlplus_client.py).

## Inhalt

1. [Architektur/Hosts](#1-architektur--hosts)
2. [Authentifizierung (OAuth2 + PKCE)](#2-authentifizierung-oauth-20-authorization-code--pkce)
3. [Pflicht-Header für Ticket-Requests](#3-pflicht-header-für-alle-ticketslidlpluscom-requests)
4. [Endpunkte](#4-endpunkte)
5. [Ticket-ID-Format](#5-ticket-id-format)
6. [Rate-Limiting / Bot-Erkennung](#6-rate-limiting--bot-erkennung)
7. [Zertifikat-Pinning](#7-zertifikat-pinning)
8. [Bekannte Fallstricke (Kurzfassung)](#8-bekannte-fallstricke-kurzfassung)
9. [Referenzen](#9-referenzen)

---

## 1. Architektur / Hosts

Die App spricht zwei getrennte Systeme an:

| Host | Zweck |
|---|---|
| `accounts.lidl.com` | Identity-Server (Login/OAuth2, ASP.NET/Duende) |
| `tickets.lidlplus.com/api` | Kassenbon-Microservice (Liste + Detail), hinter `istio-envoy` |

Daneben existiert eine große Zahl weiterer Microservice-Hosts nach dem Muster
`<feature>.lidlplus.com` (z. B. `coupons.`, `stores.`, `profile.`, `selfscanning.`) - für
Login und Kassenbons irrelevant, aber als Ausgangspunkt für Erweiterungen brauchbar
(vollständige Liste in `API_ANALYSE.md`, Abschnitt 6).

## 2. Authentifizierung (OAuth 2.0 Authorization Code + PKCE)

### 2.1 Konstanten

| Parameter | Wert |
|---|---|
| Authorization-Endpoint | `https://accounts.lidl.com/connect/authorize` |
| Token-Endpoint | `https://accounts.lidl.com/connect/token` |
| `client_id` | `LidlPlusNativeClient` |
| Client-Secret | `secret` (literal - zusammen: `LidlPlusNativeClient:secret`, als Basic-Auth beim Token-Call) |
| `scope` | `openid profile offline_access lpprofile lpapis` |
| `redirect_uri` | `com.lidlplus.app://callback` (Custom-URI-Scheme, siehe 2.3) |
| PKCE | Standard `code_verifier`/`code_challenge` (S256) |

### 2.2 Authorize-Request

```
GET https://accounts.lidl.com/connect/authorize
    ?client_id=LidlPlusNativeClient
    &redirect_uri=com.lidlplus.app%3A%2F%2Fcallback
    &response_type=code
    &scope=openid%20profile%20offline_access%20lpprofile%20lpapis
    &state=<random>
    &nonce=<random>
    &code_challenge=<S256 von code_verifier>
    &code_challenge_method=S256
    &Country=<ISO-2, z.B. DE>
    &language=<sprache>-<land>, z.B. de-DE
    &force=false
    &track=false
```

`Country` und `language` sind **zwingend**, obwohl sie kein Standard-OIDC-Parameter sind -
ohne sie landet man auf einer generischen Fehlerseite (`accounts.lidl.com/error`), weil der
Identity-Server sonst keinen Mandanten auflösen kann.

### 2.3 Login-Flow (interaktiv, nicht automatisierbar ohne Weiteres)

1. Obige URL im Browser öffnen. Der Nutzer loggt sich auf der echten Lidl-Seite ein
   (E-Mail/Telefon + Passwort, ggf. 2FA-Code) - das ist eine sich ändernde SPA, kein
   stabiler REST-Call.
2. Bei Erfolg leitet der Server auf `redirect_uri?code=...&state=...` um.
3. `redirect_uri` ist ein **Custom-URI-Scheme** (`com.lidlplus.app://callback`), kein
   `https://`-Link - ein Desktop-Browser kann das nicht öffnen. Der `code` lässt sich
   trotzdem einsehen: Browser-DevTools → Network-Tab mit "Preserve log" aktivieren → nach
   dem Login nach dem fehlgeschlagenen `callback`-Request suchen → dessen Request-URL
   enthält `code` und `state`.
4. Alternative: programmatisch mit Selenium/Chrome starten und den Navigationsversuch zu
   `com.lidlplus.app://callback` aus den Chrome-Performance-Logs lesen
   (`Network.requestWillBeSent`-Events; Chrome loggt den Versuch, auch wenn es das Schema
   nicht öffnen kann - siehe `lidlplus_client.py::_find_redirect_in_logs`). Damit lässt
   sich Schritt 1-2 automatisieren, siehe Abschnitt 6 zu den Grenzen davon.

Beispiel der Redirect-URL, die man in DevTools/Performance-Logs sucht (Werte gekürzt):

```
com.lidlplus.app://callback?code=C09A9B2E...<opak, ~40+ Zeichen>&scope=openid%20profile%20offline_access%20lpprofile%20lpapis&state=<derselbe state wie in 2.2>&session_state=<opak>
```

Relevant ist ausschließlich der `code`-Parameter (+ `state` zum Abgleich gegen den
selbst gesetzten Wert, als CSRF-Schutz) - `scope` und `session_state` können ignoriert
werden.

### 2.4 Token-Austausch

```
POST https://accounts.lidl.com/connect/token
Content-Type: application/x-www-form-urlencoded
Authorization: Basic base64("LidlPlusNativeClient:secret")

grant_type=authorization_code
&code=<aus Schritt 2.3>
&redirect_uri=com.lidlplus.app://callback
&code_verifier=<aus 2.2>
```

Response (JSON): `access_token`, `refresh_token`, `id_token`, `token_type`, `expires_in`.

Beispiel (Werte gekürzt/anonymisiert, Struktur und Feldnamen echt):

```jsonc
{
  "access_token": "eyJhbGciOiJSUzI1NiIs...<JWT, ~1560 Zeichen>",
  "expires_in": 1200,
  "token_type": "Bearer",
  "refresh_token": "A0734503D82B768F2D47...<opak, 64 Hex-Zeichen>",
  "id_token": "eyJhbGciOiJSUzI1NiIs...<JWT, ~1436 Zeichen>",
  "scope": "openid profile lpprofile lpapis offline_access"
}
```

`access_token` und `id_token` sind signierte JWTs (RS256); `refresh_token` ist ein opakes
64-stelliges Hex-Token, kein JWT.

#### Token-Lifetimes (aus den JWT-Claims gemessen, nicht in der Response enthalten)

| Token | Lifetime | Quelle |
|---|---|---|
| `access_token` | **1200 s (20 min)** | `expires_in` in der Response; verifiziert gegen `exp - iat` im decodierten JWT |
| `id_token` | **300 s (5 min)** | `exp - iat` im decodierten JWT (kürzer als der Access-Token - nur zur initialen Identitätsprüfung relevant, nicht für weitere API-Calls nötig) |
| `refresh_token` | unbekannt/nicht verifiziert | opak, keine Claims auslesbar; App behandelt ihn als langlebig (`offline_access`-Scope) - **Vorsicht:** Server könnte ihn serverseitig rotieren oder mit Sliding-/Absolute-Expiration versehen (typisch für Duende IdentityServer, aber nicht live bestätigt). Praxis: bei jedem Refresh den ggf. neuen `refresh_token` aus der Response übernehmen und den alten verwerfen (Rotation defensiv annehmen) |

Praktische Konsequenz: `access_token` proaktiv erneuern, sobald `expires_at` (selbst
berechnet: `now + expires_in`, mit Sicherheitsmarge, z. B. 60s) unterschritten wird - nicht
erst nach einem `401` reagieren.

### 2.5 Token-Refresh

```
POST https://accounts.lidl.com/connect/token
Authorization: Basic base64("LidlPlusNativeClient:secret")

grant_type=refresh_token
&refresh_token=<gespeicherter refresh_token>
```

## 3. Pflicht-Header für alle `tickets.lidlplus.com`-Requests

| Header | Beispielwert | Hinweis |
|---|---|---|
| `Authorization` | `Bearer <access_token>` | |
| `Accept` | `application/json` | |
| `App-Version` | `17.9.3` | echte App-Version, wird nicht strikt geprüft |
| `Operating-System` | `Android` (oder `iOs`) | |
| `App` | `com.lidl.eci.lidlplus` (Android-Package-ID) | bei iOS-Clients z. B. `com.lidl.eci.lidl.plus` |
| `Accept-Language` | `de` | **muss ein Header sein, kein Query-Parameter!** |

⚠️ **Wichtigster Fallstrick:** Ein Query-Parameter `LanguageCode`/`language` wird
serverseitig **ignoriert** und führt zu `400 "'Language Code' must not be empty."`, selbst
wenn gesetzt. Die Sprache muss über den `Accept-Language`-Header laufen.

## 4. Endpunkte

### 4.1 Ticket-Liste

```
GET https://tickets.lidlplus.com/api/v2/{country}/tickets?skip={skip}&take={take}
```

- `{country}` ist ein **Pfadsegment**, kein Query-Parameter: ISO-2-Code, z. B. `DE`
  (Großschreibung). Es gibt **kein** User-ID-Segment - der Nutzer wird ausschließlich über
  den Bearer-Token identifiziert.
- Response: reines **JSON-Array** (kein Wrapper-Objekt) von Ticket-Listen-Objekten.
- Bestätigte Felder: `id`, `date` (ISO-8601 mit Offset), `totalAmount`, `articlesCount`,
  `isFavorite`. Laut den Smali-Datenmodellen zusätzlich vorhanden: `savings`,
  `couponsUsedCount`, `returns[]`, `isHtml`, `iconUrl`, `vendor{}`, `badges{}`, `origin`
  (nicht alle live gegengeprüft).
- Pagination über `skip`/`take`; Ende erreicht, wenn die zurückgegebene Seite kleiner als
  `take` ist.
- Kein bekannter serverseitiger Datumsfilter-Parameter. Workaround: Liste seitenweise
  laden und **client-seitig** nach dem `date`-Feld filtern - die Liste ist absteigend
  sortiert, ein Abbruch beim ersten zu alten Eintrag reicht.

### 4.2 Ticket-Detail

```
GET https://tickets.lidlplus.com/api/v3/{country}/tickets/{ticketId}
```

⚠️ **Nicht `v2`!** `v2/{country}/tickets/{ticketId}` liefert einen sofortigen, leeren
`400` direkt vom `istio-envoy`-Gateway (Content-Length 0, ~1ms Antwortzeit - die Route
existiert unter `v2` für ein einzelnes Ticket schlicht nicht). Nur `v3` funktioniert; mit
`Accept-Language` als Header (siehe Abschnitt 3), nicht als Query-Parameter.

Bestätigte Response-Felder (aus einem echten `200`):

```jsonc
{
  "ticketType": "HTML",
  "id": "string",
  "barCode": "string",
  "couponsUsed": [],
  "offersUsed": [{ "offerTitle": "string", "offerDescription": "string" }],
  "returnedHtmlTickets": [],
  "isFavorite": false,
  "date": "2025-06-30T17:16:34",
  "totalAmount": 68.88,
  "store": {
    "id": "DE3303", "name": "string", "address": "string",
    "postalCode": "string", "locality": "string", "schedule": ""
  },
  "fiscalDataAt": null,          // nur Österreich befüllt, sonst null
  "languageCode": "de",
  "htmlPrintedReceipt": "<html>...</html>",  // s. 4.4
  "printedReceiptState": "NON_PRINTED",
  "hasInvoice": false,           // s. 4.3
  "logoUrl": "string",
  "watermarkUrl": "string",
  "codes": [{ "code": "string", "format": "ITF", "label": null,
              "position": "Bottom", "codeType": "ReturnInfo", "size": "Standard" }],
  "showCopy": false,
  "isDeleted": false,
  "collectingModel": null
}
```

Länderspezifisch existieren laut Datenmodellen zusätzlich Fiskalisierungs-Objekte
(`FiscalDataCZResponse`, `FiscalDataDeResponse`, ...) sowie Zahlungs-/Zeitstempel-Varianten
für CZ/DK/IE/IT/SE/PL - der Bon-Aufbau unterscheidet sich je nach Land.

### 4.3 Invoice/PDF-Endpoint (unverifiziert)

```
GET https://tickets.lidlplus.com/api/v3/{country}/invoice/{ticketId}
```

Aus dem APK-Bytecode rekonstruiert (Strings `v3/{country}/invoice/{id}`,
`DOWNLOAD_INVOICE`, `PDFRequest(pdfUrl=...)`), aber **nie live gesehen**: In allen bisher
geprüften Tickets stand `hasInvoice: false`. Vermutung: das ist eine pro Beleg manuell in
der App anzustoßende "Rechnung anfordern"-Funktion (ggf. für eine offizielle,
Finanzamt-taugliche Rechnung, getrennt vom normalen Kassenbon), die vermutlich erst danach
`hasInvoice: true` setzt und eine PDF-URL liefert. Vor Nutzung erst mit einem Ticket
verifizieren, bei dem `hasInvoice: true` ist.

### 4.4 Praktischer Ersatz: PDF aus `htmlPrintedReceipt` rendern

Da (4.3) unzuverlässig/unverifiziert ist, aber **jedes** Ticket-Detail-Objekt ein
`htmlPrintedReceipt`-Feld mit einer vollständigen HTML-Nachbildung des gedruckten
Kassenbons enthält (Artikel, MWST-Aufschlüsselung, Zahlungsbeleg), ist der zuverlässige
Weg zu einem PDF:

1. `htmlPrintedReceipt` in eine temporäre `.html`-Datei schreiben.
2. Mit headless Chrome öffnen (`file://...`).
3. Chrome-DevTools-Kommando `Page.printToPDF` aufrufen (`printBackground: true`), Base64
   dekodieren, als `.pdf` speichern.

Referenzimplementierung: `lidlplus_client.py::render_html_receipt_to_pdf` /
CLI-Befehl `ticket-pdf`. Ergebnis ist visuell identisch mit dem Kassenbon an der Kasse.

## 5. Ticket-ID-Format

Beispiel: `23003303220250630685989`. Enthält augenscheinlich eingebettet eine
Filial-/Kassen-Kennung, das Kaufdatum (`20250630` = 2025-06-30) und eine laufende Nummer -
**nicht vollständig verifiziert**, aber irrelevant für die Nutzung: die rohe ID aus der
Liste reicht immer als opaker Pfad-Parameter für den Detail-Call.

## 6. Rate-Limiting / Bot-Erkennung

- Die Login-Seite (`accounts.lidl.com/Account/Login`) läuft mit unsichtbarem
  **Google reCAPTCHA Enterprise (v3)** im Hintergrund.
- Eine per Selenium/ChromeDriver gesteuerte Session wird daran (u. a. am
  `navigator.webdriver`-Flag) als automatisiert erkannt und mit
  `app-errors: {"": "OverCapacityError"}` ("Die Kapazität wurde überschritten")
  abgewiesen - **kein** IP-Rate-Limit, sondern gezielte Bot-Erkennung. Derselbe Login
  funktioniert im selben Moment, von derselben IP, manuell im normalen Browser
  anstandslos.
- Es werden hier bewusst **keine** Umgehungstechniken verwendet (kein
  `undetected-chromedriver`, kein Patchen von `navigator.webdriver`, keine simulierten
  Mausbewegungen).
- **Empfehlung für eine Neuimplementierung:** den manuellen Login-Flow (2.3, Schritt 1-3)
  als zuverlässigen Standardweg vorsehen; eine automatisierte Variante nur als
  Best-Effort mit automatischem Fallback auf den manuellen Weg, nie als einzigen Pfad.
- Die `tickets.lidlplus.com`-Endpunkte selbst zeigten in den bisherigen Tests kein
  Rate-Limiting.

## 7. Zertifikat-Pinning

Nur `storetools.lidlplus.com` ist per Certificate-Pinning geschützt (vermutlich
Kassen-/POS-Terminal-Kommunikation). `accounts.lidl.com`, `tickets.lidlplus.com` und
`connect.lidlplus.com` sind **nicht** gepinnt - normale TLS-Bibliotheken/HTTP-Clients ohne
Zertifikats-Tricks reichen aus.

## 8. Bekannte Fallstricke (Kurzfassung)

| Symptom | Ursache | Lösung |
|---|---|---|
| `accounts.lidl.com/error` beim Authorize-Call | `Country`/`language` fehlen | Als Query-Parameter mitschicken (2.2) |
| `400 "'Language Code' must not be empty."` trotz gesetztem Wert | Sprache als Query-Parameter statt Header gesetzt | `Accept-Language`-**Header** verwenden (Abschnitt 3) |
| `400`, leerer Body, sofortige Antwort (~1ms) von `istio-envoy` auf `v2/{country}/tickets/{id}` | `v2` hat für Ticket-**Detail** keine Route | `v3` verwenden (4.2) |
| `400 "'Country' must be 2 characters..."` mit einer viel zu langen Zahl im Fehlertext | User-ID statt Ländercode ins Pfadsegment gesetzt | Nur den 2-stelligen Ländercode als Pfadsegment verwenden |
| Login-Automatisierung schlägt mit "Kapazität überschritten" fehl | reCAPTCHA erkennt Selenium | Nicht umgehen - manuellen Fallback nutzen (Abschnitt 6) |
| Kein PDF trotz `ticket`-Aufruf | Es gibt kein natives Bon-PDF, nur `htmlPrintedReceipt` | Lokal rendern (4.4) oder `hasInvoice`/Invoice-Endpoint prüfen (4.3) |

## 9. Referenzen

- [`API_ANALYSE.md`](./API_ANALYSE.md) - vollständiges Investigations-Log mit Beweisen,
  Sackgassen und APK-Fundstellen (Smali-Klassennamen, String-Fundstellen, Screenshots-
  Beschreibungen). Bei Unklarheiten oder für eine andere Zielsprache/Plattform zuerst
  dort nachschlagen, bevor erneut reverse-engineered wird.
- [`lidlplus_client.py`](./lidlplus_client.py) - lauffähige Python-Referenzimplementierung
  (Login manuell + automatisiert, Ticket-Liste, Ticket-Detail, PDF-Rendering, `probe`-Tool
  für weitere Pfad-Exploration).
- PyPI-Paket [`lidl-plus`](https://pypi.org/project/lidl-plus/) und
  [FaserF/ha-lidl](https://github.com/FaserF/ha-lidl) - unabhängige Cross-Checks für
  Auth-Flow und Header. **Vorsicht:** ihr `v2`-Pfad für Ticket-Detail ist gegen das aktuelle
  Backend falsch (siehe 4.2) - Endpunkte von dort immer erst live verifizieren, nicht
  blind übernehmen.
