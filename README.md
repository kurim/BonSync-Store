# BonSync-Store · LIDL

Holt Kassenbons aus dem Lidl-Plus-Konto (REST-API der Lidl-Plus-App, OAuth 2.0 PKCE, Duende) und liest Artikel, Ersparnis und Belegmetadaten aus dem Beleg.

Dies ist der Branch `modul/lidl` des [BonSync-Store](https://github.com/kurim/BonSync-Store): Er enthält nur
die Quellen des LIDL-Moduls (aktuelle Version 1.1.0). Die übrigen Module, die Build-Pipeline und die
Dokumentation des Modul-Formats liegen im Branch `dev` bzw. `main`.

## Login

OAuth 2.0 mit PKCE; der Login läuft im Browser, der Code wird manuell in BonSync eingefügt (`oauth-pkce-manual`).

## Was das Modul liefert

- Belegliste und Beleg-PDF (aus dem HTML-Kassenbon der API gerendert)
- Artikel und Ersparnis aus dem HTML-Kassenbon
- Marktdaten aus den Filialdaten der API
- Belegmetadaten (`fetchReceiptMeta`): TSE, Zahlungsart, MwSt.-Aufschlüsselung, Beleg-Nr.

## Dateien

| Pfad | Inhalt |
|---|---|
| `api-lidlplus.md` | Referenz der Lidl-Plus-API (Login und Kassenbons) |
| `module/parser.ts` | Erkennung von Artikeln und Ersparnis |
| `module/htmlToLines.ts` | HTML-Kassenbon in Textzeilen |
| `module/receiptMeta.ts` | Erkennung der Belegmetadaten |
| `module/` | manifest.yaml, index.ts, Logo |

## Entwickeln

- Das Modul-Format (Manifest, JS-Vertrag, Module-SDK) ist in `module-format.md` auf `dev`/`main` beschrieben.
- Die Version steht in `module/manifest.yaml`; bei jeder Änderung am Modul erhöhen.
- Gebaut wird mit `npm run build` im vollständigen Repo (`main`/`dev`); esbuild bündelt `module/index.ts` samt
  `_shared/` zu einer eigenständigen `index.js` im Modul-Zip.
- Die Händler-API ist inoffiziell und in [api-lidlplus.md](api-lidlplus.md) dokumentiert; sie kann sich jederzeit ändern.
