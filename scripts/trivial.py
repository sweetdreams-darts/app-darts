"""Robot del trivial competitivo de Sweet Dreams.

Cada 10 minutos (GitHub Actions):
  1. Publica el reto del día (a las 6:00 empieza la jornada del bar) con preguntas guardadas en secreto.
     El reto solo lleva los códigos de las preguntas: el texto está en trivial_preg y cada jugador solo lo puede leer
     cuando abre la pregunta. Las preguntas de los retos pasados pasan a la partida libre.
  2. Al cerrarse un reto (al día siguiente), corrige todas sus respuestas de una vez y las suma al ranking del reto.
     Así nadie sabe qué ha acertado (ni cuál era la buena) mientras el reto sigue abierto.
  3. Corrige las respuestas nuevas de la partida libre, que tiene su propio ranking aparte (sin premios).
  4. Rehace los rankings (semana, mes e histórico) y, al cambiar de semana o de mes, apunta al ganador del reto.
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


VERSION = 2


def puntos_nuevos(uid):
    return {"uid": uid, "n": "Jugador", "h": {"a": 0, "f": 0, "t": 0}, "semana": {"k": "", "a": 0, "f": 0, "t": 0}, "mes": {"k": "", "a": 0, "f": 0, "t": 0},
            "L": {"h": {"a": 0, "f": 0, "t": 0}, "semana": {"k": "", "a": 0, "f": 0, "t": 0}, "mes": {"k": "", "a": 0, "f": 0, "t": 0}}, "hechas": []}


def sumar(bolsas, d, acierto, tiempo):
    """Suma un acierto o un fallo a las bolsas {h, semana, mes} del día d. Si una bolsa ya es de un periodo posterior, no se toca."""
    for campo, clave in (("semana", clave_semana(d)), ("mes", clave_mes(d))):
        k = bolsas[campo].get("k") or ""
        if k > clave:
            continue
        if k != clave:
            bolsas[campo] = {"k": clave, "a": 0, "f": 0, "t": 0}
    for bolsa in [bolsas["h"]] + [bolsas[c] for c, clave in (("semana", clave_semana(d)), ("mes", clave_mes(d))) if bolsas[c].get("k") == clave]:
        bolsa["a" if acierto else "f"] += 1
        bolsa["t"] = round(bolsa["t"] + tiempo, 1)


def nota(p, r, a, sol, seg):
    """Devuelve (acierto, tiempo) de una pregunta abierta «a» con su respuesta «r» (o None) y su solución «sol»."""
    if r is not None:
        tiempo = max(0.0, (r["t"] - a["t"]).total_seconds())
        acierto = sol is not None and r.get("e") == sol.get("c") and tiempo <= seg + MARGEN_SEG
        if r.get("nombre"):
            p["n"] = nombre_corto(r["nombre"])
    else:
        tiempo, acierto = float(seg), False
    return acierto, min(tiempo, float(seg))


def migrar(fs, ahora):
    """Una sola vez: saca el texto de las preguntas de los retos y de la partida libre a trivial_preg (solo se lee al abrirlas)
    y apunta desde qué reto se puntúa al cerrarse. Devuelve los ajustes del robot."""
    robot = fs.get("trivial_config/robot") or {}
    if int(robot.get("version", 0)) >= VERSION:
        return robot
    escrituras = []
    for qid, q in fs.query("trivial_banco", []):
        escrituras.append(("set", f"trivial_preg/{qid}", {"p": q.get("p", ""), "ops": q.get("ops", []), "cat": q.get("cat", "")}))
    for cat, libre in fs.query("trivial_libre", []):
        ids = list(libre.get("ids") or [x["id"] for x in libre.get("preguntas", [])])
        escrituras.append(("set", f"trivial_libre/{cat}", {"cat": libre.get("cat", cat), "ids": ids}))
    for rid, r in fs.query("trivial_retos", [("abierto", "==", True)]):
        escrituras.append(("merge", f"trivial_retos/{rid}", {"preguntas": [{"id": q["id"], "cat": q.get("cat", "")} for q in r.get("preguntas", [])]}))
    # el reto de hoy (que ya ha empezado) se sigue puntuando como antes; desde el de mañana, al cerrarse
    desde = (dia_bar(ahora) + dt.timedelta(days=1)).isoformat()
    cambios = {"version": VERSION, "retoDesde": robot.get("retoDesde") or desde}
    escrituras.append(("merge", "trivial_config/robot", cambios))
    fs.write(escrituras)
    print(f"Migración del trivial: {len(escrituras) - 1} documentos preparados; los retos desde el {cambios['retoDesde']} se puntúan al cerrarse")
    robot.update(cambios)
    return robot


# ---------------- trabajo ----------------
def asegurar_reto(fs, cfg, ahora, robot):
    """Crea el reto de hoy si no existe. Devuelve el id del reto (o None si no hay preguntas)."""
    hoy = dia_bar(ahora).isoformat()
    if fs.get(f"trivial_retos/{hoy}"):
        return hoy
    escrituras = []
    desde = robot.get("retoDesde") or "9999"
    # cerrar los retos anteriores (marcándolos para puntuar) y pasar sus preguntas a la partida libre
    for rid, r in fs.query("trivial_retos", [("abierto", "==", True)]):
        escrituras.append(("merge", f"trivial_retos/{rid}", {"abierto": False, "puntuar": rid >= desde}))
        por_cat = {}
        for q in r.get("preguntas", []):
            por_cat.setdefault(q["cat"], []).append(q)
            escrituras.append(("merge", f"trivial_banco/{q['id']}", {"estado": "libre"}))
        for cat, qs in por_cat.items():
            libre = fs.get(f"trivial_libre/{cat}") or {"cat": cat, "ids": []}
            ids = list(libre.get("ids", []))
            ids += [q["id"] for q in qs if q["id"] not in set(ids)]
            escrituras.append(("set", f"trivial_libre/{cat}", {"cat": libre.get("cat", cat), "ids": ids}))
    # elegir las preguntas de hoy entre las guardadas en reserva
    reserva = fs.query("trivial_banco", [("estado", "==", "reserva")])
    n = int(cfg.get("porReto", 10))
    elegidas = random.sample(reserva, min(n, len(reserva)))
    if elegidas:
        # el reto solo lleva el código y la categoría de cada pregunta; el texto va en trivial_preg
        preguntas = [{"id": qid, "cat": q["cat"]} for qid, q in elegidas]
        escrituras.append(("set", f"trivial_retos/{hoy}", {"dia": hoy, "ids": [q["id"] for q in preguntas], "preguntas": preguntas, "seg": int(cfg.get("seg", 20)), "abierto": True, "creado": ahora}))
        for qid, q in elegidas:
            escrituras.append(("merge", f"trivial_banco/{qid}", {"estado": "reto", "diaReto": hoy}))
            escrituras.append(("set", f"trivial_preg/{qid}", {"p": q["p"], "ops": q["ops"], "cat": q["cat"]}))
    fs.write(escrituras)
    return hoy if elegidas else None


def puntuar_retos(fs, cfg, ahora):
    """Corrige de una vez los retos ya cerrados que están pendientes de puntuar y los suma al ranking del reto."""
    hechos = 0
    for rid, r in fs.query("trivial_retos", [("puntuar", "==", True)]):
        seg = int(r.get("seg") or cfg.get("seg", 20))
        aperturas = [(aid, a) for aid, a in fs.query("trivial_aperturas", [("dia", "==", rid)]) if a.get("modo") == "R"]
        resp = fs.get_many([f"trivial_resp/{aid}" for aid, _ in aperturas]) if aperturas else {}
        sols = fs.get_many(sorted({f"trivial_sol/{a['q']}" for _, a in aperturas})) if aperturas else {}
        puntos = {}
        d = dt.date.fromisoformat(rid)
        for aid, a in aperturas:
            uid = a["uid"]
            if uid not in puntos:
                puntos[uid] = fs.get(f"trivial_puntos/{uid}") or puntos_nuevos(uid)
            p = puntos[uid]
            acierto, tiempo = nota(p, resp.get(f"trivial_resp/{aid}"), a, sols.get(f"trivial_sol/{a['q']}"), seg)
            sumar(p, d, acierto, tiempo)
            if a["q"] not in p.setdefault("hechas", []):
                p["hechas"].append(a["q"])
        # los puntos y la marca de «ya puntuado» van juntos, para no contar dos veces el mismo reto
        fs.write([("set", f"trivial_puntos/{uid}", p) for uid, p in puntos.items()] + [("merge", f"trivial_retos/{rid}", {"puntuar": False, "puntuado": ahora})])
        print(f"Reto {rid} cerrado y puntuado: {len(aperturas)} preguntas abiertas por {len(puntos)} jugadores")
        hechos += 1
    return hechos


def corregir(fs, cfg, ahora, robot):
    """Corrige las preguntas de la partida libre abiertas desde la última vez (y las del reto antiguo, puntuadas como antes).
    Las del reto nuevo se saltan: se puntúan todas juntas al cerrarse el reto. Devuelve cuántas ha corregido."""
    cursor, ya = robot.get("cursor"), set(robot.get("idsCursor", []))
    desde = robot.get("retoDesde") or "9999"
    filtros = [("t", ">=", cursor)] if cursor else []
    # las que tienen justo la hora del cursor y ya se corrigieron no se vuelven a contar
    aperturas = [x for x in fs.query("trivial_aperturas", filtros, orden="t", limite=1500) if not (x[1]["t"] == cursor and x[0] in ya)]
    if not aperturas:
        return 0
    seg = int(cfg.get("seg", 20))
    al_cerrar = lambda a: a.get("modo") == "R" and (a.get("dia") or "") >= desde
    resp = fs.get_many([f"trivial_resp/{aid}" for aid, a in aperturas if not al_cerrar(a)])
    sols = fs.get_many(sorted({f"trivial_sol/{a['q']}" for _, a in aperturas if not al_cerrar(a)}))
    puntos = {}
    hechas = 0
    nuevo_cursor = cursor
    for aid, a in aperturas:
        saltar = al_cerrar(a)
        r = None if saltar else resp.get(f"trivial_resp/{aid}")
        if not saltar and r is None and (ahora - a["t"]).total_seconds() < seg + ESPERA_SIN_RESPUESTA:
            break  # todavía la está contestando: se corrige en la próxima vuelta
        if not saltar:
            uid = a["uid"]
            if uid not in puntos:
                puntos[uid] = fs.get(f"trivial_puntos/{uid}") or puntos_nuevos(uid)
            p = puntos[uid]
            acierto, tiempo = nota(p, r, a, sols.get(f"trivial_sol/{a['q']}"), seg)
            if a.get("modo") == "L":
                # la partida libre tiene su propio ranking
                bolsas = p.setdefault("L", puntos_nuevos(uid)["L"])
                sumar(bolsas, dia_bar(a["t"]), acierto, tiempo)
            else:
                sumar(p, dia_bar(a["t"]), acierto, tiempo)
            if a["q"] not in p.setdefault("hechas", []):
                p["hechas"].append(a["q"])
            hechas += 1
        if a["t"] != nuevo_cursor:
            ya = set()
        ya.add(aid)
        nuevo_cursor = a["t"]
    escrituras = [("set", f"trivial_puntos/{uid}", p) for uid, p in puntos.items()]
    if nuevo_cursor != cursor or hechas:
        escrituras.append(("merge", "trivial_config/robot", {"cursor": nuevo_cursor, "idsCursor": sorted(ya), "actualizado": ahora}))
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
    def lista(campo, clave, libre=False):
        out = []
        for uid, p in todos:
            b = ((p.get("L") or {}) if libre else p).get(campo) or {}
            if clave is not None and b.get("k") != clave:
                continue
            if b.get("a", 0) + b.get("f", 0) == 0:
                continue
            out.append({"uid": uid, "n": p.get("n", "Jugador"), "a": b.get("a", 0), "f": b.get("f", 0), "t": b.get("t", 0)})
        return ordenar(out)[:100]
    escrituras = []
    for tipo, campo, clave_nueva, premio in (("semana", "semana", ks, cfg.get("premioSemana", "")), ("mes", "mes", km, cfg.get("premioMes", ""))):
        ant = viejo.get(campo) or {}
        # el ganador se saca de los puntos de ahora (incluye el último reto, que se puntúa al cerrarse)
        cierre = lista(campo, ant["k"]) if ant.get("k") and ant.get("k") != clave_nueva else []
        if not cierre and ant.get("k") != clave_nueva:
            cierre = ant.get("lista") or []
        if ant.get("k") and ant.get("k") != clave_nueva and cierre:
            g = cierre[0]
            escrituras.append(("set", f"trivial_ganadores/{tipo}_{ant['k']}", {"tipo": tipo, "k": ant["k"], "uid": g["uid"], "n": g["n"], "a": g["a"], "f": g["f"], "premio": premio if cfg.get("premiosActivos") else "", "entregado": False, "cerrado": ahora}))
    escrituras.append(("set", "trivial_ranking/actual", {"semana": {"k": ks, "lista": lista("semana", ks)}, "mes": {"k": km, "lista": lista("mes", km)}, "historico": {"lista": lista("h", None)},
                                                         "libre": {"semana": {"k": ks, "lista": lista("semana", ks, True)}, "mes": {"k": km, "lista": lista("mes", km, True)}, "historico": {"lista": lista("h", None, True)}},
                                                         "actualizado": ahora}))
    fs.write(escrituras)
    return True


def ejecutar(fs, ahora=None):
    ahora = ahora or dt.datetime.now(dt.timezone.utc)
    cfg = fs.get("trivial_config/ajustes") or {}
    robot = migrar(fs, ahora)
    reto = asegurar_reto(fs, cfg, ahora, robot)
    cerrados = puntuar_retos(fs, cfg, ahora)
    n = corregir(fs, cfg, ahora, robot)
    hecho = rankings(fs, cfg, ahora, forzar=n > 0 or cerrados > 0)
    print(f"Reto de hoy: {reto or 'sin preguntas en reserva'} · retos cerrados puntuados: {cerrados} · respuestas corregidas: {n} · rankings {'actualizados' if hecho else 'sin cambios'}")


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
