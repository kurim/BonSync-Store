const PURCHASE_HISTORY_URL = 'https://purchasehistory-prod.services.dmtech.com/v1/purchasehistory';
const EBON_API_BASE = 'https://ebon-prod.services.dmtech.com/api/customer/ebons';
const LIST_PAGE_SIZE = 100; // Serverseitiges Maximum unbestaetigt, siehe api-dm.md
const FRONTEND_ORIGIN = 'https://account.dm.de';
// Die Backends pruefen Origin/Referer (CORS) - ohne diese Header: 401, live bestaetigt.
const ORIGIN_HEADERS = { Origin: FRONTEND_ORIGIN, Referer: `${FRONTEND_ORIGIN}/` };

// dm hat KEINEN automatisierbaren Login (siehe api-dm.md): native App verlangt
// Geraete-Attestierung, der Web-Login verlangt reCAPTCHA Enterprise, und ein Replay der
// signin.dm.de-Session-Cookie fuer einen stillen Re-Login wurde dreimal live getestet
// (inkl. frisch aus dem richtigen Host kopierter Cookie) und schlug jedes Mal fehl -
// vermutlich eine bewusste Geraete-/Fingerprint-Bindung gegen Session-Replay, die hier
// nicht umgangen wird. Zusaetzlich stellt dm fuer diesen Client gar kein refresh_token
// aus - das access_token ist nur ~150 Sekunden gueltig.
//
// Praktische Konsequenz: kein "install-and-forget"-Modul moeglich. loginWithCredentials
// nimmt ein frisch aus dem Browser kopiertes access_token entgegen; ensureFreshCredentials
// kann es NICHT selbststaendig erneuern und wirft stattdessen einen klaren Fehler, sobald
// es abgelaufen ist - man muss vor jedem Sync manuell ein neues Token einfuegen.
function pickAccessToken(fields) {
  for (const raw of Object.values(fields)) {
    if (!raw) continue;
    let value = raw.trim();
    try {
      const parsed = JSON.parse(value);
      if (parsed.accessToken) value = parsed.accessToken;
    } catch {
      // kein JSON, Rohwert weiterverwenden
    }
    value = value.replace(/^Bearer\s+/i, '').trim();
    if (value.split('.').length === 3) return value; // grobe JWT-Formpruefung
  }
  throw new Error(
    'dm: Kein access_token gefunden. Frisch aus einem eingeloggten Browser-Tab kopieren ' +
    "(DevTools -> Network -> Request an dm.de/dmtech.com -> Header 'Authorization: Bearer " +
    "...') und NUR den Token-Teil ins Login-Feld einfuegen - siehe api-dm.md. Gilt nur ca. " +
    '150 Sekunden, muss vor jedem Sync neu eingefuegt werden.'
  );
}

// Live bestaetigt (api-dm.md): die eBon-Detail-Response nennt die PLZ 'zip', nicht
// 'zipCode' - BonSync erwartet aber exakt 'zipCode' (module-format.md 4.1), sonst
// bleibt market_zip in der DB stillschweigend NULL.
function mapMarket(address) {
  if (!address) return null;
  return {
    name: address.name ?? null,
    street: address.street ?? null,
    zipCode: address.zip ?? null,
    city: address.city ?? null,
  };
}

export default function createDmModule(sdk) {
  return {
    async loginWithCredentials(fields) {
      const accessToken = pickAccessToken(fields);
      // expiresAt ist eine Schaetzung (echte expires_in unbekannt, da der Token fertig
      // eingefuegt wird, nicht per eigenem Code-Tausch geholt) - konservativ auf 120s ab
      // jetzt gesetzt, damit ensureFreshCredentials rechtzeitig vor dem echten Ablauf
      // (~150s ab Ausstellung, die bereits etwas zurueckliegt) einen Fehler wirft statt
      // mit einem toten Token gegen die eBon-API zu laufen.
      return { accessToken, expiresAt: Date.now() + 120_000 };
    },

    async ensureFreshCredentials(creds) {
      if (creds.expiresAt && Date.now() < creds.expiresAt) return creds;
      throw new Error(
        'dm: access_token abgelaufen (nur ~150s gueltig, kein automatischer Refresh ' +
        'moeglich - siehe api-dm.md). Bitte ein frisches Token aus dem Browser kopieren ' +
        'und das dm-Modul neu einrichten (Modul deinstallieren/neu installieren oder ' +
        'erneut einloggen), dann sofort synchronisieren.'
      );
    },

    async fetchReceipts(creds, knownIds) {
      const { status, json } = await sdk.http.requestJson(
        `${PURCHASE_HISTORY_URL}?size=${LIST_PAGE_SIZE}`,
        { headers: { Authorization: `Bearer ${creds.accessToken}`, ...ORIGIN_HEADERS } }
      );
      if (status !== 200) {
        throw new Error(`dm: eBon-Liste fehlgeschlagen (Status ${status})`);
      }
      const items = json.purchaseHistoryItems || [];
      // Die Liste liefert keine Marktadresse mit (nur der Detail-Abruf tut das) -
      // market bleibt hier null und wird erst ueber refreshMarketInfo nachgeladen.
      return items
        .filter((e) => !knownIds.has(e.id))
        .map((e) => ({
          storeId: 'dm',
          externalId: e.id,
          timestamp: Date.parse(e.dateTimePlaced),
          totalCents: Math.round((e.totalAmount ?? 0) * 100),
          market: null,
          cancelled: false,
          hasStructuredItems: false,
        }));
    },

    async fetchReceiptPdf(creds, externalId) {
      const res = await sdk.http.rawRequest(`${EBON_API_BASE}/${externalId}/download`, {
        headers: { Authorization: `Bearer ${creds.accessToken}`, ...ORIGIN_HEADERS },
      });
      return res.status === 200 ? res.body : null;
    },

    async refreshMarketInfo(creds, externalId) {
      const { status, json } = await sdk.http.requestJson(`${EBON_API_BASE}/${externalId}`, {
        headers: { Authorization: `Bearer ${creds.accessToken}`, ...ORIGIN_HEADERS },
      });
      if (status !== 200) return null;
      return mapMarket(json.address);
    },
  };
}
