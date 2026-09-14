// Typ-Importe zeigen bewusst ins Haupt-Repo (Cross-Verzeichnis-Pfad, da dieses Paket außerhalb
// von BonSync/modules-src/ authored wird) -- einzige Quelle für den StoreModule-Vertrag, siehe
// docs/module-format.md. Rein Typ-Importe, esbuild eliminiert sie beim Bundling vollständig.
import type { ModuleSdk } from '../../../BonSync/src/lib/server/modules/sdk';
import type { ReceiptItem, ReceiptSavings, ReceiptSummary, StoreModule, StoredCredentials } from '../../../BonSync/src/lib/server/modules/types';

// --- Konstanten aus docs/api-obi.md (per baksmali aus de.obi.app.apk 26.9.2 reversed) ---
const WEB_HOST = 'https://www.obi.de';
const API_BASE = 'https://api.live.app.obi.de/v1/';
const X_API_KEY = 'Rh57q3vtOPYTf6FtArVN1boy2AyEiIqaGEmnMks7'; // statischer Client-Key, in der App fest einprogrammiert
const USER_AGENT = 'heyOBI APP / Android Phone 30 / 26.9.2 / 1';
const LOCALE = 'de-DE';
const PURCHASES_CACHE_TTL_MS = 5 * 60 * 1000;

interface ObiCredentials extends StoredCredentials {
	token: string;
}

interface LoginResponse {
	token?: string;
}

interface ObiArticle {
	id: string;
	image?: string;
	title: string;
	count: string;
	unitPrice: string;
	totalPrice: string;
	isReturn: boolean;
	target?: string;
}

interface ObiSubtotalItem {
	title: string;
	price: string;
}

interface ObiArticleGroup {
	title: string;
	articles: ObiArticle[];
	subtotalLists: ObiSubtotalItem[][];
	isReturnGroup: boolean;
}

interface ObiReceiptLink {
	url: string;
	title?: string;
}

interface ObiReceipt {
	isReturn: boolean;
	link?: ObiReceiptLink;
	documentTitle?: string;
}

interface ObiPurchase {
	id: string;
	visibleInOverview: boolean;
	totalPrice: string;
	purchaseDate: { date: string };
	storeName?: string;
	receipts: ObiReceipt[];
	details?: {
		receiptId?: string;
		articleGroup?: ObiArticleGroup;
	};
}

interface ObiPurchaseGroup {
	title: string;
	purchases: ObiPurchase[];
}

interface ObiPurchasesResponse {
	purchaseGroups: ObiPurchaseGroup[];
}

function describeError(status: number, json: unknown): string {
	const body = typeof json === 'object' && json !== null ? JSON.stringify(json) : String(json);
	return `Status ${status}: ${body.slice(0, 500)}`;
}

function baseHeaders(): Record<string, string> {
	return {
		'x-app-type': 'b2c',
		'x-obi-client': 'heyObiApp',
		'x-obi-locale': LOCALE,
		'x-api-key': X_API_KEY,
		'User-Agent': USER_AGENT,
		'Cache-Control': 'no-cache'
	};
}

function authHeaders(creds: ObiCredentials, extra?: Record<string, string>): Record<string, string> {
	return { ...baseHeaders(), Authorization: `Bearer ${creds.token}`, ...extra };
}

/** Wandelt Preisstrings im Format "25,38 €" / "-0,25 €" in Cent (Integer) um. Komma ist das
 * deutsche Dezimaltrennzeichen; alles außer Ziffern/Komma/Minus (€-Zeichen, NBSP, Leerzeichen)
 * wird verworfen, bevor das Komma zu einem Punkt wird. */
function parseEuroCents(value: string): number {
	const normalized = value.replace(/[^0-9,-]/g, '').replace(',', '.');
	return Math.round(parseFloat(normalized) * 100);
}

function purchaseToMarket(purchase: ObiPurchase): ReceiptSummary['market'] {
	// Die "purchases"-Liste liefert nur einen Marktnamen (z.B. "Markt Hilden"), keine Adresse --
	// die fehlt hier initial. Straße/PLZ/Ort kommen erst nachträglich über refreshMarketInfo()
	// aus dem PDF-Text (die Liste-API hat sie schlicht nicht, anders als REWE/PENNY/ROSSMANN).
	return purchase.storeName ? { name: purchase.storeName } : null;
}

// Adressblock steht am Kopf jedes Kassenbons, fest zwischen "Filiale <Ort>" und "Tel.: ...":
//   Obi GmbH & Co. Deutschland KG
//   Filiale Hilden
//   Westring 5
//   40721 Hilden
//   Tel.: 02103 / 908870
// (live an einem echten PDF verifiziert, siehe docs/api-obi.md). Die Rechtsform-Zeile davor
// ("Obi GmbH & Co. Deutschland KG") wird ignoriert -- das ist der Rechtsträger, nicht der Markt.
const FILIALE_LINE = /^Filiale\s+.+$/i;
const ZIP_CITY_LINE = /^(\d{5})\s+(.+)$/;

function parseAddressFromPdfLines(lines: string[]): { street: string; zipCode: string; city: string } | null {
	const filialeIndex = lines.findIndex((line) => FILIALE_LINE.test(line.trim()));
	if (filialeIndex === -1) return null;

	const street = lines[filialeIndex + 1]?.trim();
	const zipCityMatch = lines[filialeIndex + 2]?.trim().match(ZIP_CITY_LINE);
	if (!street || !zipCityMatch) return null;

	return { street, zipCode: zipCityMatch[1], city: zipCityMatch[2] };
}

function flattenPurchases(response: ObiPurchasesResponse): ObiPurchase[] {
	return response.purchaseGroups.flatMap((group) => group.purchases);
}

export default function createObiModule(sdk: ModuleSdk): StoreModule {
	async function loginWithCredentials(fields: Record<string, string>): Promise<StoredCredentials> {
		const { email, password } = fields;
		if (!email || !password) throw new Error('E-Mail und Passwort werden benötigt.');

		const { status, json } = await sdk.http.requestJson<LoginResponse>(`${WEB_HOST}/regi/auth/api/public/login`, {
			method: 'POST',
			headers: { ...baseHeaders(), 'Content-Type': 'application/json', Accept: 'application/json' },
			body: JSON.stringify({ email, password, country: 'DE' })
		});
		if (status !== 200 || !json.token) {
			throw new Error(`OBI-Login fehlgeschlagen — ${describeError(status, json)}`);
		}

		const creds: ObiCredentials = { token: json.token };
		return creds;
	}

	/** Kein dokumentiertes Refresh-Token gefunden (siehe docs/api-obi.md, offene Fragen) — das
	 * Login-JWT wird unverändert weitergereicht. Schlägt ein Request mit 401 fehl, hilft nur ein
	 * erneuter Login über die UI, wie bei ROSSMANN. */
	async function ensureFreshCredentials(creds: StoredCredentials): Promise<StoredCredentials> {
		return creds;
	}

	// Die "purchases"-API liefert die komplette Liste inkl. Artikeldetails in einem einzigen
	// Call (keine Pagination gefunden) -- ein kurzlebiger Cache reicht, um fetchReceipts +
	// fetchReceiptPdf/-Items/-Savings, die alle kurz hintereinander pro Sync laufen, nicht
	// mehrfach denselben Request auslösen zu lassen.
	const purchasesCache = new Map<string, { byId: Map<string, ObiPurchase>; fetchedAt: number }>();

	async function fetchPurchases(creds: ObiCredentials): Promise<Map<string, ObiPurchase>> {
		const { status, json } = await sdk.http.requestJson<ObiPurchasesResponse>(`${API_BASE}bffs/receipts/purchases`, {
			method: 'GET',
			headers: authHeaders(creds, {
				Accept: 'application/vnd.obi.bff.receipts.purchases.v1+json',
				'Short-Lived-Token-Required': '30_DAYS'
			})
		});
		if (status !== 200) throw new Error(`OBI bffs/receipts/purchases fehlgeschlagen — ${describeError(status, json)}`);

		const byId = new Map(flattenPurchases(json).map((p) => [p.id, p]));
		purchasesCache.set(creds.token, { byId, fetchedAt: Date.now() });
		return byId;
	}

	async function getCachedPurchases(creds: ObiCredentials): Promise<Map<string, ObiPurchase>> {
		const cached = purchasesCache.get(creds.token);
		if (cached && Date.now() - cached.fetchedAt < PURCHASES_CACHE_TTL_MS) return cached.byId;
		return fetchPurchases(creds);
	}

	async function fetchReceipts(creds: StoredCredentials, knownIds: Set<string>): Promise<ReceiptSummary[]> {
		const c = creds as ObiCredentials;
		const byId = await fetchPurchases(c); // beim Sync immer frisch holen, nicht aus dem Cache

		const results: ReceiptSummary[] = [];
		for (const purchase of byId.values()) {
			if (knownIds.has(purchase.id)) continue;
			results.push({
				storeId: 'obi',
				externalId: purchase.id,
				timestamp: Date.parse(purchase.purchaseDate.date),
				totalCents: parseEuroCents(purchase.totalPrice),
				market: purchaseToMarket(purchase),
				cancelled: false,
				hasStructuredItems: true
			});
		}
		return results;
	}

	async function fetchReceiptPdf(creds: StoredCredentials, externalId: string): Promise<Buffer | null> {
		const c = creds as ObiCredentials;
		const byId = await getCachedPurchases(c);
		const url = byId.get(externalId)?.receipts?.[0]?.link?.url;
		// Ältere Einkäufe liefern ein leeres `receipts[]` -- kein Kassenbon-PDF verfügbar (nicht
		// vom Server nachträglich abrufbar, kein Fehler).
		if (!url) return null;

		const res = await sdk.http.rawRequest(url, { headers: authHeaders(c, { Accept: 'application/pdf' }) });
		if (res.status !== 200) return null;
		return res.body;
	}

	async function fetchReceiptItems(creds: StoredCredentials, externalId: string): Promise<ReceiptItem[]> {
		const c = creds as ObiCredentials;
		const byId = await getCachedPurchases(c);
		const articles = byId.get(externalId)?.details?.articleGroup?.articles ?? [];

		return articles.map((article) => ({
			name: article.title,
			priceCents: parseEuroCents(article.totalPrice),
			quantity: Number(article.count) || undefined,
			unitPriceCents: parseEuroCents(article.unitPrice)
		}));
	}

	async function fetchReceiptSavings(creds: StoredCredentials, externalId: string): Promise<ReceiptSavings | null> {
		const c = creds as ObiCredentials;
		const byId = await getCachedPurchases(c);
		const subtotalLists = byId.get(externalId)?.details?.articleGroup?.subtotalLists ?? [];

		// "Zwischensumme:" ist der volle Positionswert vor Abzug, negative Folgezeilen (beobachtet:
		// "heyOBI Vorteil:") sind die eigentlichen Ersparnisse -- alles andere (0 oder positiv)
		// ignorieren wir hier bewusst, weil wir keine weiteren Beispiele für andere Zeilentitel haben.
		const coupons: ReceiptSavings['coupons'] = [];
		for (const list of subtotalLists) {
			for (const item of list) {
				const cents = parseEuroCents(item.price);
				if (cents < 0) coupons.push({ label: item.title, amountCents: -cents });
			}
		}
		if (coupons.length === 0) return null;
		return { totalSavingsCents: coupons.reduce((sum, c) => sum + c.amountCents, 0), coupons };
	}

	async function refreshMarketInfo(creds: StoredCredentials, externalId: string, pdf?: Buffer): Promise<ReceiptSummary['market']> {
		if (!pdf) return null;
		const address = parseAddressFromPdfLines(await sdk.pdf.extractLines(pdf));
		if (!address) return null;

		// Name kommt weiterhin aus der Liste-API (dort schon vorhanden, s.o.) statt aus dem PDF,
		// damit er identisch zu dem bleibt, was fetchReceipts beim Erstsync gesetzt hat.
		const c = creds as ObiCredentials;
		const byId = await getCachedPurchases(c);
		const name = byId.get(externalId)?.storeName;

		return { name, ...address };
	}

	return {
		loginWithCredentials,
		ensureFreshCredentials,
		fetchReceipts,
		fetchReceiptPdf,
		fetchReceiptItems,
		fetchReceiptSavings,
		refreshMarketInfo
	};
}
