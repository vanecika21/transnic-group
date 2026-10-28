"use client";
import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import {
  Car, Users, Calendar as CalendarIcon, Wallet, BarChart3, Plus, X,
  Trash2, Pencil, Check, AlertTriangle, ChevronLeft, ChevronRight,
  Phone, Loader2, TrendingUp, TrendingDown, Gauge, Shield, Wrench, Search,
  Download, History, FileText, Send, Bell
} from "lucide-react";

/* ---------------------------------------------------------------
   Taxi Fleet Pro Cloud (web version)
   Data stored in Supabase via /api/data.
   Payment model: weekly. Each month is split into 4 fixed sections
   (1-7, 8-14, 15-21, 22-end). Sundays don't count toward the plan.
   If a car doesn't reach its monthly plan, the shortfall is added
   automatically to the next month's plan.

   MODIFICĂRI FĂCUTE (față de versiunea anterioară):
   - NOU: Căutare comună (carMatchesSearch) în Calendar și Încasări zilnice:
     se caută după nume șofer ȘI după nr. de înmatriculare (plus marcă/model).
     Ignoră majusculele, diacriticele și spațiile ("ewm110" găsește "EWM 110").
     În Calendar se găsesc și șoferii care au adus bani pe mașina respectivă
     în luna afișată; în Încasări zilnice și șoferul trecut pe ziua respectivă.
   - NOU: Notificările de pe Dashboard se pot ascunde/afișa individual
     (buton "Notificări"). Implicit sunt ascunse "Încasări lipsă" și
     "Restanțe". Asigurările/reviziile arată lista cu numere doar la
     apăsarea butonului "Detalii". Setarea se ține în localStorage.
   - Scos butonul "Restaurează" (a rămas doar Backup = descarcă JSON)
   - NOU: Istoric modificări (audit log) — filă în meniul "Bani".
     Înregistrează: încasări (numerar/card/a lucrat), totaluri pe
     săptămână, cheltuieli, venituri extra, schimbări la mașini
     (șofer, tarif, status, dată început, ștergere) și ștergeri de șoferi.
     Se păstrează ultimele 1000 de înregistrări (AUDIT_MAX).
   - NOU: Fișa șoferului (buton în lista de șoferi): totaluri pe lună,
     zile cu încasare, zile libere, medie/zi, cheltuieli, istoric pe 6 luni,
     tabel pe zile și trimitere raport pe WhatsApp.
   - NOU: Avertisment când același șofer apare pe 2+ mașini în aceeași zi
     (Dashboard, Încasări zilnice) și când alegi un șofer deja alocat
     altei mașini (formularul de mașină).
   - Indicator de salvare: "Se salvează… / Salvat / Salvarea a eșuat"
   - Protecție: nu se trimite niciodată pe server o stare complet goală
     peste date care existau deja
   - update() nu mai salvează din interiorul setData (fără salvări duble)
---------------------------------------------------------------- */

const uid = () => Math.random().toString(36).slice(2, 10);
function nowMoldova() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Chisinau",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(new Date());
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  const hour = get("hour");
  return new Date(get("year"), get("month") - 1, get("day"), hour === 24 ? 0 : hour, get("minute"), get("second"));
}
const todayISO = () => {
  const n = nowMoldova();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
};
const MONTHS_RO = ["Ianuarie","Februarie","Martie","Aprilie","Mai","Iunie","Iulie","August","Septembrie","Octombrie","Noiembrie","Decembrie"];
const MONTHS_RO_SHORT = ["Ian","Feb","Mar","Apr","Mai","Iun","Iul","Aug","Sep","Oct","Noi","Dec"];

const emptyData = () => ({
  cars: [],
  drivers: [],
  payments: {},        // legacy, unused
  weeklyPayments: {},  // key `${y}-${mm}__${carId}__${weekIdx}`. Identificatorul principal e MAȘINA (id-ul mașinii).
                        // -> {year,month,carId,driverId,weekIdx,paidCash,paidCard,paidAmount,dailyAmounts}
                        // Fiecare zi din dailyAmounts poate avea și driverId = cine a adus banii în ziua aceea.
  weeklyPaymentsLegacy: null, // copie de siguranță a plăților ÎNAINTE de trecerea pe mașină (se creează o singură dată)
  migrationReport: null,      // raportul migrării (câte înregistrări, ce a fost dedublat, ce trebuie verificat manual)
  paymentsKeyedByCar: false,  // devine true după migrarea plăților pe mașină
  debtMigratedToDrivers: false, // flag vechi (restanțe pe șofer) — păstrat doar pentru compatibilitate
  expenses: [],
  incomes: [],
  insurances: [],
  inspections: [],
  auditLog: [],        // istoric modificări, cele mai noi primele (vezi pushAudit)
});

function fmtMoney(n) {
  const v = Number(n) || 0;
  return v.toLocaleString("ro-RO", { maximumFractionDigits: 0 }) + " lei";
}
// Formatare de dată consistentă (zi/lună/an), cu fusul orar FIXAT explicit la
// Europe/Chisinau — nu lăsăm fusul implicit al motorului JS (server vs.
// browser pot diferi) să schimbe ziua afișată pentru date de tip "doar dată"
// (ex: "2026-01-15"), care se parsează la miezul nopții UTC.
function fmtDateRO(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("ro-RO", {
    timeZone: "Europe/Chisinau",
    day: "2-digit", month: "2-digit", year: "numeric",
  }).format(d);
}
// Dată + oră (pentru istoricul de modificări), tot în fusul Europe/Chisinau.
function fmtDateTimeRO(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("ro-RO", {
    timeZone: "Europe/Chisinau",
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  }).format(d);
}
function isoDay(year, month, day) {
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
function daysInMonth(year, month) { return new Date(year, month + 1, 0).getDate(); }
function monthKey(y, m) { return `${y}-${String(m + 1).padStart(2, "0")}`; }
function isSunday(year, month, day) { return new Date(year, month, day).getDay() === 0; }

/* ---------------- CĂUTARE COMUNĂ (nume șofer + nr. înmatriculare) ----------------
   Folosită în Calendar și în Încasări zilnice. Caută în: nr. înmatriculare,
   marcă, model și numele șoferilor dați. Ignoră majusculele, diacriticele și
   spațiile, deci "ewm110" găsește "EWM 110", iar "bordian" găsește "Bordian Vladimir". */
const normSearch = (s) =>
  String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, "");

function carMatchesSearch(car, drivers, query) {
  const q = normSearch(query);
  if (!q) return true;
  const hay = [car.nr, car.marca, car.model, `${car.marca || ""}${car.model || ""}`];
  (drivers || []).filter(Boolean).forEach((d) => hay.push(d.nume));
  return hay.some((h) => normSearch(h).includes(q));
}

// Câte zile pe săptămână lucrează șoferul mașinii (5, 6 sau 7).
// Implicit 6 = păstrează comportamentul vechi (toate zilele, în afară de duminică).
const CAR_WORKDAYS_OPTIONS = [5, 6, 7];
function carWorkDays(car) {
  const wd = Number(car.workDays);
  return CAR_WORKDAYS_OPTIONS.includes(wd) ? wd : 6;
}
function isCarWorkDay(car, year, month, day) {
  const dow = new Date(year, month, day).getDay(); // 0=Duminică ... 6=Sâmbătă
  const wd = carWorkDays(car);
  if (wd >= 7) return true;
  if (wd === 5) return dow !== 0 && dow !== 6; // liber sâmbăta și duminica
  return dow !== 0; // 6 zile/săpt (implicit) — liber doar duminica
}

function workingDaysInRange(car, year, month, startDay, endDay) {
  let count = 0;
  for (let d = startDay; d <= endDay; d++) if (isCarWorkDay(car, year, month, d)) count++;
  return count;
}
function weekRanges(year, month) {
  const last = daysInMonth(year, month);
  return [[1, 7], [8, 14], [15, 21], [22, last]]
    .filter(([s]) => s <= last)
    .map(([s, e]) => ({ start: s, end: Math.min(e, last) }));
}
function workingDaysInMonth(car, year, month) { return workingDaysInRange(car, year, month, 1, daysInMonth(year, month)); }

function dailyRate(car, year, month) {
  if (car.tarifPeriod === "luna") {
    const wd = workingDaysInMonth(car, year, month);
    return wd > 0 ? (Number(car.tarif) || 0) / wd : 0;
  }
  return Number(car.tarif) || 0;
}
function fmtRate(car) {
  return car.tarifPeriod === "luna" ? `${fmtMoney(car.tarif)}/lună` : `${fmtMoney(car.tarif)}/zi`;
}

/* ---------------- ISTORIC TARIFE ----------------
   car.tarif / car.tarifPeriod = tariful ACTUAL (valabil pentru toate zilele
   care nu sunt acoperite de o perioadă din car.tarifHistory).
   car.tarifHistory = perioade din trecut: { id, from, to, tarif, tarifPeriod }
   - from gol = "de la început"; to = ultima zi (inclusiv) cu acel tarif.
   Planul se calculează zi cu zi, cu tariful valabil în ziua respectivă. */
function addDaysISO(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d + n);
  return isoDay(dt.getFullYear(), dt.getMonth(), dt.getDate());
}
function tariffOnDay(car, year, month, day) {
  const iso = isoDay(year, month, day);
  const periods = car.tarifHistory || [];
  for (const p of periods) {
    if (p.from && iso < p.from) continue;
    if (p.to && iso > p.to) continue;
    return { tarif: Number(p.tarif) || 0, tarifPeriod: p.tarifPeriod || "zi" };
  }
  return { tarif: Number(car.tarif) || 0, tarifPeriod: car.tarifPeriod || "zi" };
}
function dayRateOn(car, year, month, day) {
  const t = tariffOnDay(car, year, month, day);
  if (t.tarifPeriod === "luna") {
    const wd = workingDaysInMonth(car, year, month);
    return wd > 0 ? t.tarif / wd : 0;
  }
  return t.tarif;
}
function fmtTariffHistory(car) {
  const list = car.tarifHistory || [];
  if (!list.length) return "fără perioade";
  return list.map((p) => `${p.from ? fmtDateRO(p.from) : "început"}–${p.to ? fmtDateRO(p.to) : "?"}: ${fmtRate(p)}`).join("; ");
}

function weekKey(year, month, ownerId, weekIdx) { return `${year}-${String(month + 1).padStart(2, "0")}__${ownerId}__${weekIdx}`; }
function weeklyRecord(data, year, month, ownerId, weekIdx) { return data.weeklyPayments[weekKey(year, month, ownerId, weekIdx)] || null; }
function weeklyPaid(data, year, month, ownerId, weekIdx) {
  const r = weeklyRecord(data, year, month, ownerId, weekIdx);
  return r ? Number(r.paidAmount || 0) : 0;
}
// Restanța/plata se leagă de MAȘINĂ: id-ul principal e mereu id-ul mașinii.
// Dacă se schimbă șoferul, istoricul și restanța rămân pe mașină; fiecare zi
// păstrează în plus driverId-ul celui care a adus banii (vezi dailyAmounts).
function debtOwnerId(car) {
  return car.id;
}
const dayTotal = (d) => (d && d.worked !== false ? Number(d.cash || 0) + Number(d.card || 0) : 0);
function recDaySums(rec) {
  let cash = 0, card = 0;
  Object.values(rec.dailyAmounts || {}).forEach((d) => {
    if (d && d.worked !== false) { cash += Number(d.cash || 0); card += Number(d.card || 0); }
  });
  return { cash, card };
}

/* ---------------- ISTORIC MODIFICĂRI (audit log) ----------------
   Fiecare modificare importantă adaugă o înregistrare în data.auditLog,
   ÎN ACEEAȘI operație cu modificarea (deci se salvează împreună, atomic).
   Cele mai noi sunt primele. Păstrăm doar ultimele AUDIT_MAX ca blob-ul
   să nu crească la nesfârșit. */
const AUDIT_MAX = 1000;
function pushAudit(prev, entries) {
  const list = (Array.isArray(entries) ? entries : [entries]).filter(Boolean);
  const current = prev.auditLog || [];
  if (!list.length) return current;
  const at = new Date().toISOString();
  const added = list.map((e) => ({ id: uid(), at, ...e }));
  return [...added, ...current].slice(0, AUDIT_MAX);
}
const CAR_STATUS_LABELS = { activa: "Activă", service: "În service", vanduta: "Vândută" };
function dayMoneyState(d) {
  const worked = !d || d.worked !== false;
  return {
    worked,
    cash: worked && d ? Number(d.cash || 0) : 0,
    card: worked && d ? Number(d.card || 0) : 0,
  };
}
// Compară starea unei zile ÎNAINTE și DUPĂ; întoarce [] dacă nu s-a schimbat nimic important.
function dayAuditEntries(data, car, year, month, day, before, after, source) {
  const b = dayMoneyState(before), a = dayMoneyState(after);
  const planB = !!(before && before.countsInPlan), planA = !!(after && after.countsInPlan);
  if (b.worked === a.worked && b.cash === a.cash && b.card === a.card && planB === planA) return [];
  const drvId = (after && after.driverId) || car.driverId || null;
  const drv = data.drivers.find((d) => d.id === drvId);
  const parts = [];
  if (b.worked !== a.worked) parts.push(a.worked ? "marcat „A lucrat”" : "marcat „Nu a lucrat”");
  if (b.cash !== a.cash) parts.push(`numerar ${fmtMoney(b.cash)} → ${fmtMoney(a.cash)}`);
  if (b.card !== a.card) parts.push(`card ${fmtMoney(b.card)} → ${fmtMoney(a.card)}`);
  if (planB !== planA) parts.push(planA ? "ziua numără în plan" : "ziua nu mai numără în plan");
  const date = isoDay(year, month, day);
  return [{
    type: "incasare", source, carId: car.id, carNr: car.nr,
    driverId: drvId, driverName: drv ? drv.nume : "", date,
    text: `${car.nr}${drv ? " · " + drv.nume : ""} · ${fmtDateRO(date)}: ${parts.join(", ")}`,
  }];
}

/* ---------------- ȘOFER PE 2 MAȘINI ÎN ACEEAȘI ZI ----------------
   Un șofer "apare" pe o mașină într-o zi dacă acolo are încasare > 0 și
   ziua nu e marcată "Nu a lucrat". Dacă apare pe 2+ mașini → avertisment. */
function duplicateDriverDays(data, year, month, day) {
  const map = new Map(); // driverId -> Map(carId -> {carId, carNr, total})
  Object.values(data.weeklyPayments || {}).forEach((rec) => {
    if (!rec || rec.year !== year || rec.month !== month || !rec.dailyAmounts) return;
    const dd = rec.dailyAmounts[day];
    if (!dd || dd.worked === false) return;
    const total = Number(dd.cash || 0) + Number(dd.card || 0);
    if (total <= 0) return;
    const car = data.cars.find((c) => c.id === rec.carId);
    const driverId = dd.driverId || rec.driverId || (car && car.driverId);
    if (!driverId) return;
    if (!map.has(driverId)) map.set(driverId, new Map());
    map.get(driverId).set(rec.carId, { carId: rec.carId, carNr: car ? car.nr : "mașină ștearsă", total });
  });
  return Array.from(map.entries())
    .filter(([, byCar]) => byCar.size > 1)
    .map(([driverId, byCar]) => ({ driverId, driver: data.drivers.find((d) => d.id === driverId), cars: Array.from(byCar.values()) }))
    .filter((x) => x.driver);
}

/* ---------------- FIȘA ȘOFERULUI: zilele atribuite unui șofer ---------------- */
function driverDayRecords(data, driverId) {
  const out = [];
  Object.values(data.weeklyPayments || {}).forEach((rec) => {
    if (!rec || !rec.dailyAmounts) return;
    const car = data.cars.find((c) => c.id === rec.carId);
    Object.entries(rec.dailyAmounts).forEach(([day, dd]) => {
      if (!dd) return;
      const who = dd.driverId || rec.driverId || (car && car.driverId);
      if (who !== driverId) return;
      const worked = dd.worked !== false;
      out.push({
        year: rec.year, month: rec.month, day: Number(day),
        carId: rec.carId, carNr: car ? car.nr : "mașină ștearsă",
        worked, cash: worked ? Number(dd.cash || 0) : 0, card: worked ? Number(dd.card || 0) : 0,
        note: dd.note || "",
      });
    });
  });
  return out;
}

// Migrare unică, NEDISTRUCTIVĂ: plățile (până acum legate de șofer) trec pe mașină.
//  - înregistrările unice doar își schimbă cheia (conținutul rămâne identic);
//  - dacă 2+ înregistrări cad pe aceeași mașină+săptămână (schimb de șofer sau
//    dubluri vechi), se îmbină PE ZILE: aceeași zi cu aceeași sumă = dublură (se
//    păstrează una), sume diferite în aceeași zi = se adună, iar cazul intră în
//    raportul de verificare manuală;
//  - originalul complet rămâne în data.weeklyPaymentsLegacy;
//  - e ferită de rulare dublă prin flag-ul paymentsKeyedByCar.
function migrateWeeklyToCar(data) {
  if (data.paymentsKeyedByCar) return data;
  const wp = data.weeklyPayments || {};
  const groups = new Map();
  Object.entries(wp).forEach(([oldKey, rec]) => {
    if (!rec) return;
    const k = weekKey(rec.year, rec.month, rec.carId, rec.weekIdx);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push({ oldKey, rec });
  });
  const out = {};
  const report = { at: new Date().toISOString(), oldRecords: Object.keys(wp).length, newRecords: 0, merged: [], review: [] };
  groups.forEach((parts, k) => {
    if (parts.length === 1) {
      const rec = parts[0].rec;
      let r = { ...rec };
      if (rec.dailyAmounts) {
        const da = {};
        Object.entries(rec.dailyAmounts).forEach(([day, d]) => { da[day] = { ...d, driverId: d.driverId ?? rec.driverId ?? null }; });
        r.dailyAmounts = da;
      }
      out[k] = r;
      return;
    }
    // Îmbinare pe zile
    parts.sort((a, b) => (Object.keys(b.rec.dailyAmounts || {}).length ? 1 : 0) - (Object.keys(a.rec.dailyAmounts || {}).length ? 1 : 0) || String(a.rec.driverId || "").localeCompare(String(b.rec.driverId || "")));
    const base = parts[0].rec;
    const days = {};
    const pushDay = (day, d, drv) => {
      const entry = { ...d, driverId: d.driverId ?? drv ?? null };
      const cur = days[day];
      if (!cur) { days[day] = entry; return; }
      if (dayTotal(cur) === dayTotal(entry)) { // dublură
        if (dayTotal(cur) > 0 && cur.driverId !== entry.driverId) report.review.push({ key: k, day: Number(day), amounts: [dayTotal(cur)], reason: "aceeași sumă la 2 șoferi în aceeași zi — tratată ca dublură (păstrată una)" });
        return;
      }
      // sume diferite în aceeași zi: le adunăm ca să nu pierdem bani, și marcăm pentru verificare
      days[day] = {
        ...cur,
        cash: Number(cur.cash || 0) + Number(entry.cash || 0),
        card: Number(cur.card || 0) + Number(entry.card || 0),
        note: [cur.note, entry.note, `(migrare: sumă adunată din 2 înregistrări — ${dayTotal(cur)} + ${dayTotal(entry)})`].filter(Boolean).join(" | "),
      };
      report.review.push({ key: k, day: Number(day), amounts: [dayTotal(cur), dayTotal(entry)], reason: "zi cu sume diferite pe aceeași mașină — adunate" });
    };
    parts.forEach(({ rec }) => {
      const sums = recDaySums(rec);
      const storedCash = Number(rec.paidCash || 0), storedCard = Number(rec.paidCard || 0);
      const diff = (storedCash + storedCard) - (sums.cash + sums.card);
      const entries = Object.entries(rec.dailyAmounts || {});
      if (rec.mode === "total" && diff < 0) {
        // totalul introdus manual e mai mic decât detaliul pe zile: aplicația afișa deja totalul → îl respectăm
        entries.forEach(([day, d]) => pushDay(day, { ...d, origCash: d.cash, origCard: d.card, cash: 0, card: 0 }, rec.driverId));
        report.review.push({ key: k, reason: "total introdus manual mai mic decât zilele; zilele au fost puse pe 0 (valorile vechi în origCash/origCard)" });
      } else {
        entries.forEach(([day, d]) => pushDay(day, d, rec.driverId));
        if (rec.mode === "total" && diff > 0 && !entries.length) {
          // sumă totală fără zile — o punem pe prima zi liberă din săptămână
          const r = weekRanges(rec.year, rec.month)[rec.weekIdx];
          let slot = r ? r.start : 1;
          while (r && days[slot] && slot < r.end) slot++;
          const extra = { worked: true, cash: Math.max(storedCash - sums.cash, 0), card: Math.max(storedCard - sums.card, 0), note: "Sumă totală migrată (fără detaliu pe zile)", driverId: rec.driverId ?? null };
          if (days[slot]) { days[slot] = { ...days[slot], cash: Number(days[slot].cash || 0) + extra.cash, card: Number(days[slot].card || 0) + extra.card, note: [days[slot].note, extra.note].filter(Boolean).join(" | ") }; }
          else days[slot] = extra;
          report.review.push({ key: k, day: slot, reason: "sumă totală fără zile atașată ca zi" });
        }
      }
    });
    const m = recDaySums({ dailyAmounts: days });
    out[k] = {
      ...base,
      mode: Object.keys(days).length ? "daily" : base.mode,
      dailyAmounts: days,
      paidCash: m.cash,
      paidCard: m.card,
      paidAmount: m.cash + m.card,
      driverId: parts[parts.length - 1].rec.driverId ?? base.driverId ?? null,
    };
    if (!Object.keys(days).length) { out[k].paidCash = parts.reduce((s, p) => s + Number(p.rec.paidCash || 0), 0); out[k].paidCard = parts.reduce((s, p) => s + Number(p.rec.paidCard || 0), 0); out[k].paidAmount = out[k].paidCash + out[k].paidCard; }
    report.merged.push({ key: k, from: parts.map((p) => p.oldKey) });
  });
  report.newRecords = Object.keys(out).length;
  return {
    ...data,
    weeklyPaymentsLegacy: data.weeklyPaymentsLegacy || wp,
    weeklyPayments: out,
    migrationReport: report,
    paymentsKeyedByCar: true,
    debtMigratedToDrivers: true,
  };
}
function isCarActive(car) {
  return !car.status || car.status === "activa";
}
function isDayActive(car, year, month, day) {
  if (!car.startDate) return true;
  const s = new Date(car.startDate);
  const startOnly = new Date(s.getFullYear(), s.getMonth(), s.getDate());
  return new Date(year, month, day) >= startOnly;
}
function isDayElapsed(year, month, day) {
  const now = nowMoldova();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return new Date(year, month, day) <= today;
}
const UNAVAILABLE_REASONS = {
  service: "În service",
  avariata: "Avariată",
  vacanta: "Vacanță / concediu",
  altul: "Altul",
};
// O mașină poate avea mai multe perioade (service, avariată, vacanța șoferului
// etc.) în care nu lucrează. Zilele din aceste perioade nu intră deloc în
// planul de chirie — nici măcar dacă mașina e altfel "Activă".
// O perioadă poate fi și NEDEFINITĂ (fără dată de final) — ține până o
// închizi tu manual, util când nu știi dinainte cât stă mașina în reparație.
function isDayUnavailable(car, year, month, day) {
  const periods = car.unavailablePeriods || [];
  if (!periods.length) return false;
  const dateOnly = new Date(year, month, day);
  return periods.some((p) => {
    if (!p.start) return false;
    const s = new Date(p.start);
    const sOnly = new Date(s.getFullYear(), s.getMonth(), s.getDate());
    if (dateOnly < sOnly) return false;
    if (!p.end) return true; // nedefinită — se aplică la nesfârșit până e închisă
    const e = new Date(p.end);
    const eOnly = new Date(e.getFullYear(), e.getMonth(), e.getDate());
    return dateOnly <= eOnly;
  });
}
function unavailablePeriodOnDay(car, year, month, day) {
  const periods = car.unavailablePeriods || [];
  const dateOnly = new Date(year, month, day);
  return periods.find((p) => {
    if (!p.start) return false;
    const s = new Date(p.start);
    const sOnly = new Date(s.getFullYear(), s.getMonth(), s.getDate());
    if (dateOnly < sOnly) return false;
    if (!p.end) return true;
    const e = new Date(p.end);
    const eOnly = new Date(e.getFullYear(), e.getMonth(), e.getDate());
    return dateOnly <= eOnly;
  }) || null;
}
// Zilele din săptămână care intră în plan (lista, ca să putem aplica tariful pe fiecare zi).
function countedDays(data, car, year, month, weekIdx, ranges) {
  if (!isCarActive(car)) return [];
  const r = ranges[weekIdx];
  const rec = weeklyRecord(data, year, month, debtOwnerId(car), weekIdx);
  const counted = [];
  for (let d = r.start; d <= r.end; d++) {
    const dayRec = rec && rec.dailyAmounts ? rec.dailyAmounts[d] : null;
    if (!isCarWorkDay(car, year, month, d)) {
      // Zi liberă în mod normal (de regulă duminica) — o numărăm în plan
      // DOAR dacă a fost bifată explicit opțiunea "Numără în plan" pe ziua asta.
      if (!(isSunday(year, month, d) && dayRec && dayRec.countsInPlan)) continue;
    }
    if (!isDayActive(car, year, month, d)) continue;
    if (!isDayElapsed(year, month, d)) continue;
    if (isDayUnavailable(car, year, month, d)) continue;
    if (dayRec && dayRec.worked === false) continue;
    counted.push(d);
  }
  return counted;
}
function workingDaysEffective(data, car, year, month, weekIdx, ranges) {
  return countedDays(data, car, year, month, weekIdx, ranges).length;
}
// Planul de bază al unei săptămâni = suma tarifelor valabile în fiecare zi numărată.
function weekPlanBase(data, car, year, month, weekIdx, ranges) {
  return countedDays(data, car, year, month, weekIdx, ranges).reduce((s, d) => s + dayRateOn(car, year, month, d), 0);
}
function monthlyPlanBase(data, car, year, month) {
  const ranges = weekRanges(year, month);
  let total = 0;
  for (let i = 0; i < ranges.length; i++) total += weekPlanBase(data, car, year, month, i, ranges);
  return total;
}
function monthlyPaid(data, year, month, ownerId) {
  const ranges = weekRanges(year, month);
  let sum = 0;
  for (let i = 0; i < ranges.length; i++) sum += weeklyPaid(data, year, month, ownerId, i);
  return sum;
}
function hasAnyRecordForMonth(data, year, month, ownerId) {
  const ranges = weekRanges(year, month);
  for (let i = 0; i < ranges.length; i++) if (weeklyRecord(data, year, month, ownerId, i)) return true;
  return false;
}
function prevMonth(year, month) { return month === 0 ? { year: year - 1, month: 11 } : { year, month: month - 1 }; }

function carryoverFromPrevMonth(data, car, year, month) {
  if (!isCarActive(car)) return 0;
  const pm = prevMonth(year, month);
  if (car.startDate) {
    const s = new Date(car.startDate);
    const startOnly = new Date(s.getFullYear(), s.getMonth(), s.getDate());
    const lastDayPrevMonth = new Date(pm.year, pm.month, daysInMonth(pm.year, pm.month));
    if (lastDayPrevMonth < startOnly) return 0;
  }
  if (!hasAnyRecordForMonth(data, pm.year, pm.month, debtOwnerId(car))) return 0;
  const plan = monthlyPlanWithCarry(data, car, pm.year, pm.month);
  const paid = monthlyPaid(data, pm.year, pm.month, debtOwnerId(car));
  return Math.max(plan - paid, 0);
}
function monthlyPlanWithCarry(data, car, year, month) {
  return monthlyPlanBase(data, car, year, month) + carryoverFromPrevMonth(data, car, year, month);
}
function weekPlan(data, car, year, month, weekIdx, ranges) {
  if (!isCarActive(car)) return 0;
  const base = weekPlanBase(data, car, year, month, weekIdx, ranges);
  return weekIdx === 0 ? base + carryoverFromPrevMonth(data, car, year, month) : base;
}

// Restanța unui șofer nu trebuie să dispară doar pentru că nu mai conduce
// nicio mașină acum (a fost mutat pe alta, sau a plecat). Funcția asta
// adună restanțele rămase din toate înregistrările lui, indiferent de lună.
function driverDebtsWithoutCar(data) {
  if (data.paymentsKeyedByCar) return []; // restanța e acum pe mașină, nu mai există restanțe fără mașină pe șofer
  const assignedDriverIds = new Set(data.cars.filter((c) => c.driverId).map((c) => c.driverId));
  const byDriver = new Map(); // driverId -> total restanță
  Object.values(data.weeklyPayments || {}).forEach((rec) => {
    if (!rec) return;
    const driverId = rec.driverId;
    if (!driverId || assignedDriverIds.has(driverId)) return;
    const driver = data.drivers.find((d) => d.id === driverId);
    if (!driver) return;
    const car = data.cars.find((c) => c.id === rec.carId);
    if (!car) return;
    const ranges = weekRanges(rec.year, rec.month);
    const due = weekPlan(data, car, rec.year, rec.month, rec.weekIdx, ranges);
    const paid = Number(rec.paidAmount || 0);
    const rest = Math.max(due - paid, 0);
    if (!rest) return;
    byDriver.set(driverId, (byDriver.get(driverId) || 0) + rest);
  });
  return Array.from(byDriver.entries())
    .map(([driverId, rest]) => ({ driver: data.drivers.find((d) => d.id === driverId), rest }))
    .filter((r) => r.driver && r.rest > 0)
    .sort((a, b) => b.rest - a.rest);
}

const DAY_NAMES_RO = ["Duminică", "Luni", "Marți", "Miercuri", "Joi", "Vineri", "Sâmbătă"];
// Duminica apare mereu în calendar (ca să poți nota dacă a lucrat/a adus bani),
// dar NU intră automat în planul/calculul zilelor lucrate — doar dacă bifezi
// explicit "Numără în plan" pe rândul ei (vezi DayRow + workingDaysEffective).
function weekDays(car, year, month, weekIdx, ranges) {
  const r = ranges[weekIdx];
  const days = [];
  for (let d = r.start; d <= r.end; d++) {
    if (isCarWorkDay(car, year, month, d)) days.push(d);
    else if (isSunday(year, month, d)) days.push(d);
  }
  return days;
}
function dayLabel(year, month, day) {
  return `${DAY_NAMES_RO[new Date(year, month, day).getDay()].slice(0, 3)} ${day}`;
}
function weeklyMode(data, year, month, ownerId, weekIdx) {
  const r = weeklyRecord(data, year, month, ownerId, weekIdx);
  return r && r.mode === "daily" ? "daily" : "total";
}
function statusOf(due, paid) {
  if (paid == null) return "pending";
  if (paid <= 0) return "unpaid";
  if (paid >= due) return "paid";
  return "partial";
}
function currentWeekIndex(year, month, day, ranges) {
  const idx = ranges.findIndex((r) => day >= r.start && day <= r.end);
  return idx === -1 ? ranges.length - 1 : idx;
}

// O stare complet goală (fără mașini, șoferi sau plăți) — folosită ca
// protecție: nu o trimitem niciodată pe server dacă înainte existau date.
function isDataEmpty(d) {
  return !d || (
    (!d.cars || !d.cars.length) &&
    (!d.drivers || !d.drivers.length) &&
    !Object.keys(d.weeklyPayments || {}).length
  );
}

export default function TaxiFleetPro() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saveState, setSaveState] = useState("idle"); // idle | saving | saved | error
  const [tab, setTab] = useState("dashboard");

  // dataRef = mereu cea mai recentă stare (chiar și între două randări).
  // Așa update() nu mai depinde de callback-ul lui setData și nu mai salvează de 2 ori.
  const dataRef = useRef(null);
  const hadDataRef = useRef(false);
  const applyData = useCallback((next) => {
    dataRef.current = next;
    if (!isDataEmpty(next)) hadDataRef.current = true;
    setData(next);
  }, []);

  const loadData = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    try {
      const res = await fetch("/api/data");
      if (!res.ok) throw new Error("server");
      const json = await res.json();
      if (json && json.error) throw new Error(json.error);
      // IMPORTANT: dacă serverul nu a putut fi citit, NU trecem pe un stat gol
      // în tăcere — asta ar risca să fie confundat cu "flotă nouă" și salvat
      // peste datele reale. Doar un răspuns valid (chiar și "niciun rând încă")
      // e tratat ca stare goală legitimă.
      applyData({ ...emptyData(), ...(json ? json.data || {} : {}) });
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, [applyData]);

  useEffect(() => { loadData(); }, [loadData]);

  const pendingSaveRef = useRef(null);
  const savingRef = useRef(false);

  const persist = useCallback(async (next) => {
    // PROTECȚIE: dacă starea de trimis e complet goală, dar înainte existau
    // date, NU o trimitem — ar șterge totul de pe server.
    if (isDataEmpty(next) && hadDataRef.current) {
      setSaveState("error");
      return;
    }
    // Ținem minte mereu CEA MAI RECENTĂ stare de trimis. Dacă o cerere e deja
    // în curs, noua stare așteaptă — nu pornim o a doua cerere în paralel.
    // Așa nu mai există risc ca un răspuns "vechi" să ajungă după unul "nou"
    // și să suprascrie date proaspăt introduse (exact bugul din Finanțe).
    pendingSaveRef.current = next;
    setSaveState("saving");
    if (savingRef.current) return;
    savingRef.current = true;
    let ok = true;
    while (pendingSaveRef.current) {
      const toSend = pendingSaveRef.current;
      pendingSaveRef.current = null;
      try {
        const res = await fetch("/api/data", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(toSend),
        });
        ok = res.ok;
      } catch {
        ok = false;
      }
    }
    savingRef.current = false;
    setSaveState(ok ? "saved" : "error");
  }, []);

  const update = useCallback((fn) => {
    const prev = dataRef.current;
    if (!prev) return;
    const next = fn(prev);
    applyData(next);
    persist(next);
  }, [applyData, persist]);

  // Dacă ții aplicația deschisă simultan pe telefon și pe calculator (sau în
  // mai multe tab-uri), tab-ul rămas mai mult timp în fundal poate avea date
  // vechi în memorie — și, dacă faci acolo orice modificare, trimite ÎNTREG
  // blob-ul vechi peste cel proaspăt salvat de pe celălalt dispozitiv (exact
  // "restanța revine la suma veche"). Ca să reducem riscul, reîncărcăm datele
  // de pe server automat de fiecare dată când revii pe tab-ul ăsta (dacă nu e
  // deja o salvare în curs / în așteptare).
  useEffect(() => {
    const onFocus = async () => {
      if (savingRef.current || pendingSaveRef.current) return;
      try {
        const res = await fetch("/api/data");
        if (!res.ok) return;
        const json = await res.json();
        if (!json || !json.data) return;
        // Dacă între timp a început o salvare, nu suprascriem cu date vechi.
        if (savingRef.current || pendingSaveRef.current) return;
        const fresh = { ...emptyData(), ...json.data };
        // Nu lăsăm niciodată un răspuns "gol" (fără mașini/șoferi) să
        // înlocuiască date locale care chiar există — mai bine păstrăm ce
        // avem local decât să riscăm să ștergem ceva din greșeală.
        const freshEmpty = (!fresh.cars || !fresh.cars.length) && (!fresh.drivers || !fresh.drivers.length);
        const prev = dataRef.current;
        if (freshEmpty && prev && ((prev.cars && prev.cars.length) || (prev.drivers && prev.drivers.length))) return;
        applyData(fresh);
      } catch {
        // conexiune indisponibilă — păstrăm ce avem local
      }
    };
    const onVisible = () => { if (document.visibilityState === "visible") onFocus(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [applyData]);

  // Migrare unică: plățile/restanțele trec pe MAȘINĂ (id principal = id mașină).
  // Rulează o singură dată (flag paymentsKeyedByCar), păstrează originalul în
  // weeklyPaymentsLegacy și salvează imediat. Dacă datele arată suspect de
  // goale, NU trimitem nimic pe server — setăm doar flag-ul local.
  useEffect(() => {
    if (!data || data.paymentsKeyedByCar) return;
    const looksEmpty = (!data.cars || !data.cars.length) && (!data.drivers || !data.drivers.length) && !Object.keys(data.weeklyPayments || {}).length;
    if (looksEmpty) {
      applyData({ ...data, paymentsKeyedByCar: true, debtMigratedToDrivers: true });
      return;
    }
    const migrated = migrateWeeklyToCar(data);
    applyData(migrated);
    persist(migrated);
  }, [data, persist, applyData]);

  // ---- Backup ----
  const onBackup = () => {
    const cur = dataRef.current;
    if (!cur) return;
    const blob = new Blob([JSON.stringify(cur, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `taxi-fleet-backup-${todayISO()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  if (loadFailed) {
    return (
      <Shell tab={tab} setTab={setTab} loading>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, color: "var(--muted)", padding: "60px 20px", textAlign: "center" }}>
          <AlertTriangle size={28} color="var(--red)" />
          <div style={{ color: "var(--text)", fontWeight: 700 }}>Nu am putut încărca datele de pe server.</div>
          <div style={{ fontSize: 12.5, maxWidth: 340 }}>Nu s-a schimbat nimic — datele tale sunt în siguranță pe server. Verifică conexiunea și încearcă din nou.</div>
          <button className="btn primary" onClick={loadData}>Reîncearcă</button>
        </div>
      </Shell>
    );
  }

  if (loading || !data) {
    return (
      <Shell tab={tab} setTab={setTab} loading>
        <div style={{ display: "flex", alignItems: "center", gap: 10, color: "var(--muted)", padding: "60px 0", justifyContent: "center" }}>
          <Loader2 className="spin" size={20} />
          <span>Se încarcă datele flotei…</span>
        </div>
      </Shell>
    );
  }

  return (
    <Shell tab={tab} setTab={setTab} saveState={saveState} onBackup={onBackup}>
      {tab === "dashboard" && <Dashboard data={data} setTab={setTab} />}
      {tab === "cars" && <CarsView data={data} update={update} />}
      {tab === "drivers" && <DriversView data={data} update={update} />}
      {tab === "calendar" && <WeeklyCalendarView data={data} update={update} />}
      {tab === "insurance" && <InsuranceView data={data} update={update} />}
      {tab === "inspection" && <InspectionView data={data} update={update} />}
      {tab === "finance" && <FinanceView data={data} update={update} />}
      {tab === "reports" && <ReportsView data={data} />}
      {tab === "earnings" && <EarningsView data={data} update={update} />}
      {tab === "audit" && <AuditView data={data} />}
    </Shell>
  );
}

/* ============================== SHELL ============================== */

function SaveBadge({ state }) {
  if (state === "saving") {
    return <div style={{ fontSize: 12.5, color: "var(--muted)", display: "flex", alignItems: "center", gap: 5 }}><Loader2 className="spin" size={13} />Se salvează…</div>;
  }
  if (state === "error") {
    return <div className="save-warn"><AlertTriangle size={14} />Salvarea a eșuat</div>;
  }
  if (state === "saved") {
    return <div style={{ fontSize: 12.5, color: "var(--green)", display: "flex", alignItems: "center", gap: 5 }}><Check size={13} />Salvat</div>;
  }
  return null;
}

function BackupControls({ onBackup }) {
  if (!onBackup) return null;
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      <button type="button" className="btn" style={{ padding: "6px 10px", fontSize: 12 }} onClick={onBackup} aria-label="Descarcă backup al datelor" title="Descarcă o copie a tuturor datelor">
        <Download size={13} />Backup
      </button>
    </div>
  );
}

function Shell({ tab, setTab, children, loading, saveState, onBackup }) {
  // Anul din footer NU se calculează direct în JSX cu `new Date()`. Dacă am
  // face asta, Shell fiind randat mereu (inclusiv pe ramura de "loading"),
  // orice diferență de moment/fus orar/cache între randarea de pe server și
  // prima randare din browser ar produce o eroare de hidratare React
  // (#418/#423/#425). În loc de asta: pornim cu `null` (identic pe server și
  // pe primul randare din client) și completăm anul abia după montare, într-un
  // useEffect — moment în care suntem garantat doar pe client.
  const [footerYear, setFooterYear] = useState(null);
  useEffect(() => {
    setFooterYear(new Date().getFullYear());
  }, []);

  const navGroups = [
    { label: "General", items: [
      { id: "dashboard", label: "Dashboard", icon: Gauge },
    ] },
    { label: "Introducere rapidă", items: [
      { id: "earnings", label: "Încasări zilnice", icon: TrendingUp },
    ] },
    { label: "Flotă", items: [
      { id: "cars", label: "Mașini", icon: Car },
      { id: "drivers", label: "Șoferi", icon: Users },
      { id: "calendar", label: "Calendar", icon: CalendarIcon },
    ] },
    { label: "Documente", items: [
      { id: "insurance", label: "Asigurări", icon: Shield },
      { id: "inspection", label: "Revizie tehnică", icon: Wrench },
    ] },
    { label: "Bani", items: [
      { id: "finance", label: "Finanțe", icon: Wallet },
      { id: "reports", label: "Rapoarte", icon: BarChart3 },
      { id: "audit", label: "Istoric modificări", icon: History },
    ] },
  ];
  const flatNav = navGroups.flatMap((g) => g.items);
  const current = flatNav.find((n) => n.id === tab);

  return (
    <div style={{ "--bg": "#14171c", "--panel": "#1c2029", "--amber": "#f2b705", "--orange": "#f2841c", "--green": "#2bb673", "--red": "#e5484d", "--text": "#eae7e0", "--muted": "#8b93a1", "--border": "#2a303b" }}
      className="tfp-root">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&family=IBM+Plex+Mono:wght@500;600&display=swap');
        .tfp-root{background:var(--bg);color:var(--text);min-height:100vh;font-family:'Inter',system-ui,sans-serif;display:flex;flex-direction:row;font-size:14.5px}
        .tfp-root *{box-sizing:border-box}
        .disp{font-family:'Space Grotesk',sans-serif}
        .mono{font-family:'IBM Plex Mono',monospace;font-variant-numeric:tabular-nums}
        .spin{animation:spin 1s linear infinite}
        @keyframes spin{to{transform:rotate(360deg)}}

        /* --- Sidebar (desktop) --- */
        .tfp-sidebar{width:236px;flex-shrink:0;background:var(--panel);border-right:1px solid var(--border);display:flex;flex-direction:column;position:sticky;top:0;height:100vh;overflow-y:auto}
        .tfp-sidebar-header{padding:22px 18px 18px;display:flex;align-items:center;gap:10px}
        .tfp-badge{width:36px;height:36px;border-radius:9px;background:repeating-linear-gradient(45deg,var(--amber) 0 6px,#14171c 6px 12px);display:flex;align-items:center;justify-content:center;flex-shrink:0}
        .tfp-sidebar-nav{padding:6px 12px 16px;display:flex;flex-direction:column;gap:2px;flex:1}
        .tfp-group-label{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);padding:16px 10px 6px;font-weight:700}
        .tfp-group-label:first-child{padding-top:6px}
        .tfp-sidebar .tfp-navbtn{width:100%;justify-content:flex-start;padding:10px 12px;font-size:14.5px}
        .tfp-sidebar-foot{padding:14px 18px;border-top:1px solid var(--border);font-size:11.5px;color:var(--muted);display:flex;flex-direction:column;gap:10px}

        /* --- Mobile top bar + horizontal nav --- */
        .tfp-topbar{display:none;padding:16px 18px;border-bottom:1px solid var(--border);align-items:center;justify-content:space-between;gap:12px;position:sticky;top:0;background:var(--bg);z-index:5}
        .tfp-title{display:flex;align-items:center;gap:10px}
        .tfp-nav{display:none;gap:4px;padding:10px 14px;border-bottom:1px solid var(--border);overflow-x:auto;-webkit-overflow-scrolling:touch}
        .tfp-nav::-webkit-scrollbar{display:none}

        .tfp-navbtn{display:flex;align-items:center;gap:9px;padding:9px 13px;border-radius:8px;border:1px solid transparent;background:transparent;color:var(--muted);font-size:14px;font-weight:600;white-space:nowrap;cursor:pointer;transition:.15s}
        .tfp-navbtn:hover{color:var(--text);background:#ffffff0a}
        .tfp-navbtn.active{color:#14171c;background:var(--amber)}

        .tfp-main{flex:1;min-width:0;display:flex;flex-direction:column}
        .tfp-pageheader{padding:22px 24px 4px;display:flex;align-items:center;justify-content:space-between;gap:12px;max-width:1100px;margin:0 auto;width:100%}
        .tfp-pagetitle{font-size:21px;font-weight:700}
        .tfp-body{padding:16px 24px 28px;flex:1;max-width:1100px;margin:0 auto;width:100%}
        .card{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:18px}
        .btn{display:inline-flex;align-items:center;gap:6px;padding:10px 16px;border-radius:8px;border:1px solid var(--border);background:#ffffff0d;color:var(--text);font-size:14px;font-weight:600;cursor:pointer;transition:.15s}
        .btn:hover{background:#ffffff1a}
        .btn:disabled{opacity:.45;cursor:not-allowed}
        .btn.primary{background:var(--amber);color:#14171c;border-color:var(--amber)}
        .btn.primary:hover{background:#ffcb2b}
        .btn.danger{color:var(--red);border-color:#e5484d33}
        .btn.danger:hover{background:#e5484d1a}
        input,select,textarea{background:#0f1216;border:1px solid var(--border);color:var(--text);border-radius:7px;padding:10px 12px;font-size:14.5px;font-family:inherit;width:100%}
        input:focus,select:focus,textarea:focus{outline:2px solid var(--amber);outline-offset:1px}
        button:focus-visible{outline:2px solid var(--amber);outline-offset:2px}
        table{width:100%;border-collapse:collapse;font-size:14px}
        th{text-align:left;color:var(--muted);font-weight:600;padding:10px 12px;border-bottom:1px solid var(--border);font-size:12px;text-transform:uppercase;letter-spacing:.04em}
        td{padding:11px 12px;border-bottom:1px solid #ffffff0a}
        tbody tr:hover td{background:#ffffff06}
        .modal-backdrop{position:fixed;inset:0;background:#000a;display:flex;align-items:center;justify-content:center;z-index:50;padding:16px}
        .modal{background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:22px;width:100%;max-width:440px;max-height:88vh;overflow:auto}
        .pill{display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:99px;font-size:12px;font-weight:600}
        .field{margin-bottom:14px}
        .field label{display:block;font-size:12.5px;color:var(--muted);margin-bottom:6px;font-weight:600}
        .save-warn{font-size:12.5px;color:var(--red);display:flex;align-items:center;gap:5px}
        .quickbtn{flex:1;padding:10px 6px;border-radius:8px;border:1px solid var(--border);background:#ffffff0d;color:var(--text);font-size:13px;font-weight:700;cursor:pointer}
        .quickbtn:hover{background:#ffffff1a}
        .tfp-footer{padding:16px 24px;border-top:1px solid var(--border);text-align:center;font-size:12px;color:var(--muted)}
        .finance-grid{grid-template-columns:1fr 1fr}
        .weekrow{padding:10px 0;border-top:1px solid #ffffff0a}
        .weekrow:first-child{border-top:none}
        .modetoggle{display:flex;border:1px solid var(--border);border-radius:7px;overflow:hidden}
        .modetoggle button{padding:7px 10px;font-size:12px;font-weight:600;background:transparent;color:var(--muted);border:none;cursor:pointer}
        .modetoggle button+button{border-left:1px solid var(--border)}
        .modetoggle button.active{background:var(--amber);color:#14171c}
        .dayrow{padding-bottom:7px;border-bottom:1px solid #ffffff08}
        .dayrow:last-child{border-bottom:none;padding-bottom:0}

        @media (max-width: 900px){
          .tfp-sidebar{display:none}
          .tfp-topbar{display:flex}
          .tfp-nav{display:flex}
          .tfp-pageheader{display:none}
        }
        @media (max-width: 680px){
          .finance-grid{grid-template-columns:1fr}
          .tfp-navbtn{padding:11px 14px;font-size:14px}
          .btn{padding:11px 15px;font-size:14.5px}
          .tfp-body{padding:14px}
          th,td{padding:10px 8px}
          input,select,textarea{padding:11px 12px;font-size:15px}
          .weekrow{grid-template-columns:1fr;gap:6px}
        }
      `}</style>

      {/* Sidebar — vizibilă pe ecrane late (calculator) */}
      <aside className="tfp-sidebar">
        <div className="tfp-sidebar-header">
          <div className="tfp-badge"><Car size={17} color="#14171c" /></div>
          <div>
            <div className="disp" style={{ fontSize: 16.5, fontWeight: 700, lineHeight: 1.15 }}>Taxi Fleet Pro</div>
            <div style={{ fontSize: 11, color: "var(--muted)" }}>Gestionare taxi</div>
          </div>
        </div>
        <nav className="tfp-sidebar-nav">
          {navGroups.map((g) => (
            <React.Fragment key={g.label}>
              <div className="tfp-group-label">{g.label}</div>
              {g.items.map((n) => (
                <button key={n.id} className={"tfp-navbtn" + (tab === n.id ? " active" : "")} onClick={() => !loading && setTab(n.id)}>
                  <n.icon size={16} />{n.label}
                </button>
              ))}
            </React.Fragment>
          ))}
        </nav>
        <div className="tfp-sidebar-foot">
          <SaveBadge state={saveState} />
          <BackupControls onBackup={onBackup} />
        </div>
      </aside>

      <div className="tfp-main">
        {/* Bară de sus — vizibilă doar pe mobil, înlocuiește sidebar-ul */}
        <div className="tfp-topbar">
          <div className="tfp-title">
            <div className="tfp-badge"><Car size={16} color="#14171c" /></div>
            <div>
              <div className="disp" style={{ fontSize: 17, fontWeight: 700, lineHeight: 1.1 }}>Taxi Fleet Pro</div>
              <div style={{ fontSize: 11, color: "var(--muted)" }}>Gestionare taxi</div>
            </div>
          </div>
          <SaveBadge state={saveState} />
        </div>

        <div className="tfp-nav">
          {flatNav.map((n) => (
            <button key={n.id} className={"tfp-navbtn" + (tab === n.id ? " active" : "")} onClick={() => !loading && setTab(n.id)}>
              <n.icon size={15} />{n.label}
            </button>
          ))}
        </div>

        {/* Titlul paginii curente — vizibil doar pe calculator, unde nu mai există header cu numele aplicației */}
        {current && (
          <div className="tfp-pageheader">
            <div className="disp tfp-pagetitle">{current.label}</div>
            <SaveBadge state={saveState} />
          </div>
        )}

        <div className="tfp-body">{children}</div>

        {/* Backup și pe mobil (sidebar-ul e ascuns acolo) */}
        {onBackup && (
          <div className="tfp-footer" style={{ display: "flex", justifyContent: "center", paddingBottom: 6, borderTop: "none" }}>
            <div className="tfp-mobile-backup"><BackupControls onBackup={onBackup} /></div>
          </div>
        )}
        <div className="tfp-footer">© {footerYear ?? ""} Nichita Ivanov. Toate drepturile rezervate.</div>
      </div>
    </div>
  );
}


/* ============================== DASHBOARD ============================== */

// Notificările de pe Dashboard pot fi ascunse/afișate individual.
// Preferințele se țin în localStorage (separat pe fiecare dispozitiv).
const ALERT_DEFAULTS = { earnings: false, arrears: false, insurance: true, inspection: true };
const ALERT_LABELS = {
  earnings: "Mașini fără încasările de azi",
  arrears: "Mașini cu restanță în săptămână",
  insurance: "Asigurări care expiră",
  inspection: "Revizii tehnice care expiră",
};

function Dashboard({ data, setTab }) {
  const now = nowMoldova();
  const year = now.getFullYear(), month = now.getMonth(), day = now.getDate();
  const ranges = weekRanges(year, month);
  const wIdx = currentWeekIndex(year, month, day, ranges);
  const range = ranges[wIdx];

  // Preferințe notificări (se citesc din localStorage abia după montare,
  // ca să nu apară erori de hidratare).
  const [alertPrefs, setAlertPrefs] = useState(ALERT_DEFAULTS);
  const [showAlertSettings, setShowAlertSettings] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  useEffect(() => {
    try {
      const raw = localStorage.getItem("tfp-alert-prefs");
      if (raw) setAlertPrefs({ ...ALERT_DEFAULTS, ...JSON.parse(raw) });
    } catch {}
  }, []);
  const togglePref = (k) => setAlertPrefs((p) => {
    const n = { ...p, [k]: !p[k] };
    try { localStorage.setItem("tfp-alert-prefs", JSON.stringify(n)); } catch {}
    return n;
  });

  const activeCars = data.cars.filter(isCarActive).length;
  const inService = data.cars.filter((c) => c.status === "service").length;

  const weekRows = data.cars.map((c) => {
    const rec = weeklyRecord(data, year, month, debtOwnerId(c), wIdx);
    const due = weekPlan(data, c, year, month, wIdx, ranges);
    const paid = rec ? rec.paidAmount : null;
    return { car: c, due, paid, status: statusOf(due, paid) };
  });
  const incomeWeek = weekRows.reduce((s, r) => s + (r.paid || 0), 0);
  const expensesWeek = data.expenses
    .filter((e) => e.data && e.data.startsWith(monthKey(year, month)) && Number(e.data.slice(8, 10)) >= range.start && Number(e.data.slice(8, 10)) <= range.end)
    .reduce((s, e) => s + Number(e.suma || 0), 0);
  const profitWeek = incomeWeek - expensesWeek;
  const problemCount = weekRows.filter((r) => r.status === "unpaid" || r.status === "partial").length;

  const carNr = (id) => { const c = data.cars.find((x) => x.id === id); return c ? c.nr : "mașină ștearsă"; };
  const expiryText = (days) => (days < 0 ? "expirată" : days === 0 ? "expiră azi" : `în ${days} zile`);
  // Alertele ignoră mașinile care nu sunt active (în service / vândute) —
  // oricum nu lucrează. Rămân în filele Asigurări / Revizie tehnică.
  const carIsActiveById = (id) => { const c = data.cars.find((x) => x.id === id); return !c || isCarActive(c); };
  const insuranceAlerts = data.insurances.filter((ins) => { const d = daysUntil(ins.dataExpirare); return d != null && d <= 30 && carIsActiveById(ins.carId); });
  const inspectionAlerts = data.inspections.filter((insp) => { const d = daysUntil(insp.dataExpirare); return d != null && d <= 30 && carIsActiveById(insp.carId); });
  const insuranceDetail = insuranceAlerts.map((i) => `${carNr(i.carId)} (${i.tip ? i.tip.toLowerCase() + ", " : ""}${expiryText(daysUntil(i.dataExpirare))})`).join(" · ");
  const inspectionDetail = inspectionAlerts.map((i) => `${carNr(i.carId)} (${expiryText(daysUntil(i.dataExpirare))})`).join(" · ");

  // Cash/card ADUSE AZI — introduse manual de tine în Calendar (modul "Pe zile"), NU din Yandex.
  const cashCardToday = (() => {
    let cash = 0, card = 0;
    Object.values(data.weeklyPayments || {}).forEach((rec) => {
      if (rec.year !== year || rec.month !== month || !rec.dailyAmounts) return;
      const d = rec.dailyAmounts[day];
      if (!d || d.worked === false) return;
      cash += Number(d.cash || 0);
      card += Number(d.card || 0);
    });
    return { cash, card };
  })();

  const todayRanges = weekRanges(year, month);
  const todayWeekIdx = currentWeekIndex(year, month, day, todayRanges);
  const carsWithDriver = data.cars.filter((c) => c.driverId && isCarActive(c));
  const missingTodayCount = carsWithDriver.filter((c) => {
    const rec = weeklyRecord(data, year, month, debtOwnerId(c), todayWeekIdx);
    const dayRec = rec && rec.dailyAmounts ? rec.dailyAmounts[day] : null;
    return !dayRec;
  }).length;

  // Același șofer cu încasări pe 2+ mașini azi → posibilă greșeală de introducere.
  const dupToday = duplicateDriverDays(data, year, month, day);

  const stats = [
    { label: "Mașini", value: data.cars.length, icon: Car, sub: `${activeCars} active · ${inService} service` },
    { label: "Șoferi", value: data.drivers.length, icon: Users, sub: `${data.drivers.filter((d) => d.activ).length} activi` },
    { label: "Cash adus azi", value: fmtMoney(cashCardToday.cash), icon: Wallet, sub: todayISO(), mono: true },
    { label: "Card adus azi", value: fmtMoney(cashCardToday.card), icon: TrendingUp, sub: todayISO(), mono: true, accent: true },
    { label: "Profit săptămâna", value: fmtMoney(profitWeek), icon: profitWeek >= 0 ? TrendingUp : TrendingDown, sub: `${fmtMoney(incomeWeek)} adus − ${fmtMoney(expensesWeek)} cheltuit`, mono: true, accent: profitWeek >= 0 },
  ];

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginBottom: 20 }}>
        {stats.map((s) => (
          <div className="card" key={s.label}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <div style={{ fontSize: 12, color: "var(--muted)", fontWeight: 600 }}>{s.label}</div>
              <s.icon size={16} color={s.accent === false ? "var(--red)" : s.accent === true ? "var(--green)" : "var(--amber)"} />
            </div>
            <div className={s.mono ? "mono" : "disp"} style={{ fontSize: 24, fontWeight: 700, marginTop: 6 }}>{s.value}</div>
            <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 3 }}>{s.sub}</div>
          </div>
        ))}
      </div>

      <DuplicateDriverWarning items={dupToday} dateLabel="azi" />

      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 10 }}>
        <button className="btn" style={{ padding: "6px 10px", fontSize: 12 }} onClick={() => setShowAlertSettings((v) => !v)}>
          <Bell size={13} />Notificări
        </button>
      </div>

      {showAlertSettings && (
        <div className="card" style={{ marginBottom: 14, display: "flex", flexDirection: "column", gap: 10 }}>
          {Object.entries(ALERT_LABELS).map(([k, label]) => (
            <label key={k} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13.5, cursor: "pointer" }}>
              <input type="checkbox" style={{ width: "auto" }} checked={alertPrefs[k]} onChange={() => togglePref(k)} />
              {label}
            </label>
          ))}
        </div>
      )}

      {alertPrefs.earnings && missingTodayCount > 0 && (
        <div className="card" style={{ borderColor: "#f2b70555", marginBottom: 12, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "12px 16px" }}>
          <TrendingUp size={17} color="var(--amber)" />
          <div style={{ fontSize: 13.5 }}>{missingTodayCount} mașin{missingTodayCount === 1 ? "ă nu are" : "i nu au"} încă încasările de azi introduse.</div>
          <button className="btn primary" style={{ marginLeft: "auto" }} onClick={() => setTab("earnings")}>Introdu acum</button>
        </div>
      )}
      {alertPrefs.arrears && problemCount > 0 && (
        <div className="card" style={{ borderColor: "#e5484d55", marginBottom: 12, display: "flex", alignItems: "center", gap: 10, padding: "12px 16px" }}>
          <AlertTriangle size={17} color="var(--red)" />
          <div style={{ fontSize: 13.5 }}>{problemCount} mașin{problemCount === 1 ? "ă are" : "i au"} restanță în săptămâna asta.</div>
          <button className="btn" style={{ marginLeft: "auto" }} onClick={() => setTab("calendar")}>Deschide calendar</button>
        </div>
      )}
      {alertPrefs.insurance && insuranceAlerts.length > 0 && (
        <div className="card" style={{ borderColor: "#f2841c55", marginBottom: 12, display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", flexWrap: "wrap" }}>
          <Shield size={17} color="var(--orange)" />
          <div style={{ fontSize: 13.5, flex: 1, minWidth: 200 }}>
            {insuranceAlerts.length} asigurăr{insuranceAlerts.length === 1 ? "e expiră" : "i expiră"} în curând sau au expirat.
            {showDetails && <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>{insuranceDetail}</div>}
          </div>
          <button className="btn" style={{ padding: "6px 10px", fontSize: 12 }} onClick={() => setShowDetails((v) => !v)}>{showDetails ? "Ascunde" : "Detalii"}</button>
          <button className="btn" onClick={() => setTab("insurance")}>Deschide</button>
        </div>
      )}
      {alertPrefs.inspection && inspectionAlerts.length > 0 && (
        <div className="card" style={{ borderColor: "#f2841c55", marginBottom: 12, display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", flexWrap: "wrap" }}>
          <Wrench size={17} color="var(--orange)" />
          <div style={{ fontSize: 13.5, flex: 1, minWidth: 200 }}>
            {inspectionAlerts.length} revizi{inspectionAlerts.length === 1 ? "e tehnică expiră" : "i tehnice expiră"} în curând sau au expirat.
            {showDetails && <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>{inspectionDetail}</div>}
          </div>
          <button className="btn" onClick={() => setTab("inspection")}>Deschide</button>
        </div>
      )}

      <div className="card">
        <div style={{ fontWeight: 700, marginBottom: 4 }} className="disp">Săptămâna aceasta, pe mașini</div>
        <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 10 }}>{range.start}–{range.end} {MONTHS_RO[month]}</div>
        {weekRows.filter((r) => r.due > 0).length === 0 ? (
          <EmptyState text="Niciun tarif zilnic setat încă la mașinile tale — adaugă tarife în secțiunea Mașini ca să apară aici planul săptămânal de chirie." />
        ) : (
          <table>
            <thead><tr><th>Mașină</th><th>Șofer</th><th>Plan săpt.</th><th>Adus</th><th>Stare</th></tr></thead>
            <tbody>
              {weekRows.filter((r) => r.due > 0).map(({ car, status, due, paid }) => {
                const driver = data.drivers.find((d) => d.id === car.driverId);
                return (
                  <tr key={car.id}>
                    <td>{car.nr} <span style={{ color: "var(--muted)" }}>· {car.marca} {car.model}</span></td>
                    <td>{driver ? driver.nume : <span style={{ color: "var(--muted)" }}>—</span>}</td>
                    <td className="mono">{fmtMoney(due)}</td>
                    <td className="mono">{paid == null ? "—" : fmtMoney(paid)}</td>
                    <td><StatusPill status={status} restanta={due - (paid || 0)} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

    </div>
  );
}

function StatusPill({ status, restanta }) {
  const map = {
    paid: { label: "Plan îndeplinit", bg: "#2bb67322", color: "var(--green)" },
    unpaid: { label: "Neachitat", bg: "#e5484d22", color: "var(--red)" },
    partial: { label: `Mai are ${fmtMoney(restanta)}`, bg: "#f2841c22", color: "var(--orange)" },
    pending: { label: "Așteptăm", bg: "#f2b70522", color: "var(--amber)" },
  };
  const m = map[status] || map.pending;
  return <span className="pill" style={{ background: m.bg, color: m.color }}>{m.label}</span>;
}

function EmptyState({ text }) {
  return <div style={{ color: "var(--muted)", fontSize: 13.5, padding: "18px 0", textAlign: "center" }}>{text}</div>;
}

// Avertisment: același șofer a adus bani pe 2+ mașini în aceeași zi.
function DuplicateDriverWarning({ items, dateLabel }) {
  if (!items || items.length === 0) return null;
  return (
    <div className="card" style={{ borderColor: "#e5484d55", marginBottom: 16, display: "flex", alignItems: "flex-start", gap: 10 }}>
      <AlertTriangle size={17} color="var(--red)" style={{ marginTop: 2, flexShrink: 0 }} />
      <div style={{ fontSize: 13.5 }}>
        {items.length === 1 ? "Un șofer apare" : `${items.length} șoferi apar`} pe mai multe mașini în aceeași zi{dateLabel ? ` (${dateLabel})` : ""}. Verifică să nu fie o greșeală de introducere.
        <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 6, display: "flex", flexDirection: "column", gap: 2 }}>
          {items.map((it) => (
            <div key={it.driverId}>
              <b style={{ color: "var(--text)" }}>{it.driver.nume}</b>: {it.cars.map((c) => `${c.carNr} (${fmtMoney(c.total)})`).join(" · ")}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function useEscape(onClose) {
  useEffect(() => {
    const h = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
}

function ConfirmModal({ message, onConfirm, onCancel }) {
  useEscape(onCancel);
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" role="alertdialog" aria-modal="true" style={{ maxWidth: 360 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
          <AlertTriangle size={20} color="var(--red)" />
          <div className="disp" style={{ fontWeight: 700, fontSize: 16 }}>Confirmă ștergerea</div>
        </div>
        <div style={{ fontSize: 13.5, marginBottom: 18 }}>{message}</div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn danger" style={{ flex: 1, justifyContent: "center" }} onClick={onConfirm}><Trash2 size={15} />Șterge</button>
          <button className="btn" style={{ flex: 1, justifyContent: "center" }} onClick={onCancel}>Anulează</button>
        </div>
      </div>
    </div>
  );
}

/* ============================== CARS ============================== */

function CarsView({ data, update }) {
  const [editing, setEditing] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const empty = { nr: "", marca: "", model: "", an: "", tarif: 157, tarifPeriod: "zi", workDays: 6, driverId: "", status: "activa", unavailablePeriods: [] };
  const sortedCars = useMemo(
    () => [...data.cars].sort((a, b) => a.nr.localeCompare(b.nr, "ro", { sensitivity: "base", numeric: true })),
    [data.cars]
  );

  const save = (car) => {
    update((prev) => {
      const old = car.id ? prev.cars.find((c) => c.id === car.id) : null;
      const saved = car.id ? car : { ...car, id: uid() };
      const cars = car.id ? prev.cars.map((c) => (c.id === car.id ? car : c)) : [...prev.cars, saved];
      const drvName = (id) => { const d = prev.drivers.find((x) => x.id === id); return d ? d.nume : "nealocat"; };
      const entries = [];
      if (!old) {
        entries.push({ type: "masina", carId: saved.id, carNr: saved.nr, text: `Mașină adăugată: ${saved.nr} (${fmtRate(saved)})` });
      } else {
        if (old.nr !== saved.nr) entries.push({ type: "masina", carId: saved.id, carNr: saved.nr, text: `Număr schimbat: ${old.nr} → ${saved.nr}` });
        if ((old.driverId || "") !== (saved.driverId || "")) {
          entries.push({ type: "masina", carId: saved.id, carNr: saved.nr, driverId: saved.driverId || null, driverName: saved.driverId ? drvName(saved.driverId) : "", text: `Șofer schimbat la ${saved.nr}: ${drvName(old.driverId)} → ${drvName(saved.driverId)}` });
        }
        if (Number(old.tarif) !== Number(saved.tarif) || (old.tarifPeriod || "zi") !== (saved.tarifPeriod || "zi")) {
          entries.push({ type: "masina", carId: saved.id, carNr: saved.nr, text: `Tarif ${saved.nr}: ${fmtRate(old)} → ${fmtRate(saved)}` });
        }
        if (JSON.stringify(old.tarifHistory || []) !== JSON.stringify(saved.tarifHistory || [])) {
          entries.push({ type: "masina", carId: saved.id, carNr: saved.nr, text: `Istoric tarife ${saved.nr}: ${fmtTariffHistory(old)} → ${fmtTariffHistory(saved)}` });
        }
        if ((old.status || "activa") !== (saved.status || "activa")) {
          entries.push({ type: "masina", carId: saved.id, carNr: saved.nr, text: `Status ${saved.nr}: ${CAR_STATUS_LABELS[old.status || "activa"] || old.status} → ${CAR_STATUS_LABELS[saved.status || "activa"] || saved.status}` });
        }
      }
      return { ...prev, cars, auditLog: pushAudit(prev, entries) };
    });
    setEditing(null);
  };
  const remove = (id) => update((prev) => {
    const old = prev.cars.find((c) => c.id === id);
    const entries = old ? [{ type: "masina", carId: id, carNr: old.nr, text: `Mașină ștearsă: ${old.nr}` }] : [];
    return { ...prev, cars: prev.cars.filter((c) => c.id !== id), auditLog: pushAudit(prev, entries) };
  });

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <div className="disp" style={{ fontSize: 18, fontWeight: 700 }}>Mașini ({data.cars.length})</div>
        <button className="btn primary" onClick={() => setEditing({ ...empty })}><Plus size={15} />Adaugă mașină</button>
      </div>

      {data.cars.length === 0 ? (
        <div className="card"><EmptyState text="Nicio mașină încă. Adaugă prima mașină pentru a începe." /></div>
      ) : (
        <div className="card" style={{ overflowX: "auto" }}>
          <table>
            <thead><tr><th>Nr.</th><th>Marcă / Model</th><th>An</th><th>Tarif</th><th>Zile/săpt</th><th>Șofer</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {sortedCars.map((c) => {
                const driver = data.drivers.find((d) => d.id === c.driverId);
                return (
                  <tr key={c.id}>
                    <td style={{ fontWeight: 600 }}>{c.nr}</td>
                    <td>{c.marca} {c.model}</td>
                    <td className="mono">{c.an || <span style={{ color: "var(--muted)" }}>—</span>}</td>
                    <td className="mono">{fmtRate(c)}</td>
                    <td className="mono">{carWorkDays(c)}</td>
                    <td>{driver ? driver.nume : <span style={{ color: "var(--muted)" }}>nealocat</span>}</td>
                    <td>
                      <CarStatusPill status={c.status} />
                      {(() => {
                        const now = nowMoldova();
                        const p = unavailablePeriodOnDay(c, now.getFullYear(), now.getMonth(), now.getDate());
                        return p ? (
                          <div style={{ marginTop: 4 }}>
                            <span className="pill" style={{ background: "#f2841c22", color: "var(--orange)" }}>{UNAVAILABLE_REASONS[p.reason] || "Nu lucrează"} azi</span>
                          </div>
                        ) : null;
                      })()}
                    </td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <button className="btn" style={{ padding: 6, marginRight: 6 }} aria-label={`Editează mașina ${c.nr}`} onClick={() => setEditing(c)}><Pencil size={14} /></button>
                      <button className="btn danger" style={{ padding: 6 }} aria-label={`Șterge mașina ${c.nr}`} onClick={() => setConfirm({ message: `Ștergi mașina ${c.nr}? Plățile ei rămân în istoric, dar fără mașină. Dacă a fost doar vândută, e mai bine să schimbi statusul în „Vândută". Acțiunea nu poate fi anulată.`, action: () => remove(c.id) })}><Trash2 size={14} /></button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <Modal onClose={() => setEditing(null)} title={editing.id ? "Editează mașina" : "Adaugă mașină"}>
          <CarForm car={editing} cars={data.cars} drivers={data.drivers} onSave={save} onCancel={() => setEditing(null)} />
        </Modal>
      )}
      {confirm && (
        <ConfirmModal message={confirm.message} onCancel={() => setConfirm(null)} onConfirm={() => { confirm.action(); setConfirm(null); }} />
      )}
    </div>
  );
}

function CarStatusPill({ status }) {
  const map = {
    activa: { label: "Activă", bg: "#2bb67322", color: "var(--green)" },
    service: { label: "În service", bg: "#f2b70522", color: "var(--amber)" },
    vanduta: { label: "Vândută", bg: "#8b93a122", color: "var(--muted)" },
  };
  const m = map[status] || map.activa;
  return <span className="pill" style={{ background: m.bg, color: m.color }}>{m.label}</span>;
}

function CarForm({ car, cars, drivers, onSave, onCancel }) {
  const [f, setF] = useState(car);
  const [err, setErr] = useState("");
  const [effFrom, setEffFrom] = useState(() => todayISO());
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  // Tariful actual a fost schimbat față de cel salvat? (doar la editare)
  const tarifChanged = !!car.id && (Number(f.tarif) !== Number(car.tarif) || (f.tarifPeriod || "zi") !== (car.tarifPeriod || "zi"));
  // Șoferul ales e deja alocat la ALTĂ mașină? (avertisment, nu blocăm salvarea)
  const driverClash = f.driverId ? (cars || []).find((c) => c.id !== f.id && c.driverId === f.driverId) : null;
  const trySave = () => {
    const nr = (f.nr || "").trim();
    if (!nr) { setErr("Completează numărul de înmatriculare."); return; }
    const dup = (cars || []).some((c) => c.id !== f.id && (c.nr || "").trim().toLowerCase() === nr.toLowerCase());
    if (dup) { setErr(`Există deja o mașină cu numărul ${nr}.`); return; }
    if (Number(f.tarif) < 0) { setErr("Tariful nu poate fi negativ."); return; }
    const history = (f.tarifHistory || []).map((p) => ({ ...p, tarif: Number(p.tarif) || 0 }));
    for (const p of history) {
      if (!p.to) { setErr("La fiecare perioadă din istoricul de tarife completează „Până la”."); return; }
      if (p.from && p.from > p.to) { setErr("În istoricul de tarife, „De la” nu poate fi după „Până la”."); return; }
      if (p.tarif < 0) { setErr("Un tarif din istoric este negativ."); return; }
    }
    // Tariful actual s-a schimbat și ai ales o dată: tariful VECHI se păstrează
    // ca perioadă în trecut, până în ziua dinaintea datei alese.
    if (tarifChanged && effFrom) {
      const lastTo = history.reduce((m, p) => (p.to > m ? p.to : m), "");
      const from = lastTo ? addDaysISO(lastTo, 1) : "";
      const to = addDaysISO(effFrom, -1);
      if (from && from > to) { setErr("Data de aplicare se suprapune cu istoricul de tarife. Alege o dată mai târzie sau corectează istoricul."); return; }
      history.push({ id: uid(), from, to, tarif: Number(car.tarif) || 0, tarifPeriod: car.tarifPeriod || "zi" });
    }
    for (let i = 0; i < history.length; i++) {
      for (let j = i + 1; j < history.length; j++) {
        const a = history[i], b = history[j];
        if ((a.from || "0000-00-00") <= b.to && (b.from || "0000-00-00") <= a.to) { setErr("Două perioade din istoricul de tarife se suprapun."); return; }
      }
    }
    setErr("");
    onSave({ ...f, nr, tarifHistory: history });
  };
  return (
    <div>
      <div className="field"><label>Număr înmatriculare</label><input value={f.nr} onChange={(e) => set("nr", e.target.value)} placeholder="EWM 110" /></div>
      <div style={{ display: "flex", gap: 10 }}>
        <div className="field" style={{ flex: 1 }}><label>Marcă</label><input value={f.marca} onChange={(e) => set("marca", e.target.value)} placeholder="BMW" /></div>
        <div className="field" style={{ flex: 1 }}><label>Model</label><input value={f.model} onChange={(e) => set("model", e.target.value)} placeholder="520D" /></div>
      </div>
      <div className="field"><label>An fabricație</label><input type="number" value={f.an || ""} onChange={(e) => set("an", e.target.value)} placeholder="2018" /></div>
      <div className="field">
        <label>Tarif</label>
        <div style={{ display: "flex", gap: 8 }}>
          <input type="number" style={{ flex: 1 }} value={f.tarif} onChange={(e) => set("tarif", Number(e.target.value))} />
          <select style={{ flex: 1 }} value={f.tarifPeriod || "zi"} onChange={(e) => set("tarifPeriod", e.target.value)}>
            <option value="zi">lei / zi</option>
            <option value="luna">lei / lună</option>
          </select>
        </div>
      </div>
      {tarifChanged && (
        <div className="field">
          <label>Noul tarif se aplică de la</label>
          <input type="date" value={effFrom} onChange={(e) => setEffFrom(e.target.value)} />
          <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>
            Zilele dinainte rămân cu tariful vechi ({fmtRate(car)}). Dacă lași data goală, noul tarif se aplică și pentru trecut (corecție).
          </div>
        </div>
      )}
      <div className="field">
        <label>Istoric tarife (perioade din trecut cu alt tarif)</label>
        <TariffHistoryEditor periods={f.tarifHistory || []} defaultTarif={f.tarif} defaultPeriod={f.tarifPeriod || "zi"} onChange={(next) => set("tarifHistory", next)} />
      </div>
      <div className="field">
        <label>Zile lucrate pe săptămână</label>
        <select value={f.workDays || 6} onChange={(e) => set("workDays", Number(e.target.value))}>
          <option value={7}>7 zile (fără zi liberă)</option>
          <option value={6}>6 zile (liber duminica)</option>
          <option value={5}>5 zile (liber sâmbătă și duminică)</option>
        </select>
        <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>
          Determină câte zile intră în planul săptămânal/lunar al mașinii.
        </div>
      </div>
      <div className="field">
        <label>Șofer alocat</label>
        <select value={f.driverId} onChange={(e) => set("driverId", e.target.value)}>
          <option value="">— nealocat —</option>
          {drivers.map((d) => <option key={d.id} value={d.id}>{d.nume}</option>)}
        </select>
        {driverClash && (
          <div style={{ fontSize: 11.5, color: "var(--orange)", marginTop: 5, display: "flex", alignItems: "center", gap: 5 }}>
            <AlertTriangle size={13} />Acest șofer este deja alocat la mașina {driverClash.nr}.
          </div>
        )}
      </div>
      <div className="field">
        <label>Status</label>
        <select value={f.status} onChange={(e) => set("status", e.target.value)}>
          <option value="activa">Activă</option>
          <option value="service">În service</option>
          <option value="vanduta">Vândută</option>
        </select>
      </div>
      <div className="field">
        <label>Perioade în care nu lucrează (service, avarie, vacanță…)</label>
        <div style={{ fontSize: 11, color: "var(--muted)", marginTop: -2, marginBottom: 8 }}>
          Zilele din aceste perioade nu intră în planul de chirie, indiferent de status.
        </div>
        <UnavailablePeriodsEditor periods={f.unavailablePeriods || []} onChange={(next) => set("unavailablePeriods", next)} />
      </div>
      {err && <div className="save-warn" style={{ marginTop: 10 }}><AlertTriangle size={14} />{err}</div>}
      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <button className="btn primary" style={{ flex: 1, justifyContent: "center" }} onClick={trySave}><Check size={15} />Salvează</button>
        <button className="btn" onClick={onCancel}>Anulează</button>
      </div>
    </div>
  );
}

function TariffHistoryEditor({ periods, defaultTarif, defaultPeriod, onChange }) {
  const upd = (id, patch) => onChange(periods.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  const remove = (id) => onChange(periods.filter((p) => p.id !== id));
  const add = () => onChange([...periods, { id: uid(), from: "", to: "", tarif: Number(defaultTarif) || 0, tarifPeriod: defaultPeriod || "zi" }]);
  const lbl = { fontSize: 11, color: "var(--muted)", marginBottom: 3 };
  return (
    <div>
      <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 8 }}>
        Tariful de mai sus se aplică pentru toate zilele care nu sunt acoperite de o perioadă de aici. Poți edita oricând perioadele vechi; planul și restanțele se recalculează automat. „De la” gol = de la început.
      </div>
      {periods.map((p) => (
        <div key={p.id} style={{ background: "#ffffff0d", borderRadius: 8, padding: 10, marginBottom: 8 }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 130px" }}>
              <div style={lbl}>De la</div>
              <input type="date" value={p.from || ""} onChange={(e) => upd(p.id, { from: e.target.value })} />
            </div>
            <div style={{ flex: "1 1 130px" }}>
              <div style={lbl}>Până la (inclusiv)</div>
              <input type="date" value={p.to || ""} onChange={(e) => upd(p.id, { to: e.target.value })} />
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
            <input type="number" style={{ flex: 1 }} value={p.tarif} onChange={(e) => upd(p.id, { tarif: e.target.value })} />
            <select style={{ flex: 1 }} value={p.tarifPeriod || "zi"} onChange={(e) => upd(p.id, { tarifPeriod: e.target.value })}>
              <option value="zi">lei / zi</option>
              <option value="luna">lei / lună</option>
            </select>
            <button type="button" className="btn danger" style={{ padding: 6 }} aria-label="Șterge perioada de tarif" onClick={() => remove(p.id)}><Trash2 size={13} /></button>
          </div>
        </div>
      ))}
      <button type="button" className="btn" onClick={add}><Plus size={14} />Adaugă perioadă cu alt tarif</button>
    </div>
  );
}

function UnavailablePeriodsEditor({ periods, onChange }) {
  const [reason, setReason] = useState("service");
  const [start, setStart] = useState(() => todayISO());
  const [end, setEnd] = useState(() => todayISO());
  const [undefinedPeriod, setUndefinedPeriod] = useState(false);
  const [note, setNote] = useState("");

  const add = () => {
    if (!start) return;
    if (!undefinedPeriod && !end) return;
    onChange([...periods, { id: uid(), reason, start, end: undefinedPeriod ? null : end, note: note.trim() }]);
    setNote("");
  };
  const remove = (id) => onChange(periods.filter((p) => p.id !== id));
  const closeToday = (id) => onChange(periods.map((p) => (p.id === id ? { ...p, end: todayISO() } : p)));

  return (
    <div>
      {periods.length > 0 && (
        <div style={{ marginBottom: 10, display: "flex", flexDirection: "column", gap: 6 }}>
          {periods
            .slice()
            .sort((a, b) => (a.start < b.start ? -1 : 1))
            .map((p) => (
              <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 8, background: "#ffffff0d", borderRadius: 8, padding: "7px 10px", flexWrap: "wrap" }}>
                <span className="pill" style={{ background: "#f2841c22", color: "var(--orange)" }}>{UNAVAILABLE_REASONS[p.reason] || "Altul"}</span>
                <span style={{ fontSize: 12.5 }}>
                  {fmtDateRO(p.start)} – {p.end ? fmtDateRO(p.end) : <span style={{ color: "var(--amber)" }}>nedeterminat</span>}
                  {p.note ? <span style={{ color: "var(--muted)" }}> · {p.note}</span> : null}
                </span>
                {!p.end && (
                  <button type="button" className="btn" style={{ padding: "4px 8px", fontSize: 11.5, marginLeft: "auto" }} onClick={() => closeToday(p.id)}>Închide azi</button>
                )}
                <button type="button" className="btn danger" style={{ padding: 5, marginLeft: p.end ? "auto" : 0 }} aria-label="Șterge perioada" onClick={() => remove(p.id)}><Trash2 size={13} /></button>
              </div>
            ))}
        </div>
      )}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <select style={{ flex: "1 1 140px" }} value={reason} onChange={(e) => setReason(e.target.value)}>
          {Object.entries(UNAVAILABLE_REASONS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
        </select>
        <input type="date" style={{ flex: "1 1 130px" }} value={start} onChange={(e) => setStart(e.target.value)} />
        {!undefinedPeriod && (
          <input type="date" style={{ flex: "1 1 130px" }} value={end} onChange={(e) => setEnd(e.target.value)} />
        )}
      </div>
      <label style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8, fontSize: 12.5, color: "var(--muted)", cursor: "pointer" }}>
        <input type="checkbox" checked={undefinedPeriod} onChange={(e) => setUndefinedPeriod(e.target.checked)} style={{ width: "auto" }} />
        Perioadă nedefinită (nu știu până când) — rămâne activă până o închid manual
      </label>
      <input style={{ marginTop: 8 }} placeholder="Notă (opțional)" value={note} onChange={(e) => setNote(e.target.value)} />
      <button type="button" className="btn" style={{ marginTop: 8 }} onClick={add}><Plus size={14} />Adaugă perioadă</button>
    </div>
  );
}

/* ============================== DRIVERS ============================== */

function DriversView({ data, update }) {
  const [editing, setEditing] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [profileId, setProfileId] = useState(null);
  const profileDriver = profileId ? data.drivers.find((d) => d.id === profileId) : null;
  const empty = { nume: "", telefon: "", activ: true };

  const save = (drv) => {
    update((prev) => {
      const isNew = !drv.id;
      const saved = isNew ? { ...drv, id: uid() } : drv;
      const drivers = isNew ? [...prev.drivers, saved] : prev.drivers.map((d) => (d.id === drv.id ? drv : d));
      const entries = isNew ? [{ type: "sofer", driverId: saved.id, driverName: saved.nume, text: `Șofer adăugat: ${saved.nume}` }] : [];
      return { ...prev, drivers, auditLog: pushAudit(prev, entries) };
    });
    setEditing(null);
  };
  const remove = (id) => {
    update((prev) => {
      const old = prev.drivers.find((d) => d.id === id);
      const entries = old ? [{ type: "sofer", driverId: id, driverName: old.nume, text: `Șofer șters: ${old.nume}` }] : [];
      return {
        ...prev,
        drivers: prev.drivers.filter((d) => d.id !== id),
        cars: prev.cars.map((c) => (c.driverId === id ? { ...c, driverId: "" } : c)),
        auditLog: pushAudit(prev, entries),
      };
    });
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <div className="disp" style={{ fontSize: 18, fontWeight: 700 }}>Șoferi ({data.drivers.length})</div>
        <button className="btn primary" onClick={() => setEditing({ ...empty })}><Plus size={15} />Adaugă șofer</button>
      </div>

      {data.drivers.length === 0 ? (
        <div className="card"><EmptyState text="Niciun șofer încă." /></div>
      ) : (
        <div className="card" style={{ overflowX: "auto" }}>
          <table>
            <thead><tr><th>Nume</th><th>Telefon</th><th>Mașină</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {data.drivers.map((d) => {
                const car = data.cars.find((c) => c.driverId === d.id);
                return (
                  <tr key={d.id}>
                    <td style={{ fontWeight: 600 }}>{d.nume}</td>
                    <td>{d.telefon ? <span style={{ display: "flex", alignItems: "center", gap: 5 }}><Phone size={12} />{d.telefon}</span> : "—"}</td>
                    <td>{car ? car.nr : <span style={{ color: "var(--muted)" }}>nealocat</span>}</td>
                    <td><span className="pill" style={{ background: d.activ ? "#2bb67322" : "#8b93a122", color: d.activ ? "var(--green)" : "var(--muted)" }}>{d.activ ? "Activ" : "Inactiv"}</span></td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <button className="btn" style={{ padding: 6, marginRight: 6 }} aria-label={`Fișa șoferului ${d.nume}`} title="Fișa șoferului" onClick={() => setProfileId(d.id)}><FileText size={14} /></button>
                      <button className="btn" style={{ padding: 6, marginRight: 6 }} aria-label={`Editează șoferul ${d.nume}`} onClick={() => setEditing(d)}><Pencil size={14} /></button>
                      <button className="btn danger" style={{ padding: 6 }} aria-label={`Șterge șoferul ${d.nume}`} onClick={() => setConfirm({ message: `Ștergi șoferul ${d.nume}? Istoricul plăților rămâne, dar fără numele lui. Dacă nu mai lucrează la tine, e mai bine să-l pui „Inactiv". Acțiunea nu poate fi anulată.`, action: () => remove(d.id) })}><Trash2 size={14} /></button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <Modal onClose={() => setEditing(null)} title={editing.id ? "Editează șofer" : "Adaugă șofer"}>
          <DriverForm driver={editing} onSave={save} onCancel={() => setEditing(null)} />
        </Modal>
      )}
      {profileDriver && (
        <Modal onClose={() => setProfileId(null)} title={`Fișa șoferului — ${profileDriver.nume}`} maxWidth={780}>
          <DriverProfile data={data} driver={profileDriver} />
        </Modal>
      )}
      {confirm && (
        <ConfirmModal message={confirm.message} onCancel={() => setConfirm(null)} onConfirm={() => { confirm.action(); setConfirm(null); }} />
      )}
    </div>
  );
}

function DriverForm({ driver, onSave, onCancel }) {
  const [f, setF] = useState(driver);
  const [err, setErr] = useState("");
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const trySave = () => {
    if (!(f.nume || "").trim()) { setErr("Completează numele șoferului."); return; }
    setErr("");
    onSave({ ...f, nume: f.nume.trim() });
  };
  return (
    <div>
      <div className="field"><label>Nume complet</label><input value={f.nume} onChange={(e) => set("nume", e.target.value)} placeholder="Bordian Vladimir" /></div>
      <div className="field"><label>Telefon</label><input value={f.telefon} onChange={(e) => set("telefon", e.target.value)} placeholder="+373 6X XXX XXX" /></div>
      <div className="field" style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input type="checkbox" style={{ width: "auto" }} checked={f.activ} onChange={(e) => set("activ", e.target.checked)} id="activ-chk" />
        <label htmlFor="activ-chk" style={{ margin: 0 }}>Șofer activ</label>
      </div>
      {err && <div className="save-warn" style={{ marginTop: 10 }}><AlertTriangle size={14} />{err}</div>}
      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <button className="btn primary" style={{ flex: 1, justifyContent: "center" }} onClick={trySave}><Check size={15} />Salvează</button>
        <button className="btn" onClick={onCancel}>Anulează</button>
      </div>
    </div>
  );
}

/* ============================== WEEKLY CALENDAR ============================== */

function WeeklyCalendarView({ data, update }) {
  const [year, setYear] = useState(() => nowMoldova().getFullYear());
  const [month, setMonth] = useState(() => nowMoldova().getMonth());
  const now = nowMoldova();
  const [search, setSearch] = useState("");
  const [driverFilter, setDriverFilter] = useState("toate");
  const [expandedId, setExpandedId] = useState(null);
  const ranges = weekRanges(year, month);
  const todayIdx = (year === now.getFullYear() && month === now.getMonth()) ? currentWeekIndex(year, month, now.getDate(), ranges) : -1;

  // Căutare după nume șofer ȘI nr. înmatriculare (+ marcă/model).
  // Se potrivesc: șoferul actual al mașinii + oricine a adus bani pe mașina
  // asta în luna afișată (ca să găsești și un șofer care a condus-o doar o perioadă).
  const filteredCars = useMemo(() => {
    return [...data.cars]
      .filter((c) => {
        const ids = new Set();
        if (c.driverId) ids.add(c.driverId);
        Object.values(data.weeklyPayments || {}).forEach((rec) => {
          if (!rec || rec.carId !== c.id || rec.year !== year || rec.month !== month) return;
          if (rec.driverId) ids.add(rec.driverId);
          Object.values(rec.dailyAmounts || {}).forEach((dd) => { if (dd && dd.driverId) ids.add(dd.driverId); });
        });
        const drvs = Array.from(ids).map((id) => data.drivers.find((d) => d.id === id));
        return carMatchesSearch(c, drvs, search);
      })
      .filter((c) => driverFilter === "toate" || (driverFilter === "cu_sofer" && c.driverId) || (driverFilter === "fara_sofer" && !c.driverId))
      .sort((a, b) => a.nr.localeCompare(b.nr, "ro", { sensitivity: "base", numeric: true }));
  }, [data.cars, data.drivers, data.weeklyPayments, search, driverFilter, year, month]);

  const changeMonth = (delta) => {
    // Dacă mai ai un câmp de sumă activ (necomis încă), forțează salvarea lui
    // înainte să schimbi luna — altfel valoarea abia introdusă se pierde.
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    let m = month + delta, y = year;
    if (m < 0) { m = 11; y -= 1; }
    if (m > 11) { m = 0; y += 1; }
    setMonth(m); setYear(y);
  };

  const setWeekTotal = (car, weekIdx, cash, card) => {
    const k = weekKey(year, month, debtOwnerId(car), weekIdx);
    const paidAmount = Number(cash || 0) + Number(card || 0);
    update((prev) => {
      const old = prev.weeklyPayments[k];
      const oldCash = Number((old && old.paidCash) || 0), oldCard = Number((old && old.paidCard) || 0);
      const newCash = Number(cash || 0), newCard = Number(card || 0);
      const parts = [];
      if (oldCash !== newCash) parts.push(`numerar ${fmtMoney(oldCash)} → ${fmtMoney(newCash)}`);
      if (oldCard !== newCard) parts.push(`card ${fmtMoney(oldCard)} → ${fmtMoney(newCard)}`);
      const drv = prev.drivers.find((d) => d.id === car.driverId);
      const entries = parts.length ? [{
        type: "total", source: "Calendar", carId: car.id, carNr: car.nr,
        driverId: car.driverId || null, driverName: drv ? drv.nume : "",
        date: isoDay(year, month, 1),
        text: `${car.nr}${drv ? " · " + drv.nume : ""} · total săpt. ${weekIdx + 1}, ${MONTHS_RO[month]} ${year}: ${parts.join(", ")}`,
      }] : [];
      return {
        ...prev,
        weeklyPayments: {
          ...prev.weeklyPayments,
          [k]: { ...(prev.weeklyPayments[k] || {}), year, month, carId: car.id, driverId: car.driverId || null, weekIdx, mode: "total", paidCash: newCash, paidCard: newCard, paidAmount },
        },
        auditLog: pushAudit(prev, entries),
      };
    });
  };

  const setWeekMode = (car, weekIdx, mode) => {
    const k = weekKey(year, month, debtOwnerId(car), weekIdx);
    update((prev) => {
      const existing = prev.weeklyPayments[k];
      let rec;
      if (existing) {
        rec = { ...existing, mode };
        // Dacă trecem de pe "Total" pe "Pe zile" și suma totală introdusă anterior
        // nu are încă nicio zi detaliată, o punem automat pe prima zi lucrătoare
        // din săptămână, ca banii introduși deja să nu dispară din vizualizarea pe zile.
        if (mode === "daily" && existing.mode !== "daily") {
          const hasDaily = existing.dailyAmounts && Object.keys(existing.dailyAmounts).length > 0;
          const hasTotal = Number(existing.paidCash || 0) > 0 || Number(existing.paidCard || 0) > 0;
          if (!hasDaily && hasTotal) {
            const days = weekDays(car, year, month, weekIdx, ranges);
            const firstDay = days[0];
            if (firstDay != null) {
              rec.dailyAmounts = {
                [firstDay]: {
                  worked: true,
                  cash: Number(existing.paidCash || 0),
                  card: Number(existing.paidCard || 0),
                  note: "Sumă totală introdusă anterior pentru toată săptămâna",
                },
              };
            }
          }
        }
      } else {
        rec = { year, month, carId: car.id, driverId: car.driverId || null, weekIdx, mode, paidCash: 0, paidCard: 0, paidAmount: 0, dailyAmounts: {} };
      }
      return { ...prev, weeklyPayments: { ...prev.weeklyPayments, [k]: rec } };
    });
  };

  const setWeekDay = (car, weekIdx, day, entry) => {
    const k = weekKey(year, month, debtOwnerId(car), weekIdx);
    update((prev) => {
      const existing = prev.weeklyPayments[k] || { year, month, carId: car.id, driverId: car.driverId || null, weekIdx, mode: "daily", paidCash: 0, paidCard: 0, paidAmount: 0, dailyAmounts: {} };
      const prevDay = (existing.dailyAmounts || {})[day] || {};
      const merged = { worked: true, cash: 0, card: 0, note: "", ...prevDay, ...entry };
      if (merged.driverId == null) merged.driverId = car.driverId || null;
      if (!merged.worked) { merged.cash = 0; merged.card = 0; }
      const dailyAmounts = { ...(existing.dailyAmounts || {}), [day]: merged };
      const paidCash = Object.values(dailyAmounts).reduce((s, d) => s + (d.worked === false ? 0 : Number(d.cash || 0)), 0);
      const paidCard = Object.values(dailyAmounts).reduce((s, d) => s + (d.worked === false ? 0 : Number(d.card || 0)), 0);
      const paidAmount = paidCash + paidCard;
      const rec = { ...existing, year, month, carId: car.id, driverId: car.driverId || null, weekIdx, mode: "daily", dailyAmounts, paidCash, paidCard, paidAmount };
      const entries = dayAuditEntries(prev, car, year, month, day, prevDay, merged, "Calendar");
      return { ...prev, weeklyPayments: { ...prev.weeklyPayments, [k]: rec }, auditLog: pushAudit(prev, entries) };
    });
  };

  const setCarStartDate = (car, dateStr) => {
    update((prev) => {
      const old = prev.cars.find((c) => c.id === car.id);
      const before = (old && old.startDate) || null, after = dateStr || null;
      const entries = before !== after ? [{
        type: "masina", carId: car.id, carNr: car.nr,
        text: `Data de început ${car.nr}: ${before ? fmtDateRO(before) : "—"} → ${after ? fmtDateRO(after) : "—"}`,
      }] : [];
      return {
        ...prev,
        cars: prev.cars.map((c) => (c.id === car.id ? { ...c, startDate: dateStr || null } : c)),
        auditLog: pushAudit(prev, entries),
      };
    });
  };

  const setCarStatus = (car, status) => {
    update((prev) => {
      const old = prev.cars.find((c) => c.id === car.id);
      const before = (old && old.status) || "activa";
      const entries = before !== status ? [{
        type: "masina", carId: car.id, carNr: car.nr,
        text: `Status ${car.nr}: ${CAR_STATUS_LABELS[before] || before} → ${CAR_STATUS_LABELS[status] || status}`,
      }] : [];
      return {
        ...prev,
        cars: prev.cars.map((c) => (c.id === car.id ? { ...c, status } : c)),
        auditLog: pushAudit(prev, entries),
      };
    });
  };

  if (data.cars.length === 0) {
    return <div className="card"><EmptyState text="Adaugă cel puțin o mașină pentru a folosi calendarul." /></div>;
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
        <button className="btn" style={{ padding: 8 }} aria-label="Luna anterioară" onClick={() => changeMonth(-1)}><ChevronLeft size={16} /></button>
        <div className="disp" style={{ fontSize: 18, fontWeight: 700, minWidth: 170, textAlign: "center" }}>{MONTHS_RO[month]} {year}</div>
        <button className="btn" style={{ padding: 8 }} aria-label="Luna următoare" onClick={() => changeMonth(1)}><ChevronRight size={16} /></button>
      </div>

      <div className="field" style={{ marginBottom: 10, position: "relative" }}>
        <Search size={15} color="var(--muted)" style={{ position: "absolute", left: 11, top: "50%", transform: "translateY(-50%)" }} />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Caută după șofer sau nr. înmatriculare…"
          style={{ paddingLeft: 34 }}
        />
      </div>

      <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
        {[
          { id: "toate", label: "Toate" },
          { id: "cu_sofer", label: "Cu șofer" },
          { id: "fara_sofer", label: "Fără șofer" },
        ].map((f) => (
          <button
            key={f.id}
            className={"btn" + (driverFilter === f.id ? " primary" : "")}
            style={{ padding: "7px 12px", fontSize: 12.5 }}
            onClick={() => setDriverFilter(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {filteredCars.length === 0 ? (
        <div className="card"><EmptyState text="Nicio mașină găsită pentru căutarea asta." /></div>
      ) : (
        filteredCars.map((car) => (
          <CarWeekCard
            key={car.id} car={car} data={data} year={year} month={month} ranges={ranges}
            todayIdx={todayIdx} driver={data.drivers.find((d) => d.id === car.driverId)}
            expanded={expandedId === car.id}
            onToggle={() => setExpandedId(expandedId === car.id ? null : car.id)}
            onSetWeekTotal={(weekIdx, cash, card) => setWeekTotal(car, weekIdx, cash, card)}
            onSetWeekMode={(weekIdx, mode) => setWeekMode(car, weekIdx, mode)}
            onSetWeekDay={(weekIdx, day, entry) => setWeekDay(car, weekIdx, day, entry)}
            onSetStartDate={(dateStr) => setCarStartDate(car, dateStr)}
            onSetStatus={(status) => setCarStatus(car, status)}
          />
        ))
      )}
    </div>
  );
}

function CarWeekCard({ car, data, year, month, ranges, todayIdx, driver, expanded, onToggle, onSetWeekTotal, onSetWeekMode, onSetWeekDay, onSetStartDate, onSetStatus }) {
  const carryover = carryoverFromPrevMonth(data, car, year, month);
  const planTotal = monthlyPlanWithCarry(data, car, year, month);
  const paidTotal = monthlyPaid(data, year, month, debtOwnerId(car));
  const restTotal = Math.max(planTotal - paidTotal, 0);
  const rowStatus = restTotal <= 0 ? "paid" : paidTotal > 0 ? "partial" : "unpaid";
  const [editingStart, setEditingStart] = useState(false);
  const [startVal, setStartVal] = useState(car.startDate || `${year}-${String(month + 1).padStart(2, "0")}-01`);

  const saveStart = (val) => { onSetStartDate(val); setEditingStart(false); };
  const clearStart = (e) => { e.stopPropagation(); onSetStartDate(null); };
  const quickThisMonth = (e) => {
    e.stopPropagation();
    saveStart(`${year}-${String(month + 1).padStart(2, "0")}-01`);
  };

  // Perioadele de nefuncționare care se suprapun cu luna afișată acum.
  const monthStart = new Date(year, month, 1);
  const monthEnd = new Date(year, month, daysInMonth(year, month));
  const periodsThisMonth = (car.unavailablePeriods || []).filter((p) => {
    if (!p.start) return false;
    if (new Date(p.start) > monthEnd) return false;
    if (!p.end) return true; // nedefinită — se suprapune cu orice lună de acum încolo
    return new Date(p.end) >= monthStart;
  });

  return (
    <div className="card" style={{ marginBottom: 10, padding: 0, overflow: "hidden" }}>
      <button
        onClick={onToggle}
        aria-expanded={expanded}
        style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, padding: "14px 16px", background: "transparent", border: "none", cursor: "pointer", color: "var(--text)", textAlign: "left" }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
          <ChevronRight size={16} color="var(--muted)" style={{ transform: expanded ? "rotate(90deg)" : "none", transition: ".15s", flexShrink: 0 }} />
          <div style={{ minWidth: 0 }}>
            <div className="disp" style={{ fontWeight: 700, fontSize: 15 }}>{car.nr}</div>
            <div style={{ fontSize: 12, color: "var(--muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{driver ? driver.nume : "nealocat"} · {fmtRate(car)}</div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
          {isCarActive(car) ? <StatusPill status={rowStatus} restanta={restTotal} /> : <CarStatusPill status={car.status} />}
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 10.5, color: "var(--muted)" }}>Plan lună</div>
            <div className="mono" style={{ fontWeight: 700, fontSize: 13.5 }}>{isCarActive(car) ? fmtMoney(planTotal) : "—"}</div>
          </div>
        </div>
      </button>

      <div style={{ padding: "0 16px 10px", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <select
          value={car.status || "activa"}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onSetStatus(e.target.value)}
          aria-label={`Status mașină ${car.nr}`}
          style={{ width: "auto", padding: "5px 8px", fontSize: 12 }}
        >
          <option value="activa">Activă</option>
          <option value="service">În service</option>
          <option value="vanduta">Vândută</option>
        </select>
        {!isCarActive(car) && (
          <span style={{ fontSize: 11, color: "var(--muted)" }}>restanța nu se calculează cât timp nu e activă</span>
        )}
      </div>

      {periodsThisMonth.length > 0 && (
        <div style={{ padding: "0 16px 10px", display: "flex", flexWrap: "wrap", gap: 6 }}>
          {periodsThisMonth.map((p) => (
            <span key={p.id} className="pill" style={{ background: "#f2841c22", color: "var(--orange)" }}>
              {UNAVAILABLE_REASONS[p.reason] || "Nu lucrează"}: {fmtDateRO(p.start)}–{p.end ? fmtDateRO(p.end) : "nedeterminat"}
            </span>
          ))}
        </div>
      )}

      <div style={{ padding: "0 16px 10px", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        {car.startDate ? (
          <span className="pill" style={{ background: "#ffffff0d", color: "var(--muted)" }}>
            Activ din {fmtDateRO(car.startDate)}
            <button type="button" aria-label="Editează data de început" onClick={(e) => { e.stopPropagation(); setEditingStart((v) => !v); }} style={{ background: "none", border: "none", padding: 0, marginLeft: 4, cursor: "pointer", color: "var(--muted)", display: "flex" }}><Pencil size={11} /></button>
            <button type="button" aria-label="Șterge data de început" onClick={clearStart} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "var(--muted)", display: "flex" }}><X size={12} /></button>
          </span>
        ) : (
          <>
            <button type="button" className="quickbtn" style={{ flex: "none", padding: "5px 9px" }} onClick={quickThisMonth}>A început să lucreze luna asta</button>
            <button type="button" onClick={(e) => { e.stopPropagation(); setEditingStart((v) => !v); }} style={{ background: "none", border: "none", padding: "4px 2px", cursor: "pointer", color: "var(--muted)", fontSize: 11.5, textDecoration: "underline" }}>alege altă dată</button>
          </>
        )}
        {editingStart && (
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input type="date" value={startVal} onChange={(e) => setStartVal(e.target.value)} style={{ width: 145, padding: "5px 8px" }} onClick={(e) => e.stopPropagation()} />
            <button type="button" className="btn" style={{ padding: "5px 9px", fontSize: 12 }} onClick={(e) => { e.stopPropagation(); saveStart(startVal); }}>Salvează</button>
          </span>
        )}
      </div>

      {expanded && (
        <div style={{ padding: "0 16px 16px" }}>
          {carryover > 0 && (
            <div style={{ fontSize: 12, color: "var(--orange)", marginBottom: 8, display: "flex", alignItems: "center", gap: 5 }}>
              <AlertTriangle size={13} /> din care {fmtMoney(carryover)} restanță din luna trecută
            </div>
          )}

          <div style={{ marginBottom: 8 }}>
            {ranges.map((r, i) => (
              <WeekRow
                key={i} car={car} data={data} year={year} month={month} weekIdx={i} range={r} ranges={ranges} isCurrent={i === todayIdx}
                onSetTotal={(cash, card) => onSetWeekTotal(i, cash, card)}
                onSetMode={(mode) => onSetWeekMode(i, mode)}
                onSetDay={(day, cash, card) => onSetWeekDay(i, day, cash, card)}
              />
            ))}
          </div>

          <div style={{ display: "flex", gap: 16, fontSize: 12.5, borderTop: "1px solid var(--border)", paddingTop: 8, flexWrap: "wrap" }}>
            <div>Adus: <span className="mono" style={{ color: "var(--green)", fontWeight: 700 }}>{fmtMoney(paidTotal)}</span></div>
            <div>Rest: <span className="mono" style={{ color: restTotal > 0 ? "var(--orange)" : "var(--muted)", fontWeight: 700 }}>{fmtMoney(restTotal)}</span></div>
          </div>
        </div>
      )}
    </div>
  );
}

function WeekRow({ car, data, year, month, weekIdx, range, ranges, isCurrent, onSetTotal, onSetMode, onSetDay }) {
  const rec = weeklyRecord(data, year, month, debtOwnerId(car), weekIdx);
  const plan = weekPlan(data, car, year, month, weekIdx, weekRanges(year, month));
  const mode = rec && rec.mode === "daily" ? "daily" : "total";
  const [cash, setCash] = useState(rec ? rec.paidCash : "");
  const [card, setCard] = useState(rec ? rec.paidCard : "");

  useEffect(() => {
    setCash(rec ? rec.paidCash : "");
    setCard(rec ? rec.paidCard : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year, month, weekIdx, mode]);

  const paid = rec ? rec.paidAmount : null;
  const status = statusOf(plan, paid);
  const colors = { paid: "var(--green)", unpaid: "var(--red)", partial: "var(--orange)", pending: "var(--muted)" };
  const rest = Math.max(plan - (paid || 0), 0);

  const commitTotal = () => onSetTotal(cash, card);
  const days = weekDays(car, year, month, weekIdx, ranges);

  return (
    <div className="weekrow" style={{ display: "block" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontWeight: isCurrent ? 700 : 500, display: "flex", alignItems: "center", gap: 6 }}>
            Săpt {weekIdx + 1} <span style={{ color: "var(--muted)", fontWeight: 400 }}>({range.start}–{range.end})</span>
            {isCurrent && <span className="pill" style={{ background: "#f2b70522", color: "var(--amber)" }}>curentă</span>}
          </div>
          <div style={{ fontSize: 11.5, color: colors[status] }}>
            Plan {fmtMoney(plan)}{paid != null ? ` · adus ${fmtMoney(paid)}` : ""}{status === "partial" ? ` · mai are ${fmtMoney(rest)}` : ""}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div className="modetoggle">
            <button type="button" className={mode === "total" ? "active" : ""} onClick={() => onSetMode("total")}>Total</button>
            <button type="button" className={mode === "daily" ? "active" : ""} onClick={() => onSetMode("daily")}>Pe zile</button>
          </div>
          <StatusPill status={status} restanta={rest} />
        </div>
      </div>

      {mode === "total" ? (
        <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
          <div style={{ width: 90 }}>
            <input type="number" inputMode="decimal" placeholder="Numerar" value={cash} onChange={(e) => setCash(e.target.value)} onBlur={commitTotal} onKeyDown={(e) => e.key === "Enter" && e.target.blur()} />
          </div>
          <div style={{ width: 90 }}>
            <input type="number" inputMode="decimal" placeholder="Card" value={card} onChange={(e) => setCard(e.target.value)} onBlur={commitTotal} onKeyDown={(e) => e.key === "Enter" && e.target.blur()} />
          </div>
        </div>
      ) : (
        <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
          {days.map((day) => (
            <DayRow key={day} car={car} year={year} month={month} day={day} rec={rec} onSetDay={onSetDay} />
          ))}
        </div>
      )}
    </div>
  );
}

function DayRow({ car, year, month, day, rec, onSetDay }) {
  const existing = rec && rec.dailyAmounts ? rec.dailyAmounts[day] : null;
  const worked = existing ? existing.worked !== false : true;
  const [cash, setCash] = useState(existing ? existing.cash : "");
  const [card, setCard] = useState(existing ? existing.card : "");
  const [note, setNote] = useState(existing ? existing.note || "" : "");

  useEffect(() => {
    setCash(existing ? existing.cash : "");
    setCard(existing ? existing.card : "");
    setNote(existing ? existing.note || "" : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year, month, day]);

  const commitAmounts = () => onSetDay(day, { cash, card, worked: true });
  const commitNote = (val) => onSetDay(day, { note: val, worked });
  const toggleWorked = (nextWorked) => {
    if (nextWorked) onSetDay(day, { worked: true });
    else onSetDay(day, { worked: false, note });
  };

  // Duminica e afișată mereu, dar nu e o zi lucrătoare "normală" a mașinii —
  // implicit nu intră în planul săptămânii; aici poți bifa explicit s-o incluzi.
  const isExtraSunday = isSunday(year, month, day) && !isCarWorkDay(car, year, month, day);
  const countsInPlan = !!(existing && existing.countsInPlan);
  const toggleCountsInPlan = (next) => onSetDay(day, { countsInPlan: next });

  const unavailable = unavailablePeriodOnDay(car, year, month, day);

  return (
    <div className="dayrow" style={{ display: "block" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <div style={{ fontSize: 12, color: "var(--muted)", width: 62, flexShrink: 0 }}>{dayLabel(year, month, day)}</div>
        <div className="modetoggle">
          <button type="button" className={worked ? "active" : ""} onClick={() => toggleWorked(true)}>A lucrat</button>
          <button type="button" className={!worked ? "active" : ""} onClick={() => toggleWorked(false)}>Nu a lucrat</button>
        </div>
        {isExtraSunday && (
          <div className="modetoggle" title="Implicit duminica nu intră în planul/calculul zilelor lucrate.">
            <button type="button" className={!countsInPlan ? "active" : ""} onClick={() => toggleCountsInPlan(false)}>Nu intră în plan</button>
            <button type="button" className={countsInPlan ? "active" : ""} onClick={() => toggleCountsInPlan(true)}>Numără în plan</button>
          </div>
        )}
        {unavailable && (
          <span className="pill" style={{ background: "#f2841c22", color: "var(--orange)" }} title="Zi exclusă automat din planul de chirie">
            {UNAVAILABLE_REASONS[unavailable.reason] || "Nu lucrează"} — nu intră în plan
          </span>
        )}
      </div>
      {worked ? (
        <div style={{ marginTop: 6, marginLeft: 70 }}>
          <div style={{ display: "flex", gap: 8 }}>
            <input type="number" inputMode="decimal" placeholder="Numerar" value={cash} onChange={(e) => setCash(e.target.value)} onBlur={commitAmounts} onKeyDown={(e) => e.key === "Enter" && e.target.blur()} />
            <input type="number" inputMode="decimal" placeholder="Card" value={card} onChange={(e) => setCard(e.target.value)} onBlur={commitAmounts} onKeyDown={(e) => e.key === "Enter" && e.target.blur()} />
          </div>
          <div style={{ marginTop: 6 }}>
            <input
              type="text" placeholder="Descriere (opțional)"
              value={note} onChange={(e) => setNote(e.target.value)} onBlur={(e) => commitNote(e.target.value)}
            />
          </div>
        </div>
      ) : (
        <div style={{ marginTop: 6, marginLeft: 70 }}>
          <input
            type="text" placeholder="Motiv (ex: service, liber, concediu)"
            value={note} onChange={(e) => setNote(e.target.value)} onBlur={(e) => commitNote(e.target.value)}
          />
        </div>
      )}
    </div>
  );
}

/* ============================== INSURANCE ============================== */

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const today = new Date(todayISO());
  const target = new Date(dateStr);
  return Math.round((target - today) / (1000 * 60 * 60 * 24));
}
function insuranceStatus(days) {
  if (days == null) return "unknown";
  if (days < 0) return "expired";
  if (days <= 30) return "soon";
  return "ok";
}

function InsuranceView({ data, update }) {
  const [editing, setEditing] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("toate");
  const empty = { carId: data.cars[0] ? data.cars[0].id : "", tip: "Asigurare simplă", dataExpirare: "" };

  const save = (ins) => {
    update((prev) => {
      const insurances = ins.id ? prev.insurances.map((i) => (i.id === ins.id ? ins : i)) : [...prev.insurances, { ...ins, id: uid() }];
      return { ...prev, insurances };
    });
    setEditing(null);
  };
  const remove = (id) => update((prev) => ({ ...prev, insurances: prev.insurances.filter((i) => i.id !== id) }));

  const sorted = useMemo(() => {
    const term = search.trim().toLowerCase();
    return [...data.insurances]
      .filter((ins) => {
        if (statusFilter !== "toate" && insuranceStatus(daysUntil(ins.dataExpirare)) !== statusFilter) return false;
        if (!term) return true;
        const car = data.cars.find((c) => c.id === ins.carId);
        return car && (car.nr.toLowerCase().includes(term) || `${car.marca} ${car.model}`.toLowerCase().includes(term));
      })
      .sort((a, b) => (a.dataExpirare || "").localeCompare(b.dataExpirare || ""));
  }, [data.insurances, data.cars, search, statusFilter]);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <div className="disp" style={{ fontSize: 18, fontWeight: 700 }}>Asigurări & documente ({data.insurances.length})</div>
        <button className="btn primary" disabled={data.cars.length === 0} onClick={() => setEditing({ ...empty })}><Plus size={15} />Adaugă</button>
      </div>

      {data.cars.length === 0 ? (
        <div className="card"><EmptyState text="Adaugă mai întâi o mașină, apoi îi poți atașa asigurări." /></div>
      ) : (
        <>
          <div className="field" style={{ marginBottom: 10 }}>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Caută mașină după număr, marcă sau model…" />
          </div>
          <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
            {[
              { id: "toate", label: "Toate" },
              { id: "ok", label: "Valabile" },
              { id: "soon", label: "Expiră curând" },
              { id: "expired", label: "Expirate" },
            ].map((f) => (
              <button key={f.id} className={"btn" + (statusFilter === f.id ? " primary" : "")} style={{ padding: "7px 12px", fontSize: 12.5 }} onClick={() => setStatusFilter(f.id)}>{f.label}</button>
            ))}
          </div>
          {sorted.length === 0 ? (
            <div className="card"><EmptyState text="Nimic găsit pentru filtrul ales." /></div>
          ) : (
        <div className="card" style={{ overflowX: "auto" }}>
          <table>
            <thead><tr><th>Mașină</th><th>Tip</th><th>Expiră</th><th>Stare</th><th></th></tr></thead>
            <tbody>
              {sorted.map((ins) => {
                const car = data.cars.find((c) => c.id === ins.carId);
                const days = daysUntil(ins.dataExpirare);
                const status = insuranceStatus(days);
                return (
                  <tr key={ins.id}>
                    <td style={{ fontWeight: 600 }}>{car ? car.nr : <span style={{ color: "var(--muted)" }}>mașină ștearsă</span>}</td>
                    <td>{ins.tip}</td>
                    <td className="mono">{fmtDateRO(ins.dataExpirare) || "—"}</td>
                    <td><InsuranceStatusPill status={status} days={days} /></td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <button className="btn" style={{ padding: 6, marginRight: 6 }} aria-label="Editează asigurarea" onClick={() => setEditing(ins)}><Pencil size={14} /></button>
                      <button className="btn danger" style={{ padding: 6 }} aria-label="Șterge asigurarea" onClick={() => setConfirm({ message: "Ștergi această asigurare? Această acțiune nu poate fi anulată.", action: () => remove(ins.id) })}><Trash2 size={14} /></button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
        </>
      )}

      {editing && (
        <Modal onClose={() => setEditing(null)} title={editing.id ? "Editează" : "Adaugă asigurare/document"}>
          <InsuranceForm ins={editing} cars={data.cars} onSave={save} onCancel={() => setEditing(null)} />
        </Modal>
      )}
      {confirm && (
        <ConfirmModal message={confirm.message} onCancel={() => setConfirm(null)} onConfirm={() => { confirm.action(); setConfirm(null); }} />
      )}
    </div>
  );
}

function InsuranceStatusPill({ status, days }) {
  const map = {
    ok: { label: `Valabilă (${days} zile)`, bg: "#2bb67322", color: "var(--green)" },
    soon: { label: days === 0 ? "Expiră azi" : `Expiră în ${days} zile`, bg: "#f2841c22", color: "var(--orange)" },
    expired: { label: `Expirată de ${Math.abs(days)} zile`, bg: "#e5484d22", color: "var(--red)" },
    unknown: { label: "Fără dată", bg: "#8b93a122", color: "var(--muted)" },
  };
  const m = map[status] || map.unknown;
  return <span className="pill" style={{ background: m.bg, color: m.color }}>{m.label}</span>;
}

function InsuranceForm({ ins, cars, onSave, onCancel }) {
  const [f, setF] = useState(ins);
  const [err, setErr] = useState("");
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const trySave = () => {
    if (!f.carId) { setErr("Alege mașina."); return; }
    if (!f.dataExpirare) { setErr("Alege data expirării."); return; }
    setErr("");
    onSave(f);
  };
  return (
    <div>
      <div className="field">
        <label>Mașină</label>
        <select value={f.carId} onChange={(e) => set("carId", e.target.value)}>
          {cars.map((c) => <option key={c.id} value={c.id}>{c.nr} — {c.marca} {c.model}</option>)}
        </select>
      </div>
      <div className="field">
        <label>Tip</label>
        <select value={f.tip} onChange={(e) => set("tip", e.target.value)}>
          {["Asigurare simplă", "Asigurare taxi"].map((t) => <option key={t}>{t}</option>)}
        </select>
      </div>
      <div className="field"><label>Data expirării</label><input type="date" value={f.dataExpirare} onChange={(e) => set("dataExpirare", e.target.value)} /></div>
      {err && <div className="save-warn" style={{ marginTop: 10 }}><AlertTriangle size={14} />{err}</div>}
      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <button className="btn primary" style={{ flex: 1, justifyContent: "center" }} onClick={trySave}><Check size={15} />Salvează</button>
        <button className="btn" onClick={onCancel}>Anulează</button>
      </div>
    </div>
  );
}

/* ============================== TECHNICAL INSPECTION ============================== */

function InspectionView({ data, update }) {
  const [editing, setEditing] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("toate");
  const empty = { carId: data.cars[0] ? data.cars[0].id : "", dataExpirare: "" };

  const save = (insp) => {
    update((prev) => {
      const inspections = insp.id ? prev.inspections.map((i) => (i.id === insp.id ? insp : i)) : [...prev.inspections, { ...insp, id: uid() }];
      return { ...prev, inspections };
    });
    setEditing(null);
  };
  const remove = (id) => update((prev) => ({ ...prev, inspections: prev.inspections.filter((i) => i.id !== id) }));

  const sorted = useMemo(() => {
    const term = search.trim().toLowerCase();
    return [...data.inspections]
      .filter((insp) => {
        if (statusFilter !== "toate" && insuranceStatus(daysUntil(insp.dataExpirare)) !== statusFilter) return false;
        if (!term) return true;
        const car = data.cars.find((c) => c.id === insp.carId);
        return car && (car.nr.toLowerCase().includes(term) || `${car.marca} ${car.model}`.toLowerCase().includes(term));
      })
      .sort((a, b) => (a.dataExpirare || "").localeCompare(b.dataExpirare || ""));
  }, [data.inspections, data.cars, search, statusFilter]);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <div className="disp" style={{ fontSize: 18, fontWeight: 700 }}>Revizie tehnică ({data.inspections.length})</div>
        <button className="btn primary" disabled={data.cars.length === 0} onClick={() => setEditing({ ...empty })}><Plus size={15} />Adaugă</button>
      </div>

      {data.cars.length === 0 ? (
        <div className="card"><EmptyState text="Adaugă mai întâi o mașină, apoi îi poți atașa o revizie tehnică." /></div>
      ) : (
        <>
          <div className="field" style={{ marginBottom: 10 }}>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Caută mașină după număr, marcă sau model…" />
          </div>
          <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
            {[
              { id: "toate", label: "Toate" },
              { id: "ok", label: "Valabile" },
              { id: "soon", label: "Expiră curând" },
              { id: "expired", label: "Expirate" },
            ].map((f) => (
              <button key={f.id} className={"btn" + (statusFilter === f.id ? " primary" : "")} style={{ padding: "7px 12px", fontSize: 12.5 }} onClick={() => setStatusFilter(f.id)}>{f.label}</button>
            ))}
          </div>
          {sorted.length === 0 ? (
            <div className="card"><EmptyState text="Nimic găsit pentru filtrul ales." /></div>
          ) : (
        <div className="card" style={{ overflowX: "auto" }}>
          <table>
            <thead><tr><th>Mașină</th><th>Valabilă până la</th><th>Stare</th><th></th></tr></thead>
            <tbody>
              {sorted.map((insp) => {
                const car = data.cars.find((c) => c.id === insp.carId);
                const days = daysUntil(insp.dataExpirare);
                const status = insuranceStatus(days);
                return (
                  <tr key={insp.id}>
                    <td style={{ fontWeight: 600 }}>{car ? car.nr : <span style={{ color: "var(--muted)" }}>mașină ștearsă</span>}</td>
                    <td className="mono">{fmtDateRO(insp.dataExpirare) || "—"}</td>
                    <td><InsuranceStatusPill status={status} days={days} /></td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <button className="btn" style={{ padding: 6, marginRight: 6 }} aria-label="Editează revizia" onClick={() => setEditing(insp)}><Pencil size={14} /></button>
                      <button className="btn danger" style={{ padding: 6 }} aria-label="Șterge revizia" onClick={() => setConfirm({ message: "Ștergi această revizie tehnică? Această acțiune nu poate fi anulată.", action: () => remove(insp.id) })}><Trash2 size={14} /></button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
        </>
      )}

      {editing && (
        <Modal onClose={() => setEditing(null)} title={editing.id ? "Editează" : "Adaugă revizie tehnică"}>
          <InspectionForm insp={editing} cars={data.cars} onSave={save} onCancel={() => setEditing(null)} />
        </Modal>
      )}
      {confirm && (
        <ConfirmModal message={confirm.message} onCancel={() => setConfirm(null)} onConfirm={() => { confirm.action(); setConfirm(null); }} />
      )}
    </div>
  );
}

function InspectionForm({ insp, cars, onSave, onCancel }) {
  const [f, setF] = useState(insp);
  const [err, setErr] = useState("");
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const trySave = () => {
    if (!f.carId) { setErr("Alege mașina."); return; }
    if (!f.dataExpirare) { setErr("Alege data până la care e valabilă."); return; }
    setErr("");
    onSave(f);
  };
  return (
    <div>
      <div className="field">
        <label>Mașină</label>
        <select value={f.carId} onChange={(e) => set("carId", e.target.value)}>
          {cars.map((c) => <option key={c.id} value={c.id}>{c.nr} — {c.marca} {c.model}</option>)}
        </select>
      </div>
      <div className="field"><label>Valabilă până la</label><input type="date" value={f.dataExpirare} onChange={(e) => set("dataExpirare", e.target.value)} /></div>
      {err && <div className="save-warn" style={{ marginTop: 10 }}><AlertTriangle size={14} />{err}</div>}
      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <button className="btn primary" style={{ flex: 1, justifyContent: "center" }} onClick={trySave}><Check size={15} />Salvează</button>
        <button className="btn" onClick={onCancel}>Anulează</button>
      </div>
    </div>
  );
}

/* ============================== FINANCE ============================== */

function FinanceView({ data, update }) {
  const [year, setYear] = useState(() => nowMoldova().getFullYear());
  const [month, setMonth] = useState(() => nowMoldova().getMonth());
  const mk = monthKey(year, month);
  const [showExpense, setShowExpense] = useState(false);
  const [showIncome, setShowIncome] = useState(false);
  const [showDayIncome, setShowDayIncome] = useState(false);
  const [confirm, setConfirm] = useState(null);

  const calendarIncome = Object.values(data.weeklyPayments)
    .filter((p) => p.year === year && p.month === month)
    .reduce((s, p) => s + Number(p.paidAmount || 0), 0);

  const restante = data.cars.reduce((s, car) => {
    if (!car.driverId) return s; // doar mașini cu șofer alocat momentan
    const plan = monthlyPlanBase(data, car, year, month); // fără moștenire din lunile trecute — pornește curat, de azi
    const paid = monthlyPaid(data, year, month, debtOwnerId(car));
    return s + Math.max(plan - paid, 0);
  }, 0);

  const dailyBreakdown = useMemo(() => {
    const map = {};
    Object.values(data.weeklyPayments).forEach((rec) => {
      if (rec.year !== year || rec.month !== month || !rec.dailyAmounts) return;
      Object.entries(rec.dailyAmounts).forEach(([day, d]) => {
        if (d.worked === false) return;
        const k = Number(day);
        if (!map[k]) map[k] = { cash: 0, card: 0 };
        map[k].cash += Number(d.cash || 0);
        map[k].card += Number(d.card || 0);
      });
    });
    const last = daysInMonth(year, month);
    const out = [];
    for (let d = 1; d <= last; d++) {
      out.push({ day: d, cash: map[d] ? map[d].cash : 0, card: map[d] ? map[d].card : 0, hasData: !!map[d] });
    }
    return out;
  }, [data.weeklyPayments, year, month]);

  const dailyTotals = useMemo(
    () => dailyBreakdown.reduce((acc, d) => ({ cash: acc.cash + d.cash, card: acc.card + d.card }), { cash: 0, card: 0 }),
    [dailyBreakdown]
  );

  const extraIncome = data.incomes.filter((i) => i.data.startsWith(mk)).reduce((s, i) => s + Number(i.suma || 0), 0);
  const expensesMonth = data.expenses.filter((e) => e.data.startsWith(mk));
  const totalExpenses = expensesMonth.reduce((s, e) => s + Number(e.suma || 0), 0);
  const totalIncome = calendarIncome + extraIncome;
  const profit = totalIncome - totalExpenses;

  const addExpense = (e) => update((prev) => {
    const car = prev.cars.find((c) => c.id === e.carId);
    const entry = { type: "cheltuiala", carId: e.carId || null, carNr: car ? car.nr : "", date: e.data, text: `Cheltuială adăugată: ${e.descriere} — ${fmtMoney(e.suma)} (${e.categorie}, ${fmtDateRO(e.data)}${car ? ", " + car.nr : ""})` };
    return { ...prev, expenses: [...prev.expenses, { ...e, id: uid() }], auditLog: pushAudit(prev, [entry]) };
  });
  const addIncome = (i) => update((prev) => {
    const entry = { type: "venit", date: i.data, text: `Venit extra adăugat: ${i.descriere} — ${fmtMoney(i.suma)} (${fmtDateRO(i.data)})` };
    return { ...prev, incomes: [...prev.incomes, { ...i, id: uid() }], auditLog: pushAudit(prev, [entry]) };
  });
  const delExpense = (id) => update((prev) => {
    const old = prev.expenses.find((e) => e.id === id);
    const car = old ? prev.cars.find((c) => c.id === old.carId) : null;
    const entries = old ? [{ type: "cheltuiala", carId: old.carId || null, carNr: car ? car.nr : "", date: old.data, text: `Cheltuială ștearsă: ${old.descriere} — ${fmtMoney(old.suma)} (${old.categorie}, ${fmtDateRO(old.data)}${car ? ", " + car.nr : ""})` }] : [];
    return { ...prev, expenses: prev.expenses.filter((e) => e.id !== id), auditLog: pushAudit(prev, entries) };
  });
  const delIncome = (id) => update((prev) => {
    const old = prev.incomes.find((i) => i.id === id);
    const entries = old ? [{ type: "venit", date: old.data, text: `Venit extra șters: ${old.descriere} — ${fmtMoney(old.suma)} (${fmtDateRO(old.data)})` }] : [];
    return { ...prev, incomes: prev.incomes.filter((i) => i.id !== id), auditLog: pushAudit(prev, entries) };
  });

  const changeMonth = (delta) => {
    let m = month + delta, y = year;
    if (m < 0) { m = 11; y -= 1; }
    if (m > 11) { m = 0; y += 1; }
    setMonth(m); setYear(y);
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
        <button className="btn" style={{ padding: 8 }} aria-label="Luna anterioară" onClick={() => changeMonth(-1)}><ChevronLeft size={16} /></button>
        <div className="disp" style={{ fontSize: 18, fontWeight: 700, minWidth: 170, textAlign: "center" }}>{MONTHS_RO[month]} {year}</div>
        <button className="btn" style={{ padding: 8 }} aria-label="Luna următoare" onClick={() => changeMonth(1)}><ChevronRight size={16} /></button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px,1fr))", gap: 12, marginBottom: 18 }}>
        <MiniStat label="Venituri" value={fmtMoney(totalIncome)} color="var(--green)" />
        <MiniStat label="Cheltuieli" value={fmtMoney(totalExpenses)} color="var(--red)" />
        <MiniStat label="Profit" value={fmtMoney(profit)} color={profit >= 0 ? "var(--green)" : "var(--red)"} />
        <MiniStat label="Restanță lună (fără luni vechi)" value={fmtMoney(restante)} color="var(--orange)" />
      </div>

      <div className="finance-grid" style={{ display: "grid", gap: 14 }}>
        <div className="card">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <div className="disp" style={{ fontWeight: 700 }}>Venituri extra</div>
            <button className="btn" onClick={() => setShowIncome(true)}><Plus size={14} />Adaugă</button>
          </div>
          <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 8 }}>Încasările din calendar ({fmtMoney(calendarIncome)}) intră automat mai sus.</div>
          {data.incomes.filter((i) => i.data.startsWith(mk)).length === 0 ? <EmptyState text="Niciun venit extra luna asta." /> : (
            <table>
              <tbody>
                {data.incomes.filter((i) => i.data.startsWith(mk)).map((i) => (
                  <tr key={i.id}>
                    <td>{i.descriere}</td><td className="mono" style={{ color: "var(--green)" }}>{fmtMoney(i.suma)}</td>
                    <td style={{ textAlign: "right" }}><button className="btn danger" style={{ padding: 5 }} aria-label="Șterge venitul" onClick={() => setConfirm({ message: "Ștergi acest venit? Această acțiune nu poate fi anulată.", action: () => delIncome(i.id) })}><Trash2 size={13} /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="card">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <div className="disp" style={{ fontWeight: 700 }}>Cheltuieli</div>
            <button className="btn" onClick={() => setShowExpense(true)}><Plus size={14} />Adaugă</button>
          </div>
          {expensesMonth.length === 0 ? <EmptyState text="Nicio cheltuială luna asta." /> : (
            <table>
              <tbody>
                {expensesMonth.map((e) => {
                  const drv = data.drivers.find((d) => d.id === e.șoferId);
                  const expCar = data.cars.find((c) => c.id === e.carId);
                  return (
                    <tr key={e.id}>
                      <td>
                        {e.descriere}
                        <div style={{ fontSize: 11, color: "var(--muted)" }}>
                          {e.categorie} · {fmtDateRO(e.data)}{expCar ? ` · ${expCar.nr}` : ""}{drv ? ` · ${drv.nume}` : ""}
                          {(e.cash || e.card) ? ` · Num ${fmtMoney(e.cash || 0)} / Card ${fmtMoney(e.card || 0)}` : ""}
                        </div>
                      </td>
                      <td className="mono" style={{ color: "var(--red)" }}>{fmtMoney(e.suma)}</td>
                      <td style={{ textAlign: "right" }}><button className="btn danger" style={{ padding: 5 }} aria-label="Șterge cheltuiala" onClick={() => setConfirm({ message: "Ștergi această cheltuială? Această acțiune nu poate fi anulată.", action: () => delExpense(e.id) })}><Trash2 size={13} /></button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
          <div className="disp" style={{ fontWeight: 700 }}>Cash / Card pe zi</div>
          <button className="btn" onClick={() => setShowDayIncome(true)}><Search size={14} />Venit pe zi</button>
        </div>
        <div style={{ fontSize: 11.5, color: "var(--muted)", marginBottom: 10 }}>
          Toate zilele lunii; cele fără date introduse pe modul „Pe zile" apar cu 0.
        </div>
        {dailyBreakdown.length === 0 ? <EmptyState text={`Nicio zi introdusă pe modul „Pe zile” luna asta.`} /> : (
          <table>
            <thead><tr><td>Zi</td><td>Numerar</td><td>Card</td><td>Total</td></tr></thead>
            <tbody>
              {dailyBreakdown.map((d) => (
                <tr key={d.day} style={!d.hasData ? { opacity: 0.45 } : undefined}>
                  <td>{d.day} {MONTHS_RO_SHORT[month]}</td>
                  <td className="mono">{fmtMoney(d.cash)}</td>
                  <td className="mono">{fmtMoney(d.card)}</td>
                  <td className="mono" style={{ fontWeight: 700 }}>{fmtMoney(d.cash + d.card)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ borderTop: "1px solid var(--border, #2a303b)" }}>
                <td style={{ fontWeight: 700 }}>Total {MONTHS_RO[month]}</td>
                <td className="mono" style={{ fontWeight: 700, color: "var(--green)" }}>{fmtMoney(dailyTotals.cash)}</td>
                <td className="mono" style={{ fontWeight: 700, color: "var(--green)" }}>{fmtMoney(dailyTotals.card)}</td>
                <td className="mono" style={{ fontWeight: 700 }}>{fmtMoney(dailyTotals.cash + dailyTotals.card)}</td>
              </tr>
            </tfoot>
          </table>
        )}
      </div>

      {showDayIncome && <DayIncomeModal data={data} onClose={() => setShowDayIncome(false)} />}

      {showExpense && (
        <Modal onClose={() => setShowExpense(false)} title="Adaugă cheltuială">
          <ExpenseForm drivers={data.drivers} cars={data.cars} onSave={(e) => { addExpense(e); setShowExpense(false); }} onCancel={() => setShowExpense(false)} />
        </Modal>
      )}
      {showIncome && (
        <Modal onClose={() => setShowIncome(false)} title="Adaugă venit extra">
          <IncomeForm onSave={(i) => { addIncome(i); setShowIncome(false); }} onCancel={() => setShowIncome(false)} />
        </Modal>
      )}
      {confirm && (
        <ConfirmModal message={confirm.message} onCancel={() => setConfirm(null)} onConfirm={() => { confirm.action(); setConfirm(null); }} />
      )}
    </div>
  );
}

function DayIncomeModal({ data, onClose }) {
  const [date, setDate] = useState(() => todayISO());
  const [y, m, d] = date.split("-").map(Number);
  let cash = 0, card = 0, found = false;
  Object.values(data.weeklyPayments).forEach((rec) => {
    if (rec.year !== y || rec.month !== m - 1 || !rec.dailyAmounts) return;
    const dayRec = rec.dailyAmounts[d];
    if (!dayRec || dayRec.worked === false) return;
    found = true;
    cash += Number(dayRec.cash || 0);
    card += Number(dayRec.card || 0);
  });

  return (
    <Modal onClose={onClose} title="Venitul pe zi">
      <div className="field"><label>Alege ziua</label><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 12 }}>
        <MiniStat label="Numerar" value={fmtMoney(cash)} color="var(--green)" />
        <MiniStat label="Card" value={fmtMoney(card)} color="var(--green)" />
      </div>
      <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 10 }}>
        Total: <b className="mono" style={{ color: "var(--text)" }}>{fmtMoney(cash + card)}</b>
      </div>
      {!found && <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 6 }}>Nicio mașină nu are date introduse pe modul „Pe zile" pentru ziua asta.</div>}
      <div style={{ display: "flex", marginTop: 16 }}>
        <button className="btn" style={{ flex: 1, justifyContent: "center" }} onClick={onClose}>Închide</button>
      </div>
    </Modal>
  );
}

function MiniStat({ label, value, color }) {
  return (
    <div className="card">
      <div style={{ fontSize: 12, color: "var(--muted)", fontWeight: 600 }}>{label}</div>
      <div className="mono" style={{ fontSize: 20, fontWeight: 700, color, marginTop: 4 }}>{value}</div>
    </div>
  );
}

function ExpenseForm({ onSave, onCancel, drivers, cars }) {
  const [f, setF] = useState(() => ({ data: todayISO(), descriere: "", categorie: "Motorină", șoferId: "", carId: "", cash: "", card: "" }));
  const [err, setErr] = useState("");
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const suma = Number(f.cash || 0) + Number(f.card || 0);
  const trySave = () => {
    if (!f.descriere.trim()) { setErr("Completează descrierea."); return; }
    if (Number(f.cash || 0) < 0 || Number(f.card || 0) < 0) { setErr("Sumele nu pot fi negative."); return; }
    if (suma <= 0) { setErr("Introdu o sumă (numerar sau card)."); return; }
    setErr("");
    onSave({ ...f, descriere: f.descriere.trim(), cash: Number(f.cash || 0), card: Number(f.card || 0), suma });
  };
  return (
    <div>
      <div className="field"><label>Ziua</label><input type="date" value={f.data} onChange={(e) => set("data", e.target.value)} /></div>
      <div className="field"><label>Mașină (opțional — ca să vezi profitul pe mașină)</label>
        <select value={f.carId} onChange={(e) => set("carId", e.target.value)}>
          <option value="">— fără mașină —</option>
          {(cars || []).map((c) => <option key={c.id} value={c.id}>{c.nr} — {c.marca} {c.model}</option>)}
        </select>
      </div>
      <div className="field"><label>Șofer (opțional)</label>
        <select value={f.șoferId} onChange={(e) => set("șoferId", e.target.value)}>
          <option value="">— fără șofer —</option>
          {drivers.map((d) => <option key={d.id} value={d.id}>{d.nume}</option>)}
        </select>
      </div>
      <div className="field"><label>Descriere</label><input value={f.descriere} onChange={(e) => set("descriere", e.target.value)} placeholder="Schimb ulei BMW 520D" /></div>
      <div className="field"><label>Categorie</label>
        <select value={f.categorie} onChange={(e) => set("categorie", e.target.value)}>
          {["Motorină", "Ulei/Service", "Reparații", "Spălătorie", "Asigurare", "Impozite", "Altele"].map((c) => <option key={c}>{c}</option>)}
        </select>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <div className="field" style={{ flex: 1 }}><label>Numerar (lei)</label><input type="number" inputMode="decimal" value={f.cash} onChange={(e) => set("cash", e.target.value)} /></div>
        <div className="field" style={{ flex: 1 }}><label>Card (lei)</label><input type="number" inputMode="decimal" value={f.card} onChange={(e) => set("card", e.target.value)} /></div>
      </div>
      <div style={{ fontSize: 12, color: "var(--muted)", marginTop: -6, marginBottom: 10 }}>Total scos din cont: <b className="mono">{fmtMoney(suma)}</b></div>
      {err && <div className="save-warn" style={{ marginBottom: 8 }}><AlertTriangle size={14} />{err}</div>}
      <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
        <button className="btn primary" style={{ flex: 1, justifyContent: "center" }} onClick={trySave}><Check size={15} />Salvează</button>
        <button className="btn" onClick={onCancel}>Anulează</button>
      </div>
    </div>
  );
}

function IncomeForm({ onSave, onCancel }) {
  const [f, setF] = useState(() => ({ data: todayISO(), descriere: "", suma: "" }));
  const [err, setErr] = useState("");
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const trySave = () => {
    if (!f.descriere.trim()) { setErr("Completează descrierea."); return; }
    if (!(Number(f.suma) > 0)) { setErr("Introdu o sumă mai mare ca 0."); return; }
    setErr("");
    onSave({ ...f, descriere: f.descriere.trim(), suma: Number(f.suma) });
  };
  return (
    <div>
      <div className="field"><label>Dată</label><input type="date" value={f.data} onChange={(e) => set("data", e.target.value)} /></div>
      <div className="field"><label>Descriere</label><input value={f.descriere} onChange={(e) => set("descriere", e.target.value)} placeholder="Închiriere ocazională" /></div>
      <div className="field"><label>Sumă (lei)</label><input type="number" inputMode="decimal" value={f.suma} onChange={(e) => set("suma", e.target.value)} /></div>
      {err && <div className="save-warn" style={{ marginTop: 6 }}><AlertTriangle size={14} />{err}</div>}
      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <button className="btn primary" style={{ flex: 1, justifyContent: "center" }} onClick={trySave}><Check size={15} />Salvează</button>
        <button className="btn" onClick={onCancel}>Anulează</button>
      </div>
    </div>
  );
}

/* ============================== ÎNCASĂRI ZILNICE ============================== */
// Ecran de introducere rapidă: toate mașinile cu șofer alocat, pentru O SINGURĂ
// zi, într-un singur tabel — ca să nu mai umbli mașină cu mașină prin Calendar
// doar ca să notezi cine cât a adus azi. Scrie în ACELEAȘI date ca și Calendarul
// (weeklyPayments, mod "daily"), deci ce introduci aici apare automat și acolo.

function EarningsView({ data, update }) {
  const [date, setDate] = useState(() => todayISO());
  const [search, setSearch] = useState("");
  const [y, m, d] = date.split("-").map(Number);
  const year = y, month = m - 1, day = d;
  const ranges = weekRanges(year, month);
  const weekIdx = currentWeekIndex(year, month, day, ranges);

  const cars = useMemo(() => {
    return data.cars
      .filter((c) => c.driverId && isCarActive(c))
      .sort((a, b) => {
        const da = data.drivers.find((x) => x.id === a.driverId);
        const db = data.drivers.find((x) => x.id === b.driverId);
        return (da ? da.nume : "").localeCompare(db ? db.nume : "", "ro", { sensitivity: "base" });
      });
  }, [data.cars, data.drivers]);

  const setDay = (car, entry) => {
    const k = weekKey(year, month, debtOwnerId(car), weekIdx);
    update((prev) => {
      const existing = prev.weeklyPayments[k] || { year, month, carId: car.id, driverId: car.driverId || null, weekIdx, mode: "daily", paidCash: 0, paidCard: 0, paidAmount: 0, dailyAmounts: {} };
      const prevDay = (existing.dailyAmounts || {})[day] || {};
      const merged = { worked: true, cash: 0, card: 0, note: "", ...prevDay, ...entry };
      if (merged.driverId == null) merged.driverId = car.driverId || null;
      if (!merged.worked) { merged.cash = 0; merged.card = 0; }
      const dailyAmounts = { ...(existing.dailyAmounts || {}), [day]: merged };
      const paidCash = Object.values(dailyAmounts).reduce((s, dd) => s + (dd.worked === false ? 0 : Number(dd.cash || 0)), 0);
      const paidCard = Object.values(dailyAmounts).reduce((s, dd) => s + (dd.worked === false ? 0 : Number(dd.card || 0)), 0);
      const paidAmount = paidCash + paidCard;
      const rec = { ...existing, year, month, carId: car.id, driverId: car.driverId || null, weekIdx, mode: "daily", dailyAmounts, paidCash, paidCard, paidAmount };
      const entries = dayAuditEntries(prev, car, year, month, day, prevDay, merged, "Încasări zilnice");
      return { ...prev, weeklyPayments: { ...prev.weeklyPayments, [k]: rec }, auditLog: pushAudit(prev, entries) };
    });
  };

  const rows = cars.map((car) => {
    const rec = weeklyRecord(data, year, month, debtOwnerId(car), weekIdx);
    const dayRec = rec && rec.dailyAmounts ? rec.dailyAmounts[day] : null;
    const driver = data.drivers.find((dd) => dd.id === car.driverId);
    return { car, driver, dayRec };
  });

  // Șoferi care apar pe 2+ mașini în ziua afișată.
  const dupes = useMemo(
    () => duplicateDriverDays(data, year, month, day),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data.weeklyPayments, data.cars, data.drivers, year, month, day]
  );
  const dupByDriver = useMemo(() => new Map(dupes.map((x) => [x.driverId, x.cars])), [dupes]);

  const totals = rows.reduce((acc, r) => {
    if (r.dayRec && r.dayRec.worked !== false) {
      acc.cash += Number(r.dayRec.cash || 0);
      acc.card += Number(r.dayRec.card || 0);
    }
    return acc;
  }, { cash: 0, card: 0 });
  const enteredCount = rows.filter((r) => !!r.dayRec).length;

  // Căutare după nume șofer ȘI nr. înmatriculare (+ marcă/model). Se potrivește
  // și șoferul trecut pe ziua respectivă, dacă diferă de cel alocat acum mașinii.
  const filteredRows = useMemo(() => {
    if (!search.trim()) return rows;
    return rows.filter(({ car, driver, dayRec }) => {
      const dayDriver = dayRec && dayRec.driverId ? data.drivers.find((dd) => dd.id === dayRec.driverId) : null;
      return carMatchesSearch(car, [driver, dayDriver], search);
    });
  }, [rows, search, data.drivers]);

  const shiftDate = (delta) => {
    const dt = new Date(year, month, day + delta);
    setDate(`${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`);
  };

  // Clasament pe luna afișată — cine a adus cel mai mult, cumulat pe toate zilele.
  const leaderboard = useMemo(() => {
    const map = new Map(); // driverId -> total
    Object.values(data.weeklyPayments).forEach((rec) => {
      if (rec.year !== year || rec.month !== month || !rec.dailyAmounts) return;
      const fallbackDriver = rec.driverId || (data.cars.find((c) => c.id === rec.carId) || {}).driverId;
      Object.values(rec.dailyAmounts).forEach((dd) => {
        if (dd.worked === false) return;
        const driverId = dd.driverId || fallbackDriver;
        if (!driverId) return;
        const driver = data.drivers.find((dr) => dr.id === driverId);
        if (!driver) return;
        const sum = Number(dd.cash || 0) + Number(dd.card || 0);
        map.set(driver.id, { name: driver.nume, total: (map.get(driver.id)?.total || 0) + sum });
      });
    });
    return Array.from(map.values()).sort((a, b) => b.total - a.total);
  }, [data.weeklyPayments, data.cars, data.drivers, year, month]);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
        <button className="btn" style={{ padding: 8 }} aria-label="Ziua anterioară" onClick={() => shiftDate(-1)}><ChevronLeft size={16} /></button>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ maxWidth: 170 }} />
        <button className="btn" style={{ padding: 8 }} aria-label="Ziua următoare" onClick={() => shiftDate(1)}><ChevronRight size={16} /></button>
        {date !== todayISO() && <button className="btn" onClick={() => setDate(todayISO())}>Azi</button>}
        <div style={{ marginLeft: "auto", fontSize: 12, color: "var(--muted)" }}>
          {enteredCount}/{rows.length} mașini completate
        </div>
      </div>

      <DuplicateDriverWarning items={dupes} dateLabel={fmtDateRO(date)} />

      <div className="finance-grid" style={{ display: "grid", gap: 10, marginBottom: 16 }}>
        <MiniStat label="Numerar azi" value={fmtMoney(totals.cash)} color="var(--green)" />
        <MiniStat label="Card azi" value={fmtMoney(totals.card)} color="var(--green)" />
        <MiniStat label="Total azi" value={fmtMoney(totals.cash + totals.card)} color="var(--amber)" />
      </div>

      <div className="field" style={{ position: "relative" }}>
        <Search size={15} color="var(--muted)" style={{ position: "absolute", left: 11, top: "50%", transform: "translateY(-50%)" }} />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Caută după șofer sau nr. înmatriculare…"
          style={{ paddingLeft: 34 }}
        />
      </div>

      {rows.length === 0 ? (
        <div className="card"><EmptyState text="Nicio mașină cu șofer alocat. Alocă un șofer la o mașină (secțiunea Mașini) ca să apară aici." /></div>
      ) : filteredRows.length === 0 ? (
        <div className="card"><EmptyState text="Niciun rezultat pentru căutarea curentă." /></div>
      ) : (
        <div className="card" style={{ overflowX: "auto" }}>
          <table>
            <thead><tr><th>Șofer / Mașină</th><th>Stare</th><th>Numerar</th><th>Card</th><th>Total</th></tr></thead>
            <tbody>
              {filteredRows.map(({ car, driver, dayRec }) => {
                const worked = dayRec ? dayRec.worked !== false : true;
                const who = (dayRec && dayRec.driverId) || car.driverId;
                const otherCars = (dupByDriver.get(who) || []).filter((c) => c.carId !== car.id).map((c) => c.carNr);
                return (
                  <EarningsRow
                    key={`${date}-${car.id}`}
                    car={car} driver={driver} dayRec={dayRec} worked={worked}
                    otherCars={otherCars}
                    onCommit={(entry) => setDay(car, entry)}
                    onToggleWorked={(w) => setDay(car, { worked: w })}
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="card" style={{ marginTop: 16 }}>
        <div style={{ fontWeight: 700, marginBottom: 4 }} className="disp">Clasament luna {MONTHS_RO[month]}</div>
        <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 10 }}>Cine a adus cel mai mult, cumulat pe toată luna</div>
        {leaderboard.length === 0 ? (
          <EmptyState text="Nicio încasare introdusă încă luna asta." />
        ) : (
          <table>
            <thead><tr><th>#</th><th>Șofer</th><th>Total lună</th></tr></thead>
            <tbody>
              {leaderboard.map((r, i) => (
                <tr key={r.name + i}>
                  <td className="mono" style={{ color: i === 0 ? "var(--amber)" : "var(--muted)", fontWeight: 700 }}>{i + 1}</td>
                  <td style={{ fontWeight: 600 }}>{r.name}</td>
                  <td className="mono" style={{ fontWeight: 700, color: "var(--green)" }}>{fmtMoney(r.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function EarningsRow({ car, driver, dayRec, worked, otherCars, onCommit, onToggleWorked }) {
  const [cash, setCash] = useState(dayRec ? dayRec.cash : "");
  const [card, setCard] = useState(dayRec ? dayRec.card : "");
  const commit = () => onCommit({ cash, card, worked: true });
  const total = (Number(cash) || 0) + (Number(card) || 0);

  return (
    <tr style={!dayRec ? { boxShadow: "inset 3px 0 0 var(--amber)" } : undefined}>
      <td>
        <div style={{ fontWeight: 600 }}>{driver ? driver.nume : <span style={{ color: "var(--muted)" }}>—</span>}</div>
        <div style={{ fontSize: 11.5, color: "var(--muted)" }}>{car.nr}{car.marca ? ` · ${car.marca} ${car.model}` : ""}</div>
        {otherCars && otherCars.length > 0 && (
          <div style={{ marginTop: 4 }}>
            <span className="pill" style={{ background: "#e5484d22", color: "var(--red)" }}>
              <AlertTriangle size={11} />și pe {otherCars.join(", ")} în aceeași zi
            </span>
          </div>
        )}
      </td>
      <td>
        <div className="modetoggle">
          <button type="button" className={worked ? "active" : ""} onClick={() => onToggleWorked(true)}>A lucrat</button>
          <button type="button" className={!worked ? "active" : ""} onClick={() => onToggleWorked(false)}>Liber</button>
        </div>
      </td>
      {worked ? (
        <>
          <td style={{ minWidth: 110 }}><input type="number" inputMode="decimal" placeholder="0" value={cash} onChange={(e) => setCash(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && e.target.blur()} /></td>
          <td style={{ minWidth: 110 }}><input type="number" inputMode="decimal" placeholder="0" value={card} onChange={(e) => setCard(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && e.target.blur()} /></td>
          <td className="mono" style={{ fontWeight: 700 }}>{fmtMoney(total)}</td>
        </>
      ) : (
        <td colSpan={3} style={{ color: "var(--muted)", fontSize: 12.5 }}>Zi liberă / nu a lucrat</td>
      )}
    </tr>
  );
}

/* ============================== REPORTS ============================== */

function ReportsView({ data }) {
  const [year, setYear] = useState(() => nowMoldova().getFullYear());
  const [month, setMonth] = useState(() => nowMoldova().getMonth());
  const [filter, setFilter] = useState("toate");
  const [search, setSearch] = useState("");

  const perCar = useMemo(() =>   const perCar = useMemo(() => {
    // Luna afișată este luna curentă? (doar atunci ascundem mașinile cu 0 adus)
    const nowM = nowMoldova();
    const isCurrentMonth = year === nowM.getFullYear() && month === nowM.getMonth();

    const rows = data.cars.filter((car) => car.driverId).map((car) => {
      const planBase = monthlyPlanBase(data, car, year, month);
      const plan = monthlyPlanWithCarry(data, car, year, month);
      const paid = monthlyPaid(data, year, month, debtOwnerId(car));
      const carryover = carryoverFromPrevMonth(data, car, year, month);
      const driver = data.drivers.find((d) => d.id === car.driverId);
      const rest = Math.max(plan - paid, 0);
      const status = statusOf(plan, paid);
      return { car, driver, planBase, plan, paid, rest, carryover, status };
    });

    // În luna curentă: mașinile care au adus 0 lei nu se afișează
    // și nu intră în totaluri / restanțe.
    const visible = isCurrentMonth ? rows.filter((r) => r.paid > 0) : rows;

    // Restanțele mai mari primele, ca să vezi imediat ce trebuie urmărit.
    return visible.sort((a, b) => b.rest - a.rest || b.paid - a.paid);
  }, [data, year, month]);

  // Profit pe mașină = ce a adus mașina în luna asta − cheltuielile legate de ea.
  const profitPerCar = useMemo(() => {
    const mk = monthKey(year, month);
    return data.cars.map((car) => {
      const income = monthlyPaid(data, year, month, debtOwnerId(car));
      const costs = data.expenses
        .filter((e) => e.carId === car.id && e.data && e.data.startsWith(mk))
        .reduce((s, e) => s + Number(e.suma || 0), 0);
      return { car, income, costs, profit: income - costs };
    }).filter((r) => r.income > 0 || r.costs > 0).sort((a, b) => b.profit - a.profit);
  }, [data, year, month]);

  const filteredCars = useMemo(() => {
    let out = perCar;
    if (filter === "restanta") out = out.filter((r) => r.rest > 0);
    if (filter === "la_zi") out = out.filter((r) => r.rest <= 0);
    const q = search.trim().toLowerCase();
    if (q) {
      out = out.filter((r) =>
        r.car.nr.toLowerCase().includes(q) ||
        (r.driver && r.driver.nume.toLowerCase().includes(q)) ||
        (r.car.marca && r.car.marca.toLowerCase().includes(q)) ||
        (r.car.model && r.car.model.toLowerCase().includes(q))
      );
    }
    return out;
  }, [perCar, filter, search]);

  const totals = perCar.reduce((acc, r) => ({
    plan: acc.plan + r.plan,
    paid: acc.paid + r.paid,
    rest: acc.rest + r.rest,
  }), { plan: 0, paid: 0, rest: 0 });
  const restanteCount = perCar.filter((r) => r.rest > 0).length;
  const orphanDebts = useMemo(() => driverDebtsWithoutCar(data), [data]);

  const changeMonth = (delta) => {
    let m = month + delta, y = year;
    if (m < 0) { m = 11; y -= 1; }
    if (m > 11) { m = 0; y += 1; }
    setMonth(m); setYear(y);
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
        <button className="btn" style={{ padding: 8 }} aria-label="Luna anterioară" onClick={() => changeMonth(-1)}><ChevronLeft size={16} /></button>
        <div className="disp" style={{ fontSize: 18, fontWeight: 700, minWidth: 170, textAlign: "center" }}>{MONTHS_RO[month]} {year}</div>
        <button className="btn" style={{ padding: 8 }} aria-label="Luna următoare" onClick={() => changeMonth(1)}><ChevronRight size={16} /></button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px,1fr))", gap: 12, marginBottom: 10 }}>
        <MiniStat label="Total de recuperat" value={fmtMoney(totals.plan)} color="var(--amber)" />
        <MiniStat label="Adus total" value={fmtMoney(totals.paid)} color="var(--green)" />
        <MiniStat label="Restanțe total" value={fmtMoney(totals.rest)} color={totals.rest > 0 ? "var(--orange)" : "var(--muted)"} />
      </div>
      <div style={{ fontSize: 11.5, color: "var(--muted)", marginBottom: 18 }}>
        „Total de recuperat" = chiria lunii curente + orice restanță neachitată din lunile anterioare, adunată automat.
      </div>

      {orphanDebts.length > 0 && (
        <div className="card" style={{ borderColor: "#e5484d55", marginBottom: 16 }}>
          <div style={{ fontWeight: 700, marginBottom: 4, display: "flex", alignItems: "center", gap: 6 }} className="disp">
            <AlertTriangle size={15} color="var(--red)" /> Șoferi cu restanță, fără mașină alocată acum
          </div>
          <div style={{ fontSize: 11.5, color: "var(--muted)", marginBottom: 10 }}>
            Au rămas cu datorie de pe o mașină pe care nu o mai conduc — nu apar în tabelul de mai jos, dar tot o datorează.
          </div>
          <table>
            <thead><tr><th>Șofer</th><th>Restanță</th></tr></thead>
            <tbody>
              {orphanDebts.map(({ driver, rest }) => (
                <tr key={driver.id}>
                  <td>{driver.nume}</td>
                  <td className="mono" style={{ color: "var(--orange)", fontWeight: 700 }}>{fmtMoney(rest)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {perCar.length === 0 ? (
        <div className="card"><EmptyState text="Nicio mașină cu șofer alocat momentan." /></div>
      ) : (
        <>
          <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap" }}>
            {[
              { id: "toate", label: `Toate (${perCar.length})` },
              { id: "restanta", label: `Cu restanță (${restanteCount})` },
              { id: "la_zi", label: `La zi (${perCar.length - restanteCount})` },
            ].map((f) => (
              <button
                key={f.id}
                className={"btn" + (filter === f.id ? " primary" : "")}
                style={{ padding: "7px 12px", fontSize: 12.5 }}
                onClick={() => setFilter(f.id)}
              >
                {f.label}
              </button>
            ))}
          </div>

          <div className="field" style={{ position: "relative" }}>
            <Search size={15} color="var(--muted)" style={{ position: "absolute", left: 11, top: "50%", transform: "translateY(-50%)" }} />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Caută după șofer sau nr. înmatriculare…"
              style={{ paddingLeft: 34 }}
            />
          </div>

          {filteredCars.length === 0 ? (
            <div className="card"><EmptyState text="Nicio mașină în această categorie." /></div>
          ) : (
            <div className="card" style={{ overflowX: "auto" }}>
              <table>
                <thead><tr><th>Mașină</th><th>Șofer</th><th>Total de recuperat</th><th>Adus</th><th>Rest</th><th>Stare</th></tr></thead>
                <tbody>
                  {filteredCars.map(({ car, driver, planBase, plan, paid, rest, carryover, status }) => (
                    <tr key={car.id} style={rest > 0 ? { boxShadow: "inset 3px 0 0 var(--orange)" } : undefined}>
                      <td style={{ fontWeight: 600 }}>{car.nr}</td>
                      <td>{driver ? driver.nume : <span style={{ color: "var(--muted)" }}>—</span>}</td>
                      <td className="mono">
                        {fmtMoney(plan)}
                        {carryover > 0 ? (
                          <div style={{ fontSize: 10.5, color: "var(--muted)", fontWeight: 400 }}>
                            din care: {fmtMoney(planBase)} plan lună + <span style={{ color: "var(--orange)" }}>{fmtMoney(carryover)} restanță veche</span>
                          </div>
                        ) : null}
                      </td>
                      <td className="mono" style={{ color: "var(--green)" }}>{fmtMoney(paid)}</td>
                      <td className="mono" style={{ color: rest > 0 ? "var(--orange)" : "var(--muted)", fontWeight: rest > 0 ? 700 : 400 }}>{fmtMoney(rest)}</td>
                      <td><StatusPill status={status} restanta={rest} /></td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr style={{ borderTop: "1px solid var(--border, #2a303b)" }}>
                    <td style={{ fontWeight: 700 }} colSpan={2}>Total</td>
                    <td className="mono" style={{ fontWeight: 700 }}>{fmtMoney(totals.plan)}</td>
                    <td className="mono" style={{ fontWeight: 700, color: "var(--green)" }}>{fmtMoney(totals.paid)}</td>
                    <td className="mono" style={{ fontWeight: 700, color: totals.rest > 0 ? "var(--orange)" : "var(--muted)" }}>{fmtMoney(totals.rest)}</td>
                    <td></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </>
      )}

      <div className="card" style={{ marginTop: 16 }}>
        <div style={{ fontWeight: 700, marginBottom: 4 }} className="disp">Profit pe mașină — {MONTHS_RO[month]}</div>
        <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 10 }}>
          Adus de mașină − cheltuielile la care ai ales mașina (service, ulei, spălătorie etc.). Cheltuielile fără mașină nu apar aici.
        </div>
        {profitPerCar.length === 0 ? (
          <EmptyState text="Nimic de arătat încă. Când adaugi o cheltuială în Finanțe, alege și mașina ei." />
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead><tr><th>Mașină</th><th>Adus</th><th>Cheltuieli</th><th>Profit</th></tr></thead>
              <tbody>
                {profitPerCar.map(({ car, income, costs, profit }) => (
                  <tr key={car.id}>
                    <td style={{ fontWeight: 600 }}>{car.nr} <span style={{ color: "var(--muted)", fontWeight: 400 }}>· {car.marca} {car.model}</span></td>
                    <td className="mono" style={{ color: "var(--green)" }}>{fmtMoney(income)}</td>
                    <td className="mono" style={{ color: costs > 0 ? "var(--red)" : "var(--muted)" }}>{fmtMoney(costs)}</td>
                    <td className="mono" style={{ fontWeight: 700, color: profit >= 0 ? "var(--green)" : "var(--red)" }}>{fmtMoney(profit)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/* ============================== ISTORIC MODIFICĂRI ============================== */

const AUDIT_TYPE_META = {
  incasare:   { label: "Încasare",    color: "var(--green)",  bg: "#2bb67322" },
  total:      { label: "Total săpt.", color: "var(--green)",  bg: "#2bb67322" },
  cheltuiala: { label: "Cheltuială",  color: "var(--red)",    bg: "#e5484d22" },
  venit:      { label: "Venit extra", color: "var(--amber)",  bg: "#f2b70522" },
  masina:     { label: "Mașină",      color: "var(--orange)", bg: "#f2841c22" },
  sofer:      { label: "Șofer",       color: "var(--orange)", bg: "#f2841c22" },
};
const AUDIT_FILTERS = [
  { id: "toate", label: "Toate" },
  { id: "incasare", label: "Încasări" },
  { id: "total", label: "Totaluri săpt." },
  { id: "cheltuiala", label: "Cheltuieli" },
  { id: "venit", label: "Venituri extra" },
  { id: "masina", label: "Mașini" },
  { id: "sofer", label: "Șoferi" },
];

function AuditView({ data }) {
  const [typeFilter, setTypeFilter] = useState("toate");
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(60);
  const log = data.auditLog || [];

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return log.filter((e) => {
      if (typeFilter !== "toate" && e.type !== typeFilter) return false;
      if (!q) return true;
      return (e.text || "").toLowerCase().includes(q) || (e.carNr || "").toLowerCase().includes(q) || (e.driverName || "").toLowerCase().includes(q);
    });
  }, [log, typeFilter, search]);

  const visible = filtered.slice(0, limit);

  return (
    <div>
      <div style={{ fontSize: 12.5, color: "var(--muted)", marginBottom: 12 }}>
        Aici vezi ce s-a modificat, când și cu ce valori (înainte → după). Istoricul începe din momentul în care a fost adăugată această filă și păstrează ultimele {AUDIT_MAX} modificări.
      </div>

      <div className="field" style={{ position: "relative", marginBottom: 10 }}>
        <Search size={15} color="var(--muted)" style={{ position: "absolute", left: 11, top: "50%", transform: "translateY(-50%)" }} />
        <input
          value={search}
          onChange={(e) => { setSearch(e.target.value); setLimit(60); }}
          placeholder="Caută după mașină, șofer sau text…"
          style={{ paddingLeft: 34 }}
        />
      </div>

      <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
        {AUDIT_FILTERS.map((f) => (
          <button
            key={f.id}
            className={"btn" + (typeFilter === f.id ? " primary" : "")}
            style={{ padding: "7px 12px", fontSize: 12.5 }}
            onClick={() => { setTypeFilter(f.id); setLimit(60); }}
          >
            {f.label}
          </button>
        ))}
      </div>

      {log.length === 0 ? (
        <div className="card"><EmptyState text="Nicio modificare înregistrată încă. De acum încolo, orice sumă introdusă sau schimbată apare aici." /></div>
      ) : filtered.length === 0 ? (
        <div className="card"><EmptyState text="Nimic găsit pentru filtrul ales." /></div>
      ) : (
        <div className="card" style={{ padding: "6px 16px" }}>
          {visible.map((e) => {
            const meta = AUDIT_TYPE_META[e.type] || { label: "Altceva", color: "var(--muted)", bg: "#8b93a122" };
            return (
              <div key={e.id} style={{ display: "flex", gap: 12, padding: "11px 0", borderBottom: "1px solid #ffffff0a", alignItems: "flex-start", flexWrap: "wrap" }}>
                <div style={{ width: 118, flexShrink: 0 }}>
                  <div className="mono" style={{ fontSize: 12 }}>{fmtDateTimeRO(e.at)}</div>
                  {e.source && <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>{e.source}</div>}
                </div>
                <span className="pill" style={{ background: meta.bg, color: meta.color, flexShrink: 0 }}>{meta.label}</span>
                <div style={{ fontSize: 13.5, flex: "1 1 240px", minWidth: 0, overflowWrap: "anywhere" }}>{e.text}</div>
              </div>
            );
          })}
          {filtered.length > visible.length && (
            <div style={{ padding: "12px 0", textAlign: "center" }}>
              <button className="btn" onClick={() => setLimit((n) => n + 60)}>Arată mai multe ({filtered.length - visible.length} rămase)</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ============================== FIȘA ȘOFERULUI ============================== */

function DriverProfile({ data, driver }) {
  const now = nowMoldova();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth());
  const mk = monthKey(year, month);

  const records = useMemo(
    () => driverDayRecords(data, driver.id),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data.weeklyPayments, data.cars, driver.id]
  );

  const car = data.cars.find((c) => c.driverId === driver.id);
  const monthRecs = records.filter((r) => r.year === year && r.month === month).sort((a, b) => a.day - b.day);
  const incomeDays = monthRecs.filter((r) => r.worked && r.cash + r.card > 0);
  const offDays = monthRecs.filter((r) => !r.worked);
  const cash = incomeDays.reduce((s, r) => s + r.cash, 0);
  const card = incomeDays.reduce((s, r) => s + r.card, 0);
  const total = cash + card;
  const avg = incomeDays.length ? total / incomeDays.length : 0;

  // Sume introduse DOAR ca total pe săptămână (fără detaliu pe zile) — nu pot fi puse pe o zi anume.
  const weeklyOnly = Object.values(data.weeklyPayments || {})
    .filter((rec) => rec && rec.year === year && rec.month === month && rec.driverId === driver.id && Object.keys(rec.dailyAmounts || {}).length === 0)
    .reduce((s, rec) => s + Number(rec.paidAmount || 0), 0);

  const expenses = data.expenses.filter((e) => e.șoferId === driver.id && e.data && e.data.startsWith(mk));
  const expensesTotal = expenses.reduce((s, e) => s + Number(e.suma || 0), 0);

  // Pe ce mașini a adus bani luna asta.
  const byCar = useMemo(() => {
    const map = new Map();
    incomeDays.forEach((r) => {
      const cur = map.get(r.carId) || { carNr: r.carNr, days: 0, total: 0 };
      cur.days += 1; cur.total += r.cash + r.card;
      map.set(r.carId, cur);
    });
    return Array.from(map.values()).sort((a, b) => b.total - a.total);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [records, year, month]);

  // Ultimele 6 luni (până la luna aleasă).
  const history = [];
  for (let i = 0; i < 6; i++) {
    let m = month - i, y = year;
    while (m < 0) { m += 12; y -= 1; }
    const rs = records.filter((r) => r.year === y && r.month === m && r.worked && r.cash + r.card > 0);
    const t = rs.reduce((s, r) => s + r.cash + r.card, 0);
    history.push({ y, m, days: rs.length, total: t, avg: rs.length ? t / rs.length : 0 });
  }

  // Restanța e pe MAȘINĂ (nu pe șofer), deci o arătăm pentru mașina lui actuală.
  const carRest = car && isCarActive(car)
    ? Math.max(monthlyPlanWithCarry(data, car, year, month) - monthlyPaid(data, year, month, debtOwnerId(car)), 0)
    : 0;

  const changeMonth = (delta) => {
    let m = month + delta, y = year;
    if (m < 0) { m = 11; y -= 1; }
    if (m > 11) { m = 0; y += 1; }
    setMonth(m); setYear(y);
  };

  // Mesaj pentru WhatsApp.
  const summary = [
    `Raport ${driver.nume} — ${MONTHS_RO[month]} ${year}`,
    `Zile cu încasare: ${incomeDays.length}`,
    `Numerar: ${fmtMoney(cash)}`,
    `Card: ${fmtMoney(card)}`,
    `Total adus: ${fmtMoney(total)}`,
    ...(incomeDays.length ? [`Medie pe zi: ${fmtMoney(avg)}`] : []),
    ...(offDays.length ? [`Zile libere / nelucrate: ${offDays.length}`] : []),
    ...(car && carRest > 0 ? [`Restanță mașina ${car.nr}: ${fmtMoney(carRest)}`] : []),
  ].join("\n");
  let phone = (driver.telefon || "").replace(/\D/g, "");
  if (/^0\d{8}$/.test(phone)) phone = "373" + phone.slice(1); // 06X XXX XXX → 3736X XXX XXX
  const waUrl = `https://wa.me/${phone}?text=${encodeURIComponent(summary)}`;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
        <span className="pill" style={{ background: driver.activ ? "#2bb67322" : "#8b93a122", color: driver.activ ? "var(--green)" : "var(--muted)" }}>{driver.activ ? "Activ" : "Inactiv"}</span>
        {driver.telefon && <span style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 13 }}><Phone size={12} />{driver.telefon}</span>}
        <span style={{ fontSize: 13, color: "var(--muted)" }}>Mașină: {car ? car.nr : "nealocat"}</span>
        <a className="btn" style={{ marginLeft: "auto", textDecoration: "none" }} href={waUrl} target="_blank" rel="noopener noreferrer">
          <Send size={14} />Trimite pe WhatsApp
        </a>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
        <button className="btn" style={{ padding: 8 }} aria-label="Luna anterioară" onClick={() => changeMonth(-1)}><ChevronLeft size={16} /></button>
        <div className="disp" style={{ fontSize: 16, fontWeight: 700, minWidth: 150, textAlign: "center" }}>{MONTHS_RO[month]} {year}</div>
        <button className="btn" style={{ padding: 8 }} aria-label="Luna următoare" onClick={() => changeMonth(1)}><ChevronRight size={16} /></button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(135px, 1fr))", gap: 10, marginBottom: 12 }}>
        <MiniStat label="Total adus" value={fmtMoney(total)} color="var(--green)" />
        <MiniStat label="Numerar" value={fmtMoney(cash)} color="var(--text)" />
        <MiniStat label="Card" value={fmtMoney(card)} color="var(--text)" />
        <MiniStat label="Zile cu încasare" value={String(incomeDays.length)} color="var(--amber)" />
        <MiniStat label="Medie / zi" value={fmtMoney(avg)} color="var(--amber)" />
        <MiniStat label="Zile libere" value={String(offDays.length)} color="var(--muted)" />
      </div>

      {weeklyOnly > 0 && (
        <div style={{ fontSize: 12, color: "var(--orange)", marginBottom: 10, display: "flex", alignItems: "center", gap: 5 }}>
          <AlertTriangle size={13} />Încă {fmtMoney(weeklyOnly)} au fost introduși doar ca total pe săptămână (fără zile) — nu apar în tabelul de mai jos.
        </div>
      )}
      {car && carRest > 0 && (
        <div style={{ fontSize: 12.5, color: "var(--orange)", marginBottom: 10, display: "flex", alignItems: "center", gap: 5 }}>
          <AlertTriangle size={13} />Restanță pe mașina {car.nr} în {MONTHS_RO[month]}: <b className="mono">{fmtMoney(carRest)}</b> <span style={{ color: "var(--muted)" }}>(restanța e calculată pe mașină, nu pe șofer)</span>
        </div>
      )}
      {expensesTotal > 0 && (
        <div style={{ fontSize: 12.5, color: "var(--muted)", marginBottom: 10 }}>
          Cheltuieli legate de acest șofer în {MONTHS_RO[month]}: <b className="mono" style={{ color: "var(--red)" }}>{fmtMoney(expensesTotal)}</b> ({expenses.length})
        </div>
      )}

      {byCar.length > 0 && (
        <div style={{ fontSize: 12.5, color: "var(--muted)", marginBottom: 14 }}>
          Pe mașini: {byCar.map((c) => `${c.carNr} — ${c.days} zile, ${fmtMoney(c.total)}`).join(" · ")}
        </div>
      )}

      <div style={{ fontWeight: 700, marginBottom: 6 }} className="disp">Zile din {MONTHS_RO[month]}</div>
      {monthRecs.length === 0 ? (
        <EmptyState text="Nicio zi introdusă pentru acest șofer în luna aleasă." />
      ) : (
        <div style={{ overflowX: "auto", marginBottom: 16 }}>
          <table>
            <thead><tr><th>Zi</th><th>Mașină</th><th>Numerar</th><th>Card</th><th>Total</th><th>Notă</th></tr></thead>
            <tbody>
              {monthRecs.map((r) => (
                <tr key={`${r.carId}-${r.day}`} style={!r.worked ? { opacity: 0.55 } : undefined}>
                  <td>{dayLabel(year, month, r.day)}</td>
                  <td>{r.carNr}</td>
                  {r.worked ? (
                    <>
                      <td className="mono">{fmtMoney(r.cash)}</td>
                      <td className="mono">{fmtMoney(r.card)}</td>
                      <td className="mono" style={{ fontWeight: 700 }}>{fmtMoney(r.cash + r.card)}</td>
                    </>
                  ) : (
                    <td colSpan={3} style={{ color: "var(--muted)", fontSize: 12.5 }}>Nu a lucrat</td>
                  )}
                  <td style={{ fontSize: 12, color: "var(--muted)" }}>{r.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ fontWeight: 700, marginBottom: 6 }} className="disp">Ultimele 6 luni</div>
      <div style={{ overflowX: "auto" }}>
        <table>
          <thead><tr><th>Luna</th><th>Zile cu încasare</th><th>Total adus</th><th>Medie / zi</th></tr></thead>
          <tbody>
            {history.map((h) => (
              <tr key={`${h.y}-${h.m}`}>
                <td>{MONTHS_RO[h.m]} {h.y}</td>
                <td className="mono">{h.days}</td>
                <td className="mono" style={{ fontWeight: 700, color: h.total > 0 ? "var(--green)" : "var(--muted)" }}>{fmtMoney(h.total)}</td>
                <td className="mono">{h.days ? fmtMoney(h.avg) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ============================== MODAL ============================== */

function Modal({ title, children, onClose, maxWidth }) {
  useEscape(onClose);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} style={maxWidth ? { maxWidth } : undefined} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <div className="disp" style={{ fontWeight: 700, fontSize: 16 }}>{title}</div>
          <button className="btn" style={{ padding: 6 }} aria-label="Închide" onClick={onClose}><X size={15} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}
