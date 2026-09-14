import { randomUUID } from 'node:crypto';
import { parseReceiptItems, parseSavings } from '../_shared/posParser';
import type { ModuleSdk } from '../../src/lib/server/modules/sdk';
import type { ReceiptItem, ReceiptSavings, ReceiptSummary, StoreModule, StoredCredentials } from '../../src/lib/server/modules/types';

// --- Konstanten aus docs/api-rossmann.md ---
const ACCOUNT_API = 'https://rsmappapi.rossmann.net/account.ws';
const ANYBILL_API = 'https://app.anybill.de/api/v4';
const API_KEY = 'rqYCy0y0BH5+8ZU5';
const APP_VERSION = '5.11.1';
const BUILD_NUMBER = '421000110';

// "pro Gerät stabil" laut Doku — als Server zählt für uns nur "stabil über Requests hinweg",
// ein fester Wert erfüllt das genauso wie ein echtes Geräte-Kennzeichen.
const ANDROID_ID = 'a1b2c3d4e5f6a7b8';
const REUSE_IDENTIFIER = 'b8a7f6e5d4c3b2a1';
const RECEIPT_LIST_CACHE_TTL_MS = 5 * 60 * 1000;

interface RossmannCredentials extends StoredCredentials {
	accountId: number;
	accountHash: string;
}

interface LoginResponse {
	accountId: number;
	accountHash: string;
	cashpointHash?: string;
	status: number;
}

interface AnybillAuthResponse {
	accessToken: string;
	refreshToken: string;
	expiresIn: number;
}

interface AnybillReceipt {
	id: string;
	head: { date: string; seller?: { name?: string; address?: { street?: string; city?: string } } };
	data: {
		fullAmountInclVat: number;
		lines?: Array<{ text: string; fullAmountInclVat: number; item?: { number?: string; quantity?: number; pricePerUnit?: number } }>;
	};
}

function describeError(status: number, json: unknown): string {
	const body = typeof json === 'object' && json !== null ? JSON.stringify(json) : String(json);
	return `Status ${status}: ${body.slice(0, 500)}`;
}

function accountHeaders(extra?: Record<string, string>): Record<string, string> {
	return {
		'x-api-key': API_KEY,
		'x-correlation-id': randomUUID(),
		'App-Version': APP_VERSION,
		'Build-Number': BUILD_NUMBER,
		Platform: 'android',
		'Platform-Version': '14',
		'Android-Id': ANDROID_ID,
		'Reuse-Identifier': REUSE_IDENTIFIER,
		'Build-Serial': 'unknown',
		'User-Agent': 'okhttp/5.3.2', // ohne exakt diesen UA blockt Fastly mit 406
		...extra
	};
}

/** `head.seller.name` liefert live nur die interne Filial-Kennung (z.B. "VKST-893") ohne
 * Händlernamen — für sich genommen nicht als "Rossmann"-Markt erkennbar, daher voranstellen. */
function sellerToMarket(seller: AnybillReceipt['head']['seller']): ReceiptSummary['market'] {
	if (!seller?.name) return null;
	const name = seller.name.startsWith('Rossmann') ? seller.name : `Rossmann ${seller.name}`;
	return { name, street: seller.address?.street, city: seller.address?.city };
}

export default function createRossmannModule(sdk: ModuleSdk): StoreModule {
	async function loginWithCredentials(fields: Record<string, string>): Promise<StoredCredentials> {
		const { email, password } = fields;
		if (!email || !password) throw new Error('E-Mail und Passwort werden benötigt.');

		const { status, json } = await sdk.http.requestJson<LoginResponse>(`${ACCOUNT_API}/v2/accounts/login`, {
			method: 'POST',
			headers: { ...accountHeaders(), 'Content-Type': 'application/json' },
			body: JSON.stringify({ email, password })
		});
		if (status !== 200 || !json.accountHash) {
			throw new Error(`ROSSMANN-Login fehlgeschlagen — ${describeError(status, json)}`);
		}

		const creds: RossmannCredentials = { accountId: json.accountId, accountHash: json.accountHash };
		return creds;
	}

	/** ROSSMANN hat kein klassisches Token-Refresh — die accountHash bleibt bis auf Widerruf
	 * gültig. Schlägt ein Request mit 401 fehl, hilft nur ein erneuter Login über die UI. */
	async function ensureFreshCredentials(creds: StoredCredentials): Promise<StoredCredentials> {
		return creds;
	}

	const anybillTokenCache = new Map<string, { accessToken: string; expiresAt: number }>();
	async function getAnybillToken(creds: RossmannCredentials): Promise<string> {
		const cached = anybillTokenCache.get(creds.accountHash);
		if (cached && cached.expiresAt - Date.now() > 60_000) return cached.accessToken;

		const { status, json } = await sdk.http.requestJson<AnybillAuthResponse>(`${ACCOUNT_API}/v2/accounts/${creds.accountId}/receipt/auth`, {
			method: 'GET',
			headers: accountHeaders({ 'Account-Hash': creds.accountHash })
		});
		if (status !== 200 || !json.accessToken) {
			throw new Error(`ROSSMANN anybill-Token-Endpoint fehlgeschlagen — ${describeError(status, json)}`);
		}
		anybillTokenCache.set(creds.accountHash, { accessToken: json.accessToken, expiresAt: Date.now() + json.expiresIn * 1000 });
		return json.accessToken;
	}

	const receiptListCache = new Map<string, { byId: Map<string, AnybillReceipt>; fetchedAt: number }>();
	async function fetchReceiptList(creds: RossmannCredentials, take: number): Promise<AnybillReceipt[]> {
		const accessToken = await getAnybillToken(creds);
		const url = `${ANYBILL_API}/receipt?take=${take}&orderBy=Date&orderByDirection=Descending`;
		const { status, json } = await sdk.http.requestJson<AnybillReceipt[]>(url, { method: 'GET', headers: { Authorization: `Bearer ${accessToken}` } });
		if (status !== 200) throw new Error(`ROSSMANN /receipt fehlgeschlagen — ${describeError(status, json)}`);

		receiptListCache.set(creds.accountHash, { byId: new Map(json.map((r) => [r.id, r])), fetchedAt: Date.now() });
		return json;
	}

	async function fetchReceipts(creds: StoredCredentials, knownIds: Set<string>): Promise<ReceiptSummary[]> {
		const c = creds as RossmannCredentials;
		// `take` ist server-seitig auf max. 100 begrenzt. Kein dokumentierter Cursor jenseits von
		// `take`: bei mehr als 100 Belegen insgesamt erfasst der Erstsync nur die neuesten 100.
		const take = 100;
		const items = await fetchReceiptList(c, take);

		const results: ReceiptSummary[] = [];
		for (const item of items) {
			if (knownIds.has(item.id)) break; // absteigend sortiert -> Rest ist ebenfalls bekannt
			results.push({
				storeId: 'rossmann',
				externalId: item.id,
				timestamp: Date.parse(item.head.date),
				totalCents: Math.round(item.data.fullAmountInclVat * 100),
				market: sellerToMarket(item.head.seller),
				cancelled: false,
				hasStructuredItems: true
			});
		}
		return results;
	}

	async function fetchReceiptPdf(creds: StoredCredentials, externalId: string): Promise<Buffer | null> {
		const c = creds as RossmannCredentials;
		const accessToken = await getAnybillToken(c);
		const url = `${ANYBILL_API}/receipt/${externalId}/pdf?IsPrintedVersion=false&IncludeReturnReceipts=false`;
		const res = await sdk.http.rawRequest(url, { method: 'GET', headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/pdf' } });
		if (res.status !== 200) return null;
		return res.body;
	}

	async function fetchReceiptItems(creds: StoredCredentials, externalId: string, pdf?: Buffer): Promise<ReceiptItem[]> {
		const c = creds as RossmannCredentials;
		let cached = receiptListCache.get(c.accountHash);
		if (!cached || Date.now() - cached.fetchedAt > RECEIPT_LIST_CACHE_TTL_MS || !cached.byId.has(externalId)) {
			await fetchReceiptList(c, 100);
			cached = receiptListCache.get(c.accountHash);
		}
		const receipt = cached?.byId.get(externalId);
		if (!receipt?.data.lines) return [];

		const items: ReceiptItem[] = receipt.data.lines.map((line) => ({
			name: line.text,
			priceCents: Math.round(line.fullAmountInclVat * 100),
			quantity: line.item?.quantity,
			unitPriceCents: line.item?.pricePerUnit != null ? Math.round(line.item.pricePerUnit * 100) : undefined
		}));

		// data.lines[] enthält laut Doku KEINEN Steuercode pro Position -- die von anybill
		// exportierte PDF hat ihn aber (A/B je Zeile). Positions-Zuordnung ist robuster als
		// Preis-Matching (Coupons verändern den JSON-Preis, nicht den PDF-Originalpreis).
		try {
			const pdfBuffer = pdf ?? (await fetchReceiptPdf(creds, externalId));
			if (pdfBuffer) {
				const pdfItems = parseReceiptItems(await sdk.pdf.extractLines(pdfBuffer));
				if (pdfItems.length === items.length) {
					items.forEach((item, i) => {
						item.taxCode = pdfItems[i].taxCode;
						item.discountExcluded = pdfItems[i].discountExcluded;
					});
				} else {
					const byPriceCents = new Map<number, ReceiptItem[]>();
					for (const pi of pdfItems) {
						const list = byPriceCents.get(pi.priceCents) ?? [];
						list.push(pi);
						byPriceCents.set(pi.priceCents, list);
					}
					for (const item of items) {
						const candidates = byPriceCents.get(item.priceCents);
						const match = candidates?.shift();
						if (match) {
							item.taxCode = match.taxCode;
							item.discountExcluded = match.discountExcluded;
						}
					}
				}
			}
		} catch {
			// PDF-Steuercode-Anreicherung ist optional -> bei Fehlschlag einfach ohne Steuercode weiter
		}

		return items;
	}

	async function fetchReceiptSavings(creds: StoredCredentials, externalId: string, pdf?: Buffer): Promise<ReceiptSavings | null> {
		const buffer = pdf ?? (await fetchReceiptPdf(creds, externalId));
		if (!buffer) return null;
		return parseSavings(await sdk.pdf.extractLines(buffer));
	}

	async function refreshMarketInfo(creds: StoredCredentials, externalId: string): Promise<ReceiptSummary['market']> {
		const c = creds as RossmannCredentials;
		let cached = receiptListCache.get(c.accountHash);
		if (!cached || Date.now() - cached.fetchedAt > RECEIPT_LIST_CACHE_TTL_MS || !cached.byId.has(externalId)) {
			await fetchReceiptList(c, 100);
			cached = receiptListCache.get(c.accountHash);
		}
		const receipt = cached?.byId.get(externalId);
		if (!receipt) return null;
		return sellerToMarket(receipt.head.seller);
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
