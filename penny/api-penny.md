# PENNY eBon-API — Referenz

Reverse engineered aus der PENNY-Android-App (APK, `dev.lokksmith` OIDC-Lib)
und dem JS-Bundle der `penny-ebon-ui`-SPA (`ebon_ui_bundle.js`). Inoffiziell,
nicht dokumentiert — kann sich jederzeit ändern.

## 1. Auth: OAuth2/OIDC via Keycloak (PKCE, Public Client)

```
Discovery:     https://account.penny.de/realms/penny/.well-known/openid-configuration
client_id:     pennyandroid
redirect_uri:  https://www.penny.de/app/login     (App-Link, kein Custom-Scheme)
scope:         openid profile email
client_secret: keiner (Public Client, Authorization Code + PKCE/S256)
```

`authorization_endpoint` und `token_endpoint` kommen aus dem Discovery-Dokument
(nicht hardcoden).

### 1.1 Authorization Request

```
GET {authorization_endpoint}
  ?client_id=pennyandroid
  &redirect_uri=https://www.penny.de/app/login
  &response_type=code
  &scope=openid profile email
  &state=<random>
  &code_challenge=<BASE64URL(SHA256(code_verifier))>
  &code_challenge_method=S256
```

Nutzer loggt sich im Browser/WebView ein. Ergebnis ist ein Redirect auf
`redirect_uri` mit `?code=...&state=...` (oder `?error=...&error_description=...`).
Da `redirect_uri` eine normale HTTPS-URL ist (kein Custom-Scheme), zeigt der
Browser nach dem Redirect ggf. eine Fehlerseite — der Code steht trotzdem in
der Adresszeile.

`state` muss gegen den gesendeten Wert geprüft werden (CSRF-Schutz).

### 1.2 Token Exchange

```
POST {token_endpoint}
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code
&code=<code>
&redirect_uri=https://www.penny.de/app/login
&client_id=pennyandroid
&code_verifier=<verifier>
```

Response (Keycloak-Standardformat):

```json
{
  "access_token": "<JWT>",
  "expires_in": 300,
  "refresh_expires_in": 1800,
  "refresh_token": "<JWT>",
  "token_type": "Bearer",
  "id_token": "<JWT>",
  "not-before-policy": 0,
  "session_state": "<uuid>",
  "scope": "openid profile email"
}
```

`access_token` ist kurzlebig (~5 min), `refresh_token` länger (~30 min).
Sinnvoll: `expires_at = now + expires_in` selbst mitführen, da die API dieses
Feld nicht liefert.

### 1.3 Token Refresh

```
POST {token_endpoint}
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token
&refresh_token=<refresh_token>
&client_id=pennyandroid
```

Response wie oben. Keycloak liefert nicht immer einen neuen `refresh_token`
mit — falls das Feld fehlt, den alten weiterverwenden. Bei abgelaufenem
Refresh Token (`refresh_expires_in` überschritten): 400/401, kompletter
Login-Flow (1.1) nötig.

### 1.4 Access-Token-Claims (JWT-Payload)

Relevante Claims (Standard-Keycloak-Claims gekürzt):

| Claim | Bedeutung |
|---|---|
| `sub` | Keycloak User-ID |
| `rewe_id` | **Kundennummer** — wird als `{reweId}`-Pfadparameter in der Ebons-API gebraucht |
| `preferred_username`, `email`, `given_name`, `family_name`, `name` | Profildaten |
| `exp`, `iat`, `auth_time` | Standard-JWT-Zeitfelder |
| `scope`, `realm_access`, `resource_access`, `azp`, `sid`, `jti`, `iss`, `aud`, `typ` | Standard-OIDC/Keycloak |

Kein API-Call nötig, um `reweId` zu ermitteln — einfach den Access-Token
lokal decodieren (Base64URL des mittleren JWT-Segments).

## 2. Ebons-API

```
Host: https://api.penny.de
Auth: Authorization: Bearer <access_token>
Header: correlation-id: <uuid v4>   (pro Request neu, von der offiziellen App mitgeschickt — unklar ob serverseitig erzwungen, aber zur Sicherheit setzen)
```

Bei `401` (abgelaufener Access Token): Token per 1.3 erneuern und den Request
einmal wiederholen.

### 2.1 `GET /api/tenants/penny/customers/{reweId}/ebons`

Query-Parameter: `objectsPerPage` (App nutzt `20`), `page` (1-indiziert).

Response:

```json
{
  "items": [
    {
      "id": "xxx-eb22-4ca9-b87e-xxxx",
      "timestamp": "2026-xx-xxT16:00:48Z",
      "totalPrice": 2252,
      "market": null,
      "cancelled": false
    }
  ],
  "pagination": {
    "currentPage": 1,
    "pageCount": 3
  }
}
```

- `totalPrice`: **Cent-Betrag** als Integer (2252 = 22,52 €), nicht Euro-Float.
- `market`: entweder `null` oder `{ "name": ..., "street": ..., "zipCode": ..., "city": ... }`.
- `cancelled`: `true` bei stornierten Belegen.
- Paginierung beenden, wenn `items` leer ist oder `currentPage >= pageCount`.

### 2.2 `GET /api/tenants/penny/customers/{reweId}/ebons/{id}/pdf`

Antwort: Binärer PDF-Blob (`Content-Type: application/pdf` o. ä.), kein JSON.
Enthält nativen Text (kein Scan/Bild) — direkt per Text-Extraktion auswertbar,
keine OCR nötig.

### 2.3 `DELETE /api/tenants/penny/customers/{reweId}/ebons/{id}`

Löscht einen einzelnen Beleg serverseitig unwiderruflich. Kein Response-Body.

### 2.4 `DELETE /api/tenants/penny/customers/{reweId}/ebons`

Löscht **alle** Belege des Kunden unwiderruflich. Kein Response-Body.

### 2.5 `GET /api/tenants/penny/customers/{reweId}/subscriptions`

Liefert den eBon-Opt-in-Status:

```json
{ "isSubscribed": true }
```

### 2.6 `PUT /api/tenants/penny/customers/{reweId}/subscriptions`

Request-Body:

```json
{
  "isSubscribed": true,
  "client": "MOBILE",
  "ebonsDeleted": false
}
```

`ebonsDeleted` wird von der App auf `true` gesetzt, wenn beim Deaktivieren
gleichzeitig alle Belege gelöscht werden sollen. Response wie 2.5.

## 3. PDF-Textformat (Bon-Layout)

Die eBon-PDFs enthalten reinen Text mit folgendem, per Regex auswertbarem
Aufbau (verifiziert gegen echte Belege per Summenabgleich):

| Information | Muster | Beispiel |
|---|---|---|
| Artikelzeile | `<name>  <preis>,<cent>  <steuercode>[ *]` | `Pepsi Cola Zero          8,94 A` |
| Mengenzeile (optional, Folgezeile) | `<menge> Stk x <einzelpreis>` | `2 Stk x 8,94` |
| Summe | `SUMME EUR <betrag>` | `SUMME EUR 22,52` |
| Zahlart | `Geg. <methode> EUR <betrag>` | `Geg. xxx EUR 22,52` |
| Datum/Zeit/Bon-Nr | `<TT.MM.JJJJ> <HH:MM> Bon-Nr.:<nr>` | `05.09.2026 18:00 Bon-Nr.:xxxx` |
| Markt/Kasse/Bediener | `Markt:<id> Kasse:<id> Bed.:<id>` | `Markt:0515 Kasse:1 Bed.:xxx` |
| Ersparnis | `<betrag> EUR gespart` | `0,30 EUR gespart` |
| Treuepunkte | `Sie erhalten <n> Treuepunkt...` / `Du erhältst ...` | `Sie erhalten 4 Treuepunkte` |
| Steueraufschlüsselung | `<code>=  <satz>%  <netto>  <steuer>  <brutto>` | `A=  19,00%  18,92  3,60  22,52` |
| USt-IdNr. des Markts | `UID Nr.: <id>` | `UID Nr.: xxxxx` |

Ein `*` nach dem Steuercode markiert Artikel, die von Rabatten ausgeschlossen
sind (z. B. Pfand). Beträge sind deutsches Format (`,` als Dezimaltrennzeichen,
`.` als Tausendertrennzeichen) — vor Weiterverarbeitung normalisieren.

Beispiel für ein geparstes Ergebnis (ein Artikel mit Menge, ein Artikel ohne,
ein Rabatt als negativer Preis, Pfand als "discount_excluded"):

```json
{
  "items": [
    { "name": "Pepsi Cola Zero", "price": 17.88, "tax_code": "A", "discount_excluded": false, "quantity": 2, "unit_price": 8.94 },
    { "name": "PFAND 1,50 EURO", "price": 3.0, "tax_code": "A", "discount_excluded": true, "quantity": 2, "unit_price": 1.5 },
    { "name": "App-Preis-Rabatt", "price": -0.3, "tax_code": "A", "discount_excluded": false }
  ],
  "total": 22.52,
  "payment_method": "xxxx",
  "payment_amount": 22.52,
  "date": "05.09.2026",
  "time": "18:00",
  "receipt_number": "xxxx",
  "market_id": "xxxx",
  "cashier_id": "1",
  "employee_id": "xxxx",
  "savings": 0.3,
  "loyalty_points": 4,
  "store_vat_id": "xxxxx",
  "tax_breakdown": [
    { "code": "A", "rate_percent": 19.0, "net": 18.92, "tax": 3.6, "gross": 22.52 }
  ]
}
```

## 4. Grenzen / Fallstricke

- Inoffizielle API — keine SLA, keine Versionierung, keine Garantie auf
  Stabilität von Feldnamen oder Bon-Layout.
- Kein headless Login möglich: der Authorization-Code-Schritt läuft über
  Keycloak im Browser (PKCE), es gibt keinen Resource-Owner-Password-Grant.
- `objectsPerPage`/`page` sind 1-basiert für `page`; unklar, ob ein serverseitiges
  Limit für `objectsPerPage` existiert (App nutzt konstant `20`).
- Rate-Limits sind nicht dokumentiert und wurden nicht getestet.
