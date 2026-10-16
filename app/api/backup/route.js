import { supabase } from "../../../lib/supabase";

// Cron zilnic Vercel: salvează o copie completă a datelor în fleet_data_daily_backups.
// Locul în proiect: app/api/backup/route.js
export const dynamic = "force-dynamic";

export async function GET(request) {
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return Response.json({ error: "Neautorizat" }, { status: 401 });
  }

  const { data: row, error: readError } = await supabase
    .from("fleet_data")
    .select("data")
    .eq("id", "main")
    .single();

  if (readError) {
    return Response.json({ error: readError.message }, { status: 500 });
  }

  const data = row?.data;
  const hasData =
    data &&
    ((Array.isArray(data.cars) && data.cars.length) ||
      (Array.isArray(data.drivers) && data.drivers.length));

  // Nu salvăm backup dintr-o stare goală, ca să nu acoperim un backup bun.
  if (!hasData) {
    return Response.json(
      { error: "Datele par goale, backup sărit." },
      { status: 409 }
    );
  }

  const today = new Date().toISOString().slice(0, 10);

  const { error } = await supabase
    .from("fleet_data_daily_backups")
    .insert({ data });

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  // Păstrăm ultimele 60 de zile (best-effort).
  const cutoff = new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString();
  await supabase.from("fleet_data_daily_backups").delete().lt("saved_at", cutoff);

  return Response.json({ ok: true, date: today });
}
