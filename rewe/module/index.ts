import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseReceiptItems, parseSavings, parseMarketHeader } from '../_shared/posParser';
import type { ModuleSdk } from '../../src/lib/server/modules/sdk';
import type { AuthorizeStart, ReceiptItem, ReceiptSavings, ReceiptSummary, StoreModule, StoredCredentials } from '../../src/lib/server/modules/types';

// Verzeichnis dieser Datei zur Laufzeit (nach dem Bündeln z.B. ${DATA_DIR}/modules/rewe/) --
// `import.meta.url` verweist bei einem dynamisch importierten ESM-Modul immer auf seine eigene
// Datei, unabhängig davon, von wo aus geladen wurde (bleibt auch mit dem Cache-Buster-Query-
// Parameter der Registry korrekt, da fileURLToPath nur den Pfadanteil der URL auswertet).
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

// --- Konstanten aus docs/api-rewe.md, Abschnitt 1.2 / 2 ---
const AUTHORIZE_ENDPOINT = 'https://account.rewe.de/realms/sso/protocol/openid-connect/auth';
const TOKEN_ENDPOINT = 'https://account.rewe.de/realms/sso/protocol/openid-connect/token';
const CLIENT_ID = 'reweandroid';
const REDIRECT_URI = 'de.rewe.app.mobile://redirect';
const SCOPE = 'openid email offline_access';
const API_BASE = 'https://mobile-clients-api.rewe.de';
const USER_AGENT = 'REWE-Mobile-Client/3.17.1.32270 Android/11 Phone/Google_sdk_gphone_x86_64';

interface ReweCredentials extends StoredCredentials {
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

interface EbonsResponse {
	data: {
		getEbons: {
			items: Array<{
				receiptId: string;
				receiptTimestamp: string;
				receiptTotalPrice: number;
				cancelled: boolean;
				market: { name?: string; street?: string; zipCode?: string; city?: string } | null;
			}>;
			pagination: { currentPage: number; pageCount: number; objectsPerPage: number; objectCount: number };
		};
	};
}

export default function createReweModule(sdk: ModuleSdk): StoreModule {
	let cachedTls: { cert: Buffer; key: Buffer } | null = null;
	/** Das mTLS-Client-Zertifikat liegt laut docs/api-rewe.md als feste App-Ressource
	 * (res/raw/mtls_prod.pfx) in der REWE-APK -- identisch für jede Installation der App, kein
	 * nutzerspezifisches Geheimnis. Es reist deshalb direkt im Modul-Paket mit (siehe
	 * modules-src/build.mjs) statt eine separate, vom Betreiber bereitzustellende Datei zu
	 * erfordern. `REWE_CERT_DIR` bleibt als optionaler Override nutzbar (z.B. falls REWE das
	 * Zertifikat rotiert, bevor dieses Modul aktualisiert wird, oder um bei Tests bewusst einen
	 * nicht-existenten Pfad zu erzwingen). */
	function mtlsOptions() {
		if (cachedTls) return cachedTls;
		const dir = process.env.REWE_CERT_DIR ?? MODULE_DIR;
		cachedTls = {
			cert: readFileSync(join(dir, 'client.pem')),
			key: readFileSync(join(dir, 'client.key'))
		};
		return cachedTls;
	}

	async function exchangeToken(params: Record<string, string>): Promise<ReweCredentials> {
		const { status, json } = await sdk.http.requestJson<TokenResponse>(TOKEN_ENDPOINT, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
			body: sdk.http.formBody(params)
		});
		if (status !== 200 || !json.access_token) {
			throw new Error(`REWE-Token-Endpoint antwortete mit Status ${status}`);
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
		url.searchParams.set('code_challenge', codeChallenge);
		url.searchParams.set('code_challenge_method', 'S256');

		return { url: url.toString(), state };
	}

	async function completeLogin(input: Record<string, string>): Promise<StoredCredentials> {
		let code: string | undefined = input.code;
		let state: string | undefined = input.state;
		if (!code && input.redirectUrl) {
			const parsed = new URL(input.redirectUrl.replace('de.rewe.app.mobile://redirect', 'https://placeholder'));
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

		return exchangeToken({
			grant_type: 'authorization_code',
			client_id: CLIENT_ID,
			redirect_uri: REDIRECT_URI,
			code,
			code_verifier: pending.codeVerifier
		});
	}

	async function ensureFreshCredentials(creds: StoredCredentials): Promise<StoredCredentials> {
		const c = creds as ReweCredentials;
		if (c.expiresAt - Date.now() > 60_000) return c;
		return exchangeToken({ grant_type: 'refresh_token', client_id: CLIENT_ID, refresh_token: c.refreshToken });
	}

	async function fetchReceipts(creds: StoredCredentials, knownIds: Set<string>): Promise<ReceiptSummary[]> {
		const c = creds as ReweCredentials;
		const results: ReceiptSummary[] = [];
		let page = 1;
		const objectsPerPage = 50;

		// eslint-disable-next-line no-constant-condition
		while (true) {
			const url = `${API_BASE}/api/ebons?page=${page}&objectsPerPage=${objectsPerPage}`;
			const { status, json } = await sdk.http.requestJson<EbonsResponse>(url, {
				method: 'GET',
				headers: { Authorization: `Bearer ${c.accessToken}`, 'User-Agent': USER_AGENT, Accept: 'application/json' },
				tls: mtlsOptions()
			});
			if (status !== 200) throw new Error(`REWE /api/ebons antwortete mit Status ${status}`);

			const { items, pagination } = json.data.getEbons;
			let hitKnown = false;
			for (const item of items) {
				if (knownIds.has(item.receiptId)) {
					hitKnown = true;
					break;
				}
				results.push({
					storeId: 'rewe',
					externalId: item.receiptId,
					timestamp: Date.parse(item.receiptTimestamp),
					totalCents: item.receiptTotalPrice,
					market: item.market
						? { name: item.market.name, street: item.market.street, zipCode: item.market.zipCode, city: item.market.city }
						: null,
					cancelled: item.cancelled,
					hasStructuredItems: false
				});
			}
			if (hitKnown || items.length === 0 || pagination.currentPage >= pagination.pageCount) break;
			page++;
		}
		return results;
	}

	async function fetchReceiptPdf(creds: StoredCredentials, externalId: string): Promise<Buffer | null> {
		const c = creds as ReweCredentials;
		const url = `${API_BASE}/api/receipts/${externalId}/pdf`;
		const res = await sdk.http.rawRequest(url, {
			method: 'GET',
			headers: { Authorization: `Bearer ${c.accessToken}`, 'User-Agent': USER_AGENT, Accept: 'application/pdf' },
			tls: mtlsOptions()
		});
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
		const header = parseMarketHeader(lines);
		if (!header.name) return null;
		return { name: header.name, street: header.street, zipCode: header.zipCode, city: header.city };
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
