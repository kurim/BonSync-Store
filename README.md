# BonSync-Store · REWE

Holt eBons aus dem REWE-Kundenkonto (REST-API der REWE-App, mTLS, OAuth 2.0 PKCE) und liest Artikel, Ersparnis, Belegmetadaten und den pro Einkauf gesammelten Bonus aus dem Beleg-PDF.

Dies ist der Branch `modul/rewe` des [BonSync-Store](https://github.com/kurim/BonSync-Store): Er enthält nur
die Quellen des REWE-Moduls (aktuelle Version 1.1.0). Die übrigen Module, die Build-Pipeline und die
Dokumentation des Modul-Formats liegen im Branch `dev` bzw. `main`.

## Login

OAuth 2.0 mit PKCE; der Login läuft im Browser, der Code wird manuell in BonSync eingefügt (`oauth-pkce-manual`). Der API-Zugriff nutzt ein mTLS-Clientzertifikat (`module/client.pem`, `module/client.key`).

## Was das Modul liefert

- Belegliste und Beleg-PDF
- Artikel und Ersparnis (Coupons) aus dem PDF
- Marktdaten aus dem PDF-Kopf
- Belegmetadaten (`fetchReceiptMeta`): TSE, Zahlungsart, MwSt.-Aufschlüsselung, aktueller Bonus-Stand
- Pro Einkauf gesammelter REWE Bonus („Mit diesem Einkauf hast du … gesammelt“) samt Aufschlüsselung in Bonus-Aktion(en) und Bonus-Coupon(s)

## Dateien

| Pfad | Inhalt |
|---|---|
| `_shared/posParser.ts` | Erkennung von Artikeln, Ersparnis, Marktkopf und gesammeltem Bonus |
| `_shared/receiptMeta.ts` | Erkennung der Belegmetadaten |
| `api-rewe.md` | Reverse-Engineering-Dokumentation der REWE-API |
| `module/` | manifest.yaml, index.ts, Logo, mTLS-Zertifikat |

## Entwickeln

- Das Modul-Format (Manifest, JS-Vertrag, Module-SDK) ist in `module-format.md` auf `dev`/`main` beschrieben.
- Die Version steht in `module/manifest.yaml`; bei jeder Änderung am Modul erhöhen.
- Gebaut wird mit `npm run build` im vollständigen Repo (`main`/`dev`); esbuild bündelt `module/index.ts` samt
  `_shared/` zu einer eigenständigen `index.js` im Modul-Zip.
- Die Händler-API ist inoffiziell und in [api-rewe.md](api-rewe.md) dokumentiert; sie kann sich jederzeit ändern.
