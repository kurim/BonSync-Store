/** Belegmetadaten-Erkennung (TSE, Zahlungsart, MwSt.-Aufschlüsselung, Markt/Kasse/Bon-Nr.,
 * Bonus-Stand) für das Kassenbon-PDF-Format dieses Moduls. Bewusst als eigene Datei im Modul-Ordner
 * (wie posParser.ts): esbuild bündelt sie in die index.js, das Modul-Paket ist eigenständig und
 * hängt von keinem anderen Modul ab. */

import type { ReceiptMeta } from '../../src/lib/server/modules/types';

/** Deutsches Betragsformat ("1.234,56") -> Cent-Integer. */
function parseAmountToCents(raw: string): number {
	const normalized = raw.replace(/\./g, '').replace(',', '.');
	return Math.round(parseFloat(normalized) * 100);
}

// Manche PDFs betten unsichtbare Steuer-/Formatierungszeichen (Variation-Selectors,
// Zero-Width-Joiner/Space, BOM, Soft-Hyphen, Bidi-Marken) anstelle normaler Leerzeichen
// zwischen Wörtern ein — live beobachtet (Kopie aus einem echten Bon zeigte sie sichtbar
// als Steuerzeichen-Glyphen). `\s+` matcht das nicht, wodurch Name/Preis/Steuercode nie an
// der erwarteten Stelle getrennt werden. Deshalb zuerst durch echte Leerzeichen ersetzen.
const INVISIBLE_CODEPOINTS = [
	0x00ad, // SOFT HYPHEN
	...range(0x200b, 0x200f), // ZERO WIDTH SPACE/JOINER/NON-JOINER, LTR/RTL MARK
	...range(0x202a, 0x202e), // Bidi-Einbettung (LRE/RLE/PDF/LRO/RLO)
	0x2060, // WORD JOINER
	...range(0x2066, 0x2069), // Bidi-Isolate (LRI/RLI/FSI/PDI)
	...range(0xfe00, 0xfe0f), // VARIATION SELECTOR-1..16
	0xfeff // ZERO WIDTH NO-BREAK SPACE / BOM
];
function range(from: number, to: number): number[] {
	const out: number[] = [];
	for (let i = from; i <= to; i++) out.push(i);
	return out;
}
const INVISIBLE_CHARS = new RegExp(`[${INVISIBLE_CODEPOINTS.map((c) => `\\u${c.toString(16).padStart(4, '0')}`).join('')}]`, 'g');

/** Normalisiert eine extrahierte PDF-Zeile: unsichtbare Trennzeichen -> Leerzeichen,
 * "€" am Betrag entfernen, Whitespace kollabieren. */
function normalizeLine(rawLine: string): string {
	return rawLine
		.replace(INVISIBLE_CHARS, ' ')
		.replace(/€\s?/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

const PRICE = String.raw`-?\d{1,3}(?:\.\d{3})*,\d{2}`;

// Zusätzliche Belegmetadaten — Format unterscheidet sich je nach Kassensystem, daher pro Feld
// zwei Varianten (REWE/PENNY vs. ROSSMANN/anybill). Live an echten Belegen verifiziert:
// REWE: "UID Nr.: DE307900053 EUR", "Geg. VISA EUR 15,54", "B= 7,0% 14,52 1,02 15,54",
//   "TSE-Signaturzähler: 758669", "TSE-Transaktion: 371041", "TSE-Start/-Stop: <ISO>",
//   "Markt:1017 Kasse:2 Bed.:272727", "... Bon-Nr.:309", "Aktuelles Bonus-Guthaben: 7,18 EUR".
// PENNY: identisches Format zu REWE (gleiches POS-System) plus "Sie erhalten 5 Treuepunkt(e)".
// ROSSMANN: "UmSt-ID. DE 115 055 186", "Bezahlung VISA" + "Betrag 35,68 EUR", "A 19%: 29,98
//   5,70 35,68" (Steuerzeile ohne "="/Komma-Prozent), "Signaturzähler:"/"Start:"/"Ende:" ohne
//   "TSE-"-Präfix, "TA-Nr. 151907 Beleg-Nr. 9506".
//
// Diese Extraktion bleibt zentral in der App (nicht Teil eines Modul-Pakets), weil sie
// store-übergreifend generisch ist -- sync.ts wendet sie einheitlich auf jedes PDF an, egal
// welches Modul es geliefert hat (siehe sync.ts#fetchAndStorePdfAndItems).
const UST_ID_REWE = /^UID\s*Nr\.?:\s*(DE\d+)/i;
const UST_ID_ROSSMANN = /^UmSt-ID\.?\s*((?:DE|AT|CH)(?:\s*\d+)+)/i;
const PAYMENT_INLINE = new RegExp(`^Geg\\.\\s+(.+?)\\s+EUR\\s+(${PRICE})$`, 'i');
const PAYMENT_LABEL_LINE = /^Bezahlung\s+(.+)$/i;
const PAYMENT_AMOUNT_LINE = new RegExp(`^Betrag\\s+(${PRICE})\\s*EUR$`, 'i');
const TAX_BREAKDOWN_EQUALS = new RegExp(`^([A-Z])=\\s*(\\d{1,2}(?:,\\d)?)\\s*%\\s+(${PRICE})\\s+(${PRICE})\\s+(${PRICE})$`);
const TAX_BREAKDOWN_COLON = new RegExp(`^([A-Z])\\s+(\\d{1,2})%:\\s+(${PRICE})\\s+(${PRICE})\\s+(${PRICE})$`);
const TSE_SIGNATURZAEHLER = /^(?:TSE-)?Signaturz[aä]hler:\s*(\d+)/i;
const TSE_TRANSAKTION = /^TSE-Transaktion:\s*(\d+)/i;
const TSE_START = /^(?:TSE-Start|Start):\s*(\S+)/i;
const TSE_STOP = /^(?:TSE-Stop|Ende):\s*(\S+)/i;
const TA_BELEG_NR = /^TA-Nr\.\s*(\d+)\s+Beleg-Nr\.\s*(\d+)/i;
const MARKT_KASSE_BED = /^Markt:(\S+)\s+Kasse:(\S+)\s+Bed\.?:(\S+)/i;
const BON_NR = /Bon-Nr\.?:(\d+)/i;
const LOYALTY_BALANCE = new RegExp(`Aktuelles\\s+Bonus-Guthaben:\\s*${PRICE}\\s*EUR`, 'i');
// PENNY schreibt je nach Bon-Version "Sie erhalten 5 Treuepunkt(e)" oder "Du erhältst 3 Treuepunkt(e)".
const LOYALTY_POINTS = /(?:Sie\s+erhalten|Du\s+erh[aä]ltst)\s+\d+\s+Treuepunkt/i;
// Block am Bon-Ende ("Deine zusätzlichen Vorteile heute:" -> Zeilen "Label 0,40" -> "Summe 0,40"),
// z. B. "Sonstige Vorteile 0,40". Getrennt vom Treuepunkt-Hinweis, weil es Vorteile in Euro sind.
const BENEFITS_HEADER = /^Deine\s+zus[aä]tzlichen\s+Vorteile\b/i;
const BENEFITS_ROW = new RegExp(`^(.+?)\\s+(${PRICE})$`);
const BENEFITS_TOTAL = /^Summe$/i;
const SEPARATOR_LINE = /^[-=_\s]+$/;

export function parseReceiptMeta(lines: string[]): ReceiptMeta | null {
	const meta: ReceiptMeta = { taxBreakdown: [] };
	let pendingPaymentLabel: string | undefined;
	let inBenefits = false;
	const benefits: { label: string; amountCents: number }[] = [];
	let benefitsTotalCents: number | undefined;

	for (const rawLine of lines) {
		const line = normalizeLine(rawLine);
		if (!line) continue;

		if (BENEFITS_HEADER.test(line)) {
			inBenefits = true;
			continue;
		}
		if (inBenefits) {
			if (SEPARATOR_LINE.test(line)) continue;
			const row = line.match(BENEFITS_ROW);
			if (row) {
				const amountCents = parseAmountToCents(row[2]);
				if (BENEFITS_TOTAL.test(row[1].trim())) {
					benefitsTotalCents = amountCents;
					inBenefits = false;
				} else {
					benefits.push({ label: row[1].trim(), amountCents });
				}
				continue;
			}
			inBenefits = false; // Block endet (z. B. "Danke für deinen Einkauf")
		}

		const ustRewe = line.match(UST_ID_REWE);
		if (ustRewe) {
			meta.ustId = ustRewe[1];
			continue;
		}
		const ustRossmann = line.match(UST_ID_ROSSMANN);
		if (ustRossmann) {
			meta.ustId = ustRossmann[1].replace(/\s+/g, '');
			continue;
		}

		const paymentInline = line.match(PAYMENT_INLINE);
		if (paymentInline) {
			meta.paymentMethod = paymentInline[1].trim();
			meta.paymentAmountCents = parseAmountToCents(paymentInline[2]);
			continue;
		}
		const paymentLabel = line.match(PAYMENT_LABEL_LINE);
		if (paymentLabel) {
			pendingPaymentLabel = paymentLabel[1].trim();
			continue;
		}
		const paymentAmount = line.match(PAYMENT_AMOUNT_LINE);
		if (paymentAmount && pendingPaymentLabel) {
			meta.paymentMethod = pendingPaymentLabel;
			meta.paymentAmountCents = parseAmountToCents(paymentAmount[1]);
			pendingPaymentLabel = undefined;
			continue;
		}

		const taxEquals = line.match(TAX_BREAKDOWN_EQUALS);
		if (taxEquals) {
			meta.taxBreakdown.push({
				code: taxEquals[1],
				percent: parseFloat(taxEquals[2].replace(',', '.')),
				netCents: parseAmountToCents(taxEquals[3]),
				taxCents: parseAmountToCents(taxEquals[4]),
				grossCents: parseAmountToCents(taxEquals[5])
			});
			continue;
		}
		const taxColon = line.match(TAX_BREAKDOWN_COLON);
		if (taxColon) {
			meta.taxBreakdown.push({
				code: taxColon[1],
				percent: parseFloat(taxColon[2]),
				netCents: parseAmountToCents(taxColon[3]),
				taxCents: parseAmountToCents(taxColon[4]),
				grossCents: parseAmountToCents(taxColon[5])
			});
			continue;
		}

		const sigMatch = line.match(TSE_SIGNATURZAEHLER);
		if (sigMatch) {
			meta.tseSignaturzaehler = sigMatch[1];
			continue;
		}
		const transMatch = line.match(TSE_TRANSAKTION);
		if (transMatch) {
			meta.tseTransaktion = transMatch[1];
			continue;
		}
		const startMatch = line.match(TSE_START);
		if (startMatch) {
			meta.tseStart = startMatch[1];
			continue;
		}
		const stopMatch = line.match(TSE_STOP);
		if (stopMatch) {
			meta.tseStop = stopMatch[1];
			continue;
		}
		const taBeleg = line.match(TA_BELEG_NR);
		if (taBeleg) {
			meta.tseTransaktion ??= taBeleg[1];
			meta.bonNr ??= taBeleg[2];
			continue;
		}

		const marktKasseBed = line.match(MARKT_KASSE_BED);
		if (marktKasseBed) {
			meta.marktNr = marktKasseBed[1];
			meta.kasse = marktKasseBed[2];
			meta.bediener = marktKasseBed[3];
			continue;
		}
		const bonNr = line.match(BON_NR);
		if (bonNr) {
			meta.bonNr ??= bonNr[1];
			continue;
		}

		if (LOYALTY_BALANCE.test(line) || LOYALTY_POINTS.test(line)) {
			meta.loyaltyNote = line;
			continue;
		}
	}

	if (benefits.length > 0) {
		meta.extraBenefits = benefits;
		meta.extraBenefitsCents = benefitsTotalCents ?? benefits.reduce((sum, b) => sum + b.amountCents, 0);
	}

	return hasReceiptMeta(meta) ? meta : null;
}

function hasReceiptMeta(meta: ReceiptMeta): boolean {
	return Boolean(
		meta.ustId ||
			meta.paymentMethod ||
			meta.marktNr ||
			meta.kasse ||
			meta.bediener ||
			meta.bonNr ||
			meta.taxBreakdown.length > 0 ||
			meta.tseSignaturzaehler ||
			meta.loyaltyNote ||
			meta.loyaltyEarnedCents != null ||
			meta.extraBenefitsCents != null
	);
}
