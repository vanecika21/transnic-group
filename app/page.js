"use client";
import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import {
  Car, Users, Calendar as CalendarIcon, Wallet, BarChart3, Plus, X,
  Trash2, Pencil, Check, AlertTriangle, ChevronLeft, ChevronRight,
  Phone, Loader2, TrendingUp, TrendingDown, Gauge, Shield, Wrench, Search
} from "lucide-react";

/* ---------------------------------------------------------------
   Taxi Fleet Pro Cloud (web version)
   Data stored in Supabase via /api/data.
   Payment model: weekly. Each month is split into 4 fixed sections
   (1-7, 8-14, 15-21, 22-end). Sundays don't count toward the plan.
   If a car doesn't reach its monthly plan, the shortfall is added
   automatically to the next month's plan.
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
  weeklyPayments: {},  // key `${y}-${mm}__${ownerId}__${weekIdx}`. ownerId = șoferul alocat mașinii la momentul înregistrării
                        // (sau id-ul mașinii, dacă nu are șofer alocat) -> {year,month,carId,driverId,weekIdx,paidCash,paidCard,paidAmount}
  debtMigratedToDrivers: false, // devine true după ce restanțele vechi (legate de mașină) sunt migrate pe șofer
  expenses: [],
  incomes: [],
  insurances: [],
  inspections: [],
  yandexDrivers: [],   // șoferi sincronizați din Yandex Fleet API
  yandexEarnings: {},  // key `${date}__${yandexDriverId}` -> {date, yandex_driver_id, total_cash, total_card, total_gross, yandex_commission, park_commission, net_payout}
});

function fmtMoney(n) {
  const v = Number(n) || 0;
  return v.toLocaleString("ro-RO", { maximumFractionDigits: 0 }) + " lei";
}
function daysInMonth(year, month) { return new Date(year, month + 1, 0).getDate(); }
function monthKey(y, m) { return `${y}-${String(m + 1).padStart(2, "0")}`; }
function isSunday(year, month, day) { return new Date(year, month, day).getDay() === 0; }

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

function weekKey(year, month, ownerId, weekIdx) { return `${year}-${String(month + 1).padStart(2, "0")}__${ownerId}__${weekIdx}`; }
function weeklyRecord(data, year, month, ownerId, weekIdx) { return data.weeklyPayments[weekKey(year, month, ownerId, weekIdx)] || null; }
function weeklyPaid(data, year, month, ownerId, weekIdx) {
  const r = weeklyRecord(data, year, month, ownerId, weekIdx);
  return r ? Number(r.paidAmount || 0) : 0;
}
// Restanța/plata se leagă de ȘOFER (persoană), nu de mașină: dacă mașina are
// un șofer alocat acum, el e "proprietarul" datoriei. Dacă mașina nu are
// niciun șofer alocat, rămâne provizoriu legată de mașină (ca să nu se piardă
// date), până se alocă cineva.
function debtOwnerId(car) {
  return car.driverId || car.id;
}
// Migrare unică: mută restanțele vechi (legate de mașină) pe șoferul care
// conduce acum acea mașină. Rulează o singură dată, la încărcare — vezi
// TaxiFleetPro (useEffect) — și e ferită de rulare dublă prin flag-ul
// debtMigratedToDrivers.
function migrateDebtToDrivers(data) {
  if (data.debtMigratedToDrivers) return data;
  const wp = data.weeklyPayments || {};
  const migrated = {};
  Object.values(wp).forEach((rec) => {
    if (!rec) return;
    const oldCarId = rec.carId;
    const car = data.cars.find((c) => c.id === oldCarId);
    const ownerId = (car && car.driverId) || oldCarId;
    const driverId = car && car.driverId ? car.driverId : null;
    const k = weekKey(rec.year, rec.month, ownerId, rec.weekIdx);
    const existing = migrated[k];
    if (existing) {
      // Coliziune rară: doi șoferi diferiți au adus deja bani în aceeași
      // săptămână și ajung acum pe același "proprietar" — le adunăm ca să nu
      // se piardă nimic.
      const dailyAmounts = { ...(existing.dailyAmounts || {}), ...(rec.dailyAmounts || {}) };
      migrated[k] = {
        ...existing,
        driverId: driverId || existing.driverId,
        paidCash: Number(existing.paidCash || 0) + Number(rec.paidCash || 0),
        paidCard: Number(existing.paidCard || 0) + Number(rec.paidCard || 0),
        paidAmount: Number(existing.paidAmount || 0) + Number(rec.paidAmount || 0),
        dailyAmounts,
      };
    } else {
      migrated[k] = { ...rec, carId: oldCarId, driverId };
    }
  });
  return { ...data, weeklyPayments: migrated, debtMigratedToDrivers: true };
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
function workingDaysEffective(data, car, year, month, weekIdx, ranges) {
  if (!isCarActive(car)) return 0;
  const r = ranges[weekIdx];
  const rec = weeklyRecord(data, year, month, debtOwnerId(car), weekIdx);
  let count = 0;
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
    count++;
  }
  return count;
}
function monthlyPlanBase(data, car, year, month) {
  const ranges = weekRanges(year, month);
  const rate = dailyRate(car, year, month);
  let total = 0;
  for (let i = 0; i < ranges.length; i++) total += rate * workingDaysEffective(data, car, year, month, i, ranges);
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
  const base = dailyRate(car, year, month) * workingDaysEffective(data, car, year, month, weekIdx, ranges);
  return weekIdx === 0 ? base + carryoverFromPrevMonth(data, car, year, month) : base;
}

// Restanța unui șofer nu trebuie să dispară doar pentru că nu mai conduce
// nicio mașină acum (a fost mutat pe alta, sau a plecat). Funcția asta
// adună restanțele rămase din toate înregistrările lui, indiferent de lună.
function driverDebtsWithoutCar(data) {
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

export default function TaxiFleetPro() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [tab, setTab] = useState("dashboard");

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
      setData({ ...emptyData(), ...(json ? json.data || {} : {}) });
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const pendingSaveRef = useRef(null);
  const savingRef = useRef(false);

  const persist = useCallback(async (next) => {
    // Ținem minte mereu CEA MAI RECENTĂ stare de trimis. Dacă o cerere e deja
    // în curs, noua stare așteaptă — nu pornim o a doua cerere în paralel.
    // Așa nu mai există risc ca un răspuns "vechi" să ajungă după unul "nou"
    // și să suprascrie date proaspăt introduse (exact bugul din Finanțe).
    pendingSaveRef.current = next;
    if (savingRef.current) return;
    savingRef.current = true;
    while (pendingSaveRef.current) {
      const toSend = pendingSaveRef.current;
      pendingSaveRef.current = null;
      try {
        const res = await fetch("/api/data", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(toSend),
        });
        setSaveError(!res.ok);
      } catch {
        setSaveError(true);
      }
    }
    savingRef.current = false;
  }, []);

  const update = useCallback((fn) => {
    setData((prev) => {
      const next = fn(prev);
      persist(next);
      return next;
    });
  }, [persist]);

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
        const fresh = { ...emptyData(), ...json.data };
        // Nu lăsăm niciodată un răspuns "gol" (fără mașini/șoferi) să
        // înlocuiască date locale care chiar există — mai bine păstrăm ce
        // avem local decât să riscăm să ștergem ceva din greșeală.
        const freshEmpty = (!fresh.cars || !fresh.cars.length) && (!fresh.drivers || !fresh.drivers.length);
        setData((prev) => {
          if (freshEmpty && prev && ((prev.cars && prev.cars.length) || (prev.drivers && prev.drivers.length))) return prev;
          return fresh;
        });
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Migrare unică: restanțele care erau legate de mașină trec pe șoferul
  // care conduce acum acea mașină. Rulează o singură dată (flag
  // debtMigratedToDrivers) și salvează imediat rezultatul.
  // Siguranță în plus: dacă nu există nicio mașină/șofer/plată (adică
  // "datele" arată suspect de goale), NU trimitem nimic pe server — punem
  // doar flag-ul local. Așa, chiar dacă apare vreun bug de încărcare pe
  // viitor, nu mai poate scrie automat un stat gol peste date reale.
  useEffect(() => {
    if (!data || data.debtMigratedToDrivers) return;
    const looksEmpty = (!data.cars || !data.cars.length) && (!data.drivers || !data.drivers.length) && !Object.keys(data.weeklyPayments || {}).length;
    if (looksEmpty) {
      setData((prev) => ({ ...prev, debtMigratedToDrivers: true }));
      return;
    }
    const migrated = migrateDebtToDrivers(data);
    setData(migrated);
    persist(migrated);
  }, [data, persist]);

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
    <Shell tab={tab} setTab={setTab} saveError={saveError}>
      {tab === "dashboard" && <Dashboard data={data} setTab={setTab} />}
      {tab === "cars" && <CarsView data={data} update={update} />}
      {tab === "drivers" && <DriversView data={data} update={update} />}
      {tab === "calendar" && <WeeklyCalendarView data={data} update={update} />}
      {tab === "insurance" && <InsuranceView data={data} update={update} />}
      {tab === "inspection" && <InspectionView data={data} update={update} />}
      {tab === "finance" && <FinanceView data={data} update={update} />}
      {tab === "reports" && <ReportsView data={data} />}
      {tab === "earnings" && <EarningsView data={data} update={update} />}
    </Shell>
  );
}

/* ============================== SHELL ============================== */

function Shell({ tab, setTab, children, loading, saveError }) {
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
    ] },
  ];
  const flatNav = navGroups.flatMap((g) => g.items);
  const current = flatNav.find((n) => n.id === tab);

  return (
    <div style={{ "--bg": "#14171c", "--panel": "#1c2029", "--amber": "#f2b705", "--orange": "#f2841c", "--green": "#2bb673", "--red": "#e5484d", "--text": "#eae7e0", "--muted": "#8b93a1", "--border": "#2a303b" }}
      className="tfp-root">
      <style>{`
        .tfp-root{background:var(--bg);color:var(--text);min-height:100vh;font-family:'Inter',system-ui,sans-serif;display:flex;flex-direction:row;font-size:14.5px}
        .tfp-root *{box-sizing:border-box}
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&family=IBM+Plex+Mono:wght@500;600&display=swap');
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
        .tfp-sidebar-foot{padding:14px 18px;border-top:1px solid var(--border);font-size:11.5px;color:var(--muted)}

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
        .btn.primary{background:var(--amber);color:#14171c;border-color:var(--amber)}
        .btn.primary:hover{background:#ffcb2b}
        .btn.danger{color:var(--red);border-color:#e5484d33}
        .btn.danger:hover{background:#e5484d1a}
        input,select,textarea{background:#0f1216;border:1px solid var(--border);color:var(--text);border-radius:7px;padding:10px 12px;font-size:14.5px;font-family:inherit;width:100%}
        input:focus,select:focus,textarea:focus{outline:2px solid var(--amber);outline-offset:1px}
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
        {saveError && (
          <div className="tfp-sidebar-foot">
            <div className="save-warn"><AlertTriangle size={14} />Salvarea a eșuat</div>
          </div>
        )}
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
          {saveError && <div className="save-warn"><AlertTriangle size={14} />Salvarea a eșuat</div>}
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
            {saveError && <div className="save-warn"><AlertTriangle size={14} />Salvarea a eșuat</div>}
          </div>
        )}

        <div className="tfp-body">{children}</div>

        <div className="tfp-footer" suppressHydrationWarning>© {new Date().getFullYear()} Nichita Ivanov. Toate drepturile rezervate.</div>
      </div>
    </div>
  );
}


/* ============================== DASHBOARD ============================== */

function Dashboard({ data, setTab }) {
  const [now, setNow] = useState(null);
  useEffect(() => { setNow(nowMoldova()); }, []);
  if (!now) return null;
  const year = now.getFullYear(), month = now.getMonth(), day = now.getDate();
  const ranges = weekRanges(year, month);
  const wIdx = currentWeekIndex(year, month, day, ranges);
  const range = ranges[wIdx];

  const activeCars = data.cars.filter((c) => c.status === "activa").length;
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

  const insuranceAlerts = data.insurances.filter((ins) => { const d = daysUntil(ins.dataExpirare); return d != null && d <= 30; });
  const inspectionAlerts = data.inspections.filter((insp) => { const d = daysUntil(insp.dataExpirare); return d != null && d <= 30; });

  // Cash/card ADUSE AZI — introduse manual de tine în Calendar (modul "Pe zile"), NU din Yandex.
  const cashCardToday = (() => {
    let cash = 0, card = 0;
    Object.values(data.weeklyPayments || {}).forEach((rec) => {
      if (rec.year !== year || rec.month !== month || rec.mode !== "daily" || !rec.dailyAmounts) return;
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

  const stats = [
    { label: "Mașini", value: data.cars.length, icon: Car, sub: `${activeCars} active · ${inService} service` },
    { label: "Șoferi", value: data.drivers.length, icon: Users, sub: `${data.drivers.filter((d) => d.activ).length} activi` },
    { label: "Cash adus azi", value: fmtMoney(cashCardToday.cash), icon: Wallet, sub: todayISO(), mono: true },
    { label: "Card adus azi", value: fmtMoney(cashCardToday.card), icon: TrendingUp, sub: todayISO(), mono: true, accent: true },
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

      {missingTodayCount > 0 && (
        <div className="card" style={{ borderColor: "#f2b70555", marginBottom: 16, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <TrendingUp size={17} color="var(--amber)" />
          <div style={{ fontSize: 13.5 }}>{missingTodayCount} mașin{missingTodayCount === 1 ? "ă nu are" : "i nu au"} încă încasările de azi introduse.</div>
          <button className="btn primary" style={{ marginLeft: "auto" }} onClick={() => setTab("earnings")}>Introdu acum</button>
        </div>
      )}
      {problemCount > 0 && (
        <div className="card" style={{ borderColor: "#e5484d55", marginBottom: 16, display: "flex", alignItems: "center", gap: 10 }}>
          <AlertTriangle size={17} color="var(--red)" />
          <div style={{ fontSize: 13.5 }}>{problemCount} mașin{problemCount === 1 ? "ă are" : "i au"} restanță în săptămâna asta.</div>
          <button className="btn" style={{ marginLeft: "auto" }} onClick={() => setTab("calendar")}>Deschide calendar</button>
        </div>
      )}
      {insuranceAlerts.length > 0 && (
        <div className="card" style={{ borderColor: "#f2841c55", marginBottom: 16, display: "flex", alignItems: "center", gap: 10 }}>
          <Shield size={17} color="var(--orange)" />
          <div style={{ fontSize: 13.5 }}>{insuranceAlerts.length} asigurăr{insuranceAlerts.length === 1 ? "e expiră" : "i expiră"} în curând sau au expirat.</div>
          <button className="btn" style={{ marginLeft: "auto" }} onClick={() => setTab("insurance")}>Deschide asigurări</button>
        </div>
      )}
      {inspectionAlerts.length > 0 && (
        <div className="card" style={{ borderColor: "#f2841c55", marginBottom: 16, display: "flex", alignItems: "center", gap: 10 }}>
          <Wrench size={17} color="var(--orange)" />
          <div style={{ fontSize: 13.5 }}>{inspectionAlerts.length} revizi{inspectionAlerts.length === 1 ? "e tehnică expiră" : "i tehnice expiră"} în curând sau au expirat.</div>
          <button className="btn" style={{ marginLeft: "auto" }} onClick={() => setTab("inspection")}>Deschide revizii</button>
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

function ConfirmModal({ message, onConfirm, onCancel }) {
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" style={{ maxWidth: 360 }} onClick={(e) => e.stopPropagation()}>
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
      const cars = car.id ? prev.cars.map((c) => (c.id === car.id ? car : c)) : [...prev.cars, { ...car, id: uid() }];
      return { ...prev, cars };
    });
    setEditing(null);
  };
  const remove = (id) => update((prev) => ({ ...prev, cars: prev.cars.filter((c) => c.id !== id) }));

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
                      <button className="btn" style={{ padding: 6, marginRight: 6 }} onClick={() => setEditing(c)}><Pencil size={14} /></button>
                      <button className="btn danger" style={{ padding: 6 }} onClick={() => setConfirm({ message: `Ștergi mașina ${c.nr}? Această acțiune nu poate fi anulată.`, action: () => remove(c.id) })}><Trash2 size={14} /></button>
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
          <CarForm car={editing} drivers={data.drivers} onSave={save} onCancel={() => setEditing(null)} />
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

function CarForm({ car, drivers, onSave, onCancel }) {
  const [f, setF] = useState(car);
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
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
      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <button className="btn primary" style={{ flex: 1, justifyContent: "center" }} onClick={() => f.nr && onSave(f)}><Check size={15} />Salvează</button>
        <button className="btn" onClick={onCancel}>Anulează</button>
      </div>
    </div>
  );
}

function UnavailablePeriodsEditor({ periods, onChange }) {
  const [reason, setReason] = useState("service");
  const [start, setStart] = useState(todayISO());
  const [end, setEnd] = useState(todayISO());
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
                  {new Date(p.start).toLocaleDateString("ro-RO")} – {p.end ? new Date(p.end).toLocaleDateString("ro-RO") : <span style={{ color: "var(--amber)" }}>nedeterminat</span>}
                  {p.note ? <span style={{ color: "var(--muted)" }}> · {p.note}</span> : null}
                </span>
                {!p.end && (
                  <button type="button" className="btn" style={{ padding: "4px 8px", fontSize: 11.5, marginLeft: "auto" }} onClick={() => closeToday(p.id)}>Închide azi</button>
                )}
                <button type="button" className="btn danger" style={{ padding: 5, marginLeft: p.end ? "auto" : 0 }} onClick={() => remove(p.id)}><Trash2 size={13} /></button>
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
  const empty = { nume: "", telefon: "", activ: true };

  const save = (drv) => {
    update((prev) => {
      const drivers = drv.id ? prev.drivers.map((d) => (d.id === drv.id ? drv : d)) : [...prev.drivers, { ...drv, id: uid() }];
      return { ...prev, drivers };
    });
    setEditing(null);
  };
  const remove = (id) => {
    update((prev) => ({
      ...prev,
      drivers: prev.drivers.filter((d) => d.id !== id),
      cars: prev.cars.map((c) => (c.driverId === id ? { ...c, driverId: "" } : c)),
    }));
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
                      <button className="btn" style={{ padding: 6, marginRight: 6 }} onClick={() => setEditing(d)}><Pencil size={14} /></button>
                      <button className="btn danger" style={{ padding: 6 }} onClick={() => setConfirm({ message: `Ștergi șoferul ${d.nume}? Această acțiune nu poate fi anulată.`, action: () => remove(d.id) })}><Trash2 size={14} /></button>
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
      {confirm && (
        <ConfirmModal message={confirm.message} onCancel={() => setConfirm(null)} onConfirm={() => { confirm.action(); setConfirm(null); }} />
      )}
    </div>
  );
}

function DriverForm({ driver, onSave, onCancel }) {
  const [f, setF] = useState(driver);
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  return (
    <div>
      <div className="field"><label>Nume complet</label><input value={f.nume} onChange={(e) => set("nume", e.target.value)} placeholder="Bordian Vladimir" /></div>
      <div className="field"><label>Telefon</label><input value={f.telefon} onChange={(e) => set("telefon", e.target.value)} placeholder="+373 6X XXX XXX" /></div>
      <div className="field" style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input type="checkbox" style={{ width: "auto" }} checked={f.activ} onChange={(e) => set("activ", e.target.checked)} id="activ-chk" />
        <label htmlFor="activ-chk" style={{ margin: 0 }}>Șofer activ</label>
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <button className="btn primary" style={{ flex: 1, justifyContent: "center" }} onClick={() => f.nume && onSave(f)}><Check size={15} />Salvează</button>
        <button className="btn" onClick={onCancel}>Anulează</button>
      </div>
    </div>
  );
}

/* ============================== WEEKLY CALENDAR ============================== */

function WeeklyCalendarView({ data, update }) {
  const now = nowMoldova();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth());
  const [search, setSearch] = useState("");
  const [driverFilter, setDriverFilter] = useState("toate");
  const [expandedId, setExpandedId] = useState(null);
  const ranges = weekRanges(year, month);
  const todayIdx = (year === now.getFullYear() && month === now.getMonth()) ? currentWeekIndex(year, month, now.getDate(), ranges) : -1;

  const filteredCars = useMemo(() => {
    const term = search.trim().toLowerCase();
    return [...data.cars]
      .filter((c) => !term || c.nr.toLowerCase().includes(term) || `${c.marca} ${c.model}`.toLowerCase().includes(term))
      .filter((c) => driverFilter === "toate" || (driverFilter === "cu_sofer" && c.driverId) || (driverFilter === "fara_sofer" && !c.driverId))
      .sort((a, b) => a.nr.localeCompare(b.nr, "ro", { sensitivity: "base", numeric: true }));
  }, [data.cars, search, driverFilter]);

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
    update((prev) => ({
      ...prev,
      weeklyPayments: {
        ...prev.weeklyPayments,
        [k]: { ...(prev.weeklyPayments[k] || {}), year, month, carId: car.id, driverId: car.driverId || null, weekIdx, mode: "total", paidCash: Number(cash || 0), paidCard: Number(card || 0), paidAmount },
      },
    }));
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
      if (!merged.worked) { merged.cash = 0; merged.card = 0; }
      const dailyAmounts = { ...(existing.dailyAmounts || {}), [day]: merged };
      const paidCash = Object.values(dailyAmounts).reduce((s, d) => s + (d.worked === false ? 0 : Number(d.cash || 0)), 0);
      const paidCard = Object.values(dailyAmounts).reduce((s, d) => s + (d.worked === false ? 0 : Number(d.card || 0)), 0);
      const paidAmount = paidCash + paidCard;
      const rec = { ...existing, year, month, carId: car.id, driverId: car.driverId || null, weekIdx, mode: "daily", dailyAmounts, paidCash, paidCard, paidAmount };
      return { ...prev, weeklyPayments: { ...prev.weeklyPayments, [k]: rec } };
    });
  };

  const setCarStartDate = (car, dateStr) => {
    update((prev) => ({
      ...prev,
      cars: prev.cars.map((c) => (c.id === car.id ? { ...c, startDate: dateStr || null } : c)),
    }));
  };

  const setCarStatus = (car, status) => {
    update((prev) => ({
      ...prev,
      cars: prev.cars.map((c) => (c.id === car.id ? { ...c, status } : c)),
    }));
  };

  if (data.cars.length === 0) {
    return <div className="card"><EmptyState text="Adaugă cel puțin o mașină pentru a folosi calendarul." /></div>;
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
        <button className="btn" style={{ padding: 8 }} onClick={() => changeMonth(-1)}><ChevronLeft size={16} /></button>
        <div className="disp" style={{ fontSize: 18, fontWeight: 700, minWidth: 170, textAlign: "center" }}>{MONTHS_RO[month]} {year}</div>
        <button className="btn" style={{ padding: 8 }} onClick={() => changeMonth(1)}><ChevronRight size={16} /></button>
      </div>

<div className="field" style={{ marginBottom: 10 }}>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Caută mașină după număr, marcă sau model…" />
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
              {UNAVAILABLE_REASONS[p.reason] || "Nu lucrează"}: {new Date(p.start).toLocaleDateString("ro-RO")}–{p.end ? new Date(p.end).toLocaleDateString("ro-RO") : "nedeterminat"}
            </span>
          ))}
        </div>
      )}

      <div style={{ padding: "0 16px 10px", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        {car.startDate ? (
          <span className="pill" style={{ background: "#ffffff0d", color: "var(--muted)" }}>
            Activ din {new Date(car.startDate).toLocaleDateString("ro-RO")}
            <button type="button" onClick={(e) => { e.stopPropagation(); setEditingStart((v) => !v); }} style={{ background: "none", border: "none", padding: 0, marginLeft: 4, cursor: "pointer", color: "var(--muted)", display: "flex" }}><Pencil size={11} /></button>
            <button type="button" onClick={clearStart} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "var(--muted)", display: "flex" }}><X size={12} /></button>
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
            <input type="number" placeholder="Numerar" value={cash} onChange={(e) => setCash(e.target.value)} onBlur={commitTotal} onKeyDown={(e) => e.key === "Enter" && e.target.blur()} />
          </div>
          <div style={{ width: 90 }}>
            <input type="number" placeholder="Card" value={card} onChange={(e) => setCard(e.target.value)} onBlur={commitTotal} onKeyDown={(e) => e.key === "Enter" && e.target.blur()} />
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
            <input type="number" placeholder="Numerar" value={cash} onChange={(e) => setCash(e.target.value)} onBlur={commitAmounts} onKeyDown={(e) => e.key === "Enter" && e.target.blur()} />
            <input type="number" placeholder="Card" value={card} onChange={(e) => setCard(e.target.value)} onBlur={commitAmounts} onKeyDown={(e) => e.key === "Enter" && e.target.blur()} />
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
                    <td className="mono">{ins.dataExpirare || "—"}</td>
                    <td><InsuranceStatusPill status={status} days={days} /></td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <button className="btn" style={{ padding: 6, marginRight: 6 }} onClick={() => setEditing(ins)}><Pencil size={14} /></button>
                      <button className="btn danger" style={{ padding: 6 }} onClick={() => setConfirm({ message: "Ștergi această asigurare? Această acțiune nu poate fi anulată.", action: () => remove(ins.id) })}><Trash2 size={14} /></button>
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
    soon: { label: days < 0 ? "Expiră azi" : `Expiră în ${days} zile`, bg: "#f2841c22", color: "var(--orange)" },
    expired: { label: `Expirată de ${Math.abs(days)} zile`, bg: "#e5484d22", color: "var(--red)" },
    unknown: { label: "Fără dată", bg: "#8b93a122", color: "var(--muted)" },
  };
  const m = map[status] || map.unknown;
  return <span className="pill" style={{ background: m.bg, color: m.color }}>{m.label}</span>;
}

function InsuranceForm({ ins, cars, onSave, onCancel }) {
  const [f, setF] = useState(ins);
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
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
      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <button className="btn primary" style={{ flex: 1, justifyContent: "center" }} onClick={() => f.carId && f.dataExpirare && onSave(f)}><Check size={15} />Salvează</button>
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
                    <td className="mono">{insp.dataExpirare || "—"}</td>
                    <td><InsuranceStatusPill status={status} days={days} /></td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <button className="btn" style={{ padding: 6, marginRight: 6 }} onClick={() => setEditing(insp)}><Pencil size={14} /></button>
                      <button className="btn danger" style={{ padding: 6 }} onClick={() => setConfirm({ message: "Ștergi această revizie tehnică? Această acțiune nu poate fi anulată.", action: () => remove(insp.id) })}><Trash2 size={14} /></button>
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
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  return (
    <div>
      <div className="field">
        <label>Mașină</label>
        <select value={f.carId} onChange={(e) => set("carId", e.target.value)}>
          {cars.map((c) => <option key={c.id} value={c.id}>{c.nr} — {c.marca} {c.model}</option>)}
        </select>
      </div>
      <div className="field"><label>Valabilă până la</label><input type="date" value={f.dataExpirare} onChange={(e) => set("dataExpirare", e.target.value)} /></div>
      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <button className="btn primary" style={{ flex: 1, justifyContent: "center" }} onClick={() => f.carId && f.dataExpirare && onSave(f)}><Check size={15} />Salvează</button>
        <button className="btn" onClick={onCancel}>Anulează</button>
      </div>
    </div>
  );
}

/* ============================== FINANCE ============================== */

function FinanceView({ data, update }) {
  const now = nowMoldova();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth());
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
      if (rec.year !== year || rec.month !== month || rec.mode !== "daily" || !rec.dailyAmounts) return;
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

  const addExpense = (e) => update((prev) => ({ ...prev, expenses: [...prev.expenses, { ...e, id: uid() }] }));
  const addIncome = (i) => update((prev) => ({ ...prev, incomes: [...prev.incomes, { ...i, id: uid() }] }));
  const delExpense = (id) => update((prev) => ({ ...prev, expenses: prev.expenses.filter((e) => e.id !== id) }));
  const delIncome = (id) => update((prev) => ({ ...prev, incomes: prev.incomes.filter((i) => i.id !== id) }));

  const changeMonth = (delta) => {
    let m = month + delta, y = year;
    if (m < 0) { m = 11; y -= 1; }
    if (m > 11) { m = 0; y += 1; }
    setMonth(m); setYear(y);
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
        <button className="btn" style={{ padding: 8 }} onClick={() => changeMonth(-1)}><ChevronLeft size={16} /></button>
        <div className="disp" style={{ fontSize: 18, fontWeight: 700, minWidth: 170, textAlign: "center" }}>{MONTHS_RO[month]} {year}</div>
        <button className="btn" style={{ padding: 8 }} onClick={() => changeMonth(1)}><ChevronRight size={16} /></button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px,1fr))", gap: 12, marginBottom: 18 }}>
        <MiniStat label="Venituri" value={fmtMoney(totalIncome)} color="var(--green)" />
        <MiniStat label="Cheltuieli" value={fmtMoney(totalExpenses)} color="var(--red)" />
        <MiniStat label="Profit" value={fmtMoney(profit)} color={profit >= 0 ? "var(--green)" : "var(--red)"} />
        <MiniStat label="Restanțe" value={fmtMoney(restante)} color="var(--orange)" />
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
                    <td style={{ textAlign: "right" }}><button className="btn danger" style={{ padding: 5 }} onClick={() => setConfirm({ message: "Ștergi acest venit? Această acțiune nu poate fi anulată.", action: () => delIncome(i.id) })}><Trash2 size={13} /></button></td>
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
                  return (
                    <tr key={e.id}>
                      <td>
                        {e.descriere}
                        <div style={{ fontSize: 11, color: "var(--muted)" }}>
                          {e.categorie} · {new Date(e.data).toLocaleDateString("ro-RO")}{drv ? ` · ${drv.nume}` : ""}
                          {(e.cash || e.card) ? ` · Num ${fmtMoney(e.cash || 0)} / Card ${fmtMoney(e.card || 0)}` : ""}
                        </div>
                      </td>
                      <td className="mono" style={{ color: "var(--red)" }}>{fmtMoney(e.suma)}</td>
                      <td style={{ textAlign: "right" }}><button className="btn danger" style={{ padding: 5 }} onClick={() => setConfirm({ message: "Ștergi această cheltuială? Această acțiune nu poate fi anulată.", action: () => delExpense(e.id) })}><Trash2 size={13} /></button></td>
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
          <ExpenseForm drivers={data.drivers} onSave={(e) => { addExpense(e); setShowExpense(false); }} onCancel={() => setShowExpense(false)} />
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
  const [date, setDate] = useState(todayISO());
  const [y, m, d] = date.split("-").map(Number);
  let cash = 0, card = 0, found = false;
  Object.values(data.weeklyPayments).forEach((rec) => {
    if (rec.year !== y || rec.month !== m - 1 || rec.mode !== "daily" || !rec.dailyAmounts) return;
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

function ExpenseForm({ onSave, onCancel, drivers }) {
  const [f, setF] = useState({ data: todayISO(), descriere: "", categorie: "Motorină", șoferId: "", cash: "", card: "" });
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const suma = Number(f.cash || 0) + Number(f.card || 0);
  return (
    <div>
      <div className="field"><label>Ziua</label><input type="date" value={f.data} onChange={(e) => set("data", e.target.value)} /></div>
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
        <div className="field" style={{ flex: 1 }}><label>Numerar (lei)</label><input type="number" value={f.cash} onChange={(e) => set("cash", e.target.value)} /></div>
        <div className="field" style={{ flex: 1 }}><label>Card (lei)</label><input type="number" value={f.card} onChange={(e) => set("card", e.target.value)} /></div>
      </div>
      <div style={{ fontSize: 12, color: "var(--muted)", marginTop: -6, marginBottom: 10 }}>Total scos din cont: <b className="mono">{fmtMoney(suma)}</b></div>
      <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
        <button
          className="btn primary" style={{ flex: 1, justifyContent: "center" }}
          onClick={() => f.descriere && suma > 0 && onSave({ ...f, cash: Number(f.cash || 0), card: Number(f.card || 0), suma })}
        ><Check size={15} />Salvează</button>
        <button className="btn" onClick={onCancel}>Anulează</button>
      </div>
    </div>
  );
}

function IncomeForm({ onSave, onCancel }) {
  const [f, setF] = useState({ data: todayISO(), descriere: "", suma: "" });
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  return (
    <div>
      <div className="field"><label>Dată</label><input type="date" value={f.data} onChange={(e) => set("data", e.target.value)} /></div>
      <div className="field"><label>Descriere</label><input value={f.descriere} onChange={(e) => set("descriere", e.target.value)} placeholder="Închiriere ocazională" /></div>
      <div className="field"><label>Sumă (lei)</label><input type="number" value={f.suma} onChange={(e) => set("suma", e.target.value)} /></div>
      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <button className="btn primary" style={{ flex: 1, justifyContent: "center" }} onClick={() => f.descriere && f.suma && onSave({ ...f, suma: Number(f.suma) })}><Check size={15} />Salvează</button>
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
  const [date, setDate] = useState(todayISO());
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
      if (!merged.worked) { merged.cash = 0; merged.card = 0; }
      const dailyAmounts = { ...(existing.dailyAmounts || {}), [day]: merged };
      const paidCash = Object.values(dailyAmounts).reduce((s, dd) => s + (dd.worked === false ? 0 : Number(dd.cash || 0)), 0);
      const paidCard = Object.values(dailyAmounts).reduce((s, dd) => s + (dd.worked === false ? 0 : Number(dd.card || 0)), 0);
      const paidAmount = paidCash + paidCard;
      const rec = { ...existing, year, month, carId: car.id, driverId: car.driverId || null, weekIdx, mode: "daily", dailyAmounts, paidCash, paidCard, paidAmount };
      return { ...prev, weeklyPayments: { ...prev.weeklyPayments, [k]: rec } };
    });
  };

  const rows = cars.map((car) => {
    const rec = weeklyRecord(data, year, month, debtOwnerId(car), weekIdx);
    const dayRec = rec && rec.dailyAmounts ? rec.dailyAmounts[day] : null;
    const driver = data.drivers.find((dd) => dd.id === car.driverId);
    return { car, driver, dayRec };
  });

  const totals = rows.reduce((acc, r) => {
    if (r.dayRec && r.dayRec.worked !== false) {
      acc.cash += Number(r.dayRec.cash || 0);
      acc.card += Number(r.dayRec.card || 0);
    }
    return acc;
  }, { cash: 0, card: 0 });
  const enteredCount = rows.filter((r) => !!r.dayRec).length;

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(({ car, driver }) =>
      (driver && driver.nume.toLowerCase().includes(q)) ||
      car.nr.toLowerCase().includes(q) ||
      (car.marca && car.marca.toLowerCase().includes(q)) ||
      (car.model && car.model.toLowerCase().includes(q))
    );
  }, [rows, search]);

  const shiftDate = (delta) => {
    const dt = new Date(year, month, day + delta);
    setDate(`${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`);
  };

  // Clasament pe luna afișată — cine a adus cel mai mult, cumulat pe toate zilele.
  const leaderboard = useMemo(() => {
    const map = new Map(); // driverId -> total
    Object.values(data.weeklyPayments).forEach((rec) => {
      if (rec.year !== year || rec.month !== month || rec.mode !== "daily" || !rec.dailyAmounts) return;
      const driverId = rec.driverId || (data.cars.find((c) => c.id === rec.carId) || {}).driverId;
      if (!driverId) return;
      const driver = data.drivers.find((dr) => dr.id === driverId);
      if (!driver) return;
      let sum = 0;
      Object.values(rec.dailyAmounts).forEach((dd) => { if (dd.worked !== false) sum += Number(dd.cash || 0) + Number(dd.card || 0); });
      map.set(driver.id, { name: driver.nume, total: (map.get(driver.id)?.total || 0) + sum });
    });
    return Array.from(map.values()).sort((a, b) => b.total - a.total);
  }, [data.weeklyPayments, data.cars, data.drivers, year, month]);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
        <button className="btn" style={{ padding: 8 }} onClick={() => shiftDate(-1)}><ChevronLeft size={16} /></button>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ maxWidth: 170 }} />
        <button className="btn" style={{ padding: 8 }} onClick={() => shiftDate(1)}><ChevronRight size={16} /></button>
        {date !== todayISO() && <button className="btn" onClick={() => setDate(todayISO())}>Azi</button>}
        <div style={{ marginLeft: "auto", fontSize: 12, color: "var(--muted)" }}>
          {enteredCount}/{rows.length} mașini completate
        </div>
      </div>

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
                return (
                  <EarningsRow
                    key={`${date}-${car.id}`}
                    car={car} driver={driver} dayRec={dayRec} worked={worked}
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

function EarningsRow({ car, driver, dayRec, worked, onCommit, onToggleWorked }) {
  const [cash, setCash] = useState(dayRec ? dayRec.cash : "");
  const [card, setCard] = useState(dayRec ? dayRec.card : "");
  const commit = () => onCommit({ cash, card, worked: true });
  const total = (Number(cash) || 0) + (Number(card) || 0);

  return (
    <tr>
      <td>
        <div style={{ fontWeight: 600 }}>{driver ? driver.nume : <span style={{ color: "var(--muted)" }}>—</span>}</div>
        <div style={{ fontSize: 11.5, color: "var(--muted)" }}>{car.nr}{car.marca ? ` · ${car.marca} ${car.model}` : ""}</div>
      </td>
      <td>
        <div className="modetoggle">
          <button type="button" className={worked ? "active" : ""} onClick={() => onToggleWorked(true)}>A lucrat</button>
          <button type="button" className={!worked ? "active" : ""} onClick={() => onToggleWorked(false)}>Liber</button>
        </div>
      </td>
      {worked ? (
        <>
          <td style={{ minWidth: 110 }}><input type="number" placeholder="0" value={cash} onChange={(e) => setCash(e.target.value)} onBlur={commit} /></td>
          <td style={{ minWidth: 110 }}><input type="number" placeholder="0" value={card} onChange={(e) => setCard(e.target.value)} onBlur={commit} /></td>
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
  const now = nowMoldova();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth());
  const [filter, setFilter] = useState("toate");
  const [search, setSearch] = useState("");

  const perCar = useMemo(() => {
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
    // Restanțele mai mari primele, ca să vezi imediat ce trebuie urmărit.
    return rows.sort((a, b) => b.rest - a.rest || b.paid - a.paid);
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
        <button className="btn" style={{ padding: 8 }} onClick={() => changeMonth(-1)}><ChevronLeft size={16} /></button>
        <div className="disp" style={{ fontSize: 18, fontWeight: 700, minWidth: 170, textAlign: "center" }}>{MONTHS_RO[month]} {year}</div>
        <button className="btn" style={{ padding: 8 }} onClick={() => changeMonth(1)}><ChevronRight size={16} /></button>
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
    </div>
  );
}

/* ============================== MODAL ============================== */

function Modal({ title, children, onClose }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <div className="disp" style={{ fontWeight: 700, fontSize: 16 }}>{title}</div>
          <button className="btn" style={{ padding: 6 }} onClick={onClose}><X size={15} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}
