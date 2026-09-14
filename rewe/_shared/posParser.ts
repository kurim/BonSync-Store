/** Geteilte PDF-Text-Erkennungslogik für Module mit identischem Kassensystem-Format (REST-
 * Bon-Zeilen "Name Betrag Steuercode" + Menge/Ersparnis-Varianten). Bewusst als eigene
 * Autoren-Quelldatei UNTER modules-src/ (nicht unter src/) -- esbuild bündelt sie beim Bauen
 * jedes einzelnen Moduls (siehe build.mjs) in dessen eigenständige index.js hinein, sodass jedes
 * Modul-Paket zur Laufzeit seine eigene, unabhängige Kopie mitbringt (kein geteilter Laufzeit-
 * Import zwischen installierten Modulen). Module mit einem abweichenden Bon-Format (z.B. LIDL,
 * siehe ../lidl/parser.ts) bringen ihre eigene, private Erkennungslogik mit statt diese Datei zu
 * importieren -- siehe docs/module-format.md. */

import type { ReceiptItem, ReceiptSavings } from '../../src/lib/server/modules/types';

function parseAmountToCents(raw: string): number {
	const normalized = raw.replace(/\./g, '').replace(',', '.');
	return Math.round(parseFloat(normalized) * 100);
}

// Manche PDFs betten unsichtbare Steuer-/Formatierungszeichen (Variation-Selectors,
// Zero-Width-Joiner/Space, BOM, Soft-Hyphen, Bidi-Marken) anstelle normaler Leerzeichen zwischen
// Wörtern ein -- live beobachtet. `\s+` matcht das nicht, wodurch Name/Preis/Steuercode nie an
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

function normalizeLine(rawLine: string): string {
	return rawLine
		.replace(INVISIBLE_CHARS, ' ')
		.replace(/€\s?/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

const PRICE = String.raw`-?\d{1,3}(?:\.\d{3})*,\d{2}`;
// Zeile endet auf einen Betrag + Steuercode, wobei das "*" (Rabatt-Ausschluss, z.B. Pfand)
// sowohl VOR als auch NACH dem Steuercode auftauchen kann, mit oder ohne Leerzeichen.
const ARTICLE_LINE = new RegExp(`^(.+?)\\s+(${PRICE})\\s*(\\*)?\\s*([A-Z])\\s*(\\*)?$`);
// "N Stk x Einzelpreis", OHNE folgenden Gesamtbetrag+Steuercode -- eigene Zeile.
const QTY_ONLY_LINE = new RegExp(`^(\\d+)\\s*Stk\\s*x\\s*(${PRICE})\\s*$`, 'i');
// Dieselbe Mengenangabe, aber als "Name"-Teil einer Artikelzeile, die zugleich den
// Gesamtbetrag trägt (Variante, bei der Menge+Gesamtpreis auf einer Zeile stehen).
const QTY_PREFIX = new RegExp(`^(\\d+)\\s*Stk\\s*x\\s*(${PRICE})$`, 'i');
// Variante mit Menge VOR der Artikelnummer ("2X ...") und Einzel- + Gesamtpreis auf derselben Zeile.
const QTY_PREFIX_LINE = new RegExp(`^(\\d+)X\\s+(.+?)\\s+(${PRICE})\\s+(${PRICE})\\s*(\\*)?\\s*([A-Z])\\s*(\\*)?$`, 'i');

/** Parst Artikelzeilen aus dem eBon-PDF-Text. */
export function parseReceiptItems(lines: string[]): ReceiptItem[] {
	const items: ReceiptItem[] = [];

	for (const rawLine of lines) {
		const line = normalizeLine(rawLine);
		if (!line) continue;

		if (
			/^SUMME\b/i.test(line) ||
			/^Geg\.\s/i.test(line) ||
			/^UID\s*Nr\.?:/i.test(line) ||
			/^Markt:/i.test(line) ||
			/EUR\s*gespart$/i.test(line) ||
			/Treuepunkt/i.test(line) ||
			/^\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}\s+Bon-Nr\.?:/i.test(line) ||
			/^[A-Z]=\s*\d/.test(line)
		) {
			continue;
		}

		const qtyPrefixLineMatch = line.match(QTY_PREFIX_LINE);
		if (qtyPrefixLineMatch) {
			items.push({
				name: qtyPrefixLineMatch[2].trim(),
				priceCents: parseAmountToCents(qtyPrefixLineMatch[4]),
				quantity: parseInt(qtyPrefixLineMatch[1], 10),
				unitPriceCents: parseAmountToCents(qtyPrefixLineMatch[3]),
				taxCode: qtyPrefixLineMatch[6],
				discountExcluded: Boolean(qtyPrefixLineMatch[5] || qtyPrefixLineMatch[7])
			});
			continue;
		}

		const articleMatch = line.match(ARTICLE_LINE);
		if (articleMatch) {
			const namePart = articleMatch[1].trim();
			const totalPriceCents = parseAmountToCents(articleMatch[2]);
			const taxCode = articleMatch[4];
			const discountExcluded = Boolean(articleMatch[3] || articleMatch[5]);

			const qtyPrefixMatch = namePart.match(QTY_PREFIX);
			const pending = items[items.length - 1];
			if (qtyPrefixMatch && pending && pending.priceCents === 0 && pending.quantity === undefined) {
				pending.quantity = parseInt(qtyPrefixMatch[1], 10);
				pending.unitPriceCents = parseAmountToCents(qtyPrefixMatch[2]);
				pending.priceCents = totalPriceCents;
				pending.taxCode = taxCode;
				pending.discountExcluded = discountExcluded;
			} else {
				items.push({ name: namePart, priceCents: totalPriceCents, taxCode, discountExcluded });
			}
			continue;
		}

		const qtyOnlyMatch = line.match(QTY_ONLY_LINE);
		if (qtyOnlyMatch) {
			const prev = items[items.length - 1];
			if (prev && prev.priceCents !== 0 && prev.quantity === undefined) {
				prev.quantity = parseInt(qtyOnlyMatch[1], 10);
				prev.unitPriceCents = parseAmountToCents(qtyOnlyMatch[2]);
			}
			continue;
		}

		if (line.length > 1) {
			items.push({ name: line, priceCents: 0 });
		}
	}

	return items.filter((i) => i.priceCents !== 0 || i.quantity !== undefined);
}

const ZIP_CITY_LINE = /^(\d{5})\s+(.+)$/;

/** Der Bon-Kopf (Pflichtangabe) steht bei REWE als die ersten drei Zeilen im PDF-Text. */
export function parseMarketHeader(lines: string[]): { name?: string; street?: string; zipCode?: string; city?: string } {
	if (lines.length < 3) return {};
	const name = normalizeLine(lines[0]);
	const street = normalizeLine(lines[1]);
	const zipCityMatch = normalizeLine(lines[2]).match(ZIP_CITY_LINE);
	if (!name || !street || !zipCityMatch) return {};
	return { name, street, zipCode: zipCityMatch[1], city: zipCityMatch[2] };
}

const MARKET_LINE = /^Markt:(\S+)/i;

/** "Markt:<id> Kasse:<id> Bed.:<id>" -- Fallback, wenn die API selbst kein market-Feld liefert. */
export function parseMarketNumber(lines: string[]): string | null {
	for (const rawLine of lines) {
		const line = rawLine.replace(/\s+/g, ' ').trim();
		const match = line.match(MARKET_LINE);
		if (match) return match[1];
	}
	return null;
}

const TOTAL_SAVINGS_LINE = new RegExp(`(${PRICE})\\s*(?:EUR)?\\s*gespart`, 'i');
const COUPON_LINE = new RegExp(`^(\\d{6,})\\s+(.+?)\\s+(${PRICE})$`);

/** Extrahiert die Coupon-/Rabatt-Ersparnis-Sektion aus dem eBon-Text. */
export function parseSavings(lines: string[]): ReceiptSavings {
	let totalSavingsCents: number | null = null;
	const coupons: { label: string; amountCents: number }[] = [];
	let inCouponSection = false;

	for (const rawLine of lines) {
		const line = normalizeLine(rawLine);
		if (!line) continue;

		if (/Coupon.?Ersparnis/i.test(line)) {
			inCouponSection = true;
			continue;
		}

		const totalMatch = line.match(TOTAL_SAVINGS_LINE);
		if (totalMatch) {
			totalSavingsCents = parseAmountToCents(totalMatch[1]);
			inCouponSection = false;
			continue;
		}

		if (inCouponSection) {
			const couponMatch = line.match(COUPON_LINE);
			if (couponMatch) {
				coupons.push({ label: couponMatch[2].trim(), amountCents: parseAmountToCents(couponMatch[3]) });
			}
		}
	}

	return { totalSavingsCents, coupons };
}
