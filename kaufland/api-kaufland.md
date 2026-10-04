# Kaufland App API – Referenz-Spezifikation

Implementierungs-orientierte Zusammenfassung der inoffiziellen Kaufland-App-API
(Login + digitale Kassenbons/"Transaktionen"), reverse-engineered aus der Android-App
`com.kaufland.Kaufland` v6.17.0 (Build 168737, `apkmirror.com`-Bundle) per **statischer
Analyse** (kein Live-Traffic mitgeschnitten, kein eigener Account getestet — siehe
Abschnitt 0).

**Nur für den Zugriff auf den eigenen Account gedacht.** Kein Bot-Detection-Bypass,
keine Massenabfragen fremder Accounts.

## 0. Methodik & Vertrauensstand dieser Spezifikation

Anders als [`api-lidlplus.md`](./api-lidlplus.md) (live gegen einen echten Account
verifiziert) beruht dieses Dokument **ausschließlich auf statischer Analyse** der APK,
weil hier kein Kaufland-Account zum Testen zur Verfügung stand:

1. `.apkm`-Bundle (APKMirror) mit `unzip` entpackt → `base.apk` enthält 20
   `classes*.dex`-Dateien (Multidex) sowie `resources.arsc`/`AndroidManifest.xml`.
2. Kein `apktool`/`jadx` verfügbar (keine JVM im Environment) → stattdessen
   [`androguard`](https://github.com/androguard/androguard) (Python, bereits installiert)
   direkt auf DEX-Ebene benutzt: Klassen/Methoden über `androguard.core.dex.DEX`
   aufgelistet, **Retrofit-Annotationen** (`@GET`/`@POST`/`@Path`/`@Query`) über die
   rohe `annotations_directory_item`-Struktur jeder Klasse ausgelesen (Androguards
   High-Level-API exponiert Methoden-Annotationen in der installierten Version nicht),
   Konstanten über `const-string`-Instruktionen und `BuildConfig`-`static_fields`
   extrahiert.
3. Alle in diesem Dokument genannten Pfade, Feldnamen, Header und Konstanten sind
   **wörtliche Fundstellen** aus dem Bytecode (keine Vermutungen) — aber: **kein
   einziger Request wurde live ausgeführt.** Response-Wrapper (Array vs. Objekt),
   Pflicht- vs. Optional-Status mancher Query-Parameter und exakte Enum-Werte
   (`country`, `version`) sind daher **unverifiziert** und mit ⚠️ markiert.
4. [`kaufland_client.py`](./kaufland_client.py) ist ein Referenz-Client zum **Testen
   gegen einen echten Account** — bitte vor Produktivnutzung (insb. vor dem Bau des
   BonSync-Moduls) einmal manuell durchlaufen lassen und Abweichungen hier
   nachpflegen.

## Inhalt

1. [Architektur/Hosts](#1-architektur--hosts)
2. [Authentifizierung (cidaas OAuth2 + PKCE)](#2-authentifizierung-cidaas-oauth-20--pkce)
3. [Pflicht-Header für Transaktions-/CRM-Requests](#3-pflicht-header-für-alle-acardoio-requests)
4. [Endpunkte](#4-endpunkte)
5. [Datenmodell `TransactionV2`](#5-datenmodell-transactionv2)
6. [PDF / Beleg-Rendering](#6-pdf--beleg-rendering)
7. [Bot-Erkennung / Zertifikate](#7-bot-erkennung--zertifikate)
8. [Bekannte Fallstricke & offene Fragen](#8-bekannte-fallstricke--offene-fragen)
9. [Referenzen](#9-referenzen)

---

## 1. Architektur / Hosts

Anders als Lidl (2 Hosts) verteilt sich die Kaufland-App auf mehrere Backends
(Quelle: `BuildConfig`-Konstanten, Klasse `Lcom/kaufland/kaufland/BuildConfig;`):

| Host | `BuildConfig`-Feld | Zweck |
|---|---|---|
| `account.kaufland.com` | `CidaasBaseUrl` | Identity-Server (Login/OAuth2), White-Label-Instanz von **cidaas** (Widas ID GmbH) |
| `kaufland-app-backend-production.acardo.io` | `CouponBaseUrl` | Loyalty-/CRM-Microservice (Kundenkarte, Coupons, **digitale Kassenbons/Transaktionen**), Betreiber **Acardo** |
| `api.cloud.kaufland.de` | `MpApiBaseUrl` | Marktplatz-API |
| `shop-mobile-bff.cloud.kaufland.de` | `MpBaseUrl` | Mobile-BFF (Home-Screen, Angebote, Store-Infos) |
| `sync.kaufland.de` (`wss://`) | `CouchBaseUrl` | Couchbase-Lite-Sync-Gateway (Offline-Persistenz, App-intern) |
| `www.kaufland.de` / `.com` | `MpBaseWebUrl` | Web-Shop |

Für Login + Kassenbons relevant sind ausschließlich **`account.kaufland.com`** und
**`kaufland-app-backend-production.acardo.io`**. Es gibt jeweils eine `-pp`-Variante
(`api.cloud.kaufland-pp.de`, `shop-mobile-bff.cloud.kaufland-pp.de`) für Preprod/Test,
aber keine `-pp`-Variante für `acardo.io` oder `account.kaufland.com` gefunden.

## 2. Authentifizierung (cidaas OAuth 2.0 + PKCE)

Kaufland nutzt **cidaas** als Identity-Provider (White-Label unter eigener Domain),
technisch ähnlich zu Lidls Duende-IdentityServer-Setup, aber mit cidaas-spezifischen
Pfaden (`authz-srv`, `token-srv`, `users-srv`) statt `/connect/...`.

### 2.1 Konstanten (aus `BuildConfig`)

| Parameter | Wert | Quelle |
|---|---|---|
| cidaas Base-URL | `https://account.kaufland.com` | `BuildConfig.CidaasBaseUrl` |
| `client_id` (App-Login) | `fb1b425b-ab2f-4140-aef9-20263b6cfa49` | `BuildConfig.CidaasClientId` |
| `client_id` (Loyalty/CRM-Requests) | `88207bfc-780b-400d-92ee-893ae72dab40` | `BuildConfig.LoyaltyClientId`, s. Abschnitt 3 |
| `redirect_uri` | `com.kaufland.Kaufland://oauth/callback` | `BuildConfig.RedirectScheme` (`com.kaufland.Kaufland`) + Suffix aus `CidaasConfig.c()` (`"://oauth/callback"`) |
| PKCE | Standard `code_verifier`/`code_challenge` (S256) | Klasse `kaufland/com/accountkit/oauth/pkce/CodeVerifierManager` |

⚠️ Es gibt **keinen** registrierten Android-`intent-filter` für
`com.kaufland.Kaufland://oauth/callback` im Manifest (nur für andere Custom-Schemes wie
Klarna/PayPal/`kaufland-app`). Der Login läuft vermutlich über eine **In-App-WebView**
(`LoginActivity`, `KlCustomTabService`), die die Navigation zum Custom-Scheme selbst
abfängt, statt über einen system-weiten Intent. Für die manuelle Code-Beschaffung (s.
2.3) macht das keinen Unterschied: Ein normaler Desktop-Browser versucht ebenfalls,
dorthin zu navigieren, scheitert (unbekanntes Schema) und zeigt die versuchte URL in den
DevTools an — exakt wie beim in `api-lidlplus.md` Abschnitt 2.3 beschriebenen Verfahren.

### 2.2 Authorize-Request

Rekonstruiert aus `CidaasUrlBuilder.b()` (String-Konkatenation der Query-Parameter, in
dieser Reihenfolge):

```
GET https://account.kaufland.com/authz-srv/authz
    ?client_id=fb1b425b-ab2f-4140-aef9-20263b6cfa49
    &response_type=code
    &redirect_uri=com.kaufland.Kaufland%3A%2F%2Foauth%2Fcallback
    &ui_locales=<z.B. de-DE>
    &v=1.5.22
    &view_type=
    &preferredStore=<Store-ID, optional>
    &code_challenge=<S256 von code_verifier>
    &code_challenge_method=S256
    &state=<random>
```

Zusätzlich **bedingt** angehängte Parameter (nur in bestimmten Login-Flows gesetzt,
für einen normalen Erstlogin vermutlich weglassbar): `session_expired=true`,
`wrapper=false`, `email=`, `mobile_number=`, `login_hint=`.

`v=1.5.22` ist offenbar eine feste cidaas-SDK-Versionskennung (kein App-Versions-String)
— in allen drei gefundenen cidaas-URL-Baustellen identisch, vermutlich unkritisch für
Requests von außerhalb der App, aber sicherheitshalber mitschicken.

### 2.3 Login-Flow (interaktiv)

Analog zu Lidl (Abschnitt 2.3 in `api-lidlplus.md`): Authorize-URL im Browser öffnen,
einloggen, den `code`-Parameter aus der gescheiterten Navigation zu
`com.kaufland.Kaufland://oauth/callback?code=...&state=...` in den DevTools (Network-Tab,
"Preserve log") oder aus den Chrome-Performance-Logs auslesen.

⚠️ Auf der Login-Seite läuft laut `assets/services/` eine **ThreatMitigation/Device-
Fingerprinting-SDK** (`com.lexisnexisrisk.threatmetrix.*`, LexisNexis ThreatMetrix) im
Hintergrund — vergleichbar mit Lidls reCAPTCHA Enterprise. Automatisierte
Login-Versuche (Selenium etc.) sollten daher **nicht** versucht werden; manueller
Login als primärer Weg vorsehen (siehe auch Abschnitt 7).

### 2.4 Token-Austausch

Rekonstruiert aus `CidaasTokenExchange.d()`/`.e()`/`.b()`:

```
POST https://account.kaufland.com/token-srv/token
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code
&client_id=fb1b425b-ab2f-4140-aef9-20263b6cfa49
&code=<aus 2.3>
&redirect_uri=com.kaufland.Kaufland://oauth/callback
&code_verifier=<aus 2.2>
```

⚠️ Anders als bei Lidl (`Authorization: Basic`-Header mit Client-Secret) wird hier
**kein Client-Secret** referenziert — `client_id` wird als normaler Body-Parameter
mitgeschickt (public client, typisch für PKCE-Mobile-Flows). Kein Hinweis auf ein
Secret in `CidaasTokenExchange`/`CidaasProvider` gefunden.

Erwartete Response-Felder, rekonstruiert aus `CidaasProvider.g()`/`.h()`/`.j()` (Keys,
mit denen die App das JSON parst):

```jsonc
{
  "access_token": "…",
  "expires_in": 0,
  "id_token": "…",
  "id_token_expires_in": 0,
  "refresh_token": "…",
  "refresh_expires_in": 0
}
```

Anders als bei Lidl hat der `id_token` hier laut Code einen **eigenen**
`id_token_expires_in`-Wert in der Response (nicht nur aus dem JWT `exp`-Claim
berechnet) — ⚠️ unverifiziert, ob dieses Feld in der echten Response tatsächlich
vorkommt oder nur clientseitig mit einem Default vorbelegt wird, falls es fehlt.

### 2.5 Token-Refresh

```
POST https://account.kaufland.com/token-srv/token
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token
&client_id=fb1b425b-ab2f-4140-aef9-20263b6cfa49
&refresh_token=<gespeicherter refresh_token>
```

### 2.6 UserInfo (liefert die für Abschnitt 4 nötige `{username}`)

```
GET https://account.kaufland.com/users-srv/userinfo
Authorization: Bearer <access_token>
```

Bestätigte Felder (Klasse `UserInfoResponse`): `sub`, `email`, `emailVerified`,
`firstName`, `lastName`, `birthday`, `gender`, `mobileNumber`, `mobileNumberVerified`,
`provider`, `groups[]`, `customFields{}` (länderspezifisch: `UserInfoCustomFieldsDE`
/`CZ`/`PL`/`SK`).

**`sub`** (die cidaas-Nutzer-UUID) ist der Wert, der in Abschnitt 4 als
`{username}`-Pfadsegment verwendet wird (Rückschluss aus
`UserInfoRepository.saveUserId(String)`, das direkt nach dem UserInfo-Call aufgerufen
wird — ⚠️ nicht 1:1 im Bytecode als "sub → username" markiert, aber die einzige
plausible Quelle für eine stabile Nutzer-ID vor dem ersten Kundenkarten-Request).

### 2.7 Logout

```
GET https://account.kaufland.com/session/end_session?id_token_hint=<id_token>&v=1.5.22
```

## 3. Pflicht-Header für alle `acardo.io`-Requests

Aus Klasse `Lcom/kaufland/network/api/implementation/header/LoyaltyAuthHeader;`
(`getHeaders()`):

| Header | Beispielwert | Hinweis |
|---|---|---|
| `Authorization` | `Bearer <access_token>` | derselbe Access-Token wie von cidaas (Abschnitt 2.4) |
| `client-id` | `88207bfc-780b-400d-92ee-893ae72dab40` | = `BuildConfig.LoyaltyClientId`, **nicht** der Login-`client_id` aus Abschnitt 2.1 |
| `app-platform` | `Android` | literal |
| `app-version` | `6.17.0` | = `BuildConfig.VERSION_NAME` (App-Version zum Zeitpunkt dieser Analyse) |

⚠️ Ob `client-id` hier denselben Access-Token voraussetzt wie der Login (d.h. der
Token hat mehrere Audiences) oder ob dafür ein **separater Token-Exchange** mit
`client_id=88207bfc-...` nötig ist, konnte statisch nicht abschließend geklärt werden
— im Zweifel zuerst mit dem regulären Access-Token + diesem Header probieren, das
ist der wahrscheinlichere Fall (kein zweiter Token-Endpoint-Aufruf im Umfeld von
`LoyaltyAuthHeader`/`DigitalReceiptsAPI` gefunden).

## 4. Endpunkte

### 4.1 Transaktionen / digitale Kassenbons (Liste **und** Detail in einem Call)

Retrofit-Interface `Lcom/kaufland/shoppinghistory/data/datasource/remote/receipts/DigitalReceiptsAPI;`:

```
GET https://kaufland-app-backend-production.acardo.io/api/v2/customers/{username}/transactions
    ?start={start}
    &limit={limit}
    &country={country}
    &version={version}
```

- `{username}` = Pfadsegment, cidaas-`sub` (siehe 2.6).
- `start`, `limit` = `Int` (Pagination, vermutlich Offset/Anzahl analog zu Lidls
  `skip`/`take` — ⚠️ nicht verifiziert, ob `start` ein Offset oder eine Seitenzahl ist).
- `country` = `String` (ISO-2 vermutet, z. B. `DE`; App unterstützt laut
  `UserInfoCustomFields{DE,CZ,PL,SK}` mindestens diese 4 Länder).
- `version` = `Int` (⚠️ Zweck unklar — evtl. API-Schema-Version, evtl. Mindest-App-Version).
- Es gibt **keinen separaten Detail-Endpunkt** — anders als bei Lidl liefert dieser
  eine Call bereits die vollständigen Beleg-Daten inkl. Positionen (siehe Abschnitt 5).
- ⚠️ Response-Form (rohes JSON-Array wie bei Lidl, oder Wrapper-Objekt mit z. B.
  `total`/`items`) ist **unverifiziert**.

### 4.2 Kundenkarte / Profil (Kontext, nicht Teil der Kassenbon-Kernfunktion)

```
POST /api/customers/{username}?version={n}      (Erstanlage/"upsert", Body: LoyaltyCustomerRequestBody)
PATCH /api/customers/{username}?country={cc}     (Update)
```

Kein `GET`-Retrofit-Endpunkt in `LoyaltyCustomerApi` gefunden, obwohl es eine Methode
`getCustomer(username, country)` in `LoyaltyCustomerService` gibt — vermutlich wird der
Kunde nach dem `POST` (idempotentes Upsert) aus der lokalen Cache-Antwort gelesen.
Für den reinen Kassenbon-Abruf nicht benötigt.

## 5. Datenmodell `TransactionV2`

Felder aus den Kotlin-Datenklassen im Package
`com.kaufland.shoppinghistory.data.datasource.remote.receipts.model` (per
`androguard`-Feldliste, keine Serialisierungs-Annotationen extrahiert — Feldnamen sind
vermutlich 1:1 die JSON-Keys, da die App durchgängig Gson mit Standard-Feldnamen nutzt):

```ts
TransactionV2 {
  id: string
  timestamp: string            // vermutlich ISO-8601
  receiptNumber: string
  receiptText: string          // vermutlich Klartext-Bonabbild (Positionen als Text)
  fiscalReceiptText: string | null
  receiptBarcode: string | null
  digReceiptIsCopy: boolean | null
  cardNumber: string | null    // Kundenkarten-Nummer
  currency: string
  sum: number                  // ⚠️ vermutlich Cent-Betrag (Integer, kein Decimal)
  payoff: number | null
  saving: number | null
  bonusPoints: number | null
  paymentType: string | null
  store: TransactionStoreV2
  positions: TransactionPositionV2[]
  refundPositions: TransactionPositionV2[] | null
  promotions: PromotionV2[] | null
  taxes: TransactionTaxV2[]
}

TransactionStoreV2 {
  id: string
  name: string
  street: string | null
  city: string | null
  // ⚠️ KEIN zipCode/postalCode-Feld gefunden — siehe module-format.md Abschnitt 4.1
}

TransactionPositionV2 {
  id: string
  pos: number | null           // Positions-Nr. auf dem Bon
  name: string
  gtin: string | null          // Barcode/EAN
  itemno: string | null        // Artikelnummer
  materialGroup: string | null
  quantity: number | null
  total: number | null         // ⚠️ vermutlich Cent-Betrag
}

TransactionTaxV2 {
  taxClass: string | null
  taxRate: number | null
  preTax: number | null
  totalNet: number | null
  totalTax: number | null
}

PromotionV2 {
  id: string
  desc: string | null
  saving: number | null
}
```

Für BonSync besonders relevant: **`TransactionStoreV2` liefert keine PLZ**. Laut
`module-format.md` Abschnitt 4.1 ist `market.zipCode` die einzige DB-Spalte für die
PLZ — ohne PDF-Fallback (Abschnitt 6) bleibt `market_zip` bei Kaufland also
strukturell immer `NULL`.

## 6. PDF / Beleg-Rendering

Es gibt **keinen** Hinweis auf einen serverseitigen PDF-Endpunkt für digitale
Kassenbons (kein `.../invoice/...`- oder `.../pdf`-Pfad im
`shoppinghistory`-Package — der einzige gefundene `invoice/{transactionId}/pdf`-Pfad
(`/api/v1/{country}/invoice/{transactionId}/pdf`) gehört zu einer anderen Domäne, dem
Self-Checkout-/MSS-Bezahlsystem `live.api.schwarz/kfl/mss/`, nicht zu
`DigitalReceiptsAPI`/`acardo.io`, und ist ⚠️ nicht als für Endkunden erreichbar
bestätigt).

Die App rendert den Bon stattdessen offenbar **client-seitig aus Strukturdaten**:
Klassen `SelectableTextPdfGenerator`, `LegallyCompliantReceiptShareManager`,
`ProcessReceiptUseCase` im `shoppinghistory`-Package deuten auf eine lokale
Text→PDF-Erzeugung aus `receiptText`/`fiscalReceiptText` bzw. den strukturierten
`positions`/`taxes`-Feldern hin (kein HTML wie bei Lidls `htmlPrintedReceipt`, sondern
reiner Text).

**Empfehlung fürs Modul:** `providesPdf: true` mit einer selbst gebauten, einfachen
PDF-Darstellung (`sdk.html.toPdf()` mit `receiptText` in einem `<pre>`-Block, analog
zum Lidl-Fallback in `api-lidlplus.md` Abschnitt 4.4) **oder** `providesPdf: false` und
volles Vertrauen auf `fetchReceiptItems` aus den strukturierten `positions` — Letzteres
ist robuster, weil `receiptText`/`fiscalReceiptText` nie live gesehen wurden und ihr
Format unbekannt ist.

## 7. Bot-Erkennung / Zertifikate

- **ThreatMetrix (LexisNexis)** läuft laut `assets/services/` im Hintergrund (Interfaces
  `TMXModuleInitializerInterface`, `TMXProfilingConnectionsInterface`) — Device-
  Fingerprinting, vermutlich auf der `account.kaufland.com`-Loginseite aktiv.
  Automatisierten Login (Selenium o. Ä.) vermeiden; manueller Login als Standardweg
  (siehe 2.3).
- Kein `networkSecurityConfig` im Manifest (`android:usesCleartextTraffic="false"`
  ist gesetzt, das ist alles) → **kein** Hinweis auf Certificate-Pinning für
  `account.kaufland.com` oder `acardo.io`. In `assets/marketplace/` liegen zwar
  mehrere `.cer`/`.pem`-Dateien (`self-scanning.cer`, `kaufland_pp.pem`, GTS/ISRG-
  Root-Zertifikate), diese gehören aber erkennbar zum Self-Scanning-/Payment- bzw.
  Marktplatz-Flow, nicht zu Login oder Kassenbons.

## 8. Bekannte Fallstricke & offene Fragen

| Punkt | Status | Auswirkung |
|---|---|---|
| Response-Form von `GET .../transactions` (Array vs. Wrapper) | ⚠️ unverifiziert | Parsing-Logik im Client entsprechend robust schreiben |
| Bedeutung von `version`-Query-Parameter | ⚠️ unverifiziert | Mit `2` probieren (V2-API), bei Fehler variieren |
| `start`/`limit` = Offset/Anzahl oder Seite/Größe | ⚠️ unverifiziert | Mit `start=0&limit=20` beginnen, Verhalten beobachten |
| `client-id`-Header erfordert eigenen Token-Exchange? | ⚠️ unverifiziert | Zuerst mit dem normalen Access-Token versuchen |
| `sum`/`total` in Cent oder Hauptwährungseinheit | ⚠️ unverifiziert | Bei unplausiblen Werten (Faktor 100) Einheit umstellen |
| Land-abhängige Zusatzfelder (`fiscalDataAt`-Äquivalent für AT/CZ/PL/SK) | nicht analysiert | Für DE vermutlich irrelevant |

## 9. Referenzen

- [`kaufland_client.py`](./kaufland_client.py) — Referenz-Implementierung (manueller
  PKCE-Login, Token-Exchange/Refresh, UserInfo, Transaktionsliste). **Bitte einmal
  gegen einen echten Account laufen lassen**, bevor auf dieser Spezifikation ein
  BonSync-Modul produktiv aufgebaut wird — Abschnitt 8 auflösen/aktualisieren.
- [`api-lidlplus.md`](./api-lidlplus.md) — analoge, aber **live verifizierte**
  Spezifikation für Lidl Plus; als Vorlage für Struktur und Vorgehen dieses Dokuments
  genutzt.
- `com.kaufland.Kaufland_6.17.0-168737_...apkm` — Analysequelle (APKMirror-Bundle,
  `base.apk` innerhalb des `.apkm`-Zips).
