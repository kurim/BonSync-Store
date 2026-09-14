import { htmlToLines } from './htmlToLines';
import { parseReceiptItems, parseSavings } from './parser';
import type { ModuleSdk } from '../../src/lib/server/modules/sdk';
import type { AuthorizeStart, ReceiptItem, ReceiptSavings, ReceiptSummary, StoreModule, StoredCredentials } from '../../src/lib/server/modules/types';

// --- Konstanten aus docs/api-lidlplus.md ---
const AUTHORIZE_ENDPOINT = 'https://accounts.lidl.com/connect/authorize';
const TOKEN_ENDPOINT = 'https://accounts.lidl.com/connect/token';
const CLIENT_ID = 'LidlPlusNativeClient';
const CLIENT_SECRET = 'secret'; // literal, laut Doku fest im Client -> zusammen als Basic-Auth
const REDIRECT_URI = 'com.lidlplus.app://callback';
const SCOPE = 'openid profile offline_access lpprofile lpapis';
const COUNTRY = 'DE';
const LANGUAGE = 'de-DE';
const TICKETS_API = 'https://tickets.lidlplus.com/api';
const APP_VERSION = '17.9.3';
const APP_ID = 'com.lidl.eci.lidlplus';

interface LidlCredentials extends StoredCredentials {
	accessToken: string;
	refreshToken: string;
	expiresAt: number; // epoch ms
}

interface TokenResponse {
	access_token: string;
	refresh_token: string;
	expires_in: number;
	token_type: string;
}

interface TicketListItem {
	id: string;
	date: string;
	totalAmount: number;
}

interface TicketListResponse {
	page: number;
	size: number;
	totalCount: number;
	tickets: TicketListItem[];
}

interface TicketDetail {
	id: string;
	date: string;
	totalAmount: number;
	store?: { id?: string; name?: string; address?: string; postalCode?: string; locality?: string };
	htmlPrintedReceipt?: string;
}

function basicAuthHeader(): string {
	return 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
}

/** `store.name` liefert live nur den Filialort (z.B. "Hochdahl") ohne Händlernamen -- "Lidl "
 * voranstellen (falls nicht schon vorhanden), sonst ist der Markt nicht wiedererkennbar. */
function marketName(name: string | undefined): string | undefined {
	if (!name) return name;
	return name.startsWith('Lidl') ? name : `Lidl ${name}`;
}

export default function createLidlModule(sdk: ModuleSdk): StoreModule {
	async function exchangeToken(params: Record<string, string>): Promise<LidlCredentials> {
		const { status, json } = await sdk.http.requestJson<TokenResponse>(TOKEN_ENDPOINT, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: basicAuthHeader() },
			body: sdk.http.formBody(params)
		});
		if (status !== 200 || !json.access_token) {
			throw new Error(`LIDL-Token-Endpoint antwortete mit Status ${status}`);
		}
		return {
			accessToken: json.access_token,
			refreshToken: json.refresh_token,
			expiresAt: Date.now() + json.expires_in * 1000
		};
	}

	async function beginLogin(): Promise<AuthorizeStart> {
		const codeVerifier = sdk.pkce.generateCodeVerifier();
		const codeChallenge = sdk.pkce.generateCodeChallenge(codeVerifier);
		const state = sdk.pkce.generateState();
		await sdk.pkce.saveState(state, codeVerifier);

		const url = new URL(AUTHORIZE_ENDPOINT);
		url.searchParams.set('client_id', CLIENT_ID);
		url.searchParams.set('redirect_uri', REDIRECT_URI);
		url.searchParams.set('response_type', 'code');
		url.searchParams.set('scope', SCOPE);
		url.searchParams.set('state', state);
		url.searchParams.set('nonce', sdk.pkce.generateState());
		url.searchParams.set('code_challenge', codeChallenge);
		url.searchParams.set('code_challenge_method', 'S256');
		url.searchParams.set('Country', COUNTRY);
		url.searchParams.set('language', LANGUAGE);
		url.searchParams.set('force', 'false');
		url.searchParams.set('track', 'false');

		return { url: url.toString(), state };
	}

	async function completeLogin(input: Record<string, string>): Promise<StoredCredentials> {
		let code: string | undefined = input.code;
		let state: string | undefined = input.state;
		if (!code && input.redirectUrl) {
			const parsed = new URL(input.redirectUrl.replace('com.lidlplus.app://callback', 'https://placeholder'));
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

		return exchangeToken({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, code_verifier: pending.codeVerifier });
	}

	async function ensureFreshCredentials(creds: StoredCredentials): Promise<StoredCredentials> {
		const c = creds as LidlCredentials;
		if (c.expiresAt - Date.now() > 60_000) return c;
		return exchangeToken({ grant_type: 'refresh_token', refresh_token: c.refreshToken });
	}

	function ticketHeaders(c: LidlCredentials): Record<string, string> {
		return {
			Authorization: `Bearer ${c.accessToken}`,
			Accept: 'application/json',
			'App-Version': APP_VERSION,
			'Operating-System': 'Android',
			App: APP_ID,
			'Accept-Language': 'de'
		};
	}

	async function fetchReceipts(creds: StoredCredentials, knownIds: Set<string>): Promise<ReceiptSummary[]> {
		const c = creds as LidlCredentials;
		const results: ReceiptSummary[] = [];
		let skip = 0;
		const take = 50;

		// eslint-disable-next-line no-constant-condition
		while (true) {
			const url = `${TICKETS_API}/v2/${COUNTRY}/tickets?skip=${skip}&take=${take}`;
			const { status, json } = await sdk.http.requestJson<TicketListResponse>(url, { method: 'GET', headers: ticketHeaders(c) });
			if (status !== 200) throw new Error(`LIDL /tickets antwortete mit Status ${status}`);
			const tickets = Array.isArray(json?.tickets) ? json.tickets : [];

			let hitKnown = false;
			for (const item of tickets) {
				if (knownIds.has(item.id)) {
					hitKnown = true;
					break;
				}
				results.push({
					storeId: 'lidl',
					externalId: item.id,
					timestamp: Date.parse(item.date),
					totalCents: Math.round(item.totalAmount * 100),
					market: null,
					cancelled: false,
					hasStructuredItems: false
				});
			}
			const fetchedSoFar = skip + tickets.length;
			if (hitKnown || tickets.length === 0 || fetchedSoFar >= json.totalCount) break;
			skip = fetchedSoFar;
		}
		return results;
	}

	const ticketDetailCache = new Map<string, TicketDetail>();
	async function fetchTicketDetail(c: LidlCredentials, externalId: string): Promise<TicketDetail> {
		const cached = ticketDetailCache.get(externalId);
		if (cached) return cached;
		const url = `${TICKETS_API}/v3/${COUNTRY}/tickets/${externalId}`;
		const { status, json } = await sdk.http.requestJson<TicketDetail>(url, { method: 'GET', headers: ticketHeaders(c) });
		if (status !== 200) throw new Error(`LIDL /tickets/{id} antwortete mit Status ${status}`);
		ticketDetailCache.set(externalId, json);
		return json;
	}

	async function fetchReceiptPdf(creds: StoredCredentials, externalId: string): Promise<Buffer | null> {
		const c = creds as LidlCredentials;
		const detail = await fetchTicketDetail(c, externalId);
		if (!detail.htmlPrintedReceipt) return null;
		return sdk.html.toPdf(detail.htmlPrintedReceipt);
	}

	async function fetchReceiptItems(creds: StoredCredentials, externalId: string): Promise<ReceiptItem[]> {
		const c = creds as LidlCredentials;
		const detail = await fetchTicketDetail(c, externalId);
		if (!detail.htmlPrintedReceipt) return [];
		return parseReceiptItems(htmlToLines(detail.htmlPrintedReceipt));
	}

	async function fetchReceiptSavings(creds: StoredCredentials, externalId: string): Promise<ReceiptSavings | null> {
		const c = creds as LidlCredentials;
		const detail = await fetchTicketDetail(c, externalId);
		if (!detail.htmlPrintedReceipt) return null;
		return parseSavings(htmlToLines(detail.htmlPrintedReceipt));
	}

	async function refreshMarketInfo(creds: StoredCredentials, externalId: string): Promise<ReceiptSummary['market']> {
		const c = creds as LidlCredentials;
		const detail = await fetchTicketDetail(c, externalId);
		if (!detail.store) return null;
		const { name, address, postalCode, locality } = detail.store;
		if (!name && !address && !postalCode && !locality) return null;
		return { name: marketName(name), street: address, zipCode: postalCode, city: locality };
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
