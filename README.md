# BonSync-Store

**[Deutsch](#deutsch) | [English](#english)**

---

## Deutsch

Dieses Repository ist der öffentliche Modul-Katalog für [BonSync](https://github.com/kurim) —
eine selbst gehostete App zum automatischen Einsammeln und Auswerten von Kassenbons deutscher
Händler. Jedes Top-Level-Verzeichnis (`rewe/`, `penny/`, `lidl/`, `rossmann/`, `obi/`,
`fressnapf/`, …) enthält die Quellen **eines** Händler-Moduls. Eine Build-Pipeline (GitHub
Actions) baut daraus bei jedem Push auf `main` fertige Zip-Pakete und einen `index.json`-Katalog,
den die BonSync-App unter **Händler-Schnittstellen → Store** direkt zur Installation anbietet.

Das genaue technische Format eines Moduls (Manifest-Felder, JS-Vertrag, Module-SDK) ist in
[module-format.md](module-format.md) beschrieben — diese README erklärt den **Ablauf**, um ein
eigenes Modul beizusteuern.

### Repository-Struktur

```
<retailer>/
├── api-<retailer>.md      dokumentiert die reverse-engineerte Händler-API (empfohlen)
└── module/
    ├── manifest.yaml       Pflicht — siehe module-format.md Abschnitt 3
    ├── index.ts / index.js Pflicht — Einstiegspunkt, TS wird beim Build zu ESM-JS gebündelt
    ├── logo.png / .svg     optional — UI-Logo
    └── ...                 optional — weitere Dateien (lib/, Zertifikate, etc.)
```

`scripts/build-store.mjs` erkennt jeden Ordner mit `<ordner>/module/manifest.yaml` automatisch —
ein neues Modul braucht **keine** Änderung an der Build-Pipeline.

### Zwei Wege, ein eigenes Modul zu nutzen

**1. Privat, ohne Veröffentlichung.** Ein selbst gebautes Modul-Zip kann jederzeit direkt in der
BonSync-Oberfläche hochgeladen werden (**Händler-Schnittstellen → Weiteres Modul installieren**),
ganz ohne dieses Repository. Das ist der richtige Weg für Module, die nur du selbst nutzen willst.
Siehe [module-format.md, Abschnitt 6–7](module-format.md#6-minimalbeispiel).

**2. Öffentliches Listing im Store.** Soll dein Modul für alle BonSync-Nutzer über den
Store-Katalog installierbar sein, reichst du es hier per **Pull Request** ein — Ablauf und
Sicherheitsprüfung siehe unten.

### Ein Modul zur Aufnahme in den Store einreichen

1. **Fork** dieses Repository, neuer Branch.
2. Neuen Ordner `<retailer>/module/` mit `manifest.yaml` + Einstiegsdatei (`index.ts`/`index.js`)
   anlegen. `id` im Manifest muss repository-weit eindeutig sein (Muster `^[a-z0-9][a-z0-9-]{1,31}$`).
   Optional: `<retailer>/api-<retailer>.md` mit einer kurzen Dokumentation der genutzten
   Händler-API/-Schnittstelle — hilft der Review erheblich.
3. Lokal bauen und prüfen, dass dein Modul fehlerfrei durch die Pipeline läuft:
   ```bash
   npm install
   npm run build
   ```
   Das erzeugt `dist/<id>-<version>.zip` und `dist/index.json` — Vorschau des fertigen
   Store-Eintrags, ohne main zu berühren.
4. **Pull Request gegen `main`** öffnen. Im PR-Text kurz beschreiben: welcher Händler, welche
   Login-Art (`loginStrategy.kind`), Quelle/Legitimität der genutzten API (z.B. offizielle App
   reverse-engineered, öffentlich dokumentierte API, …).
5. Warten auf Review — siehe nächster Abschnitt. Erst nach **Merge durch den Repo-Owner** baut die
   Pipeline automatisch neue Zips und aktualisiert den rollierenden `latest`-Release
   ([.github/workflows/build-store.yml](.github/workflows/build-store.yml)), von dem die App den
   Katalog lädt. Ein offener PR ändert am ausgelieferten Store-Katalog **nichts**.

### Sicherheitsverfahren & Freigabe durch den Repo-Owner

**Kein Sandboxing.** Wie in [module-format.md, Abschnitt 1](module-format.md#1-überblick--vertrauensmodell)
beschrieben, läuft ein installiertes Modul mit denselben Rechten wie der BonSync-Server selbst —
voller Netzwerk- und Dateisystemzugriff, keine technische Beschränkung. Das gilt für jedes Modul im
Store genauso wie für ein privat hochgeladenes. Aus diesem Grund ist die **manuelle Code-Review vor
dem Merge die einzige Sicherheitsschranke** für alles, was im Store öffentlich gelistet wird:

- **Nur der Repository-Owner kann Pull Requests nach `main` mergen.** Ein eingereichter PR wird
  erst live, wenn der Owner ihn geprüft und gemerged hat — bis dahin ist er für andere Nutzer der
  App unsichtbar (kein Einfluss auf `dist/index.json`, keinen Eintrag im `latest`-Release).
- Bei der Review wird u.a. geprüft: der Code tut ausschließlich das, was Manifest/Beschreibung
  vorgeben (kein verstecktes Exfiltrieren von Zugangsdaten/Belegen an Dritt-Server, keine
  Backdoors); keine mitgebündelten Secrets, die nicht dem Modul-Autor selbst gehören; `entry`
  bleibt innerhalb des Paketverzeichnisses; verwendete Endpunkte sind plausibel dem angegebenen
  Händler zuordenbar; `manifest.yaml` ist vollständig und stimmt mit dem tatsächlichen Verhalten
  überein (`loginStrategy`, `providesPdf`, `sdkVersion`, …).
- Änderungen an einem **bereits gelisteten** Modul (z.B. Versions-Update) durchlaufen denselben
  PR-Review-Prozess wie ein neues Modul — es gibt keinen automatischen Auto-Merge.
- Trotz Review: Store-Module werden nicht automatisiert auf Malware/Verhalten gescannt. Die
  Freigabe ist eine manuelle Vertrauensentscheidung des Owners, kein technischer Sandbox-Schutz.
  Installierst du ein Modul, vertraust du damit sowohl dem Modul-Autor als auch der Sorgfalt der
  Owner-Review — wie bei jeder anderen Software-Dependency auch.

### Lokal testen

```bash
npm install
npm run build      # baut dist/*.zip + dist/index.json aus allen <retailer>/module/-Ordnern
```

### Mitwirken & Lizenz

Ausführliche PR-Checkliste und Vorbereitungsschritte: [CONTRIBUTING.md](CONTRIBUTING.md).
Freigabeberechtigte Person: [.github/CODEOWNERS](.github/CODEOWNERS). Dieses Repository steht
unter der [MIT-Lizenz](LICENSE).

---

## English

This repository is the public module catalog for [BonSync](https://github.com/kurim) — a
self-hosted app that automatically collects and parses receipts from German retailers. Each
top-level directory (`rewe/`, `penny/`, `lidl/`, `rossmann/`, `obi/`, `fressnapf/`, …) holds the
source for **one** retailer module. A GitHub Actions build pipeline turns these into finished zip
packages and an `index.json` catalog on every push to `main`, which the BonSync app offers for
one-click installation under **Retailer Interfaces → Store**.

The exact technical module format (manifest fields, JS contract, module SDK) is documented in
[module-format.md](module-format.md) — this README explains the **process** for contributing your
own module.

### Repository layout

```
<retailer>/
├── api-<retailer>.md      documents the reverse-engineered retailer API (recommended)
└── module/
    ├── manifest.yaml       required — see module-format.md section 3
    ├── index.ts / index.js required — entry point, TS is bundled to ESM JS at build time
    ├── logo.png / .svg     optional — UI logo
    └── ...                 optional — extra files (lib/, certificates, etc.)
```

`scripts/build-store.mjs` auto-discovers every folder containing
`<folder>/module/manifest.yaml` — adding a module requires **no** change to the build pipeline
itself.

### Two ways to use your own module

**1. Private, unpublished.** A self-built module zip can be uploaded directly in the BonSync UI
at any time (**Retailer Interfaces → Install another module**), entirely without this repository.
This is the right path for a module you only want to use yourself. See
[module-format.md, sections 6–7](module-format.md#6-minimalbeispiel).

**2. Public store listing.** If you want your module installable by every BonSync user through
the store catalog, submit it here as a **pull request** — process and security review below.

### Submitting a module for store inclusion

1. **Fork** this repository, create a new branch.
2. Add a new `<retailer>/module/` folder with `manifest.yaml` and an entry file
   (`index.ts`/`index.js`). The `id` in the manifest must be unique across the whole repository
   (pattern `^[a-z0-9][a-z0-9-]{1,31}$`). Optionally add `<retailer>/api-<retailer>.md` briefly
   documenting the retailer API/interface used — this significantly helps review.
3. Build locally and verify your module runs cleanly through the pipeline:
   ```bash
   npm install
   npm run build
   ```
   This produces `dist/<id>-<version>.zip` and `dist/index.json` — a preview of the resulting
   store entry, without touching `main`.
4. Open a **pull request against `main`**. In the PR description, briefly describe: which
   retailer, which login type (`loginStrategy.kind`), and the source/legitimacy of the API used
   (e.g. reverse-engineered from the official app, publicly documented API, …).
5. Wait for review — see next section. Only after the **repo owner merges** the PR does the
   pipeline automatically rebuild the zips and update the rolling `latest` release
   ([.github/workflows/build-store.yml](.github/workflows/build-store.yml)) that the app loads the
   catalog from. An open PR changes **nothing** about the catalog currently served to users.

### Security process & repo-owner approval

**No sandboxing.** As described in
[module-format.md, section 1](module-format.md#1-überblick--vertrauensmodell), an installed module
runs with the exact same privileges as the BonSync server itself — full network and filesystem
access, no technical restriction. This applies equally to every store module and to a privately
uploaded one. Because of that, **manual code review before merge is the only security gate** for
anything publicly listed in the store:

- **Only the repository owner can merge pull requests into `main`.** A submitted PR only goes
  live once the owner has reviewed and merged it — until then it is invisible to other app users
  (no effect on `dist/index.json`, no entry in the `latest` release).
- Review checks include: the code does exactly what the manifest/description claims (no hidden
  exfiltration of credentials/receipts to third-party servers, no backdoors); no bundled secrets
  that don't belong to the module author; `entry` stays inside the package directory; the
  endpoints used are plausibly tied to the stated retailer; `manifest.yaml` is complete and
  matches actual behavior (`loginStrategy`, `providesPdf`, `sdkVersion`, …).
- Changes to an **already-listed** module (e.g. a version bump) go through the same PR review
  process as a new module — there is no automatic auto-merge.
- Despite review, store modules are not automatically scanned for malware or behavior. Approval
  is a manual trust decision by the owner, not a technical sandbox guarantee. Installing a module
  means trusting both its author and the diligence of the owner's review — same as with any other
  software dependency.

### Testing locally

```bash
npm install
npm run build      # builds dist/*.zip + dist/index.json from every <retailer>/module/ folder
```

### Contributing & license

Detailed PR checklist and prep steps: [CONTRIBUTING.md](CONTRIBUTING.md). Approver:
[.github/CODEOWNERS](.github/CODEOWNERS). This repository is licensed under the
[MIT License](LICENSE).
