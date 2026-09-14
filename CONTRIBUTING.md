# Contributing

**[Deutsch](#deutsch) | [English](#english)**

---

## Deutsch

Danke für dein Interesse, ein Händler-Modul zu BonSync-Store beizusteuern. Diese Datei ergänzt die
[README](README.md#ein-modul-zur-aufnahme-in-den-store-einreichen) um konkrete Vorbereitungs- und
PR-Schritte. Das technische Format ist verbindlich in [module-format.md](module-format.md)
beschrieben — bei Widersprüchen zwischen dieser Datei und `module-format.md` gilt `module-format.md`.

### Bevor du anfängst

- Prüfe, ob für den Händler bereits ein Modul existiert (Top-Level-Ordner in diesem Repo) —
  Updates an einem bestehenden Modul sind ein normaler PR mit erhöhter `version`, kein neues Modul.
- Lies [module-format.md](module-format.md) vollständig, insbesondere Abschnitt 1
  (Vertrauensmodell/kein Sandboxing) und Abschnitt 3 (`manifest.yaml`-Referenz).
- Bei Unsicherheit, ob eine Händler-API-Nutzung so gewollt/tragfähig ist: lieber vorher als Issue
  oder Diskussion klären als viel Arbeit in einen PR stecken, der aus rechtlichen oder fachlichen
  Gründen nicht gemerged werden kann.

### Workflow

1. Repository forken, Branch anlegen (z.B. `add-<retailer>-module`).
2. `<retailer>/module/` mit `manifest.yaml` + Einstiegsdatei anlegen (siehe bestehende Module wie
   `rewe/`, `penny/` als Vorlage). TypeScript wird empfohlen und beim Build automatisch gebündelt.
3. Optional, aber empfohlen: `<retailer>/api-<retailer>.md` mit einer kurzen Doku der genutzten
   Händler-API (Endpunkte, Auth-Flow, Besonderheiten) — erleichtert die Review erheblich.
4. Lokal bauen und die generierte Zip/den Katalog-Eintrag prüfen:
   ```bash
   npm install
   npm run build
   ```
5. Pull Request gegen `main` öffnen. Nutze die Checkliste unten im PR-Text.

### PR-Checkliste

- [ ] `manifest.yaml` vollständig (Pflichtfelder aus module-format.md Abschnitt 3), `id` eindeutig
      im Repo und Muster-konform (`^[a-z0-9][a-z0-9-]{1,31}$`)
- [ ] `npm run build` läuft ohne Fehler durch, `entry` zeigt auf eine existierende Datei innerhalb
      des Moduls
- [ ] Keine Secrets, persönlichen Zugangsdaten oder Test-Tokens im Code oder in Zertifikaten
- [ ] Keine unnötig mitgebündelten npm-Abhängigkeiten, die das Module-SDK bereits abdeckt
      (PDF-/HTML-Rendering, siehe module-format.md Abschnitt 5)
- [ ] Kurze Beschreibung im PR-Text: welcher Händler, `loginStrategy.kind`, Herkunft/Legitimität
      der genutzten API (z.B. reverse-engineered aus offizieller App, öffentlich dokumentiert)
- [ ] Bei Änderung eines bestehenden Moduls: `version` in `manifest.yaml` erhöht

### Code-Stil

- ESM-JavaScript als Build-Ergebnis, Quelle bevorzugt TypeScript.
- An bestehenden Modulen orientieren (`rewe/module/index.ts`, `penny/module/index.ts`); geteilte
  Parsing-Logik liegt bei Bedarf in einem eigenen `_shared/`-Ordner innerhalb *deines* Moduls —
  Module teilen sich laut module-format.md bewusst **keine** gemeinsame Logik über
  Modul-Grenzen hinweg, damit ein Modul unabhängig von anderen geändert werden kann.
- Kein direkter Zugriff auf App-interne Module — ausschließlich das `ModuleSdk` nutzen (siehe
  module-format.md Abschnitt 5).

### Review & Merge

- Freigabe erfolgt ausschließlich durch den in [`.github/CODEOWNERS`](.github/CODEOWNERS)
  eingetragenen Repo-Owner — Details und Begründung (kein Sandboxing, daher Review als
  Sicherheits-Gate) stehen in der [README](README.md#sicherheitsverfahren--freigabe-durch-den-repo-owner).
- Dies ist ein Hobby-Projekt ohne festes SLA für Review-Zeiten.
- Ein offener PR hat keinerlei Auswirkung auf den ausgelieferten Store-Katalog — erst der Merge
  nach `main` löst den Build und die Veröffentlichung im `latest`-Release aus.

### Verhalten

Es gibt (noch) keinen separaten Code of Conduct — üblicher, respektvoller Umgangston in Issues und
PRs wird vorausgesetzt.

---

## English

Thanks for your interest in contributing a retailer module to BonSync-Store. This file adds
concrete preparation and PR steps on top of the
[README](README.md#submitting-a-module-for-store-inclusion). The binding technical format is
described in [module-format.md](module-format.md) — if this file and `module-format.md` disagree,
`module-format.md` wins.

### Before you start

- Check whether a module for the retailer already exists (top-level folder in this repo) — an
  update to an existing module is a normal PR with a bumped `version`, not a new module.
- Read [module-format.md](module-format.md) in full, especially section 1 (trust model / no
  sandboxing) and section 3 (`manifest.yaml` reference).
- If you're unsure whether a particular retailer-API usage is appropriate or sustainable, raise it
  as an issue/discussion first rather than investing a lot of work into a PR that can't be merged
  for legal or technical reasons.

### Workflow

1. Fork the repository, create a branch (e.g. `add-<retailer>-module`).
2. Add `<retailer>/module/` with `manifest.yaml` and an entry file (use existing modules like
   `rewe/`, `penny/` as a template). TypeScript is recommended and gets bundled automatically at
   build time.
3. Optional but recommended: add `<retailer>/api-<retailer>.md` briefly documenting the retailer
   API used (endpoints, auth flow, quirks) — this significantly speeds up review.
4. Build locally and inspect the generated zip/catalog entry:
   ```bash
   npm install
   npm run build
   ```
5. Open a pull request against `main`. Use the checklist below in the PR description.

### PR checklist

- [ ] `manifest.yaml` complete (required fields per module-format.md section 3), `id` unique in
      the repo and pattern-compliant (`^[a-z0-9][a-z0-9-]{1,31}$`)
- [ ] `npm run build` runs without errors, `entry` points to a file that exists inside the module
- [ ] No secrets, personal credentials, or test tokens in code or certificates
- [ ] No unnecessarily bundled npm dependencies already covered by the module SDK (PDF/HTML
      rendering, see module-format.md section 5)
- [ ] Short description in the PR text: which retailer, `loginStrategy.kind`, provenance/
      legitimacy of the API used (e.g. reverse-engineered from the official app, publicly
      documented)
- [ ] When changing an existing module: `version` bumped in `manifest.yaml`

### Code style

- ESM JavaScript as the build output, TypeScript preferred as the source.
- Follow existing modules (`rewe/module/index.ts`, `penny/module/index.ts`); shared parsing logic
  lives in your own module's `_shared/` folder if needed — per module-format.md, modules
  deliberately do **not** share logic across module boundaries, so one module can be changed
  without affecting another.
- No direct access to app-internal modules — use the `ModuleSdk` exclusively (see
  module-format.md section 5).

### Review & merge

- Approval is granted exclusively by the repo owner listed in
  [`.github/CODEOWNERS`](.github/CODEOWNERS) — details and rationale (no sandboxing, hence review
  as the security gate) are in the
  [README](README.md#security-process--repo-owner-approval).
- This is a hobby project with no fixed SLA for review turnaround.
- An open PR has no effect whatsoever on the catalog currently served to users — only a merge
  into `main` triggers the build and publication to the `latest` release.

### Conduct

There is no separate code of conduct (yet) — the usual respectful tone in issues and PRs is
expected.
