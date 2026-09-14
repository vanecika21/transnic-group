/**
 * Client minimal pentru Yandex Fleet API (Yandex Pro / Dispatcher API).
 * Folosit DOAR din API routes server-side (niciodată din componente "use client").
 *
 * Credențiale necesare din partea Yandex (obținute după semnarea acordului
 * de integrare Fleet API cu reprezentantul Yandex din partea companiei):
 *   - Park ID     -> identificatorul parcului tău de taxi
 *   - Client ID   -> identificator de client emis de Yandex (ex: "taxi/park/xxxxx")
 *   - API Key     -> cheia secretă asociată Client ID-ului
 *
 * În acest proiect, ca să rămânem la DOUĂ variabile de mediu (cum ai cerut),
 * combinăm Client ID și API Key într-o singură variabilă, separate prin ":":
 *   YANDEX_CLIENT_API_KEY = "taxi/park/xxxxxxxx:CHEIA_TA_SECRETA"
 * Codul de mai jos le desparte automat.
 *
 * IMPORTANT: schema exactă de răspuns a endpoint-ului de tranzacții
 * (/v2/parks/transactions/list) nu este complet documentată public — codul
 * de mai jos folosește denumirile de câmpuri cunoscute din documentația
 * Yandex Fleet, dar la prima sincronizare recomand verificarea câmpului
 * "debugSample" din răspunsul rutei /api/yandex/sync (POST) ca să confirmi
 * că maparea cash/card/comisioane corespunde cu ce trimite contul tău.
 */

const YANDEX_API_BASE = "https://fleet-api.taxi.yandex.net";

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function getCredentials() {
  const parkId = process.env.YANDEX_PARK_ID;
  const combined = process.env.YANDEX_CLIENT_API_KEY || "";
  const [clientId, apiKey] = combined.split(":");

  if (!parkId || !clientId || !apiKey) {
    throw new Error(
      "Lipsesc credențialele Yandex. Verifică YANDEX_PARK_ID și YANDEX_CLIENT_API_KEY (format \"clientId:apiKey\") în .env.local / Vercel."
    );
  }
  return { parkId, clientId, apiKey };
}

async function yandexRequest(path, body) {
  const { parkId, clientId, apiKey } = getCredentials();

  const res = await fetch(`${YANDEX_API_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Client-ID": clientId,
      "X-API-Key": apiKey,
      "X-Park-ID": parkId,
      "Accept-Language": "ru",
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Yandex Fleet API (${path}) a răspuns cu conținut neașteptat: ${text.slice(0, 300)}`);
  }

  if (!res.ok) {
    throw new Error(
      `Yandex Fleet API (${path}) a răspuns cu eroare ${res.status}: ${json.message || text.slice(0, 300)}`
    );
  }
  return json;
}

/** Ia lista completă de șoferi din parc (activi + inactivi). */
export async function fetchYandexDrivers() {
  const { parkId } = getCredentials();
  const drivers = [];
  let offset = 0;
  const limit = 200;

  while (true) {
    const json = await yandexRequest("/v1/parks/driver-profiles/list", {
      query: { park: { id: parkId } },
      fields: {
        driver_profile: ["id", "first_name", "last_name", "middle_name", "phones"],
        car: ["number", "brand", "model"],
        current_status: ["status"],
      },
      limit,
      offset,
    });

    const page = json.driver_profiles || [];
    for (const item of page) {
      const dp = item.driver_profile || {};
      const car = item.car || {};
      const fullName = [dp.last_name, dp.first_name, dp.middle_name].filter(Boolean).join(" ").trim();
      const carModel = [car.brand, car.model].filter(Boolean).join(" ").trim();
      drivers.push({
        yandex_driver_id: dp.id,
        full_name: fullName || "Șofer fără nume",
        phone_number: (dp.phones && dp.phones[0]) || null,
        car_plate: car.number || null,
        car_model: carModel || null,
        is_active: (item.current_status && item.current_status.status) !== "offline_break"
          ? true
          : true, // Yandex nu marchează "activ în companie" prin status; activ = are profil în parc.
      });
    }

    if (page.length < limit) break;
    offset += limit;
    if (offset > 5000) break; // siguranță anti-buclă infinită
  }

  return drivers;
}

/**
 * Calculează intervalul UTC [00:00, 24:00) corespunzător unei zile calendaristice
 * în fusul orar Europe/Chisinau (ține cont automat de ora de vară/iarnă).
 */
function chisinauDayRangeUTC(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const noonUTC = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Chisinau",
    timeZoneName: "shortOffset",
  });
  const part = fmt.formatToParts(noonUTC).find((p) => p.type === "timeZoneName")?.value || "GMT+2";
  const match = part.match(/GMT([+-]\d+)/);
  const offsetHours = match ? parseInt(match[1], 10) : 2;

  const fromUTC = new Date(Date.UTC(y, m - 1, d, -offsetHours, 0, 0));
  const toUTC = new Date(Date.UTC(y, m - 1, d + 1, -offsetHours, 0, 0));
  return { fromISO: fromUTC.toISOString(), toISO: toUTC.toISOString() };
}

/**
 * Ia tranzacțiile financiare din parc pentru o zi dată și le agregă pe șofer:
 * cash, card, comision Yandex. Comisionul de parc se calculează separat
 * (vezi computeParkCommission), pentru că nu vine din Yandex — e regula ta internă.
 */
export async function fetchYandexDailyEarnings(dateStr) {
  const { parkId } = getCredentials();
  const { fromISO, toISO } = chisinauDayRangeUTC(dateStr);

  const perDriver = new Map(); // yandex_driver_id -> { cash, card, yandexCommission, otherPartnerPayments }
  // debug: sumă totală pe fiecare denumire de categorie întâlnită, ca să poți
  // verifica (comparând cu raportul din Dispecerat) că maparea de mai jos e corectă.
  const categoryTotals = new Map(); // "nume categorie" -> suma
  let offset = 0;
  const limit = 500;
  let debugSample = null;

  while (true) {
    const json = await yandexRequest("/v2/parks/transactions/list", {
      query: {
        park: {
          id: parkId,
          transaction: { event_at: { from: fromISO, to: toISO } },
        },
      },
      limit,
      offset,
    });

    const page = json.transactions || [];
    if (!debugSample && page.length) debugSample = page[0];

    for (const t of page) {
      const driverId = t.driver_profile_id || (t.driver_profile && t.driver_profile.id);
      if (!driverId) continue;

      const rawName = t.category_name || t.category_id || "necunoscut";
      const category = `${t.category_id || ""} ${t.category_name || ""}`.toLowerCase();
      const amount = Number(t.amount ?? t.sum ?? 0);
      if (!amount) continue;

      categoryTotals.set(rawName, round2((categoryTotals.get(rawName) || 0) + amount));

      if (!perDriver.has(driverId)) {
        perDriver.set(driverId, { cash: 0, card: 0, yandexCommission: 0, otherPartnerPayments: 0 });
      }
      const acc = perDriver.get(driverId);

      if (category.includes("cash") || category.includes("наличн")) {
        acc.cash += amount;
      } else if (
        category.includes("card") ||
        category.includes("online") ||
        category.includes("electron") ||
        category.includes("безнал")
      ) {
        acc.card += amount;
      } else if (
        category.includes("commission") ||
        category.includes("subvention") ||
        category.includes("комис")
      ) {
        acc.yandexCommission += Math.abs(amount);
      }      
      else if (category.includes("баланс")) {
        // ignorăm explicit categoriile legate de "balanța executorului"
        // (ex. "Прочие начисления ... на баланс исполнителей",
        // "Пополнение баланса от исполнителей") — nu sunt plăți reale, ci mișcări interne de sold.
      } else {
        // Orice altă categorie (bacșiș, bonus, compensare cursă, cost regim
        // de deplasare, corecție bonus etc.) intră la "alte plăți ale partenerului".
        acc.otherPartnerPayments += amount;
      }
    }

    if (page.length < limit) break;
    offset += limit;
    if (offset > 20000) break;
  }

  return {
    perDriver,
    debugSample,
    categoryTotals: Object.fromEntries(categoryTotals),
    range: { fromISO, toISO },
  };
}

export function computeParkCommission(totalGross) {
  const pct = Number(process.env.YANDEX_PARK_COMMISSION_PERCENT || 0);
  return Math.round(((totalGross * pct) / 100) * 100) / 100;
}
