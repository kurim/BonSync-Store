# REWE Mobile API – Reverse-Engineering-Dokumentation

Reverse engineered aus der offiziellen REWE-Android-App (`de.rewe.app.mobile`,
Version 5.17.3-53410, APK via apkmirror.com) durch Dekompilierung (apktool,
`apktool_out/`) und Live-Verifikation gegen die Produktions-API. Stand: 2026-09.

**Konfidenz-Legende:**
- ✅ **verifiziert** – live gegen die echte API getestet, Antwort gesehen
- 🟡 **wahrscheinlich** – aus Code/3rd-Party-Projekt abgeleitet, nicht selbst getestet
- ⚪ **unbestätigt** – nur aus Retrofit-Annotation extrahiert, HTTP-Verb/Verhalten nicht verifiziert

---

## 1. Auth-Modell

Die App verlangt für **jeden** Request an `mobile-clients-api.rewe.de` ein
mTLS-Client-Zertifikat (App-Identität). Für **personenbezogene** Endpunkte
(eBons, Bonus, Baskets, Checkouts, Customer-Daten, …) kommt zusätzlich ein
`Authorization: Bearer <access_token>` (User-Identität) oben drauf. Fehlt
eine der beiden Schichten, liefert die API `401` – auch dann, wenn die
jeweils andere Schicht korrekt ist.

### 1.1 mTLS-Client-Zertifikat ✅

Liegt als PKCS#12 in der APK unter `res/raw/mtls_prod.pfx` (App-Ressource,
kein Server-Secret – für alle Installationen der App identisch).

```
Datei:     res/raw/mtls_prod.pfx
Passwort:  NC3hDTstMX9waPPV
Subject:   C=US, CN=Cloudflare
Issuer:    Cloudflare Managed CA (…), gueltig bis 2032-07-03
```

Extraktion (Python, `cryptography`-Paket):

```python
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.serialization import pkcs12

data = open("mtls_prod.pfx", "rb").read()
private_key, cert, _ = pkcs12.load_key_and_certificates(data, b"NC3hDTstMX9waPPV")

open("client.pem", "wb").write(cert.public_bytes(serialization.Encoding.PEM))
open("client.key", "wb").write(private_key.private_bytes(
    encoding=serialization.Encoding.PEM,
    format=serialization.PrivateFormat.TraditionalOpenSSL,
    encryption_algorithm=serialization.NoEncryption(),
))
```

Verwendung z.B. mit `requests`: `requests.get(url, cert=("client.pem", "client.key"), ...)`.

### 1.2 User-Login: OAuth2/OIDC via Keycloak (PKCE) ✅

```
Discovery:     https://account.rewe.de/realms/sso/.well-known/openid-configuration
client_id:     reweandroid
redirect_uri:  de.rewe.app.mobile://redirect   (Custom-URI-Scheme, kein https!)
scope:         openid email offline_access
PKCE:          code_challenge_method=S256, Public Client, kein client_secret
```

Ablauf:
1. `authorization_endpoint` aus Discovery-Dokument holen, mit `client_id`,
   `redirect_uri`, `response_type=code`, `scope`, `state`,
   `code_challenge`(+S256), `code_challenge_method` aufrufen.
2. Browser-Login des Users; Redirect geht an `de.rewe.app.mobile://redirect?code=...&state=...`
   (Browser kann das Custom-Scheme nicht öffnen – Code per DevTools-Network-Tab
   / Firefox-"Öffnen mit"-Dialog abgreifen).
3. `code` gegen `token_endpoint` tauschen (`grant_type=authorization_code`,
   `code_verifier`) → `access_token`, `refresh_token`, `id_token`, `expires_in`.
4. Refresh: `grant_type=refresh_token` am selben `token_endpoint`. **Keycloak
   rotiert den `refresh_token` bei jedem Refresh** – die komplette Antwort muss
   nach jedem Refresh neu persistiert werden, sonst schlägt der nächste
   Refresh fehl.

Referenz-Implementierung im Projekt: `rewe_login.py` (`login`/`refresh`/`whoami`).

### 1.3 Zusammenspiel & Token-Refresh-Verhalten ✅

Aus `apktool_out/smali_classes3/t5.smali` (`AccessTokenAuthenticator`, ein
OkHttp-`Authenticator`): Ein `401` wird von der App als normaler Trigger für
einen automatischen Token-Refresh behandelt (bis zu 7 Retries in der
Response-Chain, danach Logout). D.h. beim Bauen eigener Clients: bei `401`
nicht sofort aufgeben, sondern `refresh_token`-Grant durchführen und den
Request mit neuem `Authorization`-Header wiederholen.

Header-Name/-Format ist simpel: `Authorization: Bearer <access_token>`
(String-Concat `"Bearer " + token`, keine Besonderheiten).

### 1.4 User-Agent

Von der App gesendeter Header (Format: `<Produkt>/<App-Version>.<Build>
Android/<OS-Version> Phone/<Geraetemodell>`):

```
User-Agent: REWE-Mobile-Client/3.17.1.32270 Android/11 Phone/Google_sdk_gphone_x86_64
```

Ob/wie stark dieser Header tatsächlich validiert wird, ist nicht verifiziert
– in unseren Tests hat ein statischer Wert genügt.

---

## 2. Basis-URLs

```
https://mobile-clients-api.rewe.de/     Haupt-API (mTLS Pflicht, s.o.)
https://account.rewe.de/                Keycloak/OIDC (Login, kein mTLS noetig)
```

---

## 3. Verifizierte Endpunkte (eBons / Kassenbons)

Quelle: Retrofit-Interface `Luc5;` (`apktool_out/smali_classes3/uc5.smali`),
Response-Modelle unter
`apktool_out/smali_classes3/de/rewe/app/repository/purchases/remote/model/ebons/`.

### `GET /api/ebons` ✅

Liste der Kassenbons, paginiert. Query-Parameter: `page` (1-basiert),
`objectsPerPage`.

```
GET https://mobile-clients-api.rewe.de/api/ebons?page=1&objectsPerPage=50
Authorization: Bearer <access_token>
+ mTLS-Client-Zertifikat
```

Response (GraphQL-artige Hülle, real getestet, Werte hier anonymisiert):

```json
{
  "data": {
    "getEbons": {
      "items": [
        {
          "receiptId": "6be134e3-296c-4cc5-bc3e-d7eaca2a5c6b",
          "receiptTimestamp": "2026-09-10T15:41:23Z",
          "receiptTotalPrice": 1554,
          "market": {
            "wwIdent": "1940142",
            "name": "REWE Markt",
            "street": "Musterstr. 1",
            "zipCode": "12345",
            "city": "Musterstadt"
          },
          "cancelled": false
        }
      ],
      "pagination": {
        "objectsPerPage": 50,
        "currentPage": 1,
        "pageCount": 18,
        "objectCount": 875
      }
    }
  }
}
```

Hinweise:
- `receiptTotalPrice` ist in **Cent** (Integer).
- Abbruchbedingung für eigene Paginierung: `currentPage >= pageCount`, oder
  leere `items`.
- Enthält **keine Einzelposten** (Artikel) – dafür siehe PDF-Endpoint unten.

### `GET /api/receipts/{ebonId}/pdf` ✅

PDF-Kassenzettel mit Einzelposten (binär, `%PDF-` Magic Bytes bestätigt).

```
GET https://mobile-clients-api.rewe.de/api/receipts/{ebonId}/pdf
Authorization: Bearer <access_token>
Accept: application/pdf
+ mTLS-Client-Zertifikat
```

### `GET /api/ebon-status` ✅

```json
{
  "data": {"getEbonStatus": {"isSubscribed": true}},
  "extensions": {"http": [{"path": ["getEbonStatus"], "message": "OK", "statusCode": 200, "responseBody": null}]}
}
```

### `PUT/PATCH /api/ebon-status` 🟡

Body: `RemoteEbonStatusRequestBody` (Struktur nicht im Detail extrahiert,
vermutlich `{"isSubscribed": bool}` o.ä. – Retrofit-Body-Parameter, siehe
`uc5.smali` Methode `a(...)`.

### `DELETE /api/ebons` ⚪

Retrofit-Methode `onDeleteEbons`, kein Pfad-Parameter im Interface sichtbar
→ vermutlich body-basiert (Liste von IDs) oder All-Delete. Nicht getestet.

---

## 4. Öffentliche Endpunkte (nur mTLS, kein Bearer nötig) 🟡

Aus dem Community-Projekt [`FaserF/ha-rewe`](https://github.com/FaserF/ha-rewe)
(Home-Assistant-Integration, nutzt denselben mTLS-Ansatz ohne User-Login) und
mit den Pfaden aus unserer eigenen Dekompilierung abgeglichen/korrigiert.
**Von uns selbst nicht live getestet.**

| Endpunkt | Zweck |
|---|---|
| `GET /api/stationary-markets?search=<query>` | Marktsuche (PLZ/Stadt/Name) |
| `GET /api/stationary-markets/{marketId}` | Marktdetails (Öffnungszeiten, Adresse) |
| `GET /api/stationary-offers/{wwIdent}` | Wochenangebote für einen Markt |
| `GET /api/products/recalls` | Aktive Produktrückrufe |
| `GET /api/service-portfolio/{zipCode}` | Lieferung/Abholung-Verfügbarkeit für PLZ |
| `GET /api/products?query=<q>` | Produktsuche (Header `rd-market-id`, `rd-postcode`, `rd-service-types` nötig laut ha-rewe) |

`ha-rewe` nutzt `curl_cffi` (Browser-TLS-Fingerprint-Impersonation) statt
`requests`, vermutlich wegen Cloudflare/Akamai-Bot-Checks auf bestimmten
Routen (z.B. `/api/v3/recipe-hub`, dort 403 laut deren README). Dieser Pfad
(`recipe-hub`) taucht in unserer APK-Version 5.17.3 nicht mehr auf – evtl.
entfernt/umbenannt.

---

## 5. Vollständiger Endpunkt-Katalog (aus Dekompilierung) ⚪

Alle 110 in `apktool_out/smali*` gefundenen Retrofit-Pfade unter
`https://mobile-clients-api.rewe.de`, gruppiert nach Domäne. HTTP-Verb aus der
jeweiligen Retrofit-Annotationsklasse abgeleitet:

- `Lys6;` → **GET** (53 Vorkommen, hochsicher)
- `Lpzb;` → **POST** (26 Vorkommen, hochsicher – konsistent mit erwartbaren
  Create-Operationen wie `/api/baskets`, `/api/checkouts`)
- `Lye4;` → **DELETE** (10 Vorkommen, hochsicher – konsistent mit
  erwartbaren Delete-Operationen)
- `Lrzb;` / `Lizb;` → **PUT oder PATCH** (13 Vorkommen zusammen; die beiden
  Klassen sind strukturell nicht unterscheidbar, welche PUT und welche PATCH
  ist, ist **nicht verifiziert**)

Kein Endpunkt hier wurde von uns live getestet außer den in Abschnitt 3
gelisteten. Anfragen-/Response-Shapes unbekannt, außer wo aus dem Pfadnamen
naheliegend.

### Konto & Bonus-Programm

```
GET    /api/bonus/account
POST   /api/bonus/account
DELETE /api/bonus/account
GET    /api/bonus/balance
PUT/PATCH? /api/bonus/balance
DELETE /api/bonus/balance
GET    /api/bonus/consent
PUT/PATCH? /api/bonus/consent
GET    /api/bonus/consent/{legalTextId}
GET    /api/bonus/coupons
PUT/PATCH? /api/bonus/coupons/{couponId}
GET    /api/bonus/faq
GET    /api/bonus/household/state
GET    /api/bonus/burn/teaser
GET    /api/bonus/burn/mission
GET    /api/bonus/game-of-chance/teaser
GET    /api/bonus/game-of-chance/url
GET    /api/bonus/missions/articles
PUT/PATCH? /api/bonus/missions/articles/{id}
GET    /api/bonus/missions/ebon
GET    /api/bonus/missions/pay
GET    /api/bonus/missions/pick
PUT/PATCH? /api/bonus/missions/pick
GET    /api/bonus/missions/revenue
GET    /api/bonus/partner/campaigns
POST   /api/bonus/partner/code
GET    /api/bonus/transactions
GET    /api/loyalty-points/overview
GET    /api/loyalty-points/detail
GET    /api/rewe-id
```

### eBons / Kassenbons (Details siehe Abschnitt 3)

```
GET    /api/ebons
DELETE /api/ebons
GET    /api/ebon-status
PUT/PATCH? /api/ebon-status
GET    /api/receipts/{ebonId}/pdf
GET    /api/corrections/{correctionNumber}/document
GET    /api/invoices/{invoiceNumber}/document
```

### Warenkorb (Baskets) & Checkout (Online-Bestellung/Lieferung)

```
POST   /api/baskets
POST   /api/baskets/merge
GET    /api/baskets/{basketId}/coupons
POST   /api/baskets/{basketId}/coupons
DELETE /api/baskets/{basketId}/coupons/{couponCode}
POST   /api/baskets/{basketId}/listings
POST   /api/baskets/{basketId}/substitutes
POST   /api/baskets/{basketId}/update-listings

POST   /api/checkouts
POST   /api/checkouts/order-modifications
DELETE /api/checkouts/{checkoutId}/order-modifications
PUT/PATCH? /api/checkouts/{checkoutId}/additionals
PUT/PATCH? /api/checkouts/{checkoutId}/addresses
PUT/PATCH? /api/checkouts/{checkoutId}/payments
PUT/PATCH? /api/checkouts/{checkoutId}/timeslots
POST   /api/checkouts/{checkoutId}/confirmations
POST   /api/checkouts/{checkoutId}/orders
POST   /api/checkouts/{checkoutId}/substitution

GET    /api/orders/{id}
GET    /api/orders/history
DELETE /api/orders/{orderId}
POST/PUT/PATCH? /api/feedback/{orderId}

GET    /api/timeslots/overview
GET    /api/timeslots/checkout
GET    /api/timeslots/reservations
POST   /api/timeslots/reservations

GET    /api/payment-options
GET    /api/v2/paymentmeans
DELETE/PUT/PATCH? /api/v1/paymentmeans/{paymentMeansId}
```

### Kunde / Adressen / Zahlungsmittel

```
GET    /api/customers
GET/PUT/PATCH? /api/customers/date-of-birth
DELETE /api/customers/bankaccounts/{bankAccountId}
DELETE /api/customers/creditcards/{creditCardId}

GET    /api/addresses
POST   /api/addresses
DELETE/PUT/PATCH? /api/addresses/{addressId}
GET    /api/addresses/field-values

GET/PUT/PATCH? /api/v1/subject
DELETE /api/v1/subject/{subject}
GET    /api/v1/subjects/{subject}/payments
POST   /api/v1/user
POST   /api/v1/onboard-user
GET    /api/v1/onboard-user/{onboardingId}
POST   /api/v1/onboard-user/{onboardingId}/complete
POST   /api/v1/onboard-user/{onboardingId}/webform
POST   /api/v1/user-data/{onboardingId}
```

### Märkte / Standorte

```
GET    /api/stationary-markets
GET    /api/stationary-markets/{marketId}
GET    /api/stationary-offers
GET    /api/stationary-offers/{wwIdent}
GET    /api/stationary-handout/{wwIdent}
GET    /api/customer-market-selections
POST   /api/customer-market-selections
GET    /api/service-portfolio/{zipCode}
GET    /api/bulky-goods-configuration/{wwIdent}/service-types/{serviceType}
GET    /api/geocoding
GET    /api/geocoding/autocomplete-suggestions
POST   /api/geocoding/autocomplete-suggestions/location
```

### Produkte / Suche

```
GET    /api/products
GET    /api/products/{productId}
GET    /api/products/recalls
GET    /api/products/recommendations
GET    /api/products/search-facets
GET    /api/products/quengelkasse
POST   /api/products/interactions
GET    /api/grocerysearch
GET    /api/similarities
GET    /api/new4u-products
GET    /api/purchased-products
DELETE /api/purchased-products/{productId}/{articleId}
```

### Rezepte

```
GET    /api/recipes
POST   /api/recipes
GET    /api/recipes/{recipeId}
GET    /api/recipes/by-name/{recipeUrlName}
GET    /api/recipes/search
GET    /api/recipes/search/landing-page
GET    /api/recipes/favorites
POST   /api/recipes/favorites
DELETE/POST /api/recipes/favorites/{recipeId}
POST   /api/recipes/favorites/multiple
```

### Favoriten-Listen (Einkaufslisten)

```
GET    /api/favorites
POST   /api/favorites
DELETE/PUT/PATCH? /api/favorites/{listId}
POST   /api/favorites/{listId}/lineitems
DELETE /api/favorites/{listId}/lineitems/{itemId}
```

### Sonstiges

```
GET    /api/shop-overview
POST   /api/showroom-ads
POST   /api/push-identifiers
```

---

## 6. Praktische Hinweise

- **Rate-Limiting:** In den API-Responses selbst keine expliziten Limits
  beobachtet, aber `ha-rewe` fügt bewusst 5–30s Jitter zwischen Requests ein
  ("Anti-Ban"). Bei automatisierten Clients defensiv bleiben (keine
  Parallel-Bursts, kein Tight-Loop-Polling).
- **mTLS ist zwingend**, auch für vermeintlich öffentliche Endpunkte
  (Angebote, Märkte) – ohne Client-Zertifikat kommt bereits am
  Cloudflare-Edge ein `401`/`403`, bevor die App-Logik überhaupt greift.
- **401 ≠ zwangsläufig falscher Request** – kann schlicht ein abgelaufener
  Access-Token sein. Immer erst Refresh versuchen, dann erneut prüfen.
- Dieses Dokument deckt **App-Version 5.17.3-53410** ab. REWE ändert
  Pfade/Felder ohne Versionierung im Pfad (`/api/v1/...` nur bei wenigen
  Endpunkten) – bei zukünftigen App-Updates ggf. erneut gegen eine aktuelle
  APK abgleichen (`apktool d <apk> -o apktool_out`, dann wie hier per
  `grep -rn 'value = "/api/'` durchsuchen).

## 7. Referenzen im Projekt-Workspace

- `rewe_login.py` – vollständige PKCE-Login/Refresh-Implementierung
- `setup_direct_api_auth.py` – Zertifikat-Extraktion + Token-Setup
- `webapp/rewe_auth.py`, `webapp/rewe_client.py` – produktiv genutzter
  eBons-Client (Abschnitt 3 dieses Dokuments), inkl. Pagination & PDF-Abruf
- `apktool_out/smali_classes3/uc5.smali` – Retrofit-Interface eBons
- `apktool_out/smali_classes3/t5.smali` – `AccessTokenAuthenticator`
  (401-Refresh-Verhalten)
- `apktool_out/smali_classes2/x3b.smali` – Basis-URL-Konfiguration
