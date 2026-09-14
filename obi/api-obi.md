# heyOBI App – Login & Kassenbon-API

Reverse-engineert aus `de.obi.app` (APKPure-Build `26.9.2`, Paket `de.obi.app`,
Kotlin/Compose-Multiplatform-App, kein Flutter/RN). Analyse per `apktool`/`baksmali`
(kein `jadx` verfügbar). Verifiziert mit echtem Account (Login, Einkäufe-Liste inkl.
Artikeldetails, Kassenbon-PDF-Link).

## Hosts

| Zweck | Basis-URL |
|---|---|
| Login | `https://www.obi.de` (**nicht** die API-Domain — Web-Host!) |
| API (live/prod) | `https://api.live.app.obi.de/v1/` |
| API (stage) | `https://api.stage.app.obi.de/v1/` |
| API (dev) | `https://api.dev.app.obi.de/v1/` |

Alle `bffs/...`-Pfade unten sind relativ zur `/v1/`-Basis, z.B.
`https://api.live.app.obi.de/v1/bffs/receipts/purchases`.

Hinweis: OBI betreibt daneben noch eine komplett getrennte API-Familie für die
"heyOBI Energy Tracker"-Bridges/Sensoren (`energy-tracking-backend.prod-eks.dbs.obi.solutions`,
gleiches Login/gleicher Account) — irrelevant für Kassenbons, hier nicht dokumentiert.

## Pflicht-Header (jeder Request, sowohl Login als auch API)

```
x-api-key: Rh57q3vtOPYTf6FtArVN1boy2AyEiIqaGEmnMks7
x-app-type: b2c
x-obi-client: heyObiApp
x-obi-locale: de-DE
User-Agent: heyOBI APP / Android Phone 30 / 26.9.2 / 1
Cache-Control: no-cache
```

`x-api-key` ist ein statischer, fest in der App einprogrammierter Client-Key
(kein Geheimnis pro Nutzer). Auf den API-Calls (nicht beim Login) zusätzlich:

```
Authorization: Bearer <token aus Login>
```

## Schritt 1: Login

```
POST https://www.obi.de/regi/auth/api/public/login
Content-Type: application/json

{ "email": "<email>", "password": "<passwort>", "country": "DE" }
```

Antwort:
```json
{ "token": "<JWT>" }
```

Kein separates Refresh-Token gefunden — das JWT wird direkt als Bearer-Token
verwendet. Gültigkeitsdauer/Refresh-Mechanismus unbekannt (siehe "Offene
Fragen" unten); schlägt ein API-Call mit 401 fehl, hilft nur ein erneuter
Login (wie ROSSMANN).

## Schritt 2: Einkäufe abrufen

```
GET https://api.live.app.obi.de/v1/bffs/receipts/purchases
Accept: application/vnd.obi.bff.receipts.purchases.v1+json
Short-Lived-Token-Required: 30_DAYS
Authorization: Bearer <token>
```

Liefert **alle** Einkäufe inkl. voller Artikeldetails in einem einzigen Call —
keine Pagination-Parameter gefunden, keine serverseitige Begrenzung
beobachtet (Live-Antwort enthielt Einkäufe von 2023 bis 2026 ungefiltert).

Live-Antwort (gekürzt, echte Werte anonymisiert):
```json
{
  "purchaseGroups": [
    {
      "title": "2026",
      "purchases": [
        {
          "id": "b78a69db-d018-4d18-af7a-a8b1a9b6715f",
          "visibleInOverview": true,
          "totalPrice": "25,38 €",
          "purchaseDate": { "date": "2026-07-20T15:20:10.000Z" },
          "articlesText": "Positionen: 3",
          "storeName": "Markt Hilden",
          "receipts": [
            {
              "isReturn": false,
              "link": {
                "style": "orangeFilled",
                "url": "https://api.live.app.obi.de/v1/documents/receipts/9011564918824/553/20260720/046330/06055301604169511805/KASSEN_BON.pdf",
                "title": "Kassenbon öffnen"
              },
              "documentTitle": "Kassenbon"
            }
          ],
          "target": "https://www.obi.de/heyobi/purchases/b78a69db-d018-4d18-af7a-a8b1a9b6715f",
          "details": {
            "receiptId": "06055301604169511805",
            "description": "Der digitale Kassenbon zeigt deinen Einkauf und hilft dir bei deinem Umtausch im OBI Markt.",
            "isReturnable": true,
            "articleGroup": {
              "title": "Gekaufte Artikel",
              "articles": [
                {
                  "id": "9685751",
                  "image": "https://heyobi.bilder.obi.de/4da39da3-d008-41b4-b8f1-ef8a6bb5f5a3?h=500",
                  "title": "Energie-Tracker",
                  "count": "1",
                  "unitPrice": "14,99 €",
                  "totalPrice": "14,99 €",
                  "isReturn": false,
                  "target": "https://www.obi.de/p/9685751"
                }
              ],
              "subtotalLists": [
                [
                  { "title": "Zwischensumme:", "price": "25,64 €" },
                  { "title": "heyOBI Vorteil:", "price": "-0,25 €" }
                ]
              ],
              "isReturnGroup": false
            }
          }
        }
      ]
    }
  ],
  "summaryText": "Letzter Einkauf: 20.07.2026"
}
```

Wichtige Eigenheiten:
- **Preise sind Strings im deutschen Format** (`"25,38 €"`, negativ für Abzüge
  wie `"-0,25 €"`), keine Zahlen — vor Weiterverarbeitung parsen (Komma → Punkt,
  alles außer Ziffern/Komma/Minus verwerfen).
- **`storeName` ist nur ein Name** (z.B. `"Markt Hilden"`), keine Adresse
  (keine Straße/PLZ/Ort in der Antwort) — anders als REWE/PENNY/ROSSMANN. Die
  volle Adresse steht stattdessen im PDF-Text, siehe Abschnitt "Adresse aus
  dem Kassenbon-PDF" unten.
- **`receipts[]` ist bei älteren Einkäufen leer** — kein PDF-Link verfügbar
  (beobachtet bei Einkäufen aus 2023). Kein Fehler, einfach kein PDF für
  diesen Beleg.
- **Artikel + Zwischensummen sind bereits strukturiert im JSON** enthalten
  (`details.articleGroup.articles` / `.subtotalLists`) — kein PDF-Text-Parsing
  nötig, anders als REWE/PENNY.
- Der PDF-Link (`receipts[].link.url`) ist eine **absolute URL auf demselben
  API-Host** und braucht denselben `Authorization: Bearer`-Header wie die
  übrigen Calls.

### Verwandte, aber ungenutzte Endpunkte

```
GET https://api.live.app.obi.de/v1/bffs/receipts/purchases/summary
Accept: application/vnd.obi.bff.receipts.purchases.summary.v1+json
Short-Lived-Token-Required: 30_DAYS
```
→ `{ "summaryText": "Letzter Einkauf: 20.07.2026" }` — nur der Text, der auch
in der Haupt-`purchases`-Antwort steckt. Nicht gebraucht.

```
GET https://api.live.app.obi.de/v1/bffs/receipts/digital-receipts-setting
Accept: application/vnd.obi.bff.receipts.digital-receipts-setting.v1+json
```
→ `{ "usesDigitalReceipts": true }` — Nutzereinstellung, ob digitale Kassenbons
aktiviert sind. Nicht gebraucht (die Liste liefert Belege unabhängig davon).

## Adresse aus dem Kassenbon-PDF

Die JSON-API liefert nirgends Straße/PLZ/Ort (siehe oben) — die Marktadresse steht nur im Text
des Kassenbon-PDFs, ganz oben, in einem festen Block direkt vor der Öffnungszeit/Tel.-Zeile.
Per `pdfjs-dist`-Zeilenextraktion (= `sdk.pdf.extractLines`) verifiziert:

```
Bon-ID
Obi GmbH & Co. Deutschland KG
Filiale Hilden
Westring 5
40721 Hilden
Tel.: 02103 / 908870
...
```

Muster: `Filiale <Ort>` markiert den Block, die zwei Folgezeilen sind Straße bzw. `<PLZ> <Ort>`.
Die Zeile davor (Rechtsform, `"Obi GmbH & Co. Deutschland KG"`) ist der Rechtsträger, nicht der
Markt selbst — wird ignoriert. Implementiert als `refreshMarketInfo()` im Modul (`sync.ts` ruft
das automatisch nach jedem PDF-Download auf und reichert die schon per `fetchReceipts` gesetzten
Marktdaten um Straße/PLZ/Ort an — überschreibt nur, wenn ein Treffer da ist).

Unverifiziert: ob der Rechtsträger-Name bei Franchise-Filialen abweicht (andere OBI-Standorte
werden teils von Partnern betrieben) — das Muster `Filiale <Ort>` + zwei Folgezeilen sollte davon
unabhängig funktionieren, wurde aber nur an einem Markt (Hilden) getestet.

## Offene Fragen

1. **Token-Ablauf/Refresh:** Kein Refresh-Endpoint gefunden. Der
   `Short-Lived-Token-Required: 30_DAYS`-Header auf den `purchases`-Calls ist
   vermutlich ein Hinweis an die Auth-Schicht, welche Token-TTL benötigt wird
   — nicht als separater Token-Austausch verifiziert. Der String
   `/authTokens:generate` taucht zwar im Code auf, gehört aber zu **Firebase
   Installations** (`projects/{id}/installations/{fid}/authTokens:generate`),
   nicht zu OBI selbst — Sackgasse.
2. **Cancelled/Storno:** Kein Beispiel für eine stornierte Bestellung in den
   Testdaten. `details.articleGroup.isReturnGroup` sieht wie der richtige
   Signalgeber aus, ist aber unverifiziert.

## Zusammenfassung des Flows

```
Login (email+password, www.obi.de)
  └─> JWT
       └─> GET bffs/receipts/purchases (api.live.app.obi.de, Bearer JWT)
             ├─> Einkaufsliste + Artikeldetails + Zwischensummen (ein Call, keine Pagination)
             └─> receipts[].link.url → Kassenbon-PDF (Bearer JWT, sofern vorhanden)
```
