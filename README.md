# BonSync-Store · ROSSMANN

Holt Kassenbons aus dem ROSSMANN-Konto (Account-API und anybill-Belegdienst, E-Mail/Passwort, Zwei-Stufen-Token) und liest Artikel, Ersparnis und Belegmetadaten.

Dies ist der Branch `modul/rossmann` des [BonSync-Store](https://github.com/kurim/BonSync-Store): Er enthält nur
die Quellen des ROSSMANN-Moduls (aktuelle Version 1.1.0). Die übrigen Module, die Build-Pipeline und die
Dokumentation des Modul-Formats liegen im Branch `dev` bzw. `main`.

## Login

E-Mail und Passwort (`credentials`). Die Account-Hash bleibt bis zum Widerruf gültig, ein Token-Refresh ist nicht nötig; für die Belege wird ein anybill-Token geholt.

## Was das Modul liefert

- Belegliste (die neuesten 100 Belege) und Beleg-PDF
- Artikel strukturiert aus der anybill-API, Steuercode je Position aus dem PDF
- Ersparnis (Coupons) aus dem PDF
- Marktdaten aus den Verkäuferdaten des Belegs
- Belegmetadaten (`fetchReceiptMeta`): USt-ID, Zahlungsart, MwSt.-Aufschlüsselung, TSE, Beleg-Nr.

## Dateien

| Pfad | Inhalt |
|---|---|
| `_shared/posParser.ts` | Erkennung von Artikeln und Ersparnis im PDF |
| `_shared/receiptMeta.ts` | Erkennung der Belegmetadaten |
| `api-rossmann.md` | Reverse-Engineering-Dokumentation von Login und Kassenbon-API |
| `module/` | manifest.yaml, index.ts, Logo |

## Entwickeln

- Das Modul-Format (Manifest, JS-Vertrag, Module-SDK) ist in `module-format.md` auf `dev`/`main` beschrieben.
- Die Version steht in `module/manifest.yaml`; bei jeder Änderung am Modul erhöhen.
- Gebaut wird mit `npm run build` im vollständigen Repo (`main`/`dev`); esbuild bündelt `module/index.ts` samt
  `_shared/` zu einer eigenständigen `index.js` im Modul-Zip.
- Die Händler-API ist inoffiziell und in [api-rossmann.md](api-rossmann.md) dokumentiert; sie kann sich jederzeit ändern.
