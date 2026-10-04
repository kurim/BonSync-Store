# BonSync-Store · Fressnapf

Holt In-Store-Kassenbons von Fressnapf/Maxi Zoo (App-Backend-API, OAuth 2.0 PKCE über SAP CDC/Gigya).

Dies ist der Branch `modul/fressnapf` des [BonSync-Store](https://github.com/kurim/BonSync-Store): Er enthält nur
die Quellen des Fressnapf-Moduls (aktuelle Version 1.0.6). Die übrigen Module, die Build-Pipeline und die
Dokumentation des Modul-Formats liegen im Branch `dev` bzw. `main`.

## Login

OAuth 2.0 mit PKCE; der Login läuft im Browser, der Code wird manuell in BonSync eingefügt (`oauth-pkce-manual`).

## Was das Modul liefert

- Belegliste mit strukturierten Artikeln und Ersparnis aus der API
- Marktdaten (`refreshMarketInfo`)
- Kein Beleg-PDF (`providesPdf: false`)

## Dateien

| Pfad | Inhalt |
|---|---|
| `api-fressnapf.md` | Reverse-Engineering-Dokumentation der Fressnapf-/Maxi-Zoo-API |
| `module/` | manifest.yaml, index.js, Logo |

## Entwickeln

- Das Modul-Format (Manifest, JS-Vertrag, Module-SDK) ist in `module-format.md` auf `dev`/`main` beschrieben.
- Die Version steht in `module/manifest.yaml`; bei jeder Änderung am Modul erhöhen.
- Gebaut wird mit `npm run build` im vollständigen Repo (`main`/`dev`).
- Die Händler-API ist inoffiziell und in [api-fressnapf.md](api-fressnapf.md) dokumentiert; sie kann sich jederzeit ändern.
