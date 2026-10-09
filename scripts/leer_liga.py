# Lector de la liga: lee los calendarios y los guarda en Firestore.
# No guarda teléfonos ni nombres de capitanes.
import hashlib, io, os, re, sys, time, unicodedata
from datetime import datetime, timezone
from urllib.parse import quote, unquote
from zoneinfo import ZoneInfo
import requests
from bs4 import BeautifulSoup

PROJECT = "sweet-dreams-darts"
API_KEY = "AIzaSyByyLDyO2f0AYGtzVgdL006DRT2AE0n7kw"
RAIZ = f"projects/{PROJECT}/databases/(default)/documents"
BASE = f"https://firestore.googleapis.com/v1/{RAIZ}"
MADRID = ZoneInfo("Europe/Madrid")
WEB_PAREJAS = "https://www.bullshootervalladolid.com/liga-parejas/calendario/nivel-{n}/"
WEB_EQUIPOS = "https://www.bullshooter.eu/es/current-league/"
HORA_EQUIPOS = "21:30"
PRUEBA = os.environ.get("PRUEBA", "false").lower() == "true"
UA = {"User-Agent": "Mozilla/5.0 (lector liga Sweet Dreams)"}
avisos = []


def aviso(t):
    avisos.append(t)
    print("AVISO:", t)


def sin_tildes(s):
    return "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn")


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", sin_tildes(s).lower()).strip("-")[:90]


def norm(s):
    t = re.sub(r"[^a-z0-9 ]", " ", sin_tildes(s).lower()).split()
    return "".join(x for x in t if x not in {"de", "del", "el", "la", "los", "las"})


def bonito(s):
    s = re.sub(r"\s*\(\d+\)\s*$", "", s).strip()
    return " ".join(p.capitalize() if p.isupper() or p.islower() else p for p in s.split())


def temporada(fechas):
    f = min(fechas)
    if f.month >= 8:
        return f"I{f.year}"
    if f.month <= 2:
        return f"I{f.year - 1}"
    return f"P{f.year}"


def instante(fecha, hora):
    h, m = [int(x) for x in hora.split(":")]
    return datetime(fecha.year, fecha.month, fecha.day, h, m, tzinfo=MADRID)


# ---------------- Parejas (PDF, fechas en formato americano MM/DD/AAAA) ----------------
RE_JOR = re.compile(r"^\s*(\d{1,2})\s*\|\s*(\d{1,2}/\d{1,2}/\d{4})\s*\|")
RE_FILA = re.compile(r"^\s*(?:(\d{1,2}/\d{1,2}/\d{4})\s*\|)?\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|\s*(.*)$")
RE_CALLE = re.compile(r"\s(?=(?:C/|AV/|AVDA|AV\.|CALLE|PZA|PLAZA|PS/|PASEO|CTRA|CAMINO)\S*)")
DIAS = ["LUNES", "MARTES", "MIERCOLES", "JUEVES", "VIERNES", "SABADO", "DOMINGO"]


def parsear_parejas(texto, origen):
    lineas = [l.rstrip() for l in texto.replace("\r", "").split("\n")]
    m = re.search(r"PAREJAS\s+NIVEL\s+(\d+)", texto, re.I)
    if not m:
        aviso(f"{origen}: no encuentro el nivel en la cabecera")
        return None
    nivel = int(m.group(1))
    mh = re.search(r"HORA\s+(\d{1,2})\s*[/:.]\s*(\d{2})", texto, re.I)
    hora = f"{int(mh.group(1)):02d}:{mh.group(2)}" if mh else "20:30"
    md = re.search(r"DIA\s+DE\s+JUEGO\s+([A-ZÁÉÍÓÚ]+)", sin_tildes(texto).upper())
    dia_esp = DIAS.index(md.group(1)) if md and md.group(1) in DIAS else None
    # tabla de equipos
    tabla, i0 = [], None
    for i, l in enumerate(lineas):
        if re.match(r"\s*EQUIPO\s+CAPITAN", l, re.I):
            i0 = i + 1
        elif i0 is not None and (l.strip().upper().startswith("BYE") or l.strip().startswith("Division")):
            break
        elif i0 is not None and l.strip():
            tabla.append(l)
    filas = []
    for l in tabla:
        mt = re.match(r"^\s*(.+?)\s+\d{9}\s+(.+)$", l)
        if mt:
            partes = RE_CALLE.split(mt.group(2).strip(), maxsplit=1)
            filas.append({"izq": mt.group(1), "est": partes[0].strip(), "dir": partes[1].strip() if len(partes) > 1 else "", "ciudad": "Valladolid"})
        else:
            mc = re.match(r"^\s*\((.+)\)\s*$", l)
            if mc and filas:
                filas[-1]["ciudad"] = bonito(mc.group(1))
    # partidos
    partidos, fecha_jor, jor = [], None, 0
    for l in lineas:
        s = l.strip()
        if not s or s.startswith(("+", "Week", "Division", "-")) or "----" in s:
            continue
        mj = RE_JOR.match(l)
        if mj:
            jor = int(mj.group(1))
            fecha_jor = datetime.strptime(mj.group(2), "%m/%d/%Y").date()
            continue
        mf = RE_FILA.match(l)
        if not mf or fecha_jor is None:
            continue
        propia, loc, vis, sede, nota = mf.groups()
        if "BYE" in (loc.upper(), vis.upper()):
            continue
        f = datetime.strptime(propia, "%m/%d/%Y").date() if propia else fecha_jor
        if not propia and dia_esp is not None and f.weekday() != dia_esp:
            aviso(f"{origen}: la jornada {jor} cae en {DIAS[f.weekday()].lower()} y no en el día de juego")
        partidos.append({"jornada": jor, "fecha": f, "hora": hora, "local": bonito(loc), "visitante": bonito(vis), "sede": bonito(sede), "nota": nota.strip()})
    if not partidos:
        aviso(f"{origen}: no he leído ningún partido")
        return None
    nombres = sorted({p["local"] for p in partidos} | {p["visitante"] for p in partidos}, key=len, reverse=True)
    equipos = []
    for f in filas:
        izq = norm(f["izq"])
        nom = next((n for n in nombres if izq.startswith(norm(n))), bonito(" ".join(f["izq"].split()[:-1])))
        equipos.append({"nombre": nom, "estab": bonito(f["est"]), "dir": f["dir"], "ciudad": f["ciudad"]})
    return {"categoria": "parejas", "nivel": nivel, "partidos": partidos, "equipos": equipos}


# ---------------- Equipos online (tablas HTML, fechas en formato europeo DD/MM/AAAA) ----------------
RE_NIVEL = re.compile(r"\b(\d{2})E(\d{2})([A-Z])\b")


def tachado(celda):
    return bool(celda.find(["del", "s", "strike"])) or "line-through" in str(celda)


def parsear_equipos(html, origen):
    sopa = BeautifulSoup(html, "html.parser")
    res = []
    for tabla in sopa.find_all("table"):
        filas = tabla.find_all("tr")
        cab = [c.get_text(" ", strip=True).lower() for c in filas[0].find_all(["th", "td"])] if filas else []
        if "local" not in cab or "visitante" not in cab:
            continue
        previo = tabla.find_previous(string=RE_NIVEL)
        mn = RE_NIVEL.search(previo) if previo else None
        if not mn:
            aviso(f"{origen}: una tabla no tiene código de nivel delante")
            continue
        nivel, il, iv = int(mn.group(1)), cab.index("local"), cab.index("visitante")
        inotas = cab.index("notes") if "notes" in cab else None
        partidos, jor, fecha = [], 0, None
        for tr in filas[1:]:
            cel = tr.find_all(["td", "th"])
            if len(cel) <= max(il, iv):
                continue
            t0, t1 = cel[0].get_text(" ", strip=True), cel[1].get_text(" ", strip=True)
            if t0.isdigit():
                jor = int(t0)
                mf = re.match(r"(\d{1,2})/(\d{1,2})/(\d{4})", t1)
                fecha = datetime(int(mf.group(3)), int(mf.group(2)), int(mf.group(1))).date() if mf else None
            tl, tv = cel[il].get_text(" ", strip=True), cel[iv].get_text(" ", strip=True)
            rel = lambda t: not re.sub(r"[\s–—\-]", "", t)
            if rel(tl) or rel(tv) or tachado(cel[il]) or tachado(cel[iv]) or fecha is None:
                continue
            hora, nota = HORA_EQUIPOS, ""
            if inotas is not None and len(cel) > inotas:
                nota = cel[inotas].get_text(" ", strip=True)
                mh = re.search(r"(\d{1,2}):(\d{2})", nota)
                if mh:
                    hora = f"{int(mh.group(1)):02d}:{mh.group(2)}"
            partidos.append({"jornada": jor, "fecha": fecha, "hora": hora, "local": bonito(tl), "visitante": bonito(tv), "sede": "", "nota": nota})
        if partidos:
            nombres = sorted({p["local"] for p in partidos} | {p["visitante"] for p in partidos})
            res.append({"categoria": "equipos", "nivel": nivel, "partidos": partidos, "equipos": [{"nombre": n} for n in nombres]})
    return res


# ---------------- Preparar documentos ----------------
def preparar(listas):
    docs, locales = [], {}
    for lig in listas:
        temp = temporada([p["fecha"] for p in lig["partidos"]])
        cat, niv = lig["categoria"], lig["nivel"]
        por_norm = {}
        for e in lig["equipos"]:
            if cat == "parejas":
                clave = slug(e["ciudad"] + " " + e["dir"]) or slug(e["estab"])
                loc = locales.setdefault(clave, {"nombre": e["estab"], "direccion": e["dir"], "ciudad": e["ciudad"], "categorias": set(), "niveles": set()})
                loc["categorias"].add(cat)
                loc["niveles"].add(f"{cat}-{niv}")
                por_norm[norm(e["estab"])] = (clave, loc["nombre"])
            docs.append(("liga_equipos", f"{temp}_{cat}_{niv}_{slug(e['nombre'])}", {"temporada": temp, "categoria": cat, "nivel": niv, "nombre": e["nombre"], "local": e.get("estab", "")}, None))
        for p in lig["partidos"]:
            sede_id, sede = por_norm.get(norm(p["sede"]), ("", p["sede"])) if p["sede"] else ("", "")
            d = {"temporada": temp, "categoria": cat, "nivel": niv, "jornada": p["jornada"], "fecha": instante(p["fecha"], p["hora"]),
                 "dia": p["fecha"].isoformat(), "hora": p["hora"], "local": p["local"], "visitante": p["visitante"],
                 "sede": sede, "sedeId": sede_id, "enSweetDreams": norm(sede) == norm("Sweet Dreams") if cat == "parejas" else False, "nota": p["nota"]}
            docs.append(("liga_partidos", f"{temp}_{cat}_{niv}_{p['jornada']:02d}_{slug(p['local'])}_{slug(p['visitante'])}", d, None))
    for clave, l in locales.items():
        maps = "https://www.google.com/maps/search/?api=1&query=" + quote(f"{l['nombre']}, {l['direccion']}, {l['ciudad']}")
        d = {"nombre": l["nombre"], "direccion": l["direccion"], "ciudad": l["ciudad"], "mapsAuto": maps, "categorias": sorted(l["categorias"]), "niveles": sorted(l["niveles"])}
        docs.append(("liga_locales", clave, d, list(d.keys())))
    return docs


# ---------------- Firestore (REST, con la cuenta robot) ----------------
def valor(x):
    if x is None: return {"nullValue": None}
    if isinstance(x, bool): return {"booleanValue": x}
    if isinstance(x, int): return {"integerValue": str(x)}
    if isinstance(x, datetime): return {"timestampValue": x.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
    if isinstance(x, (list, tuple)): return {"arrayValue": {"values": [valor(i) for i in x]}}
    return {"stringValue": str(x)}


def entrar():
    r = requests.post(f"https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key={API_KEY}",
                      json={"email": os.environ["ROBOT_EMAIL"], "password": os.environ["ROBOT_PASSWORD"], "returnSecureToken": True},
                      headers={"Referer": "https://sweetdreams-darts.github.io/app-darts/"}, timeout=30)
    if r.status_code != 200:
        sys.exit("No he podido entrar con la cuenta robot: " + r.text[:200])
    return {"Authorization": "Bearer " + r.json()["idToken"]}


def guardar(cab, docs):
    for i in range(0, len(docs), 200):
        w = []
        for col, did, d, mascara in docs[i:i + 200]:
            e = {"update": {"name": f"{RAIZ}/{col}/{did}", "fields": {k: valor(v) for k, v in d.items()}}}
            if mascara:
                e["updateMask"] = {"fieldPaths": mascara}
            w.append(e)
        r = requests.post(f"{BASE}:commit", headers=cab, json={"writes": w}, timeout=60)
        if r.status_code != 200:
            sys.exit(f"Error al guardar: {r.status_code} {r.text[:300]}")


def huella_guardada(cab, did):
    r = requests.get(f"{BASE}/liga_importaciones/{did}", headers=cab, timeout=30)
    if r.status_code == 200:
        return r.json().get("fields", {}).get("huella", {}).get("stringValue")
    return None


# ---------------- Descarga ----------------
def pedir(url):
    time.sleep(1)
    r = requests.get(url, headers=UA, timeout=60)
    return r if r.status_code == 200 else None


def fuentes_parejas():
    for n in range(1, 21):
        pag = pedir(WEB_PAREJAS.format(n=n))
        if not pag:
            continue
        m = re.search(r"file=([^\"'&\s<>]+\.pdf)", unquote(pag.text), re.I) or re.search(r"href=[\"']([^\"']+\.pdf)", pag.text, re.I)
        if not m:
            aviso(f"Parejas nivel {n}: la página existe pero no encuentro el PDF")
            continue
        pdf = pedir(m.group(1))
        if not pdf:
            aviso(f"Parejas nivel {n}: no he podido descargar {m.group(1)}")
            continue
        yield f"parejas-{n}", m.group(1), pdf.content


def texto_pdf(datos):
    import pdfplumber
    with pdfplumber.open(io.BytesIO(datos)) as pdf:
        return "\n".join((p.extract_text() or "") for p in pdf.pages)


def paginas_equipos(url):
    if url:
        r = pedir(url)
        return [(url, r.text)] if r else []
    r = pedir(WEB_EQUIPOS)
    if not r:
        return []
    if "<table" in r.text and RE_NIVEL.search(r.text):
        return [(WEB_EQUIPOS, r.text)]
    sopa, res = BeautifulSoup(r.text, "html.parser"), []
    for a in sopa.find_all("a", href=True):
        h = a["href"]
        if "bullshooter.eu" in h and "league" in h and "current-league" not in h and "finished" not in h and h not in [x[0] for x in res]:
            p = pedir(h)
            if p and RE_NIVEL.search(p.text):
                res.append((h, p.text))
    return res


def main():
    cab = None if PRUEBA else entrar()
    print("MODO PRUEBA (no se guarda nada)" if PRUEBA else "MODO REAL (se guarda en Firestore)")
    trabajos = []
    for clave, url, datos in fuentes_parejas():
        trabajos.append((clave, url, hashlib.sha256(datos).hexdigest(), lambda d=datos, c=clave: [x for x in [parsear_parejas(texto_pdf(d), c)] if x]))
    for url, html in paginas_equipos(os.environ.get("URL_EQUIPOS", "").strip()):
        trabajos.append(("equipos-" + slug(url), url, hashlib.sha256(re.sub(r"\s+", " ", html).encode()).hexdigest(), lambda h=html, u=url: parsear_equipos(h, u)))
    if not [t for t in trabajos if t[0].startswith("equipos")]:
        print("No hay liga de equipos publicada ahora mismo en la página de Liga actual.")
    total = 0
    for clave, url, huella, leer in trabajos:
        if cab and huella_guardada(cab, slug(clave)) == huella:
            print(f"{clave}: sin cambios, no hago nada")
            continue
        listas = leer()
        docs = preparar(listas)
        parts = sum(len(l["partidos"]) for l in listas)
        print(f"{clave}: {len(listas)} nivel(es), {parts} partidos, {len(docs)} documentos")
        for l in listas[:1]:
            print("  nivel", l["nivel"], "equipos:", ", ".join(e["nombre"] for e in l["equipos"]))
            for p in l["partidos"][:3]:
                print("  ", p["jornada"], p["fecha"], p["hora"], p["local"], "-", p["visitante"], "|", p["sede"])
        if cab and docs:
            guardar(cab, docs)
            guardar(cab, [("liga_importaciones", slug(clave), {"url": url, "huella": huella, "fecha": datetime.now(timezone.utc), "partidos": parts}, None)])
        total += len(docs)
    print(f"TOTAL documentos: {total}; avisos: {len(avisos)}")


main()
