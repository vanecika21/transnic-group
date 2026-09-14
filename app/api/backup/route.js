import { supabase } from "../../../lib/supabase";

export async function GET() {
  const { data, error } = await supabase
    .from("fleet_data")
    .select("data")
    .eq("id", "main")
    .single();

  if (error && error.code !== "PGRST116") {
    return Response.json({ error: error.message }, { status: 500 });
  }
  return Response.json({ data: data ? data.data : null });
}

function looksSuspiciouslyEmpty(body) {
  const hasCars = Array.isArray(body?.cars) && body.cars.length > 0;
  const hasDrivers = Array.isArray(body?.drivers) && body.drivers.length > 0;
  return !hasCars && !hasDrivers;
}

export async function POST(request) {
  const body = await request.json();

  const { data: existingRow } = await supabase
    .from("fleet_data")
    .select("data")
    .eq("id", "main")
    .single();
  const existing = existingRow ? existingRow.data : null;
  const existingHasData =
    existing &&
    ((Array.isArray(existing.cars) && existing.cars.length) ||
      (Array.isArray(existing.drivers) && existing.drivers.length));

  // PLASĂ DE SIGURANȚĂ: dacă exista deja o flotă reală (mașini/șoferi) și ce
  // vine acum la salvare pare complet gol, refuzăm scrierea. Așa nu se mai
  // poate repeta ștergerea accidentală a tuturor datelor, indiferent de unde
  // ar veni bug-ul (client vechi, tab uitat deschis, etc.).
  if (existingHasData && looksSuspiciouslyEmpty(body)) {
    return Response.json(
      {
        error:
          "Salvare refuzată: datele trimise nu au nicio mașină și niciun șofer, dar pe server exista deja o flotă. Ca să nu se piardă date din greșeală, scrierea a fost blocată.",
      },
      { status: 409 }
    );
  }

  // Istoric: păstrăm o copie a stării DINAINTE de suprascriere, ca să poți
  // recupera manual din Supabase (tabelul fleet_data_history) dacă vreodată
  // ceva merge prost. Nu blocăm salvarea dacă asta eșuează.
  if (existing) {
    try {
      await supabase.from("fleet_data_history").insert({ data: existing });
    } catch {
      // best-effort — nu oprim salvarea principală din cauza istoricului
    }
  }

  const { error } = await supabase
    .from("fleet_data")
    .upsert({ id: "main", data: body, updated_at: new Date().toISOString() });

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
  return Response.json({ ok: true });
}
