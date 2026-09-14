import { NextResponse } from "next/server";

// Rute care rămân accesibile FĂRĂ cod (altfel te-ai bloca singur afară).
const PUBLIC_PATHS = ["/login", "/api/login"];

export function middleware(request) {
  const { pathname } = request.nextUrl;

  if (
    PUBLIC_PATHS.includes(pathname) ||
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon")
  ) {
    return NextResponse.next();
  }

  const session = request.cookies.get("tfp_session")?.value;
  const expected = process.env.APP_ACCESS_CODE;

  if (!expected || session !== expected) {
    const loginUrl = new URL("/login", request.url);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

// Se aplică pe tot site-ul (pagini + API), în afară de fișierele statice interne Next.js.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
