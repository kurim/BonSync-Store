# BonSync-Store · dm

Holt eBons aus dem Mein-dm-Konto (REST-API der Mein-dm-App). Kein „Install-and-forget“-Modul: dm erlaubt keinen automatisierbaren Login.

**Wichtig:** dm hat keinen automatisierbaren Login (Geräte-Attestierung in der App, reCAPTCHA Enterprise im Web, kein Refresh-Token). Das Access-Token ist nur etwa 150 Sekunden gültig und muss vor jedem Sync manuell aus einem eingeloggten Browser-Tab (DevTools, Authorization-Header) eingefügt werden. Details in `dm/api-dm.md`.

Dies ist der Branch `modul/dm` des [BonSync-Store](https://github.com/kurim/BonSync-Store): Er enthält nur
die Quellen des dm-Moduls (aktuelle Version 0.1.0). Die übrigen Module, die Build-Pipeline und die
Dokumentation des Modul-Formats liegen im Branch `dev` bzw. `main`.

## Login

Manuelles Access-Token statt Login (`credentials`, ca. 150 Sekunden gültig, kein Auto-Refresh).

## Was das Modul liefert

- Belegliste und Beleg-PDF
- Marktdaten (`refreshMarketInfo`)
- Keine strukturierten Artikel: das Modul liefert keine Artikelzeilen und keine Ersparnis

## Dateien

| Pfad | Inhalt |
|---|---|
| `api-dm.md` | Reverse-Engineering-Dokumentation von Login und eBon-API |
| `module/` | manifest.yaml, index.js, Logo |

## Entwickeln

- Das Modul-Format (Manifest, JS-Vertrag, Module-SDK) ist in `module-format.md` auf `dev`/`main` beschrieben.
- Die Version steht in `module/manifest.yaml`; bei jeder Änderung am Modul erhöhen.
- Gebaut wird mit `npm run build` im vollständigen Repo (`main`/`dev`).
- Die Händler-API ist inoffiziell und in [api-dm.md](api-dm.md) dokumentiert; sie kann sich jederzeit ändern.
