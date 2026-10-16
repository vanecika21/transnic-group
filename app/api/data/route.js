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

  // PLASĂ 1: nu acceptăm o salvare complet goală peste o flotă existentă.
  if (existingHasData && looksSuspiciouslyEmpty(body)) {
    return Response.json(
      {
        error:
          "Salvare refuzată: datele trimise nu au nicio mașină și niciun șofer, dar pe server exista deja o flotă.",
      },
      { status: 409 }
    );
  }

  // PLASĂ 2: după migrare, datele au paymentsKeyedByCar = true. O filă/dispozitiv
  // cu versiunea veche de page.js nu trimite acest semn, deci salvarea lui este
  // refuzată și nu poate suprascrie datele migrate.
  if (existing?.paymentsKeyedByCar === true && body?.paymentsKeyedByCar !== true) {
    return Response.json(
      {
        error:
          "Salvare refuzată: aplicația de pe acest dispozitiv e veche. Reîncarcă pagina (refresh complet).",
      },
      { status: 409 }
    );
  }

  // Istoric: copie a stării de DINAINTE de suprascriere (best-effort).
  if (existing) {
    try {
      await supabase.from("fleet_data_history").insert({ data: existing });
    } catch {
      // nu oprim salvarea principală din cauza istoricului
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
