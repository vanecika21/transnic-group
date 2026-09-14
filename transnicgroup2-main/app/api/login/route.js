export async function POST(request) {
  let body = {};
  try {
    body = await request.json();
  } catch {
    // fără body -> tratat mai jos ca "cod greșit"
  }
  const code = (body.code || "").trim();
  const expected = process.env.APP_ACCESS_CODE;

  if (!expected) {
    return Response.json(
      { error: "Codul de acces nu e configurat pe server (lipsește APP_ACCESS_CODE)." },
      { status: 500 }
    );
  }
  if (code !== expected) {
    return Response.json({ error: "Cod greșit." }, { status: 401 });
  }

  const res = Response.json({ ok: true });
  // Cookie-ul ține minte că ai introdus codul corect, 180 de zile.
  res.headers.append(
    "Set-Cookie",
    `tfp_session=${encodeURIComponent(expected)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=15552000`
  );
  return res;
}
