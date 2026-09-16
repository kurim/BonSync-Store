# Kaufland-API-Reverse-Engineering — Stand

Ziel (siehe `find-api.md`): Kaufland-App-APIs fuer Login und digitale Kassenbons
reverse-engineeren und daraus ein BonSync-Modul (`module-format.md`) bauen, nach
demselben Muster wie bereits fuer Lidl Plus (`api-lidlplus.md`).

## Aktueller Stand: Doku + Modul geschrieben, **noch NICHT live verifiziert**

Anders als beim Lidl-Plus-Client stand fuer Kaufland kein Test-Account zur Verfuegung.
Alles unten beruht auf **statischer APK-Analyse** (kein einziger Request live
ausgefuehrt). Naechster Schritt liegt beim Nutzer: `kaufland_client.py` mit einem
echten Kaufland-Account durchlaufen lassen, siehe Abschnitt "Naechste Schritte".

## Dateien in diesem Verzeichnis

| Datei | Zweck | Status |
|---|---|---|
| `com.kaufland.Kaufland_6.17.0-168737_..._apkmirror.com.apkm` | Analysequelle (APK-Bundle) | — |
| `api-kaufland.md` | Vollstaendige API-Spezifikation (Hosts, OAuth-Flow, Endpunkte, Datenmodell) | ⚠️ statisch, unverifiziert — Details/offene Fragen in Abschnitt 8 der Datei |
| `kaufland_client.py` | CLI zum manuellen Testen: `login` / `refresh` / `userinfo` / `receipts` | Syntaktisch geprueft, **funktional ungetestet** |
| `kaufland-module/` | BonSync-Modul-Paket (`manifest.yaml` + `index.js`) gemaess `module-format.md` | Node-Syntax geprueft, **funktional ungetestet** |
| `api-lidlplus.md` | Referenz/Vorlage (bei Lidl: live verifiziert) | fremd, nur als Vergleich |
| `module-format.md` | BonSync-Modul-Vertrag (Vorgabe, nicht von mir) | fremd |
| `find-api.md` | Ursprungsauftrag (5 Schritte) | fremd |

## Methodik (kurz)

Kein `apktool`/`jadx` verfuegbar (keine JVM). Stattdessen `androguard` (Python) direkt
auf DEX-Ebene: Klassen/Methoden aufgelistet, Retrofit-Annotationen
(`@GET`/`@POST`/`@Path`/`@Query`) ueber die rohe `annotations_directory_item`-Struktur
ausgelesen (Androguards High-Level-API exponiert das in der installierten Version
nicht), Konstanten via `const-string`-Instruktionen und `BuildConfig`-`static_fields`
extrahiert. Details siehe `api-kaufland.md` Abschnitt 0.

## Zentrale Erkenntnisse

- **Auth**: `account.kaufland.com` = White-Label-**cidaas**-Instanz. OAuth 2.0
  Authorization-Code + PKCE, `client_id=fb1b425b-...`,
  `redirect_uri=com.kaufland.Kaufland://oauth/callback`. Public Client (kein Secret
  gefunden). Login vermutlich ThreatMetrix-(LexisNexis-)ueberwacht — kein
  Automatisierungsversuch, manueller Login wie bei Lidl.
- **Kassenbons/Transaktionen**: `kaufland-app-backend-production.acardo.io`
  (Acardo-CRM-Backend), **ein** Call statt Liste+Detail:
  `GET /api/v2/customers/{username}/transactions?start=&limit=&country=&version=`
  mit `{username}` = cidaas-`sub` (aus `GET /users-srv/userinfo`). Zusatz-Header
  `client-id: 88207bfc-...` (= `LoyaltyClientId`, ein *anderer* client_id als der
  Login-client_id — ob dafuer ein eigener Token noetig ist: unklar).
- **Kein PDF-Endpunkt** fuer Kassenbons gefunden. Modul ist daher mit
  `providesPdf: false` gebaut und liefert Artikel/Ersparnisse stattdessen strukturiert
  aus `positions[]`/`promotions[]`.
- **Kein `zipCode`-Feld** im Store-Objekt der Kaufland-API — `market.zipCode` bleibt
  im Modul absichtlich `undefined` statt erfunden (`market_zip` wird in BonSync `NULL`
  bleiben).

## Offene Fragen / Risiken (Details: `api-kaufland.md` Abschnitt 8)

1. Response-Form von `GET .../transactions` — rohes Array oder Wrapper-Objekt?
   (`index.js` behandelt beides defensiv ueber `extractList()`.)
2. Bedeutung von `version`-Query-Parameter (aktuell hartkodiert `2`).
3. `start`/`limit` — Offset/Anzahl oder Seite/Groesse? (aktuell als Offset/Anzahl
   angenommen, Pagination bricht ab, sobald eine Seite < `limit` liefert oder eine
   bereits bekannte ID auftaucht — Annahme: Liste ist absteigend nach Datum sortiert).
4. Braucht der `client-id`-Header (`LoyaltyAuthHeader`) einen eigenen Token-Exchange
   gegen `client_id=LoyaltyClientId`, oder reicht der normale Access-Token? Aktuell:
   normaler Access-Token wird mitgeschickt.
5. `sum`/`total`/`payoff` in Cent oder Hauptwaehrung? Aktuell unveraendert als Cent
   behandelt (`normalizeAmount()` rundet nur, rechnet nicht um).
6. `ReceiptItem`/`ReceiptSavings`-Feldnamen im Modul sind **eigene, sinnvolle
   Annahmen** — `module-format.md` spezifiziert nur das `market`-Format strikt, nicht
   diese beiden Typen im Detail.

## Naechste Schritte (Nutzer)

1. `python3 kaufland_client.py login` mit echtem Kaufland-Account durchlaufen
   (Browser-Login, Callback-URL aus DevTools kopieren).
2. `python3 kaufland_client.py userinfo` — prueft `/users-srv/userinfo` und den
   `sub`-Claim.
3. `python3 kaufland_client.py receipts --country DE --limit 20` — prueft den
   zentralen Transaktions-Endpunkt und zeigt die echte Response-Form.
4. Ergebnisse melden — `api-kaufland.md` (Abschnitt 8) und `kaufland-module/index.js`
   werden danach an die reale API angepasst, bevor das Modul ueber die BonSync-UI
   ("Weiteres Modul installieren") produktiv hochgeladen wird.
