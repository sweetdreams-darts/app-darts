"""Robot del trivial competitivo de Sweet Dreams.

Cada 10 minutos (GitHub Actions):
  1. Publica el reto del día (a las 6:00 empieza la jornada del bar) con preguntas guardadas en secreto.
     Las preguntas de los retos pasados pasan a la partida libre.
  2. Corrige las respuestas nuevas: comprueba la respuesta y que se contestó a tiempo.
  3. Rehace los rankings (semana, mes e histórico) y, al cambiar de semana o de mes, apunta al ganador.
Los puntos los pone siempre el robot: el móvil de cada jugador solo envía lo que ha contestado.
"""
import os, random, datetime as dt
from zoneinfo import ZoneInfo

MADRID = ZoneInfo("Europe/Madrid")
PROYECTO = "sweet-dreams-darts"
API_KEY = "AIzaSyByyLDyO2f0AYGtzVgdL006DRT2AE0n7kw"
REFERER = "https://sweetdreams-darts.github.io/"
PARTICULAS = {"de", "del", "la", "las", "los", "el", "y"}
MARGEN_SEG = 2          # segundos de cortesía por la conexión
ESPERA_SIN_RESPUESTA = 120  # si pasan estos segundos sin respuesta, la pregunta cuenta como fallo


# ---------------- utilidades ----------------
def dia_bar(t):
    """Día de la jornada del bar: hasta las 6:00 cuenta el día anterior."""
    return (t.astimezone(MADRID) - dt.timedelta(hours=6)).date()


def clave_semana(d):
    a, s, _ = d.isocalendar()
    return f"{a}-S{s:02d}"


def clave_mes(d):
    return f"{d.year}-{d.month:02d}"


def nombre_corto(nombre):
    """«Brian Palacios del Valle» → «Brian P.»"""
    p = [x for x in (nombre or "").split() if x]
    if not p:
        return "Jugador"
    resto = [x for x in p[1:] if x.lower() not in PARTICULAS]
    return p[0].capitalize() + (" " + resto[0][0].upper() + "." if resto else "")


def ordenar(lista):
    return sorted(lista, key=lambda e: (-e["a"], e["f"], e["t"], e["n"]))


# ---------------- trabajo ----------------
def asegurar_reto(fs, cfg, ahora):
    """Crea el reto de hoy si no existe. Devuelve el id del reto (o None si no hay preguntas)."""
    hoy = dia_bar(ahora).isoformat()
    if fs.get(f"trivial_retos/{hoy}"):
        return hoy
    escrituras = []
    # cerrar los retos anteriores y pasar sus preguntas a la partida libre
    for rid, r in fs.query("trivial_retos", [("abierto", "==", True)]):
        escrituras.append(("set", f"trivial_retos/{rid}", dict(r, abierto=False)))
        por_cat = {}
        for q in r.get("preguntas", []):
            por_cat.setdefault(q["cat"], []).append(q)
            escrituras.append(("merge", f"trivial_banco/{q['id']}", {"estado": "libre"}))
        for cat, qs in por_cat.items():
            libre = fs.get(f"trivial_libre/{cat}") or {"cat": cat, "ids": [], "preguntas": []}
            ids = set(libre.get("ids", []))
            nuevas = [q for q in qs if q["id"] not in ids]
            libre["ids"] = list(libre.get("ids", [])) + [q["id"] for q in nuevas]
            libre["preguntas"] = list(libre.get("preguntas", [])) + [{"id": q["id"], "p": q["p"], "ops": q["ops"]} for q in nuevas]
            escrituras.append(("set", f"trivial_libre/{cat}", libre))
    # elegir las preguntas de hoy entre las guardadas en reserva
    reserva = fs.query("trivial_banco", [("estado", "==", "reserva")])
    n = int(cfg.get("porReto", 10))
    elegidas = random.sample(reserva, min(n, len(reserva)))
    if elegidas:
        preguntas = [{"id": qid, "p": q["p"], "ops": q["ops"], "cat": q["cat"]} for qid, q in elegidas]
        escrituras.append(("set", f"trivial_retos/{hoy}", {"dia": hoy, "ids": [q["id"] for q in preguntas], "preguntas": preguntas, "seg": int(cfg.get("seg", 20)), "abierto": True, "creado": ahora}))
        for qid, _ in elegidas:
            escrituras.append(("merge", f"trivial_banco/{qid}", {"estado": "reto", "diaReto": hoy}))
    fs.write(escrituras)
    return hoy if elegidas else None


def corregir(fs, cfg, ahora):
    """Corrige las preguntas abiertas desde la última vez. Devuelve cuántas ha corregido."""
    robot = fs.get("trivial_config/robot") or {}
    cursor, ya = robot.get("cursor"), set(robot.get("idsCursor", []))
    filtros = [("t", ">=", cursor)] if cursor else []
    # las que tienen justo la hora del cursor y ya se corrigieron no se vuelven a contar
    aperturas = [x for x in fs.query("trivial_aperturas", filtros, orden="t", limite=1500) if not (x[1]["t"] == cursor and x[0] in ya)]
    if not aperturas:
        return 0
    seg = int(cfg.get("seg", 20))
    resp = fs.get_many([f"trivial_resp/{aid}" for aid, _ in aperturas])
    sols = fs.get_many(sorted({f"trivial_sol/{a['q']}" for _, a in aperturas}))
    puntos = {}
    hechas = 0
    nuevo_cursor = cursor
    for aid, a in aperturas:
        r = resp.get(f"trivial_resp/{aid}")
        sol = sols.get(f"trivial_sol/{a['q']}")
        if r is None and (ahora - a["t"]).total_seconds() < seg + ESPERA_SIN_RESPUESTA:
            break  # todavía la está contestando: se corrige en la próxima vuelta
        uid = a["uid"]
        if uid not in puntos:
            puntos[uid] = fs.get(f"trivial_puntos/{uid}") or {"uid": uid, "n": "Jugador", "h": {"a": 0, "f": 0, "t": 0}, "semana": {"k": "", "a": 0, "f": 0, "t": 0}, "mes": {"k": "", "a": 0, "f": 0, "t": 0}, "hechas": []}
        p = puntos[uid]
        if r is not None:
            tiempo = max(0.0, (r["t"] - a["t"]).total_seconds())
            acierto = sol is not None and r.get("e") == sol.get("c") and tiempo <= seg + MARGEN_SEG
            if r.get("nombre"):
                p["n"] = nombre_corto(r["nombre"])
        else:
            tiempo, acierto = float(seg), False
        tiempo = min(tiempo, float(seg))
        d = dia_bar(a["t"])
        for campo, clave in (("semana", clave_semana(d)), ("mes", clave_mes(d))):
            if p[campo].get("k") != clave:
                p[campo] = {"k": clave, "a": 0, "f": 0, "t": 0}
        for bolsa in (p["h"], p["semana"], p["mes"]):
            bolsa["a" if acierto else "f"] += 1
            bolsa["t"] = round(bolsa["t"] + tiempo, 1)
        if a["q"] not in p["hechas"]:
            p["hechas"].append(a["q"])
        hechas += 1
        if a["t"] != nuevo_cursor:
            ya = set()
        ya.add(aid)
        nuevo_cursor = a["t"]
    escrituras = [("set", f"trivial_puntos/{uid}", p) for uid, p in puntos.items()]
    if nuevo_cursor != cursor:
        escrituras.append(("set", "trivial_config/robot", {"cursor": nuevo_cursor, "idsCursor": sorted(ya), "actualizado": ahora}))
    elif hechas:
        escrituras.append(("set", "trivial_config/robot", {"cursor": nuevo_cursor, "idsCursor": sorted(ya), "actualizado": ahora}))
    fs.write(escrituras)
    return hechas


def rankings(fs, cfg, ahora, forzar=False):
    """Rehace los rankings. Al cambiar de semana o de mes, apunta al ganador del periodo que se cierra."""
    hoy = dia_bar(ahora)
    ks, km = clave_semana(hoy), clave_mes(hoy)
    viejo = fs.get("trivial_ranking/actual") or {}
    cambio = (viejo.get("semana") or {}).get("k") != ks or (viejo.get("mes") or {}).get("k") != km
    if not forzar and not cambio:
        return False
    todos = fs.query("trivial_puntos", [])
    def lista(campo, clave):
        out = []
        for uid, p in todos:
            b = p.get(campo) or {}
            if clave is not None and b.get("k") != clave:
                continue
            if b.get("a", 0) + b.get("f", 0) == 0:
                continue
            out.append({"uid": uid, "n": p.get("n", "Jugador"), "a": b.get("a", 0), "f": b.get("f", 0), "t": b.get("t", 0)})
        return ordenar(out)[:100]
    escrituras = []
    for tipo, campo, clave_nueva, premio in (("semana", "semana", ks, cfg.get("premioSemana", "")), ("mes", "mes", km, cfg.get("premioMes", ""))):
        ant = viejo.get(campo) or {}
        if ant.get("k") and ant.get("k") != clave_nueva and ant.get("lista"):
            g = ant["lista"][0]
            escrituras.append(("set", f"trivial_ganadores/{tipo}_{ant['k']}", {"tipo": tipo, "k": ant["k"], "uid": g["uid"], "n": g["n"], "a": g["a"], "f": g["f"], "premio": premio if cfg.get("premiosActivos") else "", "entregado": False, "cerrado": ahora}))
    escrituras.append(("set", "trivial_ranking/actual", {"semana": {"k": ks, "lista": lista("semana", ks)}, "mes": {"k": km, "lista": lista("mes", km)}, "historico": {"lista": lista("h", None)}, "actualizado": ahora}))
    fs.write(escrituras)
    return True


def ejecutar(fs, ahora=None):
    ahora = ahora or dt.datetime.now(dt.timezone.utc)
    cfg = fs.get("trivial_config/ajustes") or {}
    reto = asegurar_reto(fs, cfg, ahora)
    n = corregir(fs, cfg, ahora)
    hecho = rankings(fs, cfg, ahora, forzar=n > 0)
    print(f"Reto de hoy: {reto or 'sin preguntas en reserva'} · respuestas corregidas: {n} · rankings {'actualizados' if hecho else 'sin cambios'}")


# ---------------- Firestore por REST (cuenta robot) ----------------
class Firestore:
    def __init__(self, email, clave):
        import requests
        self.rq = requests.Session()
        r = self.rq.post(f"https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key={API_KEY}", json={"email": email, "password": clave, "returnSecureToken": True}, headers={"Referer": REFERER}, timeout=30)
        r.raise_for_status()
        self.rq.headers.update({"Authorization": "Bearer " + r.json()["idToken"], "Referer": REFERER})
        self.raiz = f"projects/{PROYECTO}/databases/(default)/documents"
        self.url = "https://firestore.googleapis.com/v1/" + self.raiz

    @staticmethod
    def a_valor(v):
        if v is None: return {"nullValue": None}
        if isinstance(v, bool): return {"booleanValue": v}
        if isinstance(v, int): return {"integerValue": str(v)}
        if isinstance(v, float): return {"doubleValue": v}
        if isinstance(v, str): return {"stringValue": v}
        if isinstance(v, dt.datetime): return {"timestampValue": v.astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z")}
        if isinstance(v, (list, tuple)): return {"arrayValue": {"values": [Firestore.a_valor(x) for x in v]}}
        if isinstance(v, dict): return {"mapValue": {"fields": {k: Firestore.a_valor(x) for k, x in v.items()}}}
        raise TypeError(type(v))

    @staticmethod
    def de_valor(v):
        if "nullValue" in v: return None
        if "booleanValue" in v: return v["booleanValue"]
        if "integerValue" in v: return int(v["integerValue"])
        if "doubleValue" in v: return float(v["doubleValue"])
        if "stringValue" in v: return v["stringValue"]
        if "timestampValue" in v:
            s = v["timestampValue"].replace("Z", "+00:00")
            if "." in s:
                base, resto = s.split(".", 1)
                frac, zona = resto[:resto.index("+")], resto[resto.index("+"):]
                s = base + "." + (frac + "000000")[:6] + zona
            return dt.datetime.fromisoformat(s)
        if "arrayValue" in v: return [Firestore.de_valor(x) for x in v["arrayValue"].get("values", [])]
        if "mapValue" in v: return {k: Firestore.de_valor(x) for k, x in v["mapValue"].get("fields", {}).items()}
        return None

    def _datos(self, d):
        return {k: self.de_valor(x) for k, x in d.get("fields", {}).items()}

    def get(self, ruta):
        r = self.rq.get(f"{self.url}/{ruta}", timeout=30)
        if r.status_code == 404: return None
        r.raise_for_status()
        return self._datos(r.json())

    def get_many(self, rutas):
        out = {}
        for i in range(0, len(rutas), 100):
            r = self.rq.post(f"{self.url}:batchGet", json={"documents": [f"{self.raiz}/{x}" for x in rutas[i:i + 100]]}, timeout=60)
            r.raise_for_status()
            for item in r.json():
                if "found" in item:
                    out[item["found"]["name"].split("/documents/", 1)[1]] = self._datos(item["found"])
        return out

    def query(self, coleccion, filtros, orden=None, limite=None):
        ops = {"==": "EQUAL", ">": "GREATER_THAN", "<": "LESS_THAN", ">=": "GREATER_THAN_OR_EQUAL"}
        q = {"from": [{"collectionId": coleccion}]}
        if filtros:
            fs = [{"fieldFilter": {"field": {"fieldPath": c}, "op": ops[o], "value": self.a_valor(v)}} for c, o, v in filtros]
            q["where"] = fs[0] if len(fs) == 1 else {"compositeFilter": {"op": "AND", "filters": fs}}
        if orden: q["orderBy"] = [{"field": {"fieldPath": orden}, "direction": "ASCENDING"}]
        if limite: q["limit"] = limite
        r = self.rq.post(f"{self.url}:runQuery", json={"structuredQuery": q}, timeout=60)
        r.raise_for_status()
        return [(x["document"]["name"].rsplit("/", 1)[1], self._datos(x["document"])) for x in r.json() if "document" in x]

    def write(self, escrituras):
        ws = []
        for tipo, ruta, datos in escrituras:
            w = {"update": {"name": f"{self.raiz}/{ruta}", "fields": {k: self.a_valor(v) for k, v in datos.items()}}}
            if tipo == "merge": w["updateMask"] = {"fieldPaths": list(datos.keys())}
            ws.append(w)
        for i in range(0, len(ws), 400):
            r = self.rq.post(f"{self.url}:commit", json={"writes": ws[i:i + 400]}, timeout=60)
            r.raise_for_status()


if __name__ == "__main__":
    ejecutar(Firestore(os.environ["ROBOT_EMAIL"], os.environ["ROBOT_PASSWORD"]))
