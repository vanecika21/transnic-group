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

export async function POST(request) {
  const body = await request.json();
  const { error } = await supabase
    .from("fleet_data")
    .upsert({ id: "main", data: body, updated_at: new Date().toISOString() });

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
  return Response.json({ ok: true });
}
