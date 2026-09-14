import { randomUUID } from 'node:crypto';
import { parseReceiptItems, parseSavings, parseMarketNumber } from '../_shared/posParser';
import type { ModuleSdk } from '../../src/lib/server/modules/sdk';
import type { AuthorizeStart, ReceiptItem, ReceiptSavings, ReceiptSummary, StoreModule, StoredCredentials } from '../../src/lib/server/modules/types';

// --- Konstanten aus docs/api-penny.md ---
const DISCOVERY_URL = 'https://account.penny.de/realms/penny/.well-known/openid-configuration';
const CLIENT_ID = 'pennyandroid';
const REDIRECT_URI = 'https://www.penny.de/app/login';
const SCOPE = 'openid profile email';
const API_BASE = 'https://api.penny.de';
const MARKET_LIST_URL = 'https://www.penny.de/.rest/market';
const MARKET_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // Marktliste ändert sich selten, 1x täglich reicht

interface PennyCredentials extends StoredCredentials {
	accessToken: string;
	refreshToken: string;
	expiresAt: number; // epoch ms
	reweId: string; // aus dem `rewe_id`-Claim des Access-Tokens dekodiert
}

interface TokenResponse {
	access_token: string;
	refresh_token?: string;
	expires_in: number;
	token_type: string;
}

interface DiscoveryDocument {
	authorization_endpoint: string;
	token_endpoint: string;
}

interface PennyMarket {
	wawi: string; // 8-stellig, die letzten 4 Ziffern sind die auf Kassenbon/API sichtbare "Marktnummer"
	marketName: string;
	streetWithHouseNumber: string;
	zipCode: string;
	city: string;
}

/** JWT-Payload dekodieren (nur lesen, keine Signaturprüfung nötig — reine Info-Extraktion). */
function decodeJwtPayload(jwt: string): Record<string, unknown> {
	const payload = jwt.split('.')[1];
	if (!payload) throw new Error('Ungültiger JWT (kein Payload-Segment)');
	const json = Buffer.from(payload, 'base64url').toString('utf8');
	return JSON.parse(json);
}

export default function createPennyModule(sdk: ModuleSdk): StoreModule {
	let cachedDiscovery: DiscoveryDocument | null = null;
	async function getDiscovery(): Promise<DiscoveryDocument> {
		if (cachedDiscovery) return cachedDiscovery;
		const { status, json } = await sdk.http.requestJson<DiscoveryDocument>(DISCOVERY_URL);
		if (status !== 200 || !json.authorization_endpoint || !json.token_endpoint) {
			throw new Error(`PENNY-Discovery-Dokument nicht ladbar (Status ${status})`);
		}
		cachedDiscovery = json;
		return json;
	}

	let marketCache: { byMarketNumber: Map<string, PennyMarket[]>; fetchedAt: number } | null = null;
	async function getMarketIndex(): Promise<Map<string, PennyMarket[]>> {
		if (marketCache && Date.now() - marketCache.fetchedAt < MARKET_CACHE_TTL_MS) return marketCache.byMarketNumber;

		const { status, json } = await sdk.http.requestJson<PennyMarket[]>(MARKET_LIST_URL);
		if (status !== 200) throw new Error(`PENNY-Marktliste (${MARKET_LIST_URL}) antwortete mit Status ${status}`);

		const byMarketNumber = new Map<string, PennyMarket[]>();
		for (const market of json) {
			if (!market.wawi || market.wawi.length < 4) continue;
			const marketNumber = market.wawi.slice(-4);
			const list = byMarketNumber.get(marketNumber) ?? [];
			list.push(market);
			byMarketNumber.set(marketNumber, list);
		}
		marketCache = { byMarketNumber, fetchedAt: Date.now() };
		return byMarketNumber;
	}

	/** Löst eine 4-stellige PENNY-Marktnummer über die öffentliche Marktliste auf -- nur wenn
	 * eindeutig, sonst `null` statt einer ggf. falschen Adresse (siehe docs/api-penny.md: die
	 * Nummer ist bundesweit nicht eindeutig, geschlossene Filialen fehlen in der Liste). */
	async function resolveMarketNumber(marketNumber: string | number): Promise<ReceiptSummary['market']> {
		const padded = String(marketNumber).padStart(4, '0');
		try {
			const index = await getMarketIndex();
			const matches = index.get(padded);
			if (!matches || matches.length !== 1) return { name: `Markt ${marketNumber}` };
			const m = matches[0];
			return { name: m.marketName, street: m.streetWithHouseNumber, zipCode: m.zipCode, city: m.city };
		} catch {
			return { name: `Markt ${marketNumber}` };
		}
	}

	async function exchangeToken(tokenEndpoint: string, params: Record<string, string>, previousReweId?: string): Promise<PennyCredentials> {
		const { status, json } = await sdk.http.requestJson<TokenResponse>(tokenEndpoint, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: sdk.http.formBody(params)
		});
		if (status !== 200 || !json.access_token) {
			throw new Error(`PENNY-Token-Endpoint antwortete mit Status ${status}`);
		}
		const claims = decodeJwtPayload(json.access_token);
		const reweId = (claims.rewe_id as string | undefined) ?? previousReweId;
		if (!reweId) throw new Error('Access-Token enthält keinen rewe_id-Claim.');

		return {
			accessToken: json.access_token,
			refreshToken: json.refresh_token ?? (params.refresh_token as string),
			expiresAt: Date.now() + json.expires_in * 1000,
			reweId
		};
	}

	async function beginLogin(): Promise<AuthorizeStart> {
		const discovery = await getDiscovery();
		const codeVerifier = sdk.pkce.generateCodeVerifier();
		const codeChallenge = sdk.pkce.generateCodeChallenge(codeVerifier);
		const state = sdk.pkce.generateState();
		await sdk.pkce.saveState(state, codeVerifier);

		const url = new URL(discovery.authorization_endpoint);
		url.searchParams.set('client_id', CLIENT_ID);
		url.searchParams.set('redirect_uri', REDIRECT_URI);
		url.searchParams.set('response_type', 'code');
		url.searchParams.set('scope', SCOPE);
		url.searchParams.set('state', state);
		url.searchParams.set('code_challenge', codeChallenge);
		url.searchParams.set('code_challenge_method', 'S256');

		return { url: url.toString(), state };
	}

	async function completeLogin(input: Record<string, string>): Promise<StoredCredentials> {
		let code: string | undefined = input.code;
		let state: string | undefined = input.state;
		if (!code && input.redirectUrl) {
			const parsed = new URL(input.redirectUrl);
			code = parsed.searchParams.get('code') ?? undefined;
			state = parsed.searchParams.get('state') ?? undefined;
		}
		if (!code || !state) {
			throw new Error('Kein code/state in der eingefügten Redirect-URL gefunden.');
		}

		const pending = await sdk.pkce.consumeState(state);
		if (!pending) {
			throw new Error('Unbekannter oder abgelaufener Login-Versuch (state nicht gefunden) — bitte erneut starten.');
		}

		const discovery = await getDiscovery();
		return exchangeToken(discovery.token_endpoint, {
			grant_type: 'authorization_code',
			client_id: CLIENT_ID,
			redirect_uri: REDIRECT_URI,
			code,
			code_verifier: pending.codeVerifier
		});
	}

	async function ensureFreshCredentials(creds: StoredCredentials): Promise<StoredCredentials> {
		const c = creds as PennyCredentials;
		if (c.expiresAt - Date.now() > 60_000) return c;
		const discovery = await getDiscovery();
		return exchangeToken(discovery.token_endpoint, { grant_type: 'refresh_token', client_id: CLIENT_ID, refresh_token: c.refreshToken }, c.reweId);
	}

	function pennyHeaders(c: PennyCredentials): Record<string, string> {
		return { Authorization: `Bearer ${c.accessToken}`, 'correlation-id': randomUUID(), Accept: 'application/json' };
	}

	interface EbonsResponse {
		items: Array<{
			id: string;
			timestamp: string;
			totalPrice: number;
			cancelled: boolean;
			market: { name?: string; street?: string; zipCode?: string; city?: string } | string | number | null;
		}>;
		pagination: { currentPage: number; pageCount: number };
	}

	async function normalizeMarket(market: EbonsResponse['items'][number]['market']): Promise<ReceiptSummary['market']> {
		if (market === null || market === undefined) return null;
		if (typeof market === 'string' || typeof market === 'number') return resolveMarketNumber(market);
		if (!market.name && !market.street && !market.zipCode && !market.city) return null;
		return { name: market.name, street: market.street, zipCode: market.zipCode, city: market.city };
	}

	async function fetchReceipts(creds: StoredCredentials, knownIds: Set<string>): Promise<ReceiptSummary[]> {
		const c = creds as PennyCredentials;
		const results: ReceiptSummary[] = [];
		let page = 1;
		const objectsPerPage = 20;

		// eslint-disable-next-line no-constant-condition
		while (true) {
			const url = `${API_BASE}/api/tenants/penny/customers/${c.reweId}/ebons?page=${page}&objectsPerPage=${objectsPerPage}`;
			const { status, json } = await sdk.http.requestJson<EbonsResponse>(url, { method: 'GET', headers: pennyHeaders(c) });
			if (status !== 200) throw new Error(`PENNY /ebons antwortete mit Status ${status}`);

			let hitKnown = false;
			for (const item of json.items) {
				if (knownIds.has(item.id)) {
					hitKnown = true;
					break;
				}
				results.push({
					storeId: 'penny',
					externalId: item.id,
					timestamp: Date.parse(item.timestamp),
					totalCents: item.totalPrice,
					market: await normalizeMarket(item.market),
					cancelled: item.cancelled,
					hasStructuredItems: false
				});
			}
			if (hitKnown || json.items.length === 0 || json.pagination.currentPage >= json.pagination.pageCount) break;
			page++;
		}
		return results;
	}

	async function fetchReceiptPdf(creds: StoredCredentials, externalId: string): Promise<Buffer | null> {
		const c = creds as PennyCredentials;
		const url = `${API_BASE}/api/tenants/penny/customers/${c.reweId}/ebons/${externalId}/pdf`;
		const res = await sdk.http.rawRequest(url, { method: 'GET', headers: { ...pennyHeaders(c), Accept: 'application/pdf' } });
		if (res.status !== 200) return null;
		return res.body;
	}

	async function fetchReceiptItems(creds: StoredCredentials, externalId: string, pdf?: Buffer): Promise<ReceiptItem[]> {
		const buffer = pdf ?? (await fetchReceiptPdf(creds, externalId));
		if (!buffer) return [];
		return parseReceiptItems(await sdk.pdf.extractLines(buffer));
	}

	async function fetchReceiptSavings(creds: StoredCredentials, externalId: string, pdf?: Buffer): Promise<ReceiptSavings | null> {
		const buffer = pdf ?? (await fetchReceiptPdf(creds, externalId));
		if (!buffer) return null;
		return parseSavings(await sdk.pdf.extractLines(buffer));
	}

	async function refreshMarketInfo(creds: StoredCredentials, externalId: string, pdf?: Buffer): Promise<ReceiptSummary['market']> {
		const buffer = pdf ?? (await fetchReceiptPdf(creds, externalId));
		if (!buffer) return null;
		const lines = await sdk.pdf.extractLines(buffer);
		const marketNumber = parseMarketNumber(lines);
		if (!marketNumber) return null;
		return normalizeMarket(marketNumber);
	}

	return {
		beginLogin,
		completeLogin,
		ensureFreshCredentials,
		fetchReceipts,
		fetchReceiptPdf,
		fetchReceiptItems,
		fetchReceiptSavings,
		refreshMarketInfo
	};
}
