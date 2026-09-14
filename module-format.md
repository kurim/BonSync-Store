# BonSync Modul-Format

Dieses Dokument beschreibt, wie ein Händler-Modul für BonSync aufgebaut sein muss, damit es
installiert werden kann — sowohl für die 4 mitgelieferten Module (REWE, PENNY, LIDL, ROSSMANN,
siehe `modules-src/`) als auch für eigene, per Zip hochgeladene Module.

## 1. Überblick & Vertrauensmodell

Ein BonSync-Modul ist ein kleines, in sich geschlossenes Software-Paket (Manifest + ausführbarer
JavaScript-Code), das die Kommunikation mit einem bestimmten Händler (Login, Beleg-Liste,
PDF-Download, Artikel-Erkennung) kapselt. Module werden über die Oberfläche unter
**Händler-Schnittstellen** installiert, deinstalliert und verwaltet.

**Wichtig — kein Sandboxing:** Ein installiertes Modul läuft mit denselben Rechten wie der
BonSync-Server selbst, im selben Node-Prozess. Es gibt keine technische Beschränkung, was ein
Modul tun kann (Netzwerkzugriff, Dateisystem, etc.) — das ist eine bewusste Design-Entscheidung
für eine selbst gehostete Single-User-App, die nur der Betreiber selbst administriert. Installiere
daher **nur Module, denen du vertraust** — genau wie bei jeder anderen Software/Dependency auch.
Die eingebauten Module (`modules-src/`) unterliegen exakt denselben Regeln wie jedes andere
installierte Modul; es gibt keinen privilegierten "Kern".

## 2. Paket-Layout

Ein Modul-Paket ist ein Zip mit folgendem Inhalt im Wurzelverzeichnis:

```
mein-modul-1.0.0.zip
├── manifest.yaml     (Pflicht, muss im Wurzelverzeichnis liegen)
├── index.js          (Pflicht, der in manifest.yaml unter "entry" angegebene Einstiegspunkt)
├── lib/               (optional: weitere Dateien, per relativem Import aus index.js erreichbar)
└── logo.png           (optional: eigenes UI-Logo, referenziert über ui.logo im Manifest)
```

- **`entry`** ist ein Pfad relativ zum Paket-Wurzelverzeichnis (z.B. `"index.js"` oder
  `"dist/index.js"`). Er muss auf eine Datei *innerhalb* des Pakets zeigen — ein Pfad, der das
  Paketverzeichnis verlässt (z.B. via `..`), wird beim Laden abgelehnt.
- **Zusätzliche Dateien** sind erlaubt: alles, was `index.js` per relativem Import lädt (z.B.
  `import './lib/helpers.js'`), wird ganz normal von Node aufgelöst, da das Paket nach der
  Installation unverändert als Verzeichnis auf der Platte liegt.
- **Das Format ist fertiges, gebautes ESM-JavaScript** — kein TypeScript, keine Laufzeit-
  Transpilation. Schreibst du dein Modul in TypeScript (empfohlen, siehe `modules-src/` als
  Vorlage), baue es vorher zu JavaScript, z.B. mit `esbuild --bundle --format=esm --platform=node`
  (genau das macht `modules-src/build.mjs` für die 4 eingebauten Module).
- **Keine npm-Abhängigkeiten mitbündeln, die BonSync bereits als Fähigkeit anbietet** (siehe
  Abschnitt 5, Module-SDK) — schwere Pakete wie PDF- oder Headless-Browser-Bibliotheken sollen
  nicht pro Modul dupliziert werden.

## 3. `manifest.yaml`-Referenz

| Feld | Typ | Pflicht | Beschreibung |
|---|---|---|---|
| `manifestVersion` | integer | ja | Aktuell immer `1`. |
| `id` | string | ja | Eindeutige Kennung. Muster: `^[a-z0-9][a-z0-9-]{1,31}$` (Kleinbuchstaben, Ziffern, `-`, 2–32 Zeichen, beginnt mit Buchstabe/Ziffer). Wird als Verzeichnisname unter `${DATA_DIR}/modules/` und als Primärschlüssel in der Datenbank verwendet. |
| `displayName` | string | ja | Anzeigename in der Oberfläche, z.B. `"REWE"`. |
| `version` | string | ja | Frei wählbar, Semver empfohlen (z.B. `"1.0.0"`). Wird angezeigt und für Upgrade-Erkennung genutzt. |
| `entry` | string | ja | Relativer Pfad zur ESM-Einstiegsdatei im Paket. |
| `sdkVersion` | integer | nein (Default `1`) | Welche Version des Module-SDK-Vertrags (Abschnitt 5) das Modul erwartet. Eine höhere Zahl als die aktuell unterstützte wird beim Laden abgelehnt, statt das Modul mit potenziell fehlenden Fähigkeiten laufen zu lassen. |
| `loginStrategy.kind` | string | ja | Eines von `oauth-pkce-manual`, `oauth-pkce-redirect`, `credentials` (siehe Abschnitt 4). |
| `author` | string | nein | Nur zur Anzeige. |
| `description` | string | nein | Nur zur Anzeige. |
| `authDescription` | string | nein | Kurzer technischer Hinweis, was das Modul für Login/Transport nutzt (z.B. `"REST-Client · OAuth 2.0 (PKCE)"`), wird auf der Modul-Karte angezeigt. |
| `providesPdf` | boolean | nein (Default `true`) | Auf `false` setzen, wenn der Händler **grundsätzlich kein** Beleg-PDF liefert (z.B. nur strukturierte Artikeldaten über die API). Ohne diese Angabe wartet die Beleg-Detailseite dauerhaft auf ein PDF, das nie kommt -- zeigt permanent "Noch nicht vollständig geladen" und versucht bei jedem Seitenaufruf erneut, eins zu laden. `fetchReceiptPdf` muss trotzdem implementiert sein (einfach immer `null` zurückgeben), da es Pflichtteil des Vertrags bleibt (siehe Abschnitt 4) -- `providesPdf: false` sagt der App nur, dieses `null` dauerhaft zu erwarten statt es als "noch nicht geladen" zu werten. **Ohne PDF ist die Marktadresse aus `fetchReceipts`/`refreshMarketInfo` die einzige Datenquelle für Marktdaten — siehe Abschnitt 4.1 für das exakte Feldformat.** |
| `ui.color` | string | nein | CSS-Farbwert (Hex empfohlen, z.B. `"#cc071e"`) für Akzent/Badge/Kartenrand. |
| `ui.chip` | string | nein | 2–3-Buchstaben-Kürzel, angezeigt solange kein Logo geladen ist. |
| `ui.logo` | string | nein | Relativer Pfad zu einer Bilddatei im Paket (`.png`, `.svg`, `.jpg`, `.jpeg`, `.webp`), ausgeliefert über `/module-assets/<id>/<pfad>`. |

Felder ohne `ui`-Angaben bekommen automatisch einen generischen, aber konsistenten Fallback
(deterministische Farbe aus der `id`, Kürzel aus `displayName`) — ein Modul ganz ohne `ui`-Block
ist also vollkommen gültig.

### Beispiel (REWE, siehe `modules-src/rewe/manifest.yaml`)

```yaml
manifestVersion: 1
id: rewe
displayName: REWE
version: 1.0.0
entry: index.js
sdkVersion: 1
loginStrategy:
  kind: oauth-pkce-manual
author: Kurim
description: Offizielles REWE-Modul (REST-Client, mTLS, OAuth 2.0 PKCE).
authDescription: "REST-Client · mTLS · OAuth 2.0 (PKCE)"
ui:
  logo: logo.png
  color: "#cc071e"
  chip: RE
```

## 4. Der `StoreModule`-JS-Vertrag

Die `entry`-Datei muss als `default`-Export **entweder**

- ein fertiges `StoreModule`-Objekt liefern, **oder**
- eine Fabrikfunktion `(sdk) => StoreModule` — die Registry erkennt das automatisch per
  `typeof export.default === 'function'` und übergibt ein pro Modul vorkonfiguriertes
  [Module-SDK](#5-module-sdk-referenz) (Abschnitt 5).

Methoden (aus `src/lib/server/modules/types.ts`, `StoreModule`-Interface):

| Methode | Pflicht | Signatur | Zweck |
|---|---|---|---|
| `ensureFreshCredentials` | ja | `(creds) => Promise<StoredCredentials>` | Erneuert Tokens falls nötig, gibt sonst `creds` unverändert zurück. |
| `fetchReceipts` | ja | `(creds, knownIds: Set<string>) => Promise<ReceiptSummary[]>` | Liefert neue Belege (Externe-ID nicht in `knownIds`). |
| `fetchReceiptPdf` | ja | `(creds, externalId) => Promise<Buffer \| null>` | Lädt das Beleg-PDF, `null` falls nicht verfügbar. |
| `beginLogin` | nur bei `oauth-pkce-*` | `() => Promise<{ url, state }>` | Baut die Authorize-URL, persistiert den PKCE-Verifier (`sdk.pkce.saveState`). |
| `completeLogin` | nur bei `oauth-pkce-*` | `(input: Record<string,string>) => Promise<StoredCredentials>` | Tauscht den vom Nutzer eingefügten Code gegen Tokens. |
| `loginWithCredentials` | nur bei `credentials` | `(fields: Record<string,string>) => Promise<StoredCredentials>` | Direkter Login mit z.B. E-Mail+Passwort. |
| `fetchReceiptItems` | optional | `(creds, externalId, pdf?) => Promise<ReceiptItem[]>` | Strukturierte Artikelzeilen, falls verfügbar. |
| `fetchReceiptSavings` | optional | `(creds, externalId, pdf?) => Promise<ReceiptSavings \| null>` | Coupon-/Rabatt-Ersparnis. |
| `refreshMarketInfo` | optional | `(creds, externalId, pdf?) => Promise<ReceiptSummary['market']>` | Nachträgliche Markt-Auflösung (z.B. bei "Neu einlesen"). |

`beginLogin`+`completeLogin` bzw. `loginWithCredentials` sind **verpflichtend**, wenn die
entsprechende `loginStrategy.kind` im Manifest angegeben ist — die Registry prüft das beim Laden
und lehnt das Modul mit einer konkreten Fehlermeldung ab, falls die passende Methode fehlt.

`StoredCredentials` ist ein beliebiges JSON-serialisierbares Objekt (`Record<string, unknown>`) —
was genau darin steht, entscheidet das Modul selbst (Access-/Refresh-Token, Account-Hash, etc.).
Es wird von BonSync AES-256-GCM-verschlüsselt in der Datenbank abgelegt, das Modul bekommt es beim
nächsten Aufruf entschlüsselt zurück.

### 4.1 Das `market`-Format (`fetchReceipts` / `refreshMarketInfo`)

Beide Methoden liefern Marktdaten in genau diesem Format (aus `src/lib/server/modules/types.ts`):

```ts
market: {
  name?: string;
  street?: string;
  zipCode?: string;
  city?: string;
} | null;
```

Wichtig, weil BonSync diese Felder 1:1 in feste Datenbankspalten schreibt (`src/lib/server/sync.ts`):

| `market`-Feld | DB-Spalte (`receipts`) |
|---|---|
| `name` | `market_name` |
| `street` | `market_street` |
| `zipCode` | `market_zip` |
| `city` | `market_city` |

- Das Feld heißt **`zipCode`**, nicht `postalCode` — ein häufiger Stolperstein, wenn die
  Händler-API selbst `postalCode` nennt (z.B. `address.postalCode` in der Rohantwort). Ein
  falscher Feldname fällt nicht auf: ein dynamisch geladenes Modul wird zur Laufzeit nicht gegen
  diesen Typ geprüft, das Feld verschwindet einfach kommentarlos und `market_zip` bleibt in der
  DB dauerhaft `NULL`, statt eines Fehlers.
- **Es gibt keine `country`- oder `phone`-Spalte** — BonSync speichert je Beleg nur Name/Straße/
  PLZ/Ort. Liefert die Händler-API zusätzlich Land/Telefonnummer (z.B. unter
  `address.country`/`address.phone`), können diese Angaben nicht übernommen werden — weglassen,
  statt sie unter einem falschen der vier obigen Feldnamen unterzubringen.
- Alle vier Felder sind optional — fehlt z.B. `street` in der API-Antwort, bleibt `market_street`
  einfach `NULL`, statt einen Platzhalter zu erfinden.
- **Bei `providesPdf: false` ist diese Adresse die einzige Quelle für Marktdaten** — ohne PDF
  kann BonSync sie nicht nachträglich per Text-Parsing ergänzen (wie es z.B. `parseMarketHeader`
  für REWE aus dem PDF-Kopf tut, siehe `modules-src/_shared/posParser.ts`). Das Mapping muss hier
  also schon beim ersten Anlauf stimmen.

## 5. Module-SDK-Referenz

Ein Modul importiert **keine** App-internen Dateien direkt (kein `../db`, kein `pdfjs-dist`, kein
`playwright`) — stattdessen bekommt es beim Laden ein `ModuleSdk`-Objekt mit folgenden Fähigkeiten
(siehe `src/lib/server/modules/sdk.ts`):

```ts
interface ModuleSdk {
  http: {
    rawRequest(url, options?): Promise<{ status, headers, body: Buffer }>;
    requestJson<T>(url, options?): Promise<{ status: number; json: T }>;
    formBody(fields: Record<string,string>): string; // application/x-www-form-urlencoded
  };
  pkce: {
    generateCodeVerifier(): string;
    generateCodeChallenge(verifier): string;
    generateState(): string;
    saveState(state, codeVerifier): Promise<void>;   // persistiert, isoliert pro Modul-id
    consumeState(state): Promise<{ codeVerifier } | null>; // liest + löscht einmalig
  };
  pdf: {
    extractLines(pdf: Buffer): Promise<string[]>;    // Text pro Zeile aus einem PDF
  };
  html: {
    toPdf(html: string): Promise<Buffer>;            // Headless-Rendering (z.B. ohne natives PDF)
  };
}
```

`options` bei `http.rawRequest`/`requestJson` unterstützt `method`, `headers`, `body` sowie `tls`
(`{ cert, key }` oder `{ pfx, passphrase }`) für mTLS-Client-Zertifikate.

Warum über ein SDK statt direktem Import: `pkce.saveState`/`consumeState` kapseln den Zugriff auf
die gemeinsame Datenbank (ein Modul darf keine eigene, zweite `node:sqlite`-Verbindung auf
dieselbe Datei aufmachen), und `pdf`/`html` kapseln schwere npm-Abhängigkeiten (`pdfjs-dist`,
`playwright`), die nicht pro Modul erneut mitgebündelt werden sollen.

**Eigene, store-spezifische Logik gehört dagegen ins Modul selbst**, nicht ins SDK — allen voran
die PDF-/HTML-Text-Erkennung der Artikelzeilen (siehe `modules-src/_shared/posParser.ts` für das
generische REWE/PENNY/ROSSMANN-Kassenformat bzw. `modules-src/lidl/parser.ts` für LIDLs
abweichendes Format als Beispiel für ein komplett eigenes, privates Format). Jedes Modul bringt
seine Erkennungslogik unabhängig mit — ein künftiges Modul mit einem dritten Format forkt sich
einfach seine eigene Variante, ohne ein bestehendes Modul zu beeinflussen.

## 6. Minimalbeispiel

Ein fiktives Modul `beispiel-markt` mit `credentials`-Login, ohne echten Netzwerkaufruf:

**`manifest.yaml`**
```yaml
manifestVersion: 1
id: beispiel-markt
displayName: Beispiel-Markt
version: 0.1.0
entry: index.js
sdkVersion: 1
loginStrategy:
  kind: credentials
author: Dein Name
description: Beispiel-Modul für die Dokumentation.
```

**`index.js`**
```js
export default function createBeispielMarktModule(sdk) {
  return {
    async loginWithCredentials(fields) {
      const { email, password } = fields;
      if (!email || !password) throw new Error('E-Mail und Passwort werden benötigt.');
      const { status, json } = await sdk.http.requestJson('https://api.beispiel-markt.de/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      if (status !== 200) throw new Error(`Login fehlgeschlagen (Status ${status})`);
      return { accessToken: json.accessToken };
    },

    async ensureFreshCredentials(creds) {
      return creds; // kein Refresh-Flow in diesem Beispiel
    },

    async fetchReceipts(creds, knownIds) {
      const { json } = await sdk.http.requestJson('https://api.beispiel-markt.de/receipts', {
        headers: { Authorization: `Bearer ${creds.accessToken}` }
      });
      return json.receipts
        .filter((r) => !knownIds.has(r.id))
        .map((r) => ({
          storeId: 'beispiel-markt',
          externalId: r.id,
          timestamp: Date.parse(r.date),
          totalCents: r.totalCents,
          market: r.market ?? null,
          cancelled: false,
          hasStructuredItems: false
        }));
    },

    async fetchReceiptPdf(creds, externalId) {
      const res = await sdk.http.rawRequest(`https://api.beispiel-markt.de/receipts/${externalId}/pdf`, {
        headers: { Authorization: `Bearer ${creds.accessToken}` }
      });
      return res.status === 200 ? res.body : null;
    }
  };
}
```

**Packen** (im Ordner mit `manifest.yaml` + `index.js`):
```bash
zip -r beispiel-markt-0.1.0.zip manifest.yaml index.js
```

Diese Zip-Datei kann direkt über die Oberfläche hochgeladen werden.

## 7. Installieren / Deinstallieren

**Installieren** — unter **Händler-Schnittstellen**, Kachel "Weiteres Modul installieren": Zip
auswählen, Vorschau (Name/Version/Autor/Beschreibung/Login-Art) prüfen. Ist die `id` bereits
installiert, erscheint eine "Überschreiben"-Checkbox — Belege/Zugangsdaten bleiben dabei
unangetastet, nur Code+Manifest werden ersetzt.

**Deinstallieren** — über das ⋮-Menü der jeweiligen Modul-Karte, "Modul deinstallieren". Eine
Rückfrage bietet die Checkbox "Auch vorhandene Daten löschen" (Belege, Artikel, Zugangsdaten,
heruntergeladene PDFs) — standardmäßig **nicht** angehakt. Ohne Häkchen bleibt die komplette
Sync-Historie erhalten, und eine spätere Neuinstallation derselben `id` knüpft nahtlos daran an.

Beide Aktionen funktionieren identisch für die 4 eingebauten Module wie für jedes selbst
installierte — es gibt keinen technischen Unterschied zwischen "eingebaut" und "hochgeladen".
