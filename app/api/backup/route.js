import { supabase } from "../../../lib/supabase";

/**
 * Ruta de backup. Poate fi apelată în 2 moduri:
 *  1) automat, de Vercel Cron (vezi vercel.json), care trimite
 *     Authorization: Bearer <CRON_SECRET>
 *  2) manual, de tine, din Console, cu același header, ca test.
 *
 * Copiază tot rândul curent "main" din fleet_data într-un rând nou
 * în fleet_data_daily_backups, cu data/ora exactă a salvării.
 */
export async function GET(request) {
  const authHeader = request.headers.get("authorization") || "";
  const expected = `Bearer ${process.env.CRON_SECRET}`;

  if (!process.env.CRON_SECRET || authHeader !== expected) {
    return Response.json({ error: "Neautorizat." }, { status: 401 });
  }

  // 1) citește starea curentă din fleet_data (id = "main")
  const { data: row, error: readError } = await supabase
    .from("fleet_data")
    .select("data")
    .eq("id", "main")
    .single();

  if (readError) {
    return Response.json({ error: readError.message }, { status: 500 });
  }

  // 2) scrie o copie nouă în fleet_data_daily_backups
  const savedAt = new Date().toISOString();
  const { error: writeError } = await supabase
    .from("fleet_data_daily_backups")
    .insert({ data: row ? row.data : null, saved_at: savedAt });

  if (writeError) {
    return Response.json({ error: writeError.message }, { status: 500 });
  }

  return Response.json({ ok: true, saved_at: savedAt });
}
