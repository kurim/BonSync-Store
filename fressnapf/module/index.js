// Fressnapf/Maxi Zoo Modul für BonSync.
// Basiert auf der Reverse-Engineering-Dokumentation der offiziellen Android-App
// (com.fressnapf.mobileapp, "Maxi Zoo"-Backend). Login läuft über OAuth2/PKCE gegen
// SAP Customer Data Cloud (Gigya); der Redirect nutzt ein Custom-URI-Scheme
// (fressnapfapp-auth://), das im Browser nicht geöffnet werden kann — die Ziel-URL
// bleibt aber sichtbar und wird hier vom Nutzer manuell eingefügt (oauth-pkce-manual).

const MARKET = 'fressnapfDE';
const GATEWAY = 'https://eos.prod.fressnapf.cloud/app-backend';

// Client-ID + Redirect-URI der offiziellen Android-App. Beide gehören zusammen
// (der Redirect ist serverseitig fest für diese Client-ID registriert) und sind
// laut Dokumentation live verifiziert funktionsfähig.
const CLIENT_ID = '7SXrjF1Zc509hlTIgg7F2XGm';
const REDIRECT_URI = 'fressnapfapp-auth://oauth-redirect';
const SCOPE = 'openid';

export default function createFressnapfModule(sdk) {
  // Issuer/Authorize/Token-Endpoints werden pro Markt dynamisch vom Backend
  // geladen (kein hartkodierter OIDC-Client) — einmal pro Prozess auflösen und
  // cachen, statt bei jedem Login/Refresh erneut zu discovern.
  let oidcEndpointsPromise = null;

  async function getOidcEndpoints() {
    if (!oidcEndpointsPromise) {
      oidcEndpointsPromise = (async () => {
        const { json: config } = await sdk.http.requestJson(
          `${GATEWAY}/v1/${MARKET}/configuration/global?lang=de`
        );
        const issuerUrl = config.cdcOidc.issuerUrl.replace(/\/+$/, '');
        const { json: discovery } = await sdk.http.requestJson(
          `${issuerUrl}/.well-known/openid-configuration`
        );
        return {
          authorizationEndpoint: discovery.authorization_endpoint,
          tokenEndpoint: discovery.token_endpoint
        };
      })().catch((err) => {
        oidcEndpointsPromise = null;
        throw err;
      });
    }
    return oidcEndpointsPromise;
  }

  function authHeader(creds) {
    return { Authorization: `Bearer ${creds.accessToken}` };
  }

  function toStoredCredentials(tokenJson, previousRefreshToken) {
    return {
      accessToken: tokenJson.access_token,
      refreshToken: tokenJson.refresh_token ?? previousRefreshToken,
      expiresAt: Date.now() + Math.max(0, (tokenJson.expires_in ?? 0) - 60) * 1000
    };
  }

  function formatTimestamp(date) {
    // API erwartet "+0000" statt "Z" am Ende von ISO-8601-Zeitstempeln.
    return date.toISOString().replace(/\.\d{3}Z$/, '+0000');
  }

  // Der Detail-Endpunkt braucht neben dem receiptCode noch orderDateShort,
  // storeNumber und workstationId aus dem Listen-Header. Da fetchReceiptItems/
  // fetchReceiptPdf/refreshMarketInfo nur die externalId zurückbekommen, werden
  // diese Felder in der externalId mit-kodiert.
  function buildExternalId(header) {
    return [header.receiptCode, header.orderDateShort, header.storeNumber, header.workstationId].join(':');
  }

  function decodeExternalId(externalId) {
    const [receiptCode, orderDateShort, storeNumber, workstationId] = externalId.split(':');
    return { receiptCode, orderDateShort, storeNumber, workstationId };
  }

  function toReceiptSummary(receipt, externalId) {
    const header = receipt.receiptHeader;
    return {
      storeId: 'fressnapf',
      externalId,
      timestamp: Date.parse(header.orderDate),
      totalCents: Math.round((header.totalAmount?.value ?? 0) * 100),
      market: header.storeDisplayName ? { name: header.storeDisplayName } : null,
      cancelled: false,
      hasStructuredItems: true
    };
  }

  function toReceiptItem(item) {
    const totalPriceCents = Math.round((item.price?.value ?? 0) * 100);
    const quantity = item.amount ?? 1;
    return {
      name: item.product?.name ?? 'Unbekannter Artikel',
      quantity,
      priceCents: totalPriceCents,
      unitPriceCents: quantity ? Math.round(totalPriceCents / quantity) : totalPriceCents
    };
  }

  function extractCodeAndState(fields) {
    if (fields.code && fields.state) {
      return { code: fields.code, state: fields.state };
    }
    const pasted = fields.redirectUrl ?? fields.url ?? Object.values(fields)[0] ?? '';
    const codeMatch = String(pasted).match(/[?&]code=([^&]+)/);
    const stateMatch = String(pasted).match(/[?&]state=([^&]+)/);
    if (!codeMatch || !stateMatch) {
      throw new Error(
        'Konnte "code" und "state" nicht aus der eingefügten URL lesen. Bitte die komplette Weiterleitungs-URL (fressnapfapp-auth://oauth-redirect?...) einfügen.'
      );
    }
    return { code: decodeURIComponent(codeMatch[1]), state: decodeURIComponent(stateMatch[1]) };
  }

  // BonSync speichert market nur als flaches (name, street, zip, city) —
  // keine Spalten für country/phone/Geo-Koordinaten, daher hier weggelassen.
  // Fallback über address.formattedAddress ("Straße 1, 12345 Ort"), falls die
  // aufgeschlüsselten Felder mal fehlen sollten (siehe fetchStoreInfo) — das
  // ist auch das Feld, auf das sich fressnapf_client.py::get_store_address
  // verlässt, statt auf line1/postalCode/town einzeln.
  function toMarketInfo(store, fallbackName) {
    const address = store?.address ?? {};
    let street = address.line1 ?? null;
    let zipCode = address.postalCode ?? null;
    let city = address.town ?? null;
    if ((!street || !zipCode || !city) && address.formattedAddress) {
      const match = address.formattedAddress.match(/^(.*),\s*(\d{4,5})\s+(.*)$/);
      if (match) {
        street = street ?? match[1].trim();
        zipCode = zipCode ?? match[2].trim();
        city = city ?? match[3].trim();
      }
    }
    return {
      name: store?.displayName ?? fallbackName ?? null,
      street,
      zipCode,
      city
    };
  }

  // GET stores/{storeNumber} laut api-fressnapf.md Abschnitt 3.6. Wie
  // fressnapf_client.py::api_get schickt auch dieser Aufruf fields=FULL +
  // currentTime mit, obwohl das Beispiel in der Doku das nicht zeigt — ohne
  // fields=FULL liefert Hybris vermutlich nur eine reduzierte DTO-Tiefe, bei
  // der die aufgeschlüsselten address.line1/postalCode/town-Felder fehlen.
  // Ein Cache pro storeNumber vermeidet wiederholte Abfragen, da dieselbe
  // Filiale in vielen Belegen wiederkehrt. Fehlschlag wird nicht hart
  // durchgereicht, damit der Sync nicht an einer einzelnen Filialauflösung
  // scheitert.
  const storeInfoCache = new Map();

  async function fetchStoreInfo(creds, storeNumber) {
    if (!storeNumber) return null;
    if (storeInfoCache.has(storeNumber)) return storeInfoCache.get(storeNumber);
    const params = new URLSearchParams({ fields: 'FULL', currentTime: String(Date.now()), lang: 'de' });
    const info = await sdk.http
      .requestJson(`${GATEWAY}/v1/${MARKET}/stores/${storeNumber}?${params.toString()}`, {
        headers: authHeader(creds)
      })
      .then(({ status, json }) => (status === 200 ? json : null))
      .catch(() => null);
    storeInfoCache.set(storeNumber, info);
    return info;
  }

  // refresh_token ist laut api-fressnapf.md Abschnitt 2.3 einmalig verwendbar
  // (rotiert bei jedem Refresh) und expires_in sehr kurz (300s). Stoßen mehrere
  // parallele Aufrufe mit demselben abgelaufenen Token einen Refresh an, gewinnt
  // nur der erste — die anderen bekämen 403. Ein In-Process-Single-Flight-Lock
  // (analog zum In-Memory-Lock der offiziellen App) bündelt gleichzeitige
  // Aufrufe auf ein und dasselbe Refresh-Ergebnis statt mehrfach zu refreshen.
  let refreshInFlight = null;

  async function doTokenRefresh(creds) {
    const { tokenEndpoint } = await getOidcEndpoints();
    const { status, json } = await sdk.http.requestJson(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: sdk.http.formBody({
        grant_type: 'refresh_token',
        refresh_token: creds.refreshToken,
        client_id: CLIENT_ID
      })
    });
    if (status !== 200) {
      throw new Error(`Token-Refresh fehlgeschlagen (Status ${status})`);
    }
    return toStoredCredentials(json, creds.refreshToken);
  }

  async function fetchReceiptDetail(creds, externalId) {
    const { receiptCode, orderDateShort, storeNumber, workstationId } = decodeExternalId(externalId);
    const params = new URLSearchParams({
      fields: 'FULL',
      currentTime: String(Date.now()),
      orderDateShort,
      storeNumber,
      workstationId,
      lang: 'de'
    });
    const { status, json } = await sdk.http.requestJson(
      `${GATEWAY}/v1/${MARKET}/receipthistory/${receiptCode}?${params.toString()}`,
      { headers: authHeader(creds) }
    );
    if (status !== 200) {
      throw new Error(`Kassenbon-Detail konnte nicht geladen werden (Status ${status})`);
    }
    return json;
  }

  return {
    async beginLogin() {
      const { authorizationEndpoint } = await getOidcEndpoints();
      const codeVerifier = sdk.pkce.generateCodeVerifier();
      const codeChallenge = sdk.pkce.generateCodeChallenge(codeVerifier);
      const state = sdk.pkce.generateState();
      await sdk.pkce.saveState(state, codeVerifier);
      const params = new URLSearchParams({
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        scope: SCOPE,
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256'
      });
      return { url: `${authorizationEndpoint}?${params.toString()}`, state };
    },

    async completeLogin(fields) {
      const { code, state } = extractCodeAndState(fields);
      const pkceState = await sdk.pkce.consumeState(state);
      if (!pkceState) {
        throw new Error('Login-Sitzung abgelaufen oder ungültig, bitte den Login erneut starten.');
      }
      const { tokenEndpoint } = await getOidcEndpoints();
      const { status, json } = await sdk.http.requestJson(tokenEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: sdk.http.formBody({
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT_URI,
          client_id: CLIENT_ID,
          code_verifier: pkceState.codeVerifier
        })
      });
      if (status !== 200) {
        throw new Error(`Token-Tausch fehlgeschlagen (Status ${status})`);
      }
      return toStoredCredentials(json);
    },

    async ensureFreshCredentials(creds) {
      if (!creds.expiresAt || Date.now() < creds.expiresAt) {
        return creds;
      }
      if (!refreshInFlight) {
        refreshInFlight = doTokenRefresh(creds).finally(() => {
          refreshInFlight = null;
        });
      }
      return refreshInFlight;
    },

    async fetchReceipts(creds, knownIds) {
      const now = Date.now();
      const params = new URLSearchParams({
        fields: 'FULL',
        newerThanTS: '2000-01-01T00:00:00+0000',
        olderThanTS: formatTimestamp(new Date(now + 24 * 60 * 60 * 1000)),
        currentTime: String(now),
        lang: 'de'
      });
      const { status, json } = await sdk.http.requestJson(
        `${GATEWAY}/v1/${MARKET}/receipthistory?${params.toString()}`,
        { headers: authHeader(creds) }
      );
      if (status !== 200) {
        throw new Error(`Kassenbon-Liste konnte nicht geladen werden (Status ${status})`);
      }
      return json
        .map((receipt) => ({ receipt, externalId: buildExternalId(receipt.receiptHeader) }))
        .filter(({ externalId }) => !knownIds.has(externalId))
        .map(({ receipt, externalId }) => toReceiptSummary(receipt, externalId));
    },

    async fetchReceiptPdf() {
      // Fressnapf liefert für In-Store-Kassenbons kein PDF — die Artikel kommen
      // bereits strukturiert aus der API (siehe fetchReceiptItems).
      return null;
    },

    async fetchReceiptItems(creds, externalId) {
      const receipt = await fetchReceiptDetail(creds, externalId);
      return (receipt.items ?? []).map(toReceiptItem);
    },

    async fetchReceiptSavings(creds, externalId) {
      const receipt = await fetchReceiptDetail(creds, externalId);
      const discount = receipt.receiptSumBox?.totalGrossDiscount?.value;
      if (!discount) return null;
      return { totalCents: Math.round(discount * 100) };
    },

    async refreshMarketInfo(creds, externalId) {
      const receipt = await fetchReceiptDetail(creds, externalId);
      const header = receipt.receiptHeader;
      if (!header?.storeNumber) return null;
      const store = await fetchStoreInfo(creds, header.storeNumber);
      const market = toMarketInfo(store, header.storeDisplayName);
      return market.name ? market : null;
    }
  };
}
