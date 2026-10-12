# Lee los PDF de clasificación de la liga (Bullshooter) y guarda las estadísticas en Firestore:
#   liga_config/clasificaciones  → la última clasificación de cada nivel (jugadores, equipos y partidos recientes)
#   liga_config/historial        → la evolución semana a semana de cada jugador (para flechas y gráficas)
import io, json, os, re, sys, unicodedata
from datetime import datetime, timezone

# <logica>
COLS_X01 = ["ppd", "pj", "pg", "hats", "d3", "t80", "ht", "lt", "do6", "do7", "do8", "do9"]      # PPD Games Wins Hats 3BD Ton80 HTon LTon 6DO 7DO 8DO 9DO
COLS_CRI = ["mpr", "pj", "pg", "asist", "hats", "wh", "m5", "m6", "m7", "m8", "m9"]               # MPR Games Wins Assists Hats WHorse 5MR 6MR 7MR 8MR 9MR
NUM = r"-?\d+(?:\.\d+)?"


def sin_tildes(s):
    return "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn")


def clave(nombre):
    """Identificador de un jugador: minúsculas, sin tildes y sin signos. Así 'Álvaro  López' y 'alvaro lopez' son el mismo."""
    return re.sub(r"[^a-z0-9]+", " ", sin_tildes(nombre).lower()).strip()


def _num(s):
    v = float(s)
    return int(v) if v.is_integer() and "." not in s else v


def _filas(texto, ncols):
    """Saca las filas 'Nombre | Equipo | n | n | ...' aunque dos filas vengan pegadas en la misma línea."""
    patron = re.compile(r"([^|\n]+?)\s*\|\s*([^|\n]+?)\s*\|\s*((?:" + NUM + r"\s*\|\s*){" + str(ncols) + r"})")
    out = []
    for m in patron.finditer(texto):
        nombre, equipo = m.group(1).strip(), m.group(2).strip()
        if not nombre or nombre.lower() in ("player", "team") or not equipo:
            continue
        nums = [_num(x) for x in re.findall(NUM, m.group(3))]
        out.append([nombre, equipo] + nums)
    return out


def parsear_pdf(texto, origen=""):
    """Devuelve el nivel con sus equipos, jugadores de 501 y jugadores de cricket, o None si no reconoce el PDF."""
    avisos = []
    t = texto.replace("\r", "")
    m = re.search(r"League:\s*(\d+)([A-Z])(\d{2})([A-Z]),\s*Nivel\s*(\d+)", t)
    if not m:
        return None, [f"{origen}: no encuentro la cabecera 'League: …, Nivel N'"]
    nivel = int(m.group(5))
    temporada = ("I" if m.group(4) == "I" else "P") + str(2000 + int(m.group(3)))
    md = re.search(r"Report Date:\s*(\d{1,2})/(\d{1,2})/(\d{4})", t)
    informe = f"{md.group(3)}-{int(md.group(1)):02d}-{int(md.group(2)):02d}" if md else ""
    # secciones: cada una empieza en una línea de título
    titulos = [(x.start(), x.group(0)) for x in re.finditer(r"^(Team Standings.*|Last Match Results.*|(?:All|Team)\b[^\n]*games[^\n]*sorted by \w+:?)\s*$", t, re.M)]
    secciones = {}
    for i, (pos, titulo) in enumerate(titulos):
        fin = titulos[i + 1][0] if i + 1 < len(titulos) else len(t)
        secciones.setdefault(titulo.strip(), t[pos + len(titulo):fin])
    equipos, ultimos, x01, cri, variante_cri = [], [], [], [], ""
    for titulo, cuerpo in secciones.items():
        if titulo.startswith("Team Standings"):
            for f in re.finditer(r"([^|\n]+?)\s*\|\s*(" + NUM + r")\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|", cuerpo):
                if f.group(1).strip().lower() != "team":
                    equipos.append({"e": f.group(1).strip(), "pct": float(f.group(2)), "pj": int(f.group(3)), "pg": int(f.group(4))})
        elif titulo.startswith("Last Match Results"):
            for f in re.finditer(r"([^|\n]+?)\s*\|\s*([^|\n]+?)\s*\|\s*(\d{1,2})/(\d{1,2})/(\d{4})\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|", cuerpo):
                ultimos.append({"e": f.group(1).strip(), "c": f.group(2).strip(), "f": f"{f.group(5)}-{int(f.group(3)):02d}-{int(f.group(4)):02d}", "s": int(f.group(6)), "pj": int(f.group(7)), "pg": int(f.group(8))})
        elif "PPD" in titulo:
            x01 += _filas(cuerpo, len(COLS_X01))
        elif "MPR" in titulo:
            if cri:
                avisos.append(f"{origen}: hay dos tablas de cricket; me quedo con la primera")
                continue
            cri = _filas(cuerpo, len(COLS_CRI))
            variante_cri = "400" if "400" in titulo else ""
    if not x01 and not cri:
        avisos.append(f"{origen}: no he leído ningún jugador")
    return {"cat": "parejas", "n": nivel, "temp": temporada, "informe": informe, "equipos": equipos, "ultimos": ultimos, "x01": x01, "cri": cri, "cri400": variante_cri == "400"}, avisos


def fusionar(anterior, nuevos):
    """Mezcla lo leído ahora con lo que ya había: cada nivel leído sustituye al suyo; los demás se conservan."""
    por_clave = {(n["cat"], n["n"]): n for n in (anterior or [])}
    for n in nuevos:
        por_clave[(n["cat"], n["n"])] = n
    return sorted(por_clave.values(), key=lambda n: (n["cat"], n["n"]))


def marcar_sweet_dreams(niveles, equipos_sd):
    """equipos_sd: conjunto de (cat, nivel, clave del equipo) que son de Sweet Dreams."""
    for n in niveles:
        for e in n["equipos"]:
            e["sd"] = (n["cat"], n["n"], clave(e["e"])) in equipos_sd
        sd = {clave(e["e"]) for e in n["equipos"] if e["sd"]}
        n["sd"] = sorted(sd)
    return niveles


def actualizar_historial(hist, niveles, tope=40):
    """hist = {"v":1,"h":{"clave|cat|nivel":{"x":[[fecha,media,partidas],…],"c":[…]}}}. Añade (o reemplaza el del mismo día) el punto de cada jugador."""
    h = (hist or {}).get("h", {})
    for n in niveles:
        fecha = n["informe"]
        if not fecha:
            continue
        for tipo, filas in (("x", n["x01"]), ("c", n["cri"])):
            for f in filas:
                k = f"{clave(f[0])}|{n['cat']}|{n['n']}"
                serie = h.setdefault(k, {}).setdefault(tipo, [])
                serie[:] = [p for p in serie if p[0] != fecha] + [[fecha, f[2], f[3]]]
                serie.sort(key=lambda p: p[0])
                del serie[:-tope]
    return {"v": 1, "h": h}


def resumen(niveles):
    nj = len({clave(f[0]) for n in niveles for f in n["x01"] + n["cri"]})
    return f"{len(niveles)} niveles, {nj} jugadores"
# </logica>


# ---------------- Firestore y descarga (solo se usan al ejecutar el lector) ----------------
def _servicio():
    import requests
    import google.auth.transport.requests
    from google.oauth2 import service_account
    cuenta = json.loads(os.environ["FCM_SERVICE_ACCOUNT"])
    cred = service_account.Credentials.from_service_account_info(cuenta, scopes=["https://www.googleapis.com/auth/cloud-platform"])
    cred.refresh(google.auth.transport.requests.Request())
    base = f"https://firestore.googleapis.com/v1/projects/{cuenta['project_id']}/databases/(default)/documents"
    return requests, {"Authorization": "Bearer " + cred.token}, base


def _leer_doc(requests, cab, base, ruta):
    r = requests.get(f"{base}/{ruta}", headers=cab, timeout=30)
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.json().get("fields", {})


def _guardar_texto(requests, cab, base, ruta, datos, extra):
    campos = {"datos": {"stringValue": datos}}
    campos.update({k: {"stringValue": str(v)} for k, v in extra.items()})
    r = requests.patch(f"{base}/{ruta}", headers=cab, json={"fields": campos}, timeout=60)
    if r.status_code != 200:
        sys.exit(f"Error al guardar {ruta}: {r.status_code} {r.text[:300]}")


def _equipos_sd(requests, cab, base):
    """Equipos de Sweet Dreams: los de parejas cuyo establecimiento es Sweet Dreams y los de la liga online que marcas en el panel."""
    res = set()
    token = None
    while True:
        params = {"pageSize": 300}
        if token:
            params["pageToken"] = token
        r = requests.get(f"{base}/liga_equipos", headers=cab, params=params, timeout=60)
        r.raise_for_status()
        j = r.json()
        for d in j.get("documents", []):
            f = d.get("fields", {})
            cat = f.get("categoria", {}).get("stringValue", "")
            if cat == "parejas" and clave(f.get("local", {}).get("stringValue", "")) == "sweet dreams":
                res.add(("parejas", int(f.get("nivel", {}).get("integerValue", 0)), clave(f.get("nombre", {}).get("stringValue", ""))))
        token = j.get("nextPageToken")
        if not token:
            break
    cfg = _leer_doc(requests, cab, base, "liga_config/equiposSweetDreams")
    nombres = [v.get("stringValue", "") for v in (cfg or {}).get("nombres", {}).get("arrayValue", {}).get("values", [])]
    return res, {clave(n) for n in nombres}


def texto_de_pdf(contenido):
    import pdfplumber
    with pdfplumber.open(io.BytesIO(contenido)) as pdf:
        return "\n".join((p.extract_text() or "") for p in pdf.pages)


def procesar(pdfs, prueba=False):
    """pdfs: {"parejas-2": {"url": …}, …} tal como lo deja leer_pdfs. Lee cada PDF, fusiona y guarda."""
    requests, cab, base = _servicio()
    nuevos, avisos = [], []
    for k, v in sorted(pdfs.items()):
        cat, n = k.rsplit("-", 1)
        if cat != "parejas":
            continue   # la liga online de equipos se lee desde otra fuente
        r = requests.get(v["url"], headers={"User-Agent": "Mozilla/5.0 (lector liga Sweet Dreams)"}, timeout=60)
        if r.status_code != 200:
            avisos.append(f"{k}: no se pudo descargar ({r.status_code})")
            continue
        nivel, av = parsear_pdf(texto_de_pdf(r.content), k)
        avisos += av
        if nivel and nivel["n"] == int(n):
            nuevos.append(nivel)
        elif nivel:
            avisos.append(f"{k}: el PDF dice nivel {nivel['n']}, lo ignoro")
    if not nuevos:
        print("Ninguna clasificación nueva que leer.", *avisos, sep="\n")
        return "Ninguna clasificación con datos todavía."
    previo = _leer_doc(requests, cab, base, "liga_config/clasificaciones")
    anterior = json.loads(previo["datos"]["stringValue"])["niveles"] if previo and "datos" in previo else []
    niveles = fusionar(anterior, nuevos)
    sd_parejas, sd_online = _equipos_sd(requests, cab, base)
    marcar_sweet_dreams(niveles, sd_parejas | {("equipos", n["n"], c) for n in niveles if n["cat"] == "equipos" for c in sd_online})
    hist_doc = _leer_doc(requests, cab, base, "liga_config/historial")
    hist = actualizar_historial(json.loads(hist_doc["datos"]["stringValue"]) if hist_doc and "datos" in hist_doc else None, nuevos)
    temporada = max(n["temp"] for n in niveles)
    informe = max(n["informe"] for n in niveles)
    datos = json.dumps({"v": 1, "temp": temporada, "informe": informe, "niveles": niveles}, ensure_ascii=False, separators=(",", ":"))
    texto_hist = json.dumps(hist, ensure_ascii=False, separators=(",", ":"))
    for a in avisos:
        print("AVISO:", a)
    print(f"Clasificaciones: {resumen(niveles)} · {len(datos.encode())} bytes · historial {len(texto_hist.encode())} bytes")
    if len(datos.encode()) > 900000 or len(texto_hist.encode()) > 900000:
        sys.exit("Los datos son demasiado grandes")
    if prueba:
        print("Modo prueba: no se guarda nada.")
        return resumen(niveles)
    ahora = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    _guardar_texto(requests, cab, base, "liga_config/clasificaciones", datos, {"generado": ahora, "temporada": temporada, "informe": informe})
    _guardar_texto(requests, cab, base, "liga_config/historial", texto_hist, {"generado": ahora})
    print("Guardadas las clasificaciones y el historial")
    return "Leídas las clasificaciones: " + resumen(niveles) + "."
