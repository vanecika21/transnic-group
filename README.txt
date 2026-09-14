TAXI FLEET PRO — publicare pe Vercel + Supabase
=================================================

Ai deja un proiect Supabase creat (Healthy). Pașii de mai jos duc
de acolo până la un link funcțional pe care îl deschizi de pe
telefon și de pe calculator, cu aceleași date.

PASUL 1 — Creează tabelul în Supabase
--------------------------------------
1. Intră în proiectul tău Supabase.
2. Meniul din stânga → SQL Editor → New query.
3. Deschide fișierul supabase.sql din acest folder, copiază tot
   conținutul, lipește-l în editor și apasă Run.
   (Creează un singur tabel "fleet_data" unde se salvează toate
   datele aplicației — mașini, șoferi, calendar, finanțe.)

PASUL 2 — Ia cheile din Supabase
----------------------------------
1. Settings (roata din stânga jos) → API.
2. Copiază:
   - "Project URL"  → acesta va fi SUPABASE_URL
   - "service_role" key (secretă, NU "anon" key) → acesta va fi
     SUPABASE_SERVICE_ROLE_KEY
   Nu trimite aceste chei nimănui altcuiva — service_role are
   acces complet la baza ta de date.

PASUL 3 — Urcă acest folder pe GitHub
----------------------------------------
Nu ai nevoie de git instalat. Cel mai simplu:
1. Mergi pe https://github.com/new și creează un repository nou,
   de exemplu "taxi-fleet-pro-cloud" (poate fi Private).
2. Pe pagina repository-ului apasă "uploading an existing file".
3. Trage tot conținutul acestui folder (inclusiv subfolderele
   app/, lib/, package.json etc.) și apasă "Commit changes".

PASUL 4 — Importă în Vercel
------------------------------
1. Mergi pe https://vercel.com/new
2. Alege "Import" lângă repository-ul taxi-fleet-pro-cloud.
3. Înainte de a apăsa Deploy, deschide "Environment Variables"
   și adaugă:
     SUPABASE_URL = <Project URL de la pasul 2>
     SUPABASE_SERVICE_ROLE_KEY = <service_role key de la pasul 2>
4. Apasă Deploy și așteaptă 1-2 minute.

PASUL 5 — Gata
-----------------
Vercel îți dă un link de forma:
   https://taxi-fleet-pro-cloud.vercel.app

Deschide-l pe telefon și pe calculator — vezi exact aceleași
mașini, șoferi, calendar și finanțe, salvate automat în Supabase.

DE ȘTIUT
----------
- Acest link nu are parolă — oricine îl are poate vedea și
  modifica datele. Pentru uz personal e suficient, dar dacă vrei
  protecție (user/parolă), spune-mi și adăugăm un ecran de login.
- Dacă vrei propriul domeniu (ex. taxifleetpro.md) în loc de
  ...vercel.app, se face din Vercel → Settings → Domains, după ce
  cumperi domeniul de la un registrator (ex. Namecheap).
