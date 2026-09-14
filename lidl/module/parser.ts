/** LIDL-eigene Artikel-/Ersparnis-Erkennung -- bewusst NICHT geteilt mit den anderen Modulen
 * (siehe ../_shared/posParser.ts für die generische Variante ohne LIDL-Format), damit das
 * gebaute LIDL-Paket seine Erkennungslogik exklusiv selbst mitbringt und umgekehrt kein anderes
 * Modul (REWE/PENNY/ROSSMANN) das LIDL-spezifische Format in seinem eigenen Bundle trägt. */

import type { ReceiptItem, ReceiptSavings } from '../../src/lib/server/modules/types';

function parseAmountToCents(raw: string): number {
	const normalized = raw.replace(/\./g, '').replace(',', '.');
	return Math.round(parseFloat(normalized) * 100);
}

// Manche Belege betten unsichtbare Formatierungszeichen (Variation-Selectors, Zero-Width-
// Joiner/Space, BOM, Soft-Hyphen, Bidi-Marken) anstelle normaler Leerzeichen zwischen Wörtern
// ein -- `\s+` matcht das nicht. Deshalb zuerst durch echte Leerzeichen ersetzen.
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
const ARTICLE_LINE = new RegExp(`^(.+?)\\s+(${PRICE})\\s*(\\*)?\\s*([A-Z])\\s*(\\*)?$`);
const QTY_ONLY_LINE = new RegExp(`^(\\d+)\\s*Stk\\s*x\\s*(${PRICE})\\s*$`, 'i');
const QTY_PREFIX = new RegExp(`^(\\d+)\\s*Stk\\s*x\\s*(${PRICE})$`, 'i');
const QTY_PREFIX_LINE = new RegExp(`^(\\d+)X\\s+(.+?)\\s+(${PRICE})\\s+(${PRICE})\\s*(\\*)?\\s*([A-Z])\\s*(\\*)?$`, 'i');
// LIDL-Format: "Name Einzelpreis x Menge Gesamtpreis Steuercode", z.B.
// "Pepsi Cola Zero 1,49 x 24 35,76 B" -- einzig hier relevant, siehe Kommentar oben.
const LIDL_ARTICLE_LINE = new RegExp(`^(.+?)\\s+(${PRICE})\\s*x\\s*(\\d+)\\s+(${PRICE})\\s*(\\*)?\\s*([A-Z])\\s*(\\*)?$`, 'i');

/** Parst Artikelzeilen aus dem LIDL-eBon-Text (aus HTML in Textzeilen gewandelt). */
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

		const lidlMatch = line.match(LIDL_ARTICLE_LINE);
		if (lidlMatch) {
			items.push({
				name: lidlMatch[1].trim(),
				priceCents: parseAmountToCents(lidlMatch[4]),
				quantity: parseInt(lidlMatch[3], 10),
				unitPriceCents: parseAmountToCents(lidlMatch[2]),
				taxCode: lidlMatch[6],
				discountExcluded: Boolean(lidlMatch[5] || lidlMatch[7])
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
