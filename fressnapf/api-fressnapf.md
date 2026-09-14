# Fressnapf/Maxi Zoo Mobile API – Reverse-Engineering-Dokumentation

Reverse engineered aus der offiziellen Fressnapf-Android-App
(`com.fressnapf.mobileapp`, intern als "Maxi Zoo" gebrandet, Version
2026.9.0-65aba4c477, APK via APKPure-XAPK) durch Dekompilierung (`apktool`,
`jadx`) und Live-Verifikation gegen die Produktions-API. Stand: 2026-09-12.

**Konfidenz-Legende:**
- ✅ **verifiziert** – live gegen die echte API getestet, Antwort gesehen
- 🟡 **wahrscheinlich** – aus Code/Retrofit-Annotation abgeleitet, nicht selbst live getestet
- ⚪ **unbestätigt** – nur Pfad aus Dekompilierung, HTTP-Verb/Body/Verhalten nicht verifiziert

---

## 1. Architektur-Überblick

- **BFF/Gateway:** `https://eos.prod.fressnapf.cloud/app-backend/{version}/{market}/...`
  `{version}` ist `v1`, `v2`, ... (App liest das aus einer eigenen
  `@ApiVersion(major=N)`-Annotation pro Endpunkt und ersetzt zur Laufzeit
  einen `API_VERSION`-Platzhalter im Pfad).
- **Market-Segment `{market}`:** String der Form `<brand><LAND>`, z. B.
  `fressnapfDE` ✅ (verifiziert). Vermutlich analog `fressnapfAT`,
  `fressnapfCH`, `maxizooFR`, `maxizooBE`, `maxizooPL`, `maxizooIE` 🟡
  (Fressnapf-Marke in DE/AT/CH, Maxi-Zoo-Marke in FR/BE/PL/IE). Verfügbare
  Märkte lassen sich über `GET /v1/{market}/countries` abfragen (Platzhalter
  `{market}` hier trotzdem nötig – vermutlich reicht ein beliebiger gültiger
  Wert, nicht verifiziert).
- **Downstream-Backend:** Das Gateway reicht Requests intern weiter an
  `https://api.os.fressnapf.com/rest/v{n}/{market}/users/current/...`
  (sichtbar in Fehlermeldungen) – vermutlich **SAP Commerce Cloud /
  Hybris** (Hinweise im Code: `baseSite`, `occ`-Klassen).
- **Web-Frontend nutzt denselben Backend-Pfad** über einen eigenen Proxy:
  `https://www.fressnapf.de/api/proxy/v1/{market}/...` ✅ – nützlich, um per
  Browser-DevTools (Netzwerk-Tab) auf eingeloggter Website live mitzuschneiden,
  welche Parameter/Felder für einen Endpunkt nötig sind, ohne Android-Emulator.
- **Kein klassisches Retrofit/OkHttp-`@GET`/`@POST`** im dekompilierten Code
  sichtbar – R8 hat auch die Bibliotheks-Annotationsklassen umbenannt. Die
  interne `@RestMethod`-Metaannotation (`method`, `path`, `hasBody`) ist aber
  erhalten und erlaubt Re-Identifikation der (umbenannten) `@GET`/`@POST`/
  `@PUT`/`@DELETE`-Äquivalente.

---

## 2. Auth-Modell: OAuth2/PKCE via SAP Customer Data Cloud (Gigya)

Kein hartkodierter Client in der APK – Client-ID und Issuer-URL werden zur
Laufzeit **pro Markt** vom Backend geladen.

### 2.1 Konfiguration laden ✅

```
GET https://eos.prod.fressnapf.cloud/app-backend/v1/{market}/configuration/global?lang=de
```

Keine Authentifizierung nötig (öffentlicher Endpunkt). Relevanter Ausschnitt
der Response (`fressnapfDE`, Stand 2026-09):

```json
{
  "cdcOidc": {
    "issuerUrl": "https://account.fressnapf-maxizoo.com/oidc/op/v1.0/3_mnkfdgqPKpk4S0pIPHeUcXleUFqhgN2HByrJHRrYoSKuE5NpRHlIqIpkLVz3AN46/",
    "clientIdAndroid": "7SXrjF1Zc509hlTIgg7F2XGm",
    "clientIdIOS": "7SXrjF1Zc509hlTIgg7F2XGm",
    "clientIdWeb": "KkfIKqcAlVx4bM2qVhDV-WfV",
    "loginScope": "openid",
    "registrationScope": "openid registration"
  },
  "app": {
    "apiMinVersion": "2.0.0",
    "appMinVersionAndroid": "2025.11.0",
    "recaptchaSiteKeyAndroid": "6LfPyP0lAAAAAL-TjYsHPq6MsEC9idVGjjKuMsNH",
    "emarsysConfig": { "contactFieldId": "6435", "applicationCode": "EMS38-02378", "merchantId": "1A07D08A92BA5124" }
  },
  "paybackEnabled": true,
  "shippingFee": { "value": 2.99, "formattedValue": "2,99 €" },
  "freeShippingThreshold": { "value": 49.0, "formattedValue": "49,00 €" }
}
```

`clientIdWeb` unterscheidet sich von `clientIdAndroid`/`clientIdIOS` – für
einen eigenständigen Client (Node/Python/etc.) ist vermutlich `clientIdWeb`
die "sauberere" Wahl (kein App-Package-Binding zu erwarten), wurde aber nicht
gesondert getestet; `clientIdAndroid` ist ✅ verifiziert funktionsfähig.

`recaptchaSiteKeyAndroid` deutet auf reCAPTCHA-Schutz im gehosteten
Login-Formular hin (analog zu LIDL in anderen Projekten dieses Workspaces) –
ein vollautomatisierter Login ohne echten Browser ist daher unwahrscheinlich.

### 2.2 OIDC-Discovery ✅

```
GET {issuerUrl}/.well-known/openid-configuration
```

Relevante Felder (Auszug):

```json
{
  "authorization_endpoint": "https://account.fressnapf-maxizoo.com/oidc/op/v1.0/3_.../authorize",
  "token_endpoint": "https://account.fressnapf-maxizoo.com/oidc/op/v1.0/3_.../token",
  "revocation_endpoint": "https://account.fressnapf-maxizoo.com/oidc/op/v1.0/3_.../revoke",
  "userinfo_endpoint": "https://account.fressnapf-maxizoo.com/oidc/op/v1.0/3_.../userinfo",
  "jwks_uri": "https://account.fressnapf-maxizoo.com/oidc/op/v1.0/3_.../.well-known/jwks",
  "code_challenge_methods_supported": ["plain", "S256"],
  "grant_types_supported": ["authorization_code", "implicit", "refresh_token", "client_credentials", "urn:ietf:params:oauth:grant-type:jwt-bearer", "urn:ietf:params:oauth:grant-type:token-exchange"],
  "scopes_supported": ["openid", "profile", "email", "address", "phone", "uid", "offline_access", "fnmz", "registration"]
}
```

### 2.3 Login-Ablauf (PKCE, Public Client, kein Client-Secret) ✅

```
redirect_uri (Android): fressnapfapp-auth://oauth-redirect   (Custom-URI-Scheme)
client_id:               7SXrjF1Zc509hlTIgg7F2XGm  (Android)
scope:                   openid   (Login)  |  "openid registration"  (Registrierung)
code_challenge_method:   S256
```

1. `authorization_endpoint` mit `client_id`, `redirect_uri`, `response_type=code`,
   `scope`, `state`, `code_challenge`(+`code_challenge_method=S256`) aufrufen –
   **funktioniert in einem ganz normalen Desktop-/Mobile-Browser**, da es eine
   öffentliche HTTPS-URL ohne App-Kontext-Bindung ist (kein mTLS, kein
   App-Attestation-Zwang beobachtet).
2. Nutzer loggt sich im Gigya-gehosteten Formular ein (ggf. reCAPTCHA).
   Redirect geht an `fressnapfapp-auth://oauth-redirect?code=...&state=...`
   – im Desktop-Browser schlägt das Öffnen des Custom-Schemes fehl, die
   **vollständige URL bleibt aber sichtbar** (Adresszeile/Fehlermeldung) und
   kann manuell herauskopiert werden.
3. `code` gegen `token_endpoint` tauschen: `grant_type=authorization_code`,
   `code`, `redirect_uri`, `client_id`, `code_verifier` →
   `access_token`, `refresh_token`, `id_token`, `expires_in`.
4. Refresh: `grant_type=refresh_token`, `refresh_token`, `client_id` am
   selben `token_endpoint`.

Referenz-Implementierung im Projekt: `fressnapf_login.py`
(`interactive_login`/`refresh_access_token`/`get_valid_access_token`).

**Wichtig: `refresh_token` ist einmalig verwendbar (rotiert bei jedem
Refresh)**, analog zu Keycloak bei REWE/PENNY. `expires_in` ist mit **300
Sekunden (5 Minuten)** sehr kurz bemessen. Konsequenzen für eine eigene
Implementierung:
- Access-Token-Ablauf lokal tracken (`expires_at = now + expires_in`) und
  **nur bei tatsächlichem Ablauf** refreshen, nicht bei jedem Request/Aufruf
  - sonst wird der `refresh_token` unnötig oft rotiert.
- Nach jedem Refresh **sofort** den neuen `refresh_token` persistieren, auch
  wenn er nur zu Diagnose-/Testzwecken abgerufen wurde - ein "vergessener"
  Refresh macht den alten, gespeicherten `refresh_token` ungültig und der
  nächste reguläre Refresh-Versuch schlägt mit `403` fehl.
- **Race Condition bei mehreren parallelen Prozessen/Instanzen:** Wenn zwei
  Prozesse gleichzeitig denselben (bereits abgelaufenen) `refresh_token`
  verwenden, gewinnt nur einer; der andere bekommt `403`. Mitigation: bei
  `403` die persistierte Token-Datei/den Datenbank-Eintrag neu einlesen -
  falls ein anderer Prozess zwischenzeitlich erfolgreich refresht hat, dessen
  Ergebnis übernehmen statt sofort einen kompletten Login zu erzwingen.

**Wie die App selbst das Problem löst (kein Neu-Login!):** Der Blick in die
dekompilierte AppAuth-`AuthState`-Klasse (von R8 zu `lc0` umbenannt, Methode
`f(...)` = `performActionWithFreshTokens(...)`) zeigt: die App loggt sich bei
einem noetigen Refresh **nicht** neu ein, sondern nutzt einen simplen
**In-Memory-Single-Flight-Lock**:

```java
synchronized (this.h) {
    ArrayList arrayList = this.i;          // Warteschlange wartender Aufrufer
    if (arrayList != null) {
        arrayList.add(ulcVar);             // Refresh laeuft schon -> nur anstellen, kein 2. Request
        return;
    }
    ArrayList arrayList2 = new ArrayList();
    this.i = arrayList2;
    arrayList2.add(ulcVar);
    // ... hier der EINE echte grant_type=refresh_token-Request
}
```

D. h.: Braucht die App an mehreren Stellen gleichzeitig einen frischen Token,
stoesst nur der *erste* Aufrufer den echten HTTP-Refresh an; alle anderen
reihen sich in eine In-Memory-Liste ein und werden mit demselben Ergebnis
bedient, sobald der eine Request zurueckkommt - dadurch wird der
`refresh_token` nie doppelt/parallel benutzt. Zusaetzlich prueft dieselbe
Methode vorab, ob der aktuelle Access-Token noch >60s gueltig ist, und
liefert dann direkt zurueck, ohne ueberhaupt einen Refresh anzustossen -
exakt das Prinzip, das `fressnapf_login.py::is_still_valid` mit einem
30s-Puffer nachbildet.

**Empfehlung fuer den geplanten Multi-Store-Hub:** Der Datei-Reload-Workaround
oben ist nur eine Reaktion *nach* einer Kollision und tragfaehig fuer ein
einmaliges CLI-Skript. Sobald mehrere gleichzeitige Requests (z. B. mehrere
gleichzeitig geladene Seiten/Widgets derselben Sync-Instanz) denselben
gespeicherten Fressnapf-Account-Token brauchen koennten, sollte der Hub
denselben Single-Flight-Ansatz wie die App selbst implementieren: den
Refresh-Aufruf pro Account hinter einem In-Process-Mutex/einer
gecachten Promise buendeln (z. B. `Map<accountId, Promise<Tokens>>` - alle
gleichzeitigen Aufrufer fuer denselben Account erhalten dieselbe
in-flight-Promise statt je einen eigenen Refresh-Request auszuloesen), statt
sich ausschliesslich auf Retry-nach-403 zu verlassen.

### 2.4 API-Requests ✅

```
Authorization: Bearer <access_token>
```

Einfacher String-Concat, keine Besonderheiten. Kein mTLS, kein zusätzlicher
API-Key-Header für die hier getesteten Endpunkte nötig (anders als z. B. bei
ROSSMANN/LIDL in Nachbarprojekten).

---

## 3. Verifizierte Endpunkte: Kaufverlauf ("Meine Einkäufe")

Zwei getrennte Datenquellen – **In-Store-Kassenbons** vs. **Online-Bestellungen**.

### 3.1 Kassenbon-Liste ✅

```
GET https://eos.prod.fressnapf.cloud/app-backend/v1/{market}/receipthistory
    ?fields=FULL
    &newerThanTS=2026-03-12T00:00:00+0000
    &olderThanTS=2026-09-12T23:59:59+0000
    &currentTime=1789247229376
    &lang=de
Authorization: Bearer <access_token>
```

**Wichtig:** `fields=FULL` und `currentTime` (Unix-Millisekunden) sind
**Pflichtparameter** – fehlen sie, antwortet das Backend mit einem
irreführenden

```json
{"detail":"404 Not Found from GET https://api.os.fressnapf.com/rest/v2/{market}/users/current/receipthistory",
 "status":404,
 "original_error":{"errors":[{"type":"OrderHistoryError","message":"orderHistoryServiceUnavailable"}]}}
```

statt eines hilfreichen 400 Bad Request. `newerThanTS`/`olderThanTS` sind
ISO-8601 mit `+0000`-Suffix (nicht `Z`, nicht URL-encoded `%2B0000` in der
rohen Form – wird von HTTP-Clients automatisch encodiert).

Response: flache **Liste** von Bon-Objekten (kein Pagination-Wrapper in den
bisher gesehenen Antworten – bei Konten mit vielen Bons ggf. serverseitiges
Limit, nicht verifiziert):

```json
[
  {
    "receiptHeader": {
      "storeDisplayName": "Fressnapf Hilden",
      "storeNumber": "0709",
      "partForStoreUrlGen": "fressnapf-hilden",
      "orderDate": "2026-09-12T00:00:00+0000",
      "orderDateShort": "20260912",
      "receiptCode": "00000000000000000723",
      "workstationId": "0000000101",
      "totalAmount": {"value": 53.98, "formattedValue": "53,98 €", "priceType": "BUY"},
      "returnCode": {"payload": "0010709120926101000723", "format": "ITF"}
    },
    "receiptSumBox": {
      "finalAmountGrossValue": {"value": 53.98, "formattedValue": "53,98 €"},
      "totalGrossDiscount": {"value": 3.56, "formattedValue": "3,56 €"},
      "totalLoyaltyPoints": {"value": 0.0, "formattedValue": "0 °P"}
    },
    "items": [
      {
        "position": -1,
        "amount": 1,
        "price": {"value": 6.59, "formattedValue": "6,59 €", "priceType": "BUY"},
        "discounts": [],
        "product": {
          "brandName": "PERFECT FIT",
          "name": "Sensitive 1+ mit Truthahn 1,4 kg",
          "code": "1002911004",
          "url": "/p/perfect-fit-sensitive-1-mit-truthahn-14-kg-1002911004/",
          "images": [{"url": "https://media.os.fressnapf.com/products-v2/...jpg", "altText": "..."}],
          "stock": {"stockLevelStatus": "inStock"},
          "purchasable": true
        }
      }
    ]
  }
]
```

Hinweise:
- `totalAmount`/Preise sind **Euro als Float**, nicht Cent (im Unterschied zu
  REWE/PENNY in Nachbarprojekten, die Cent-Integer liefern) – beim Mapping
  in ein gemeinsames Datenmodell ggf. `round(value * 100)`.
- `receiptCode`/`storeNumber`/`workstationId`/`orderDateShort` aus dem Header
  werden 1:1 für den Detail-Call (3.2) gebraucht.
- Einzelposten (`items`) sind bereits in der **Listen-Response** strukturiert
  enthalten (kein separater Detail-Call zwingend nötig, anders als bei
  REWE/PENNY, die dafür ein PDF parsen müssen).

### 3.2 Kassenbon-Detail ✅

```
GET https://eos.prod.fressnapf.cloud/app-backend/v1/{market}/receipthistory/{receiptCode}
    ?fields=FULL
    &orderDateShort=20260912
    &storeNumber=0709
    &workstationId=0000000101
    &lang=de
Authorization: Bearer <access_token>
```

`{receiptCode}` ist der auf 20 Stellen linksgepaddete `receiptCode` aus dem
Listen-Eintrag (z. B. `00000000000000000723`). Response-Shape identisch zu
einem einzelnen Element aus der Liste (Abschnitt 3.1) – in der Praxis meist
redundant zur Listen-Response, kann aber nützlich sein falls die Liste
irgendwann Items nicht mehr inline liefert.

### 3.6 Filial-Adresse nachladen ✅

`receiptHeader` liefert nur `storeDisplayName` (z. B. "Fressnapf Hilden") und
`storeNumber`, keine Adresse. Die volle Adresse gibt es über den
Store-Detail-Endpunkt (`storeId` in der URL = `storeNumber`):

```
GET https://eos.prod.fressnapf.cloud/app-backend/v1/{market}/stores/{storeNumber}?lang=de
Authorization: Bearer <access_token>
```

Response (gekürzt, unwichtige SEO-/Feature-Felder weggelassen):

```json
{
  "storeNumber": "0709",
  "displayName": "Fressnapf Hilden",
  "address": {
    "phone": "02103-2957565",
    "formattedAddress": "Walder Straße 286, 40724 Hilden",
    "line1": "Walder Straße 286",
    "postalCode": "40724",
    "town": "Hilden",
    "country": {"isocode": "DE", "name": "Deutschland"}
  },
  "geoPoint": {"latitude": 51.1675148, "longitude": 6.9701247},
  "ownerAddress": {
    "formattedAddress": "Friedensstraße 64, 42699 Solingen",
    "companyName": "Jannes Heimtierbedarf GmbH"
  },
  "status": "OPENED_SOON",
  "openingHours": {
    "code": "fressnapfDe-standard-hours-1126",
    "weekDayOpeningList": [
      {"weekDay": "Mo.", "weekDayId": "MONDAY", "closed": false,
       "openingTime": {"formattedHour": "09:00"}, "closingTime": {"formattedHour": "20:00"}}
    ],
    "specialDayOpeningList": []
  },
  "posFeatures": [{"code": "service_parking", "name": "kostenlose Parkplätze", "description": "..."}]
}
```

Hinweise:
- Kein `fields=FULL`/`currentTime` nötig für diesen Endpunkt (anders als
  receipthistory/orderhistory) – ein einfacher `GET` mit `lang` reicht.
- `ownerAddress`/`companyName` ist die Franchise-Betreiber-Firma (rechtliche
  Anschrift), nicht die Filialadresse selbst – für eine Kaufverlaufs-Anzeige
  ist `address.formattedAddress` die relevante.
- Die Filiale taucht typischerweise in mehreren Bons wieder auf – client-seitig
  lohnt sich ein einfacher Cache über `storeNumber` (siehe
  `fressnapf_client.py::get_store_address`, In-Memory-`dict`-Cache).
- Verwandt: `GET /v1/{market}/stores?query=&latitude=&longitude=&radius=&pageSize=&lang=de`
  (Filialsuche, z. B. für eine Umkreissuche) 🟡 – nicht live getestet.

### 3.3 Online-Bestellungen (Liste) ✅

```
GET https://eos.prod.fressnapf.cloud/app-backend/v2/{market}/orderhistory
    ?fields=FULL
    &newerThanTS=2026-03-12T00:00:00+0000
    &olderThanTS=2026-09-12T23:59:59+0000
    &currentTime=1789247229376
    &onlyOpen=false
    &lang=de
Authorization: Bearer <access_token>
```

Gleiche Pflichtparameter-Falle wie bei 3.1 (`fields=FULL` + `currentTime`
zwingend). Response ist **kein flaches Array**, sondern:

```json
{"crmOrders": [], "shopOrders": []}
```

Struktur der einzelnen Einträge in `shopOrders`/`crmOrders` bei diesem
Testaccount nicht verifizierbar (beide leer – Account hat nur In-Store,
keine Online-Käufe). Vermutlich analog zu Abschnitt 3.1 mit
Bestellstatus-Feldern (`order_history_detail_consignment_*`-Strings aus
`strings.xml`: `open`, `shipped`, `delivered`, `cancelled`,
`picked_up_in_store`, `returned`, ... deuten auf ein Statusfeld mit diesen
Werten hin) 🟡.

### 3.4 Online-Bestellung Detail 🟡

```
GET https://eos.prod.fressnapf.cloud/app-backend/v2/{market}/orderhistory/{code}?lang=de
```

Aus Dekompilierung bekannt, nicht live getestet (kein Testdatensatz
vorhanden).

### 3.5 Weitere Order-bezogene Endpunkte ⚪

```
GET  /v1/orders/{code}?businessOrderDay=...&email=...   (anderer Pfad, ohne {market}-Präfix – evtl. separater Microservice / Gast-Bestellstatus per E-Mail)
POST /v1/orders/{code}/return                            (Retoure anstoßen, Body-Struktur unbekannt)
```

---

## 4. Sonstige Endpunkte (aus Dekompilierung, ⚪ nicht live getestet)

Alle folgenden Pfade sind relativ zu
`https://eos.prod.fressnapf.cloud/app-backend/{version}/{market}/...`
(Ausnahmen mit vollständigem Pfad markiert). HTTP-Verb aus den
(umbenannten) Retrofit-Metaannotationen abgeleitet – siehe Legende oben.

```
GET    countries
GET    configuration/global          (siehe Abschnitt 2.1)
GET    configuration/featuretoggles
GET    configuration/i18n
GET    cms/app
GET    cms/wordpress/pages/mobile
GET    cms/wordpress/navigationnodes
GET    app/routeMap

GET    stores
GET    stores/{storeId}
GET    stores/{storeId}/availability/{productCode}
GET    stores/availability/{productCode}

POST   search
POST   search/category
POST   product/recommendation

POST   carts
POST   carts/{cartId}/entries
POST   carts/{cartId}/entries/delete
POST   carts/{cartId}/paybackAuthCode
GET    carts/{cartId}/payback/getPaybackAuthorizationUrl
POST   carts/{cartId}/pointsToRedeem
POST   carts/{cartId}/storeAvailability
POST   carts/{cartId}/vouchers

POST   coupons/activate

PUT    loyalty                        (oder DELETE - beide Klassen strukturell identisch, nicht unterscheidbar)
POST   loyalty/activate
GET    loyalty
GET    donation/friends

GET    users
GET    users/{addressId? / petId?}    (siehe unten, mehrere Varianten)
POST   users/addresses
GET    users/addresses/{addressId}
POST   users/pets
GET    users/pets
DELETE users/pets/{petId}
PUT    users/pets/{petId}
GET    users/pets/{petId}
GET    pet/types

POST   wishlists/entries
POST   wishlists/entries/multiple

POST   upload
POST   client/contact-token / /contact-token / v3/contact-token

# "Doctor" (Tierarzt-Terminbuchung, eigenes Sub-Modul)
GET    doctor/orders/{orderId}
GET    doctor/services
GET    doctor/paymentMethods
POST   doctor/appointments
POST   doctor/appointments/{appointmentId}/anamnesisInfo
POST   doctor/appointments/{appointmentId}/ping
POST   doctor/appointments/{appointmentId}/upload
PUT    doctor/orders/{orderId}/coupon/{couponId}   (Apply)
DELETE doctor/orders/{orderId}/coupon/{couponId}   (Remove - selbe Pfad-Struktur, andere Methode)
POST   doctor/orders/{orderId}/payment
GET    doctor/insuranceProviders
POST   doctor/insuranceProviders/validate
POST   doctor/booking/reservation
GET    doctor/booking/available/timeslots
```

---

## 5. Praktische Hinweise

- **`fields=FULL` und `currentTime=<unix_ms>` bei JEDEM Request an
  receipthistory/orderhistory mitschicken** – sonst generischer,
  irreführender 404. Am einfachsten in einer gemeinsamen Client-Funktion als
  Default setzen (siehe `fressnapf_client.py::api_get`).
- **Preise sind Float/Euro**, nicht Cent-Integer wie bei REWE/PENNY – beim
  Bauen eines gemeinsamen Datenmodells über mehrere Händler hinweg beachten.
- **`newerThanTS`/`olderThanTS`-Format:** `YYYY-MM-DDTHH:MM:SS+0000` (kein
  `Z`, explizites `+0000`).
- **Kein mTLS, kein API-Key-Header** für die getesteten Endpunkte nötig -
  einfacher als REWE (mTLS-Pflicht) oder ROSSMANN (exakter User-Agent
  erzwungen). Ein generischer `requests`/`httpx`-Client ohne Sonderkonfiguration reicht.
- **reCAPTCHA im Login** (`recaptchaSiteKeyAndroid`) - ein rein
  serverseitiger/headless Login (ohne echten Browser-Login-Schritt durch
  einen Menschen) ist voraussichtlich nicht zuverlässig möglich. Für eine
  Multi-User-Webapp müsste der PKCE-Redirect-Flow reibungsfrei im normalen
  Browser des Nutzers ablaufen (funktioniert - siehe Abschnitt 2.3), nur ein
  automatisiertes Skript ohne Nutzerinteraktion würde an reCAPTCHA scheitern.
- **App-eigenes SSL-Pinning-Verhalten (nur relevant für App-internes MITM,
  nicht für einen eigenen Client):** Die Android-App baut mind. an zwei
  Stellen einen eigenen `SSLContext` mit eigenem `TrustManager` auf - ein
  reiner System-CA-Trust reicht für Traffic-Mitschnitte der App selbst
  NICHT aus (relevant nur, falls künftig erneut App-Traffic mitgeschnitten
  werden muss, z. B. bei einem App-Update mit geänderten Endpunkten - dann
  Frida-basiertes Bypass wie in `fressnapf-api-login-flow.md` Abschnitt 5
  beschrieben verwenden, nicht nur `/system/etc/security/cacerts`).
- Dieses Dokument deckt **App-Version 2026.9.0-65aba4c477** ab. Bei
  zukünftigen App-Updates: neue XAPK von APKPure/APKMirror ziehen,
  `apktool d`/`jadx` erneut laufen lassen, `configuration/global` erneut
  abfragen (Client-ID/Issuer können sich ändern) und die hier gelisteten
  Pfade gegenprüfen.

---

## 6. Referenzen im Projekt-Workspace

- `fressnapf_login.py` – PKCE-Login (interaktiv, Browser-basiert) + Token-Refresh
- `fressnapf_client.py` – Kaufverlauf-Client (Liste + Detail, Kassenbons + Bestellungen)
- `fressnapf_tokens.json` – persistierte Tokens (0600, **Zugangsdaten - nicht committen**)
- `receipts_raw.json` / `orders_raw.json` – letzter voller Roh-Response-Dump
- `fressnapf-api-login-flow.md` – Herleitung/Reverse-Engineering-Prozess,
  inkl. Android-14-spezifischer MITM-Fallstricke (APEX-Zertifikatsspeicher,
  Zygote-Caching, App-eigener TrustManager) - relevant falls künftig erneut
  App-Traffic mitgeschnitten werden muss
- `apktool_out/`, `jadx_out/` – vollständige Dekompilierung von
  `com.fressnapf.mobileapp` Version 2026.9.0-65aba4c477
