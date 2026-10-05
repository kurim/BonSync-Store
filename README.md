# BonSync-Store · PENNY

Holt eBons aus dem PENNY-Konto (REST-API der PENNY-eBon-App, OAuth 2.0 PKCE über Keycloak) und liest Artikel, Ersparnis und Belegmetadaten aus dem Beleg-PDF.

Dies ist der Branch `modul/penny` des [BonSync-Store](https://github.com/kurim/BonSync-Store): Er enthält nur
die Quellen des PENNY-Moduls (aktuelle Version 1.4.0). Die übrigen Module, die Build-Pipeline und die
Dokumentation des Modul-Formats liegen im Branch `dev` bzw. `main`.

## Login

OAuth 2.0 mit PKCE; der Redirect ist eine normale https-URL (`oauth-pkce-redirect`).

## Was das Modul liefert

- Belegliste und Beleg-PDF
- Artikel und Ersparnis (Coupons) aus dem PDF
- Marktdaten über die Marktnummer auf dem Beleg
- Wochenangebote (`searchMarkets` / `fetchOffers`) über die öffentliche Website-API von penny.de, ohne Login und bundesweit (nicht marktspezifisch)
- Belegmetadaten (`fetchReceiptMeta`): TSE, Zahlungsart, MwSt.-Aufschlüsselung, Treuepunkte-Zeile, zusätzliche Vorteile am Bon-Ende

## Dateien

| Pfad | Inhalt |
|---|---|
| `_shared/posParser.ts` | Erkennung von Artikeln, Ersparnis und Marktnummer |
| `_shared/receiptMeta.ts` | Erkennung der Belegmetadaten |
| `api-penny.md` | Reverse-Engineering-Dokumentation der PENNY-eBon-API |
| `module/` | manifest.yaml, index.ts, Logo |

## Entwickeln

- Das Modul-Format (Manifest, JS-Vertrag, Module-SDK) ist in `module-format.md` auf `dev`/`main` beschrieben.
- Die Version steht in `module/manifest.yaml`; bei jeder Änderung am Modul erhöhen.
- Gebaut wird mit `npm run build` im vollständigen Repo (`main`/`dev`); esbuild bündelt `module/index.ts` samt
  `_shared/` zu einer eigenständigen `index.js` im Modul-Zip.
- Die Händler-API ist inoffiziell und in [api-penny.md](api-penny.md) dokumentiert; sie kann sich jederzeit ändern.
