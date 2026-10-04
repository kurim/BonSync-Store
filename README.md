# BonSync-Store · OBI

Holt Kassenbons aus dem heyOBI-Konto (heyOBI-App-API, E-Mail/Passwort) und liefert Artikel, Ersparnis, Beleg-PDF und Marktdaten.

Dies ist der Branch `modul/obi` des [BonSync-Store](https://github.com/kurim/BonSync-Store): Er enthält nur
die Quellen des OBI-Moduls (aktuelle Version 1.0.1). Die übrigen Module, die Build-Pipeline und die
Dokumentation des Modul-Formats liegen im Branch `dev` bzw. `main`.

## Login

E-Mail und Passwort (`credentials`).

## Was das Modul liefert

- Belegliste und Beleg-PDF
- Strukturierte Artikel und Ersparnis aus der API
- Marktdaten, Straße/PLZ/Ort nachträglich über `refreshMarketInfo` aus dem PDF
- Keine Belegmetadaten über `fetchReceiptMeta` (TSE, Zahlungsart, MwSt.): das Modul implementiert die Methode nicht

## Dateien

| Pfad | Inhalt |
|---|---|
| `api-obi.md` | Reverse-Engineering-Dokumentation von Login und Kassenbon-API |
| `module/` | manifest.yaml, index.ts, Logo |

## Entwickeln

- Das Modul-Format (Manifest, JS-Vertrag, Module-SDK) ist in `module-format.md` auf `dev`/`main` beschrieben.
- Die Version steht in `module/manifest.yaml`; bei jeder Änderung am Modul erhöhen.
- Gebaut wird mit `npm run build` im vollständigen Repo (`main`/`dev`).
- Die Händler-API ist inoffiziell und in [api-obi.md](api-obi.md) dokumentiert; sie kann sich jederzeit ändern.
