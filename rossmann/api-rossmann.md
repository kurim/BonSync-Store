# Rossmann App – Login & Kassenbon-API

Reverse-engineert aus `de.rossmann.app.android` 5.11.1 (versionCode 421000110).
Verifiziert mit echtem Account (Login, Bestellhistorie, Kassenbons, PDF-Export).

## Hosts

| Zweck | Basis-URL |
|---|---|
| Login / Account | `https://rsmappapi.rossmann.net/account.ws` (v1) und `/account.ws/v2` (v2) |
| Online-Bestellungen (optional) | `https://api-ocm-de-prod.rossmann.net/order-history-api/` |
| Kassenbons (anybill, Drittanbieter) | `https://app.anybill.de/api/v4/` |

## Pflicht-Header (Login + Account-API)

Diese Header gehören auf **jeden** Request an `rsmappapi.rossmann.net` und
`api-ocm-de-prod.rossmann.net`:

```
x-api-key: rqYCy0y0BH5+8ZU5
x-correlation-id: <neue UUID pro Request>
App-Version: 5.11.1
Build-Number: 421000110
Platform: android
Platform-Version: 14
Android-Id: <beliebiger 16-stelliger Hex-String, pro Geraet stabil>
Reuse-Identifier: <beliebiger 16-stelliger Hex-String, pro Geraet stabil>
Build-Serial: unknown
```

Zusätzlich auf **Client-Ebene** (nicht pro Request, sondern für die gesamte
HTTP-Session):

```
User-Agent: okhttp/5.3.2
Accept-Encoding: gzip
```

Ohne den echten `okhttp`-User-Agent lehnt die vorgeschaltete CDN (Fastly)
Requests mit generischem HTTP-Client-User-Agent (z. B. `python-requests/…`)
mit `406` und leerem Body ab. Kein explizites `Accept` senden, die App tut
das auch nicht.

`Content-Type: application/json` nur bei Requests mit JSON-Body (POST/PUT).

## Schritt 1: Login

```
POST https://rsmappapi.rossmann.net/account.ws/v2/accounts/login
Content-Type: application/json

{
  "email": "<email>",
  "password": "<passwort>"
}
```

Wichtig: `anonymousAccountId`/`anonymousAccountHash` NICHT als `null` mitsenden,
sondern komplett weglassen, sonst `400`.

Antwort:
```json
{
  "accountId": 2400053267678,
  "accountHash": "54e7edc3efb176d5668e2eacf434de7b",
  "cashpointHash": "ef97feea36ed3a5f",
  "status": 0
}
```

`accountId` und `accountHash` werden für alle folgenden Schritte gebraucht.

## Schritt 2: Kassenbons (anybill)

### 2a) anybill-Zugangstoken holen

```
GET https://rsmappapi.rossmann.net/account.ws/v2/accounts/{accountId}/receipt/auth
Account-Hash: <accountHash>
```

Antwort:
```json
{ "accessToken": "...", "refreshToken": "...", "expiresIn": 3600 }
```

### 2b) Kassenbons auflisten

```
GET https://app.anybill.de/api/v4/receipt?take=<N>&orderBy=Date&orderByDirection=Descending
Authorization: Bearer <accessToken>
```

`take` ist server-seitig auf **max. 100** begrenzt (Live-getestet: `take=1000`
liefert `400` mit `"The field take must be between 1 and 100."`). Bei Konten
mit mehr als 100 Belegen insgesamt erfasst ein Erstsync mit `take=100` nur
die neuesten 100 — ein Cursor/Pagination-Mechanismus jenseits von `take` ist
nicht bekannt (siehe Abschnitt "Pagination ungeklärt" unten).

**Nutzungsmuster:**
- **Initialer Sync** (einmalig): `take=100` (server-seitiges Maximum).
- **Zyklische Abfrage** (danach, z. B. stündlich/täglich): kleines `take`
  genügt (z. B. `take=20`), da `orderByDirection=Descending` die neuesten
  Bons zuerst liefert. Gegen die Liste bereits bekannter `id`s abgleichen
  (Set/DB) und beim ersten schon bekannten `id` abbrechen, das sind die
  neuen Bons seit der letzten Abfrage.

Antwort: JSON-Array, ein Objekt pro Bon:
```json
[
  {
    "id": "55f58b44-d2bc-4857-9c0e-48b66057a750",
    "head": {
      "date": "2026-09-02T13:33:28.427+02:00",
      "seller": { "name": "VKST-893", "address": { "street": "...", "city": "..." } }
    },
    "data": {
      "currency": "EUR",
      "fullAmountInclVat": 18.15,
      "paymentMethods": [ { "name": "Visa", "amount": 18.15, "type": "CardPayment" } ],
      "lines": [
        {
          "text": "POKEMON ENHANCED 2-P",
          "fullAmountInclVat": 12.59,
          "item": { "number": "D228928", "quantity": 1, "pricePerUnit": 12.59 },
          "discounts": [ { "discountId": "10% COUPONAKTION...", "fullAmountInclVat": 1.4 } ]
        }
      ]
    }
  }
]
```

**Pagination ungeklärt:** ~~Bei `take=1000` liefert die API vermutlich alles
auf einmal~~ — widerlegt, `take` ist hart auf 100 begrenzt (`400` sonst). Ein
`continuationToken`-Mechanismus existiert im SDK, dessen genaue Übertragung
(vermutlich per Response-Header oder `skip`-Parameter) wurde nicht
verifiziert. Bei mehr als 100 Bons: Response-Header der Liste prüfen, ob ein
Cursor mitgeliefert wird.

### 2c) Einzelnen Bon als PDF exportieren

```
GET https://app.anybill.de/api/v4/receipt/{id}/pdf?IsPrintedVersion=false&IncludeReturnReceipts=false
Authorization: Bearer <accessToken>
```

Antwort: rohe PDF-Bytes (`Content-Type: application/pdf`). Beide Query-Parameter
sind Pflicht, App-Default für beide ist `false`.

Referenz-Implementierung: `rossmann_login_test.py` (`--pdf`-Flag lädt alle
Bons automatisch herunter).

## Schritt 3 (optional): Online-Bestellungen

Nur relevant, falls auch im Onlineshop bestellt wurde, getrennt vom Kassenbon-Flow.

### 3a) Phantom-Token holen

```
POST https://rsmappapi.rossmann.net/account.ws/accounts/token
X-Triggered-By: UNDEFINED
Content-Type: application/json

{ "accountId": "<accountId>", "accountHash": "<accountHash>" }
```

Antwort: `{ "token": "<phantomToken>" }`

### 3b) Bestellhistorie abrufen

```
GET https://api-ocm-de-prod.rossmann.net/order-history-api/v1/order-history?previewCount=5&pageIndex=0
X-API-Version: v1
Authorization: <phantomToken>
```

**Kein `Bearer`-Präfix** beim Phantom-Token, der rohe Token-String ist der
komplette Header-Wert.

## Zusammenfassung des Flows

```
Login (email+password)
  └─> accountId, accountHash
       ├─> receipt/auth (Account-Hash Header) → anybill accessToken
       │     ├─> GET receipt (Liste)
       │     └─> GET receipt/{id}/pdf (Export)
       │
       └─> [optional] accounts/token → phantomToken
             └─> GET order-history-api/v1/order-history
```
