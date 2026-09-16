// Kaufland-Modul fuer BonSync -- reverse-engineered per statischer APK-Analyse
// (androguard auf com.kaufland.Kaufland v6.17.0/168737), NICHT live gegen einen
// echten Account verifiziert. Details, Unsicherheiten und offene Fragen: siehe
// api-kaufland.md im selben Repo-Stand wie dieses Modul.

const CIDAAS_BASE = 'https://account.kaufland.com';
const ACARDO_BASE = 'https://kaufland-app-backend-production.acardo.io';

const CLIENT_ID = 'fb1b425b-ab2f-4140-aef9-20263b6cfa49'; // BuildConfig.CidaasClientId
const LOYALTY_CLIENT_ID = '88207bfc-780b-400d-92ee-893ae72dab40'; // BuildConfig.LoyaltyClientId
const REDIRECT_URI = 'com.kaufland.Kaufland://oauth/callback';
const APP_VERSION = '6.17.0';
const CIDAAS_SDK_V = '1.5.22';
const DEFAULT_COUNTRY = 'DE';

function normalizeAmount(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function parseTimestamp(value) {
  if (typeof value === 'number') {
    return value < 1e12 ? value * 1000 : value;
  }
  const parsed = Date.parse(value);
  if (!Number.isNaN(parsed)) return parsed;
  const asNumber = Number(value);
  if (Number.isFinite(asNumber)) return asNumber < 1e12 ? asNumber * 1000 : asNumber;
  return Date.now();
}

function extractList(json) {
  if (Array.isArray(json)) return json;
  if (json && typeof json === 'object') {
    for (const key of ['items', 'transactions', 'content', 'data', 'results']) {
      if (Array.isArray(json[key])) return json[key];
    }
  }
  return [];
}

function mapTransaction(t) {
  return {
    storeId: 'kaufland',
    externalId: t.id,
    timestamp: parseTimestamp(t.timestamp),
    // API-Feld "sum" ist laut statischer Analyse vermutlich bereits ein Cent-Betrag
    // (Integer) -- unverifiziert, siehe api-kaufland.md Abschnitt 8.
    totalCents: normalizeAmount(t.sum ?? t.payoff ?? 0),
    market: t.store
      ? { name: t.store.name ?? undefined, street: t.store.street ?? undefined, city: t.store.city ?? undefined }
      : null,
    // Kein Storno-/Cancelled-Flag im Datenmodell gefunden -- immer false, bis ein
    // echtes Beispiel mit Retoure/Storno zeigt, welches Feld das anzeigt.
    cancelled: false,
    hasStructuredItems: Array.isArray(t.positions) && t.positions.length > 0
  };
}

export default function createKauflandModule(sdk) {
  const transactionCache = new Map();

  async function tokenRequest(fields) {
    const body = sdk.http.formBody(fields);
    const { status, json } = await sdk.http.requestJson(`${CIDAAS_BASE}/token-srv/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    if (status !== 200) {
      throw new Error(`Kaufland-Token-Request fehlgeschlagen (Status ${status}): ${JSON.stringify(json)}`);
    }
    return json;
  }

  async function fetchUserInfo(accessToken) {
    const { status, json } = await sdk.http.requestJson(`${CIDAAS_BASE}/users-srv/userinfo`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }
    });
    if (status !== 200) {
      throw new Error(`Kaufland-UserInfo-Abruf fehlgeschlagen (Status ${status})`);
    }
    return json;
  }

  async function fetchTransactionsPage(creds, start, limit) {
    const url =
      `${ACARDO_BASE}/api/v2/customers/${encodeURIComponent(creds.username)}/transactions` +
      `?start=${start}&limit=${limit}&country=${DEFAULT_COUNTRY}&version=2`;
    const { status, json } = await sdk.http.requestJson(url, {
      headers: {
        Authorization: `Bearer ${creds.accessToken}`,
        'client-id': LOYALTY_CLIENT_ID,
        'app-platform': 'Android',
        'app-version': APP_VERSION,
        Accept: 'application/json'
      }
    });
    if (status !== 200) {
      throw new Error(`Kaufland-Transaktionsabruf fehlgeschlagen (Status ${status}): ${JSON.stringify(json)}`);
    }
    return extractList(json);
  }

  async function getTransaction(creds, externalId) {
    if (transactionCache.has(externalId)) return transactionCache.get(externalId);

    const pageSize = 100;
    const maxPages = 30; // ~3000 Belege durchsuchen, dann aufgeben
    let start = 0;
    for (let page = 0; page < maxPages; page += 1) {
      const items = await fetchTransactionsPage(creds, start, pageSize);
      if (items.length === 0) break;
      for (const t of items) {
        if (t && t.id) transactionCache.set(t.id, t);
      }
      if (transactionCache.has(externalId)) return transactionCache.get(externalId);
      if (items.length < pageSize) break;
      start += pageSize;
    }
    return null;
  }

  return {
    async beginLogin() {
      const codeVerifier = sdk.pkce.generateCodeVerifier();
      const codeChallenge = sdk.pkce.generateCodeChallenge(codeVerifier);
      const state = sdk.pkce.generateState();
      await sdk.pkce.saveState(state, codeVerifier);

      const params = new URLSearchParams({
        client_id: CLIENT_ID,
        response_type: 'code',
        redirect_uri: REDIRECT_URI,
        ui_locales: 'de-DE',
        v: CIDAAS_SDK_V,
        view_type: '',
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        state
      });

      return { url: `${CIDAAS_BASE}/authz-srv/authz?${params.toString()}`, state };
    },

    async completeLogin(input) {
      const raw = input.callbackUrl || input.redirectUrl || input.url || input.code || '';
      let code = null;
      let state = input.state || null;

      // com.kaufland.Kaufland://... ist fuer new URL() kein bekanntes Protokoll --
      // deshalb ueber die Query-String-Position parsen statt ueber den URL-Parser.
      const queryIndex = raw.indexOf('?');
      if (queryIndex >= 0) {
        const query = new URLSearchParams(raw.slice(queryIndex + 1));
        code = query.get('code') || code;
        state = query.get('state') || state;
      }
      if (!code) code = raw || null;

      if (!code) {
        throw new Error(
          'Kein Login-Code gefunden. Bitte die komplette Callback-URL aus den Browser-DevTools einfuegen.'
        );
      }
      if (!state) {
        throw new Error(
          'Kein "state" gefunden -- bitte die komplette Callback-URL (nicht nur den Code) einfuegen, ' +
            'damit der PKCE-code_verifier zugeordnet werden kann.'
        );
      }

      const pkceState = await sdk.pkce.consumeState(state);
      if (!pkceState) {
        throw new Error(
          'Kein passender PKCE-code_verifier fuer diesen state gefunden (Login-Versuch abgelaufen?). ' +
            'Bitte Login erneut starten.'
        );
      }

      const tokens = await tokenRequest({
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: pkceState.codeVerifier
      });

      const userInfo = await fetchUserInfo(tokens.access_token);

      return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        idToken: tokens.id_token,
        expiresAt: Date.now() + Math.max(0, (tokens.expires_in ?? 1200) - 60) * 1000,
        username: userInfo.sub
      };
    },

    async ensureFreshCredentials(creds) {
      if (!creds || !creds.accessToken || !creds.username) {
        throw new Error('Unvollstaendige Kaufland-Zugangsdaten -- bitte erneut einloggen.');
      }
      if (creds.expiresAt && Date.now() < creds.expiresAt) {
        return creds;
      }
      if (!creds.refreshToken) {
        throw new Error('Kaufland-Token abgelaufen und kein refresh_token vorhanden -- bitte erneut einloggen.');
      }

      const tokens = await tokenRequest({
        grant_type: 'refresh_token',
        client_id: CLIENT_ID,
        refresh_token: creds.refreshToken
      });

      return {
        ...creds,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? creds.refreshToken,
        idToken: tokens.id_token ?? creds.idToken,
        expiresAt: Date.now() + Math.max(0, (tokens.expires_in ?? 1200) - 60) * 1000
      };
    },

    async fetchReceipts(creds, knownIds) {
      const summaries = [];
      const pageSize = 50;
      let start = 0;

      // Annahme (wie bei Lidl): Liste ist absteigend nach Datum sortiert, daher
      // Abbruch beim ersten bereits bekannten Beleg -- unverifiziert.
      for (;;) {
        const page = await fetchTransactionsPage(creds, start, pageSize);
        if (page.length === 0) break;

        let hitKnown = false;
        for (const t of page) {
          if (!t || !t.id) continue;
          transactionCache.set(t.id, t);
          if (knownIds.has(t.id)) {
            hitKnown = true;
            break;
          }
          summaries.push(mapTransaction(t));
        }
        if (hitKnown || page.length < pageSize) break;
        start += pageSize;
      }

      return summaries;
    },

    async fetchReceiptPdf() {
      // providesPdf: false -- Kaufland liefert kein Beleg-PDF ueber diese API,
      // siehe api-kaufland.md Abschnitt 6.
      return null;
    },

    async fetchReceiptItems(creds, externalId) {
      const t = await getTransaction(creds, externalId);
      if (!t || !Array.isArray(t.positions)) return [];
      return t.positions.map((p) => ({
        name: p.name ?? p.itemno ?? 'Artikel',
        quantity: p.quantity ?? 1,
        totalCents: normalizeAmount(p.total ?? 0),
        gtin: p.gtin ?? null,
        itemNumber: p.itemno ?? null
      }));
    },

    async fetchReceiptSavings(creds, externalId) {
      const t = await getTransaction(creds, externalId);
      if (!t) return null;
      const promotions = Array.isArray(t.promotions) ? t.promotions : [];
      const totalSavingCents = normalizeAmount(
        t.saving ?? promotions.reduce((sum, p) => sum + (p.saving ?? 0), 0)
      );
      if (totalSavingCents === 0 && promotions.length === 0) return null;
      return {
        totalSavingCents,
        promotions: promotions.map((p) => ({
          id: p.id ?? null,
          description: p.desc ?? null,
          savingCents: normalizeAmount(p.saving ?? 0)
        }))
      };
    },

    async refreshMarketInfo(creds, externalId) {
      const t = await getTransaction(creds, externalId);
      if (!t || !t.store) return null;
      // Kein zipCode-Aequivalent im Datenmodell -- Feld bewusst weggelassen statt
      // erfunden, siehe module-format.md Abschnitt 4.1 und api-kaufland.md Abschnitt 5.
      return { name: t.store.name ?? undefined, street: t.store.street ?? undefined, city: t.store.city ?? undefined };
    }
  };
}
