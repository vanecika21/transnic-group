import { supabase } from "../../../../lib/supabase";
import { fetchYandexDrivers, fetchYandexDailyEarnings, computeParkCommission } from "../../../../lib/yandexFleet";

/**
 * Nu mai există tabele separate "drivers" / "daily_earnings". Totul se
 * citește și se scrie în ACELAȘI rând din "fleet_data" (id = "main") pe
 * care îl folosește restul aplicației (mașini, șoferi, calendar, finanțe).
 * Așa nu există niciun risc ca două surse de date să se calce pe picioare.
 */

function todayChisinauISO() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Chisinau",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}
function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

export async function POST(request) {
  let body = {};
  try {
    body = await request.json();
  } catch {
    // fără body e ok, folosim ziua curentă
  }
  const date = body.date || todayChisinauISO();

  try {
    // 1) citește blob-ul curent din Supabase (sursa unică de adevăr)
    const { data: row, error: readError } = await supabase
      .from("fleet_data")
      .select("data")
      .eq("id", "main")
      .single();
    if (readError) throw new Error(`Supabase (citire): ${readError.message}`);

    const current = row?.data || {};
    const existingDrivers = current.yandexDrivers || [];
    const existingEarnings = current.yandexEarnings || {};

    // 2) ia lista de șoferi din Yandex și o combină cu ce era deja salvat
    const freshDrivers = await fetchYandexDrivers();
    const byId = new Map(existingDrivers.map((d) => [d.yandex_driver_id, d]));
    for (const d of freshDrivers) {
      byId.set(d.yandex_driver_id, { ...byId.get(d.yandex_driver_id), ...d });
    }
    const mergedDrivers = Array.from(byId.values());

    // 3) ia încasările zilei selectate din Yandex
    const { perDriver, debugSample, categoryTotals } = await fetchYandexDailyEarnings(date);
    const updatedEarnings = { ...existingEarnings };
    for (const [yandexDriverId, sums] of perDriver.entries()) {
      const totalGross = round2(sums.cash + sums.card);
      const yandexCommission = round2(sums.yandexCommission);
      const parkCommission = computeParkCommission(totalGross);
      const netPayout = round2(totalGross - yandexCommission - parkCommission);
      const otherPartnerPayments = round2(sums.otherPartnerPayments);

      updatedEarnings[`${date}__${yandexDriverId}`] = {
        date,
        yandex_driver_id: yandexDriverId,
        total_cash: round2(sums.cash),
        total_card: round2(sums.card),
        total_gross: totalGross,
        yandex_commission: yandexCommission,
        park_commission: parkCommission,
        net_payout: netPayout,
        other_partner_payments: otherPartnerPayments,
      };
    }

    // 4) scrie blob-ul ÎNTREG înapoi, în același rând "main"
    const updatedData = { ...current, yandexDrivers: mergedDrivers, yandexEarnings: updatedEarnings };
    const { error: writeError } = await supabase
      .from("fleet_data")
      .upsert({ id: "main", data: updatedData, updated_at: new Date().toISOString() });
    if (writeError) throw new Error(`Supabase (scriere): ${writeError.message}`);

    return Response.json({
      data: updatedData,
      syncedDrivers: freshDrivers.length,
      syncedEarnings: perDriver.size,
      debugSample,
      // TEMPORAR — șterge acest câmp după ce confirmi că "other_partner_payments"
      // se potrivește cu coloana "Прочие платежи партнера, MDL" din Dispecerat.
      categoryTotalsDebug: categoryTotals,
    });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
