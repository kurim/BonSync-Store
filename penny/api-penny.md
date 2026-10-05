# PENNY API — Referenz (eBons + Angebote)

Reverse engineered aus der PENNY-Android-App (APK, `dev.lokksmith` OIDC-Lib),
dem JS-Bundle der `penny-ebon-ui`-SPA (`ebon_ui_bundle.js`) sowie — für
Angebote — der öffentlichen Website `www.penny.de`. Inoffiziell, nicht
dokumentiert — kann sich jederzeit ändern.

Abschnitt 1–3: eBons (Kassenzettel), über `api.penny.de` + Keycloak-Login.
Abschnitt 4: Angebote, über die öffentliche Website-REST-API, **kein Login
nötig** — der praktisch funktionierende Weg. Abschnitt 5: wie Angebote
stattdessen *in der Android-App* laufen (Cloud Firestore) — serverseitig
blockiert, nur als Hintergrundwissen dokumentiert.

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

Bei `401` (abgelaufener/widerrufener Access Token) wirft das Modul einen
`PennyAuthExpiredError` ("PENNY-Anmeldung abgelaufen … bitte erneut anmelden."). Das Token wird
vorab in `ensureFreshCredentials` erneuert (60 s Puffer); ein trotzdem auftretendes 401 heißt, dass die
Keycloak-Session beendet wurde -- nur ein neuer Login (1.1) hilft. Gleiches gilt, wenn der Refresh
(1.3) mit 400/401 abgelehnt wird. Die App setzt den Händler dann auf "Handlung nötig" mit "Erneut anmelden".

Zusätzlich sendet die offizielle App (und das Modul): `Accept-Language: de-DE,de;q=0.9`,
`User-Agent: PENNY-App/Android`.


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

## 4. Angebote (Offers) — Website-REST-API (Magnolia CMS, kein Login nötig)

**Das ist der Weg, der tatsächlich funktioniert** (im Gegensatz zu Abschnitt 5)
— und offenbar auch der Weg, über den Drittanbieter (Prospekt-/Preisvergleichs-
Aggregatoren) an PENNY-Angebote kommen: ein öffentlicher Open-Source-Scraper
(`github.com/g6jjjz4gyb-sketch/prospekt`, `scrapers/penny.py`, scrapt u. a.
ALDI SÜD/LIDL/PENNY/REWE/EDEKA/NETTO) nutzt exakt denselben Endpunkt. Live
getestet am 2026-10-05 (`penny_offers_web_test.py` in `_receipts/penny/`):
**227 Angebote** über alle Kategorien per plain `requests.get`, keine
Sonder-Header, kein Cookie-Consent, keine Authentifizierung nötig.

### 4.1 Endpunkt

```
GET https://www.penny.de/.rest/offers/by-category/{yyyy-ww}/{slug}
```

- `{yyyy-ww}`: ISO-Kalenderwoche der aktuellen Angebote, z. B. `2026-41`.
  Nicht hartkodieren — ändert sich wöchentlich. Am einfachsten aus der
  `/angebote`-Seite extrahieren: dort referenziert der erste `by-category/`-
  Link im HTML die aktuelle Woche.
- `{slug}`: Kategorie-Name, z. B. `top-angebote`, `getraenke`,
  `fleisch-und-wurst`.

Response: `application/json`, kein Auth-Header, keine Cookies nötig.

### 4.2 Kategorien & Wochentags-Gruppen entdecken

Die `/angebote`-Seite enthält im HTML `data-category-id`-Attribute im Format
`ab-<wochentag>--<slug>`:

```html
data-category-id="ab-montag--getraenke"
data-category-id="ab-donnerstag--kochen-und-backen"
data-category-id="ab-freitag--framstag"
```

**Das ist exakt der Ursprung der in der App beobachteten Abschnitte "Alle ab
Montag" / "Alle ab Donnerstag" / "Alle ab Freitag"** (siehe auch den UI-String
`offer_category_section_all_from` in Abschnitt 5) — bestätigt am 2026-10-05
mit Woche `2026-41`:

| Gruppe | Anzahl Kategorien | Beispiele |
|---|---|---|
| `ab-montag` | 12 | `top-angebote`, `obst-und-gemuese`, `kuehlregal`, `fleisch-und-wurst`, `getraenke`, `dauerhaft-im-preis-gesenkt`, ... |
| `ab-donnerstag` | 12 | `haushalt-und-wohnen`, `kochen-und-backen`, `kinderwelt`, `que-viva-espana`, `getraenke1`, ... |
| `ab-freitag` | 1 | `framstag` |

Der `slug` für den REST-Call ist der Teil **nach** dem `ab-<wochentag>--`-
Präfix (den Präfix selbst als Slug zu verwenden liefert `404`). Manche Slugs
sind über zwei Wochentags-Gruppen hinweg namensgleich bis auf eine
angehängte Ziffer (`getraenke` vs. `getraenke1`, `obst-und-gemuese` vs.
`obst-und-gemuese1`) — das sind unterschiedliche Kategorien mit eigenem
Inhalt, keine Duplikate.

### 4.3 Response-Format (`offerTiles`)

```json
{
  "offerTiles": [
    {
      "uuid": "322b3a83-659a-4156-8b7b-83ada0379292",
      "title": "RED BULL Energy-Drink*",
      "type": "food",
      "quantity": "je 250 ml",
      "price": "0.99",
      "listPrice": "1.49",
      "crossOutPrice": null,
      "advantage": "33%",
      "basePrice": "(1 l = 3.96)",
      "benefitPrice": "0.85²",
      "benefitValue": "42%¹",
      "benefitGroundPrice": "(1 l = 3.40)",
      "lowestPrice30Days": null,
      "actionMarker": null,
      "bargainPrice": false,
      "actionPrice": false,
      "primaryType": "promoPlus",
      "imageRendition": {
        "tileXs": "https://cdn.penny.de/dam/jcr:.../....png?impolicy=penny&imwidth=100",
        "tileSm": "...imwidth=200",
        "tileMd": "...imwidth=400",
        "tileLg": "...imwidth=600",
        "tileXl": "...imwidth=800"
      },
      "linkHref": "/angebote/top-angebote/red-bull-energy-drink",
      "detailLinkHref": "/angebote/top-angebote/red-bull-energy-drink~mgnlArea=main~",
      "productData": "{\"id\":\"322b3a83-...\",\"name\":\"red-bull-energy-drink\",\"category\":\"top-angebote\",\"price\":\"0.9900\",\"units\":1,\"rrp\":\"1.4900\",\"savingsPercent\":\"33.0000\",\"savingsAmount\":\"0.5000\",\"disturberType\":\"Rabatt\",\"listPosition\":\"1\",\"shoppable\":\"not_set\",\"promotion\":\"reduzierter Preis\"}"
    }
  ]
}
```

Wichtige Felder:

| Feld | Bedeutung |
|---|---|
| `uuid` | Eindeutige Angebots-ID (stabil, gut als dedupe-Key — manche Angebote tauchen in mehreren Kategorien auf) |
| `title` | Produktname, oft mit `*` am Ende (Fußnoten-Referenz, z. B. "nur in Markt X") — vor Weiterverarbeitung strippen |
| `price` | Aktionspreis als String, `.` als Dezimaltrennzeichen (nicht `,` wie im eBon-PDF!) |
| `listPrice` / `crossOutPrice` | Alter/durchgestrichener Preis — je Angebotstyp wird nur eines der beiden befüllt |
| `advantage` | Ersparnis in Prozent als String (`"33%"`) |
| `basePrice` | Grundpreisangabe, z. B. `"(1 kg = 6.45)"` |
| `benefitPrice` / `benefitValue` / `benefitGroundPrice` | **App-/Vorteilscode-Preis** — zweiter, niedrigerer Preis nur für PENNY-App-Nutzer (mit Fußnoten-Hochziffern wie `²`/`¹`/`⁴`, die auf Fußnotentext auf der Seite verweisen — nicht Teil des Zahlenwerts, vor Parsing abschneiden) |
| `lowestPrice30Days` | 30-Tage-Tiefstpreis (EU-Preisangabenpflicht), oft `null` |
| `productData` | **JSON-String** (nicht verschachteltes Objekt — selbst parsen), u. a. `disturberType` (z. B. "Rabatt"/"Aktion"/"Kein Störer") und `promotion` (z. B. "reduzierter Preis"/"normaler Preis") |
| `linkHref` | Relativer Pfad zur Produktdetailseite, mit `BASE` zusammensetzen |
| `primaryType` | Tile-Darstellungstyp, z. B. `"promoPlus"`, `"offer"` — nicht alle Felder sind bei jedem Typ befüllt (z. B. `discount`/`discountPercentage`/`originalPrice` statt `advantage`/`crossOutPrice` bei manchen Tiles) |

**Fallstrick:** Die Tile-Struktur ist nicht einheitlich — je `primaryType`
fehlen oder erscheinen andere Felder (gesehen: ein Tile mit
`discount`/`discountPercentage`/`originalPrice`/`originalPriceType` statt
`advantage`/`crossOutPrice`/`benefitPrice`). Beim Parsen alle Felder als
optional behandeln, nicht auf ein festes Schema verlassen.

## 5. Angebote — Android-App-Variante (Cloud Firestore, serverseitig blockiert)

**Nicht empfohlen — siehe Abschnitt 4 für den tatsächlich funktionierenden
Weg.** Dieser Abschnitt dokumentiert den von der Android-App intern genutzten
Weg, der sich aus Smali-Analyse ergibt, aber live getestet an App Check
scheitert (keine echten Rohdaten verfügbar).

Im Gegensatz zu den eBons läuft "Angebote" in der App **nicht** über
`api.penny.de`,
sondern direkt über das eingebettete Cloud-Firestore-Client-SDK
(`com.google.firebase.firestore.FirebaseFirestore`). Reverse engineered aus
`de/penny/core/data/offer/android/*` (Smali) und den zugehörigen
Firestore-DTO-Klassen (kotlinx.serialization — Feldnamen bleiben auch nach
R8-Minifizierung lesbar und sollten 1:1 den echten JSON/Firestore-Keys
entsprechen, auch wenn hier keine mitgeschnittene Rohantwort vorliegt).

### 5.1 Firebase-Projekt

```
project_id:   rd-penny-prod-v001-5e43f
app_id:       1:949429868154:android:7cff3a72875620e4
api_key:      AIzaSyCNzGDsFalEo-I7bztjf7zPbXcaAtWBs30
database_url: https://rd-penny-prod-v001-5e43f.firebaseio.com   (Realtime DB — für Angebote nicht relevant)
```

Firestore-REST-Basis wäre entsprechend
`https://firestore.googleapis.com/v1/projects/rd-penny-prod-v001-5e43f/databases/(default)/documents/...`
(nicht getestet, siehe Offene Fragen).

**Wichtig:** Die App registriert Firebase **App Check** mit Play-Integrity-
Provider (`FirebaseAppCheckPlayIntegrityRegistrar` im Manifest). Wird App
Check für dieses Projekt serverseitig erzwungen, scheitert ein Zugriff ohne
gültiges Play-Integrity-Attestat (z. B. von einem Server/Skript aus) —
unverifiziert, siehe Offene Fragen.

### 5.2 Collection `offers_weeks`

Query (aus `id7.smali`, Methode `Lid7;->a()`):

```
collection("offers_weeks")
  .whereGreaterThanOrEqualTo(FieldPath.of("visible", "until"), <jetzt>)
  .orderBy(FieldPath.of("visible", "until"), ASC)
  .limit(2)
```

Liefert die aktuell sichtbaren "Angebotswochen" (typischerweise 2 Treffer —
vgl. UI-Strings `offer_category_date_this_week`/`offer_category_date_next_week`,
"Diese Woche"/"Nächste Woche"). Jedes Dokument ist ein `FirestoreOfferWeek`:

| Feld | Typ | Bedeutung |
|---|---|---|
| `uuid` | String | ID der Angebotswoche |
| `week` | Int | Wochennummer |
| `valid` | `{ from, until }` (Firestore `Timestamp`) | Gültigkeitszeitraum der Angebote |
| `visible` | `{ from, until }` (Firestore `Timestamp`) | Sichtbarkeitszeitraum in der App |
| `updated` | Firestore `Timestamp` | Letzte Aktualisierung |

Die vom Nutzer in der App beobachteten Abschnitts-Überschriften ("Alle ab
Montag" / "Alle ab Donnerstag" / "Alle ab Freitag") sind **keine festen
Tabs**, sondern der UI-String `offer_category_section_all_from` = `"Alle ab
%s"`, wobei `%s` je Abschnitt durch den Wochentag von `valid.from` (bzw.
`visible.from`) ersetzt wird. PENNY scheint also mehrere parallele
"Angebotswochen"-Dokumente mit unterschiedlichem Start-Wochentag zu
veröffentlichen (z. B. Hauptprospekt ab Montag, Zusatzaktionen ab
Donnerstag/Freitag), nicht ein Dokument pro Kalenderwoche.

### 5.3 Kategorien & Angebote (`FirestoreOfferCategory` / `FirestoreOffer`)

**Nicht verifiziert**, wie Kategorien zu einer `offers_weeks`-Woche gehören:
im disassemblierten Code taucht kein `DocumentReference.collection(...)`-Aufruf
für eine "categories"-Subcollection auf. Die einzige Fundstelle mit dem String
`"offers-weeks-categories"` ist der Name eines Firebase-Performance-Traces
(`wc.smali`), keine Collection — das spricht dafür, dass Wochen-Metadaten und
Kategorien in einem zusammengesetzten Ladevorgang geholt werden (ggf.
verschachteltes Feld im selben Dokument, oder ein zweites Dokument mit
derselben `uuid` in einer bislang nicht gefundenen Collection). Siehe Offene
Fragen.

Datenmodell laut Smali-Felddeklarationen (`FirestoreOfferCategory.smali`,
`FirestoreOffer.smali`):

```
FirestoreOfferCategory {
  id: String
  title: String
  color: String
  order: Int
  tags: List<String>
  valid: { from, until }
  visible: { from, until }
  categoryImage: { url: String }
  heroBackgroundImage: { url: String }
  iconImage: { url: String }
  offers: List<FirestoreOffer>
}

FirestoreOffer {
  uuid: String
  title: String
  subtitle: String
  priceSubtitle: String
  price: String                 // formatierter Anzeigepreis, z.B. "1,99"
  priceLoyalty: String          // Preis mit Vorteilscode/App
  priceLoyaltyPercentage: String
  basePrice: String             // z.B. Grundpreisangabe "/ kg"
  details: String
  disclaimer: String
  flag: String                  // z.B. Badge-Text
  order: Int
  images: List<{ url: String }>
  logos: List<{ url: String }>
  tags: List<String>
  valid: { from, until }
  visible: { from, until }
  meta: {
    price: Int                  // Preis in Cent
    regions: List<String>       // Marktregionen, für die das Angebot gilt
    discount: { oldPrice: Int, ratio: Double }  // oldPrice in Cent
  }
}
```

### Offene Fragen

- Exakter Pfad/Mechanismus, wie Kategorien/Angebote zu einer
  `offers_weeks`-Woche zugeordnet werden (eigene Collection? Subcollection?
  Feld im Rohdokument, das die schlanke `FirestoreOfferWeek`-Klasse nur nicht
  mappt?). Braucht einen echten mitgeschnittenen Firestore-Request (z. B.
  TLS-Mitschnitt oder `adb logcat` mit Firestore-Debug-Logging), nicht
  weitere Smali-Analyse.
- Welche Werte `meta.regions` tatsächlich annimmt (PLZ-Präfixe? interne
  Regionscodes?) — nicht beobachtet.
- **Live getestet (2026-10-05, `penny_offers_test.py` in `_receipts/penny/`):**
  Ein unauthentifizierter REST-Request gegen `offers_weeks` (Liste, `runQuery`
  wie in 4.2, sowie die Collection-Namens-Rateversuche aus 4.3) liefert
  durchgehend `403 PERMISSION_DENIED — "Missing or insufficient permissions."`,
  mit und ohne den öffentlichen Android-API-Key als `?key=`-Parameter.
  **Direkter, anonymer Server-Zugriff auf diese Firestore-Collection
  funktioniert also nicht.**
- Nicht unterscheidbar aus der Fehlermeldung (Google vereinheitlicht die
  Antwort bewusst): ob die Ablehnung von **App Check** (Play-Integrity-Token
  fehlt) kommt, von **Firestore Security Rules** (die z. B. `request.auth !=
  null` verlangen), oder von beidem. Um das zu klären, bräuchte es einen
  echten Mitschnitt eines erfolgreichen Requests aus der laufenden App (TLS-
  Proxy auf einem gerooteten/gepatchten Gerät oder Emulator).
- **Angemeldeter PENNY-Nutzer hilft dabei nicht.** Getestet mit dem echten
  Keycloak-Access-Token aus dem eBon-Login (`penny_tokens.json`, Schritt 5 in
  `penny_offers_test.py`): Firestore lehnt das Token mit einem **anderen**
  Fehler ab als den anonymen Request —
  `401 UNAUTHENTICATED — "Request had invalid authentication credentials.
  Expected OAuth 2 access token, login cookie or other valid authentication
  credential."` — Firestore versteht also gar kein fremdes Keycloak-JWT,
  unabhängig davon, ob der Nutzer in der PENNY-App eingeloggt ist oder nicht.
  Dazu passt: eine Grep-Suche über alle `de/penny/**`-Smali-Klassen nach
  Aufrufen von `FirebaseAuth`-Methoden findet **keinen einzigen Treffer** —
  die `com.google.firebase.auth.*`-Klassen sind zwar (transitiv) im APK
  enthalten, werden aber von PENNY-eigenem Code nie aufgerufen. Es gibt also
  keine zweite, an den Keycloak-Login gekoppelte Firebase-Auth-Session, die
  Firestore-Zugriff gewähren könnte. Alles spricht dafür, dass allein
  **App Check** (Play-Integrity-Attestation eines echten/zertifizierten
  Android-Geräts) den Zugriff freischaltet, nicht ein Nutzer-Login — was
  serverseitig ohne echtes Android-Gerät praktisch nicht reproduzierbar ist.

## 6. Grenzen / Fallstricke

- Inoffizielle API — keine SLA, keine Versionierung, keine Garantie auf
  Stabilität von Feldnamen oder Bon-Layout.
- Kein headless Login möglich: der Authorization-Code-Schritt läuft über
  Keycloak im Browser (PKCE), es gibt keinen Resource-Owner-Password-Grant.
- `objectsPerPage`/`page` sind 1-basiert für `page`; unklar, ob ein serverseitiges
  Limit für `objectsPerPage` existiert (App nutzt konstant `20`).
- Rate-Limits sind nicht dokumentiert und wurden nicht getestet.
- Angebote: Abschnitt 4 (Website-REST-API) ist **live verifiziert**
  (`penny_offers_web_test.py`, 227 Angebote über alle Kategorien, 2026-10-05)
  und der empfohlene Weg. Abschnitt 5 (Android-App/Firestore-Variante) bleibt
  **rein aus Smali rekonstruiert**, ohne eine einzige erfolgreiche echte
  Firestore-Antwort — ein Live-Test (`penny_offers_test.py`) bestätigt nur,
  dass unauthentifizierter Zugriff `403 PERMISSION_DENIED` liefert. Abschnitt
  5 ist nur noch als Hintergrundwissen relevant, nicht als Implementierungsweg.
- Die Website-REST-API (Abschnitt 4) ist ebenso inoffiziell wie der Rest
  dieser Doku — kein öffentlich dokumentierter Vertrag, kann sich jederzeit
  ändern (Magnolia-CMS-Implementierungsdetail, kein offizielles Partner-Feed).
