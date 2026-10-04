# BonSync-Store · Kaufland

Holt digitale Kassenbons („Transaktionen“) aus dem Kaufland-Konto (cidaas OAuth 2.0 PKCE, Acardo-CRM).

**Ungetestet:** Das Modul ist per statischer Analyse der Android-App entstanden und wurde noch nicht gegen einen echten Account geprüft. Vertrauensstand und offene Fragen stehen in `kaufland/api-kaufland.md`; vor produktiver Nutzung `kaufland/kaufland_client.py` mit einem echten Account durchlaufen lassen.

Dies ist der Branch `modul/kaufland` des [BonSync-Store](https://github.com/kurim/BonSync-Store): Er enthält nur
die Quellen des Kaufland-Moduls (aktuelle Version 0.1.0). Die übrigen Module, die Build-Pipeline und die
Dokumentation des Modul-Formats liegen im Branch `dev` bzw. `main`.

## Login

OAuth 2.0 mit PKCE (cidaas); der Code wird manuell in BonSync eingefügt (`oauth-pkce-manual`).

## Was das Modul liefert

- Belegliste, Artikel, Ersparnis und Marktdaten aus den Transaktionen
- Kein Beleg-PDF (`providesPdf: false`)

## Dateien

| Pfad | Inhalt |
|---|---|
| `api-kaufland.md` | Referenz der Kaufland-App-API (Login und Transaktionen) |
| `kaufland_client.py` | Python-Referenzclient zum Prüfen der API mit einem echten Account |
| `CLAUDE.md` | Arbeitsstand der Reverse-Engineering-Arbeit |
| `module/` | manifest.yaml, index.js |

## Entwickeln

- Das Modul-Format (Manifest, JS-Vertrag, Module-SDK) ist in `module-format.md` auf `dev`/`main` beschrieben.
- Die Version steht in `module/manifest.yaml`; bei jeder Änderung am Modul erhöhen.
- Gebaut wird mit `npm run build` im vollständigen Repo (`main`/`dev`).
- Die Händler-API ist inoffiziell und in [api-kaufland.md](api-kaufland.md) dokumentiert; sie kann sich jederzeit ändern.
