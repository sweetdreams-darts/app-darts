# Avisos push: revisa reservas nuevas, usuarios nuevos y recordatorios, y envía notificaciones con Firebase Cloud Messaging.
# También comprueba las tarjetas NFC de los camareros, da los puntos a los embajadores cuando viene un amigo suyo,
# mantiene la cuenta protegida de cada persona (cuentas/{uid}: alta, bloqueo y número de socio)
# y, una vez por jornada, borra todos los datos de las cuentas que ya no existen en Firebase Authentication.
import json, os, random, re, time
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
import requests
import google.auth.transport.requests
from google.oauth2 import service_account

CUENTA = json.loads(os.environ["FCM_SERVICE_ACCOUNT"])
PROYECTO = CUENTA["project_id"]
RAIZ = f"projects/{PROYECTO}/databases/(default)/documents"
BASE = f"https://firestore.googleapis.com/v1/{RAIZ}"
MADRID = ZoneInfo("Europe/Madrid")
DURACION = int(os.environ.get("DURACION", "270"))
APP = "https://sweetdreams-darts.github.io/app-darts/"
DIAS = ["lun", "mar", "mié", "jue", "vie", "sáb", "dom"]
MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"]
# Claves de las tarjetas NFC (NTAG 424 DNA). Si no se ponen, son las de fábrica (todo ceros), las que deja NXP TagWriter.
K_META = bytes.fromhex(os.environ.get("NFC_K_META") or "00" * 16)
K_FILE = bytes.fromhex(os.environ.get("NFC_K_FILE") or "00" * 16)
cred = service_account.Credentials.from_service_account_info(
    CUENTA, scopes=["https://www.googleapis.com/auth/cloud-platform", "https://www.googleapis.com/auth/firebase.messaging",
                    "https://www.googleapis.com/auth/identitytoolkit"])
cache = {}


def api(metodo, url, **kw):
    if not cred.valid:
        cred.refresh(google.auth.transport.requests.Request())
    return requests.request(metodo, url, headers={"Authorization": "Bearer " + cred.token}, timeout=30, **kw)


def ms_de(ts):
    ts = re.sub(r"(\.\d{6})\d+", r"\1", ts.replace("Z", "+00:00"))
    return int(datetime.fromisoformat(ts).timestamp() * 1000)


def iso(ms):
    return datetime.fromtimestamp(ms / 1000, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f") + "Z"


def local(ms):
    return datetime.fromtimestamp(ms / 1000, MADRID)


def hora(ms):
    return local(ms).strftime("%H:%M")


def fecha_bonita(ms):
    d = local(ms)
    return f"{DIAS[d.weekday()]} {d.day} {MESES[d.month - 1]}"


def campo(doc, nombre, tipo="stringValue"):
    return doc.get("fields", {}).get(nombre, {}).get(tipo)


def id_de(doc):
    return doc["name"].rsplit("/", 1)[1]


def consulta(coleccion, filtros, orden=None):
    fs = [{"fieldFilter": {"field": {"fieldPath": c}, "op": op, "value": v}} for c, op, v in filtros]
    q = {"from": [{"collectionId": coleccion}], "where": fs[0] if len(fs) == 1 else {"compositeFilter": {"op": "AND", "filters": fs}}}
    if orden:
        q["orderBy"] = [{"field": {"fieldPath": orden}, "direction": "ASCENDING"}]
    r = api("POST", f"{BASE}:runQuery", json={"structuredQuery": q})
    r.raise_for_status()
    return [x["document"] for x in r.json() if "document" in x]


def nombre_de(coleccion, did):
    k = (coleccion, did)
    if k not in cache:
        r = api("GET", f"{BASE}/{coleccion}/{did}")
        cache[k] = (campo(r.json(), "nombre") or did) if r.status_code == 200 else did
    return cache[k]


def tokens_de(uid):
    return [id_de(d) for d in consulta("push_tokens", [("uid", "EQUAL", {"stringValue": uid})])]


def admins():
    return [id_de(d) for d in consulta("users", [("role", "EQUAL", {"stringValue": "admin"})])]


def enviar(token, titulo, cuerpo, tag, url=APP):
    msg = {"message": {"token": token, "data": {"title": titulo, "body": cuerpo, "url": url, "tag": tag},
                       "webpush": {"headers": {"Urgency": "high", "TTL": "3600"}}}}
    r = api("POST", f"https://fcm.googleapis.com/v1/projects/{PROYECTO}/messages:send", json=msg)
    if r.status_code != 200 and ("UNREGISTERED" in r.text or "not a valid FCM registration token" in r.text):
        api("DELETE", f"{BASE}/push_tokens/{token}")
        print("Token caducado: borrado")
    elif r.status_code != 200:
        print("Error al enviar:", r.status_code, r.text[:200])
    return r.status_code == 200


def leer_estado():
    """Hasta dónde se han revisado las reservas y los usuarios nuevos (None si aún no se sabe)."""
    r = api("GET", f"{BASE}/avisos_estado/revision")
    if r.status_code != 200:
        return None, None
    f = r.json().get("fields", {})
    u = f.get("ultimaUsuariosMs", {}).get("integerValue")
    return int(f["ultimaMs"]["integerValue"]), (int(u) if u else None)


def guardar_estado(ms, usuarios_ms):
    api("PATCH", f"{BASE}/avisos_estado/revision?updateMask.fieldPaths=ultimaMs&updateMask.fieldPaths=ultimaUsuariosMs",
        json={"fields": {"ultimaMs": {"integerValue": str(ms)}, "ultimaUsuariosMs": {"integerValue": str(usuarios_ms)}}})


def revisar_nuevas(ultima):
    mayor = ultima
    for d in consulta("reservations", [("creado", "GREATER_THAN", {"timestampValue": iso(ultima)})], "creado"):
        mayor = max(mayor, ms_de(campo(d, "creado", "timestampValue")) + 1)
        ini, fin = ms_de(campo(d, "inicio", "timestampValue")), ms_de(campo(d, "fin", "timestampValue"))
        uid = campo(d, "uid")
        cuerpo = f"{nombre_de('dartboards', campo(d, 'dianaId'))} · {fecha_bonita(ini)} · {hora(ini)}–{hora(fin)} · {nombre_de('users', uid)}"
        for admin in admins():
            if admin != uid:
                for t in tokens_de(admin):
                    enviar(t, "Nueva reserva", cuerpo, "reserva-" + id_de(d))
        print("Reserva nueva:", cuerpo)
    return mayor


def revisar_usuarios(ultima):
    """Avisa a los administradores de cada persona que se registra en la app."""
    mayor = ultima
    for d in consulta("users", [("creado", "GREATER_THAN", {"timestampValue": iso(ultima)})], "creado"):
        alta = ms_de(campo(d, "creado", "timestampValue"))
        mayor = max(mayor, alta + 1)
        uid = id_de(d)
        try:
            asegurar_cuenta(uid, alta)
        except Exception as e:
            print("No se ha podido preparar la cuenta protegida:", e)
        nombre = (campo(d, "nombre") or "").strip() or "Sin nombre"
        cuerpo = f"{nombre} se ha registrado ({fecha_bonita(alta)}, {hora(alta)}). Toca para verlo."
        for admin in admins():
            if admin != uid:
                for t in tokens_de(admin):
                    enviar(t, "👤 Nuevo usuario", cuerpo, "usuario-" + uid, APP + "admin-nuevos.html")
        print("Usuario nuevo:", nombre)
    return mayor


# ---------------- cuenta protegida (cuentas/{uid}) ----------------
def asegurar_cuenta(uid, alta_ms):
    """Si la persona no tiene cuenta protegida (o le falta la fecha de alta), se la pone con la fecha de su ficha.
    Si ya la tiene, no se toca: así, aunque borre su ficha y la vuelva a crear, su alta sigue siendo la primera."""
    c = leer(f"cuentas/{uid}")
    if c and "alta" in c.get("fields", {}):
        return
    escribir([cambiar(f"cuentas/{uid}", {"alta": {"ms": alta_ms}})])


def sincronizar_cuentas():
    """Rellena la cuenta protegida de todas las fichas: fecha de alta, número de socio y bloqueo de reservas.
    Solo añade: quitar un bloqueo lo hace el administrador desde su panel."""
    ahora = int(time.time() * 1000)
    cuentas = {id_de(d): d.get("fields", {}) for d in listar("cuentas")}
    writes = []
    for u in listar("users"):
        uid, c = id_de(u), cuentas.get(id_de(u), {})
        cambios = {}
        if "alta" not in c:
            creado = campo(u, "creado", "timestampValue")
            cambios["alta"] = {"ms": ms_de(creado) if creado else ahora}
        num = int(campo(u, "socioNum", "integerValue") or 0)
        if num and not int(c.get("socioNum", {}).get("integerValue", 0) or 0):
            cambios["socioNum"] = num
        if campo(u, "bloqueado", "booleanValue") is True and c.get("bloqueado", {}).get("booleanValue") is not True:
            cambios["bloqueado"] = True
        if cambios:
            writes.append(cambiar(f"cuentas/{uid}", cambios))
    escribir(writes)
    print(f"Cuentas protegidas: {len(writes)} actualizada(s)")
    return len(writes)


def existen_en_auth(uids, control):
    """De esos uids, cuáles siguen existiendo en Firebase Authentication. Devuelve None si no se ha podido comprobar bien.
    «control» es una cuenta que seguro que existe (un administrador): si la respuesta no la trae, algo va mal y no se borra nada."""
    url = f"https://identitytoolkit.googleapis.com/v1/projects/{PROYECTO}/accounts:lookup"
    uids, out = list(uids), set()
    for i in range(0, len(uids), 90):
        r = api("POST", url, json={"localId": uids[i:i + 90] + [control]})
        if r.status_code != 200:
            print("No se ha podido consultar Firebase Authentication:", r.status_code, r.text[:200])
            return None
        vistos = {x.get("localId") for x in r.json().get("users", [])}
        if control not in vistos:
            print("La consulta a Firebase Authentication no ha devuelto la cuenta de control: no se borra nada")
            return None
        out |= vistos
    return out


# ---------------- utilidades para leer y escribir varios documentos ----------------
def leer(ruta):
    r = api("GET", f"{BASE}/{ruta}")
    return r.json() if r.status_code == 200 else None


def listar(coleccion, campos=None):
    q = {"from": [{"collectionId": coleccion}]}
    if campos is not None:   # solo esos campos (o solo el nombre del documento si la lista está vacía)
        q["select"] = {"fields": [{"fieldPath": c} for c in (campos or ["__name__"])]}
    r = api("POST", f"{BASE}:runQuery", json={"structuredQuery": q})
    r.raise_for_status()
    return [x["document"] for x in r.json() if "document" in x]


def leer_varios(rutas):
    out = {}
    for i in range(0, len(rutas), 100):
        r = api("POST", f"{BASE}:batchGet", json={"documents": [f"{RAIZ}/{x}" for x in rutas[i:i + 100]]})
        r.raise_for_status()
        for it in r.json():
            if "found" in it:
                out[it["found"]["name"].split("/documents/", 1)[1]] = it["found"]
    return out


def escribir(writes):
    for i in range(0, len(writes), 400):
        r = api("POST", f"{BASE}:commit", json={"writes": writes[i:i + 400]})
        r.raise_for_status()


def valor(v):
    if isinstance(v, bool): return {"booleanValue": v}
    if isinstance(v, int): return {"integerValue": str(v)}
    if isinstance(v, str): return {"stringValue": v}
    if isinstance(v, dict) and "ms" in v: return {"timestampValue": iso(v["ms"])}
    raise TypeError(type(v))


def cambiar(ruta, datos):
    """Escritura que solo toca los campos indicados."""
    return {"update": {"name": f"{RAIZ}/{ruta}", "fields": {k: valor(v) for k, v in datos.items()}}, "updateMask": {"fieldPaths": list(datos.keys())}}


def nombre_corto(nombre):
    p = (nombre or "").split()
    if not p:
        return "Tu amigo"
    return p[0][:1].upper() + p[0][1:] + (" " + p[1][:1].upper() + "." if len(p) > 1 else "")


def mes_de(ms):
    d = datetime.fromtimestamp(ms / 1000, timezone.utc)
    return f"{d.year}-{d.month:02d}"


# ---------------- trae a un amigo ----------------
# Niveles de los embajadores por amigos traídos (los que han venido y han dado puntos), con sus puntos extra por defecto.
NIVELES = [("bronce", 3, "🥉 Bronce", 25), ("plata", 10, "🥈 Plata", 50), ("oro", 25, "🥇 Oro", 100), ("diamante", 50, "💎 Diamante", 250)]
MESES_LARGOS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"]


def entero(v, defecto=0):
    if not v: return defecto
    if "integerValue" in v: return int(v["integerValue"])
    if "doubleValue" in v: return int(v["doubleValue"])
    return defecto


def ajustes_invitar():
    cfg = {"activo": True, "puntos": 100, "maxMes": 0, "minimo": 4.5, "premioMes": "", "puntosVisita": 30, "maxVisitasMes": 0, "mesesVisitas": 4,
           "bonus": {n: b for n, _, _, b in NIVELES}, "campana": None}
    d = leer("settings/invitaciones")
    f = (d or {}).get("fields", {})
    if "activo" in f: cfg["activo"] = f["activo"].get("booleanValue", True)
    if "puntos" in f: cfg["puntos"] = int(f["puntos"].get("integerValue", 100))
    if "maxMes" in f: cfg["maxMes"] = int(f["maxMes"].get("integerValue", 0))
    if "minimo" in f: cfg["minimo"] = float(f["minimo"].get("doubleValue", f["minimo"].get("integerValue", 4.5)))
    if "premioMes" in f: cfg["premioMes"] = f["premioMes"].get("stringValue", "")
    for k in ("puntosVisita", "maxVisitasMes", "mesesVisitas"):
        if k in f: cfg[k] = max(0, entero(f[k], cfg[k]))
    niv = f.get("niveles", {}).get("mapValue", {}).get("fields", {})
    for n in cfg["bonus"]:
        if n in niv: cfg["bonus"][n] = entero(niv[n], cfg["bonus"][n])
    c = f.get("campana", {}).get("mapValue", {}).get("fields", {})
    if c.get("activa", {}).get("booleanValue") is True:
        hasta = c.get("hasta", {}).get("stringValue", "")
        hoy = local(int(time.time() * 1000)).strftime("%Y-%m-%d")
        if hasta and hasta >= hoy:
            cfg["campana"] = {"multiplicador": max(1, entero(c.get("multiplicador"), 2)), "hasta": hasta, "id": c.get("id", {}).get("stringValue", "")}
    return cfg


def puntos_por_amigo(cfg):
    """Puntos que gana un embajador por amigo (multiplicados si hay campaña de puntos dobles activa)."""
    return cfg["puntos"] * (cfg["campana"]["multiplicador"] if cfg["campana"] else 1)


def fecha_corta(dia):
    """«2026-11-30» → «30 de noviembre»."""
    try:
        y, m, d = (int(x) for x in dia.split("-"))
        return f"{d} de {MESES_LARGOS[m - 1]}"
    except Exception:
        return dia


def revisar_invitaciones(ultima):
    """Cuando un amigo invitado viene al bar (compra con puntos o canje en la caja), premia al embajador que le invitó."""
    # solo movimientos de hace más de 2 minutos: así no se escapa ninguna compra que tarde unos segundos en guardarse
    hasta = int(time.time() * 1000) - 120000
    if hasta <= ultima:
        return ultima
    mayor, visitas, minimo = ultima, [], None
    for d in consulta("socios_mov", [("creado", "GREATER_THAN", {"timestampValue": iso(ultima)}), ("creado", "LESS_THAN_OR_EQUAL", {"timestampValue": iso(hasta)})], "creado"):
        cuando = ms_de(campo(d, "creado", "timestampValue"))
        mayor = max(mayor, cuando + 1)
        u = campo(d, "uid")
        if campo(d, "tipo") != "compra" or not u:
            continue   # canjear un cupón (aunque sea el regalo gratis) no cuenta
        if minimo is None:
            minimo = ajustes_invitar()["minimo"]
        importe = float(campo(d, "importe", "doubleValue") or campo(d, "importe", "integerValue") or 0)
        if importe + 1e-9 >= minimo:
            visitas.append((u, cuando))
    premiar_invitados(visitas)
    return mayor


def jornada_de(ms):
    """Día de la jornada del bar (acaba a las 6:00): «2026-11-18»."""
    return local(ms - 6 * 3600000).strftime("%Y-%m-%d")


def premiar_invitados(visitas):
    """Para cada visita al bar de una persona invitada por un embajador (una compra de la consumición mínima en la caja
    o una validación con la tarjeta del camarero): la primera vez el embajador gana los puntos de la primera visita;
    después, los puntos de cada visita siguiente (una por jornada, durante los meses configurados).
    «visitas» es una lista de (uid, momento en ms); también vale una lista de uids (momento = ahora)."""
    ahora = int(time.time() * 1000)
    eventos, vistos = [], set()
    for v in visitas or []:
        uid, cuando = (v, ahora) if isinstance(v, str) else v
        clave = (uid, jornada_de(cuando))
        if clave not in vistos:
            vistos.add(clave)
            eventos.append((uid, cuando))
    if not eventos:
        return
    invs = leer_varios(sorted({f"invitaciones/{u}" for u, _ in eventos}))
    eventos = [(u, c) for u, c in eventos if f"invitaciones/{u}" in invs]
    if not eventos:
        return
    cfg = ajustes_invitar()
    if not cfg["activo"]:
        return
    mes = mes_de(ahora)
    primeras = set()
    for uid, cuando in sorted(eventos, key=lambda x: x[1]):
        inv = invs[f"invitaciones/{uid}"]
        # cada visita por separado: si una falla, las demás siguen (y el robot no se queda atascado)
        try:
            if campo(inv, "premiado", "booleanValue") is not True:
                if uid not in primeras:
                    premiar_uno(uid, inv, cfg, ahora, mes)
                    primeras.add(uid)
            else:
                premiar_visita(uid, inv, cfg, cuando)
        except Exception as e:
            print("Embajadores: no se ha podido atender la visita de", uid, "-", e)


def premiar_visita(uid, inv, cfg, cuando):
    """Visita de un amigo que ya vino alguna vez: el embajador gana los puntos de «cada visita siguiente»
    (una vez por jornada y solo durante los meses configurados desde que el amigo se registró)."""
    pts_base = cfg["puntosVisita"]
    socio = campo(inv, "refUid")
    if pts_base <= 0 or not socio or int(campo(inv, "puntos", "integerValue") or 0) <= 0:
        return   # sin puntos por visita, o la primera visita no contó (por ejemplo, porque no era embajador activo)
    creado = campo(inv, "creado", "timestampValue")
    if cfg["mesesVisitas"] and creado and cuando - ms_de(creado) > cfg["mesesVisitas"] * 30.5 * 864e5:
        return   # ya han pasado los meses en los que sus visitas dan puntos
    jornada = jornada_de(cuando)
    primera = campo(inv, "premiadoEn", "timestampValue")
    if primera and jornada_de(ms_de(primera)) == jornada:
        return   # el mismo día de su primera visita ya cobró
    mes_visita = jornada[:7]
    n_mes = int(campo(inv, "visitasMesN", "integerValue") or 0) if campo(inv, "visitasMesK") == mes_visita else 0
    if cfg["maxVisitasMes"] and n_mes >= cfg["maxVisitasMes"]:
        return
    if leer(f"socios_mov/visita_{uid}_{jornada}"):
        return   # esa jornada ya se premió
    emb = leer(f"embajadores/{socio}")
    if not emb or campo(emb, "activo", "booleanValue") is not True:
        return
    pts = pts_base * (cfg["campana"]["multiplicador"] if cfg["campana"] else 1)
    ahora = int(time.time() * 1000)
    nombre = campo(inv, "nombre") or nombre_corto(campo(leer(f"users/{uid}") or {}, "nombre") or "")
    sp = leer(f"socios_puntos/{socio}")
    saldo = (int(campo(sp, "puntos", "integerValue") or 0) if sp else 0) + pts
    mov = {"uid": socio, "tipo": "ajuste", "importe": 0, "puntos": pts, "saldo": saldo, "por": "robot", "porNombre": "Embajadores",
           "nota": nombre + " ha vuelto", "mes": mes_de(ahora), "creado": {"ms": ahora}}
    visitas = int(campo(inv, "visitas", "integerValue") or 0) + 1
    escribir([
        {"update": {"name": f"{RAIZ}/socios_mov/visita_{uid}_{jornada}", "fields": {k: valor(v) for k, v in mov.items()}}, "currentDocument": {"exists": False}},
        {"update": {"name": f"{RAIZ}/socios_puntos/{socio}", "fields": {"actualizado": valor({"ms": ahora})}}, "updateMask": {"fieldPaths": ["actualizado"]},
         "updateTransforms": [{"fieldPath": "puntos", "increment": {"integerValue": str(pts)}}, {"fieldPath": "total", "increment": {"integerValue": str(pts)}}]},
        cambiar(f"invitaciones/{uid}", {"visitas": visitas, "puntosVisitas": int(campo(inv, "puntosVisitas", "integerValue") or 0) + pts,
                                        "visitasMesK": mes_visita, "visitasMesN": n_mes + 1, "ultimaVisita": jornada}),
    ])
    for t in tokens_de(socio):
        enviar(t, "🔁 Tu amigo ha vuelto", f"{nombre} ha vuelto hoy a Sweet Dreams: +{pts} puntos para ti.", "visita-" + uid + "-" + jornada, APP)
    print(f"Embajadores: +{pts} puntos para {socio} por la visita de {nombre} ({jornada})")


def premiar_uno(uid, inv, cfg, ahora, mes):
    """Atiende una invitación: da los puntos al embajador (una sola vez por invitado) o apunta por qué no."""
    num = int(inv["fields"]["ref"]["integerValue"])
    if leer(f"socios_mov/inv_{uid}"):
        # este invitado ya hizo ganar puntos a un embajador alguna vez: no se repite
        escribir([cambiar(f"invitaciones/{uid}", {"premiado": True, "puntos": 0, "motivo": "ya se premió antes", "premiadoEn": {"ms": ahora}, "premiadoMes": mes})])
        print("Embajadores: invitación ya premiada antes, sin puntos")
        return
    quien = consulta("users", [("socioNum", "EQUAL", {"integerValue": str(num)})])
    amigo = leer(f"users/{uid}")
    nombre = nombre_corto(campo(amigo, "nombre") if amigo else "")
    if not quien or id_de(quien[0]) == uid:
        escribir([cambiar(f"invitaciones/{uid}", {"premiado": True, "puntos": 0, "motivo": "no hay socio con ese número", "premiadoEn": {"ms": ahora}, "premiadoMes": mes})])
        return
    socio = id_de(quien[0])
    emb = leer(f"embajadores/{socio}")
    if not emb or campo(emb, "activo", "booleanValue") is not True:
        escribir([cambiar(f"invitaciones/{uid}", {"premiado": True, "puntos": 0, "motivo": "quien invitó no es embajador activo", "refUid": socio, "premiadoEn": {"ms": ahora}, "premiadoMes": mes})])
        print("Invitación de alguien que no es embajador activo: sin puntos (socio", num, ")")
        return
    if cfg["maxMes"]:
        ya = consulta("invitaciones", [("refUid", "EQUAL", {"stringValue": socio}), ("premiadoMes", "EQUAL", {"stringValue": mes})])
        if sum(1 for d in ya if int(campo(d, "puntos", "integerValue") or 0) > 0) >= cfg["maxMes"]:
            escribir([cambiar(f"invitaciones/{uid}", {"premiado": True, "puntos": 0, "motivo": "tope del mes", "refUid": socio, "premiadoEn": {"ms": ahora}, "premiadoMes": mes})])
            print("Embajadores: tope del mes para el socio", num)
            return
    pts = puntos_por_amigo(cfg)
    sp = leer(f"socios_puntos/{socio}")
    saldo = (int(campo(sp, "puntos", "integerValue") or 0) if sp else 0) + pts
    mov = {"uid": socio, "tipo": "ajuste", "importe": 0, "puntos": pts, "saldo": saldo, "por": "robot", "porNombre": "Embajadores", "nota": "has invitado a " + nombre, "mes": mes, "creado": {"ms": ahora}}
    escribir([
        {"update": {"name": f"{RAIZ}/socios_puntos/{socio}", "fields": {"actualizado": valor({"ms": ahora})}}, "updateMask": {"fieldPaths": ["actualizado"]},
         "updateTransforms": [{"fieldPath": "puntos", "increment": {"integerValue": str(pts)}}, {"fieldPath": "total", "increment": {"integerValue": str(pts)}}]},
        {"update": {"name": f"{RAIZ}/socios_mov/inv_{uid}", "fields": {k: valor(v) for k, v in mov.items()}}, "currentDocument": {"exists": False}},
        cambiar(f"invitaciones/{uid}", {"premiado": True, "puntos": pts, "refUid": socio, "premiadoEn": {"ms": ahora}, "premiadoMes": mes}),
    ])
    for t in tokens_de(socio):
        enviar(t, "🎉 Tu amigo ha venido", f"{nombre} ha venido a Sweet Dreams: +{pts} puntos para ti.", "invitar-" + uid, APP)
    print(f"Embajadores: +{pts} puntos para el socio {num} por {nombre}")
    try:
        subir_nivel(socio, cfg, ahora, mes)
    except Exception as e:
        print("Embajadores: no se ha podido revisar el nivel:", e)
    try:
        calcular_ranking()
    except Exception as e:
        print("Embajadores: no se ha podido actualizar el ranking:", e)


def amigos_de(socio):
    """Amigos que un embajador ha traído al bar (invitaciones que le dieron puntos)."""
    return sum(1 for d in consulta("invitaciones", [("refUid", "EQUAL", {"stringValue": socio})]) if int(campo(d, "puntos", "integerValue") or 0) > 0)


def subir_nivel(socio, cfg, ahora, mes):
    """Si el embajador llega a un nivel nuevo (Bronce, Plata, Oro, Diamante), se lo apunta y le da sus puntos extra (una sola vez)."""
    n = amigos_de(socio)
    emb = leer(f"embajadores/{socio}")
    actual = campo(emb or {}, "nivel") or ""
    orden = [x[0] for x in NIVELES]
    alcanzado = [x for x in NIVELES if n >= x[1]]
    if not alcanzado:
        return
    clave, _, nombre, _ = alcanzado[-1]
    if actual in orden and orden.index(actual) >= orden.index(clave):
        return
    extra = cfg["bonus"].get(clave, 0)
    writes = [cambiar(f"embajadores/{socio}", {"nivel": clave, "nivelEn": {"ms": ahora}})]
    if extra > 0:
        sp = leer(f"socios_puntos/{socio}")
        saldo = (int(campo(sp, "puntos", "integerValue") or 0) if sp else 0) + extra
        mov = {"uid": socio, "tipo": "ajuste", "importe": 0, "puntos": extra, "saldo": saldo, "por": "robot", "porNombre": "Embajadores",
               "nota": "¡nivel " + nombre.split(" ", 1)[1] + "!", "mes": mes, "creado": {"ms": ahora}}
        writes = [
            {"update": {"name": f"{RAIZ}/socios_mov/nivel_{socio}_{clave}", "fields": {k: valor(v) for k, v in mov.items()}}, "currentDocument": {"exists": False}},
            {"update": {"name": f"{RAIZ}/socios_puntos/{socio}", "fields": {"actualizado": valor({"ms": ahora})}}, "updateMask": {"fieldPaths": ["actualizado"]},
             "updateTransforms": [{"fieldPath": "puntos", "increment": {"integerValue": str(extra)}}, {"fieldPath": "total", "increment": {"integerValue": str(extra)}}]},
        ] + writes
    escribir(writes)
    for t in tokens_de(socio):
        enviar(t, f"{nombre.split(' ')[0]} ¡Subes a nivel {nombre.split(' ', 1)[1]}!", f"Ya has traído {n} amigos." + (f" Te regalamos {extra} puntos extra." if extra > 0 else ""), "nivel-" + clave, APP)
    print(f"Embajadores: el socio {socio} sube a {clave} (+{extra} puntos)")


def calcular_ranking(mes=None):
    """Ranking de embajadores de un mes (por amigos traídos) y total de puntos repartidos. Lo enseña la app a los socios."""
    ahora = int(time.time() * 1000)
    mes = mes or mes_de(ahora)
    por = {}
    for d in consulta("invitaciones", [("premiadoMes", "EQUAL", {"stringValue": mes})]):
        pts, ref = int(campo(d, "puntos", "integerValue") or 0), campo(d, "refUid")
        if pts > 0 and ref:
            x = por.setdefault(ref, {"amigos": 0, "puntos": 0, "ultimo": 0})
            x["amigos"] += 1
            x["puntos"] += pts
            x["ultimo"] = max(x["ultimo"], ms_de(campo(d, "premiadoEn", "timestampValue")) if campo(d, "premiadoEn", "timestampValue") else 0)
    fichas = leer_varios([f"users/{u}" for u in por] + [f"embajadores/{u}" for u in por]) if por else {}
    lista = []
    for u, x in por.items():
        if f"users/{u}" not in fichas:
            continue   # cuenta borrada: no sale en el ranking
        lista.append({"uid": u, "n": nombre_corto(campo(fichas.get(f"users/{u}", {}), "nombre") or ""), "amigos": x["amigos"], "puntos": x["puntos"],
                      "nivel": campo(fichas.get(f"embajadores/{u}", {}), "nivel") or "", "ultimo": x["ultimo"]})
    # más amigos primero; a igualdad, quien llegó antes a esa cifra
    lista.sort(key=lambda e: (-e["amigos"], e["ultimo"], e["n"]))
    lista = lista[:20]
    total_pts, total_amigos = sum(x["puntos"] for x in por.values()), sum(x["amigos"] for x in por.values())
    def mapa(e):
        return {"mapValue": {"fields": {"uid": valor(e["uid"]), "n": valor(e["n"]), "amigos": valor(e["amigos"]), "puntos": valor(e["puntos"]), "nivel": valor(e["nivel"])}}}
    escribir([{"update": {"name": f"{RAIZ}/embajadores_ranking/actual", "fields": {
        "mes": valor(mes), "lista": {"arrayValue": {"values": [mapa(e) for e in lista]}} if lista else {"arrayValue": {}},
        "totalPuntos": valor(total_pts), "totalAmigos": valor(total_amigos), "actualizado": valor({"ms": ahora})}}}])
    return lista


def cerrar_mes_embajadores():
    """Al empezar un mes nuevo, apunta al mejor embajador del mes anterior (con su premio) y le avisa."""
    rk = leer("embajadores_ranking/actual")
    mes_ant = campo(rk or {}, "mes")
    ahora = int(time.time() * 1000)
    if not mes_ant or mes_ant == mes_de(ahora):
        return
    lista = calcular_ranking(mes_ant)   # con los datos definitivos del mes que se cierra
    if lista and not leer(f"embajadores_ganadores/{mes_ant}"):
        g, premio = lista[0], ajustes_invitar()["premioMes"]
        escribir([{"update": {"name": f"{RAIZ}/embajadores_ganadores/{mes_ant}", "fields": {
            "mes": valor(mes_ant), "uid": valor(g["uid"]), "n": valor(g["n"]), "amigos": valor(g["amigos"]), "premio": valor(premio),
            "entregado": valor(False), "cerrado": valor({"ms": ahora})}}}])
        y, m = mes_ant.split("-")
        for t in tokens_de(g["uid"]):
            enviar(t, "🏆 ¡Mejor embajador del mes!", f"Has sido el embajador que más amigos ha traído en {MESES_LARGOS[int(m) - 1]}: {g['amigos']}."
                   + (f" Tu premio: {premio}. Pásate por la barra." if premio else " ¡Enhorabuena!"), "ganador-" + mes_ant, APP)
        print(f"Embajadores: ganador de {mes_ant}: {g['n']} ({g['amigos']} amigos)")
    calcular_ranking()


def revisar_invitados_nuevos(ultima):
    """Cuando alguien se registra con el enlace de un embajador: guarda su nombre corto (para que el embajador lo vea en su lista)
    y avisa al embajador al momento."""
    mayor = ultima
    cfg = None
    for d in consulta("invitaciones", [("creado", "GREATER_THAN", {"timestampValue": iso(ultima)})], "creado"):
        mayor = max(mayor, ms_de(campo(d, "creado", "timestampValue")) + 1)
        uid, num = id_de(d), int(campo(d, "ref", "integerValue") or 0)
        try:
            amigo = leer(f"users/{uid}")
            nombre = nombre_corto(campo(amigo, "nombre") if amigo else "")
            quien = consulta("users", [("socioNum", "EQUAL", {"integerValue": str(num)})]) if num else []
            cambios = {"nombre": nombre}
            if quien and id_de(quien[0]) != uid:
                cambios["refUid"] = id_de(quien[0])
                cambios["refNombre"] = nombre_corto(campo(quien[0], "nombre") or "")
            escribir([cambiar(f"invitaciones/{uid}", cambios)])
            if "refUid" in cambios:
                emb = leer(f"embajadores/{cambios['refUid']}")
                if emb and campo(emb, "activo", "booleanValue") is True:
                    cfg = cfg or ajustes_invitar()
                    for t in tokens_de(cambios["refUid"]):
                        enviar(t, "👋 Nuevo amigo registrado", f"{nombre} se ha registrado con tu enlace. Cuando venga al bar, te llevas {puntos_por_amigo(cfg)} puntos.", "registro-" + uid, APP)
            print("Embajadores: nuevo invitado registrado:", nombre)
        except Exception as e:
            print("Embajadores: no se ha podido avisar del invitado", uid, "-", e)
    return mayor


def rellenar_ref_nombres():
    """Invitaciones antiguas sin el nombre de quien invitó: se lo pone (lo enseña la tarjeta del invitado)."""
    writes = []
    for d in listar("invitaciones", ["refUid", "refNombre"]):
        if campo(d, "refUid") and not campo(d, "refNombre"):
            u = leer(f"users/{campo(d, 'refUid')}")
            if u:
                writes.append(cambiar(f"invitaciones/{id_de(d)}", {"refNombre": nombre_corto(campo(u, "nombre") or "")}))
    escribir(writes)


def recordar_invitados():
    """Una vez: si un invitado lleva una semana registrado y no ha venido, se lo recuerda a su embajador."""
    ahora = int(time.time() * 1000)
    for d in consulta("invitaciones", [("premiado", "EQUAL", {"booleanValue": False})]):
        if campo(d, "recordado", "booleanValue") or not campo(d, "refUid") or not campo(d, "creado", "timestampValue"):
            continue
        dias = (ahora - ms_de(campo(d, "creado", "timestampValue"))) / 864e5
        if dias < 7 or dias > 60:
            continue
        nombre = campo(d, "nombre") or "Tu amigo"
        for t in tokens_de(campo(d, "refUid")):
            enviar(t, "⏳ ¡Recuérdaselo!", f"{nombre} se registró con tu enlace hace una semana y aún no ha venido. Si viene, te llevas tus puntos.", "recuerdo-inv-" + id_de(d), APP)
        escribir([cambiar(f"invitaciones/{id_de(d)}", {"recordado": True})])


def anunciar_campana():
    """Cuando el administrador activa una campaña de puntos dobles, se avisa a todos los embajadores activos (una vez por campaña)."""
    cfg = ajustes_invitar()
    c = cfg["campana"]
    if not c or not c["id"] or not cfg["activo"]:
        return
    if campo(leer("avisos_estado/campana") or {}, "id") == c["id"]:
        return
    pts = puntos_por_amigo(cfg)
    for e in consulta("embajadores", [("activo", "EQUAL", {"booleanValue": True})]):
        for t in tokens_de(id_de(e)):
            enviar(t, f"🔥 ¡Puntos x{c['multiplicador']}!", f"Hasta el {fecha_corta(c['hasta'])}, cada amigo que traigas al bar vale {pts} puntos. ¡Comparte tu enlace!", "campana-" + c["id"], APP)
    escribir([{"update": {"name": f"{RAIZ}/avisos_estado/campana", "fields": {"id": valor(c["id"])}}}])
    print("Embajadores: campaña anunciada:", c)


# ---------------- cumpleaños de los socios ----------------
def ajustes_cumple():
    f = (leer("settings/cumple") or {}).get("fields", {})
    return {"activo": f.get("activo", {}).get("booleanValue") is True, "premio": f.get("premio", {}).get("stringValue", "").strip(),
            "dias": max(1, entero(f.get("dias"), 7))}


def regalos_cumple():
    """Cada jornada: a los socios que cumplen años hoy les crea su regalo de cumpleaños (uno por año) y les felicita."""
    cfg = ajustes_cumple()
    if not cfg["activo"] or not cfg["premio"]:
        return 0
    ahora = int(time.time() * 1000)
    hoy = local(ahora - 6 * 3600000)   # la jornada del bar empieza a las 6:00
    bisiesto = hoy.year % 4 == 0 and (hoy.year % 100 != 0 or hoy.year % 400 == 0)
    dias_hoy = {hoy.strftime("%m-%d")} | ({"02-29"} if hoy.strftime("%m-%d") == "02-28" and not bisiesto else set())
    cumplen = [(id_de(d), campo(d, "nacimiento")) for d in listar("perfil_extra", ["nacimiento"]) if (campo(d, "nacimiento") or "")[5:] in dias_hoy]
    if not cumplen:
        return 0
    fichas = leer_varios([f"users/{u}" for u, _ in cumplen])
    hechos = 0
    for uid, _ in cumplen:
        u = fichas.get(f"users/{uid}")
        if not u or campo(u, "socio", "booleanValue") is not True:
            continue
        cid = f"{uid}_cumple_{hoy.year}"
        if leer(f"cupones/{cid}"):
            continue
        codigo = "".join(random.choice("ABCDEFGHJKMNPQRSTUVWXYZ23456789") for _ in range(4))
        datos = {"uid": uid, "premioId": "cumple", "nombre": "🎂 " + cfg["premio"], "coste": 0, "estado": "pendiente", "codigo": codigo,
                 "creado": {"ms": ahora}, "caduca": {"ms": ahora + cfg["dias"] * 86400000}}
        escribir([{"update": {"name": f"{RAIZ}/cupones/{cid}", "fields": {k: valor(v) for k, v in datos.items()}}, "currentDocument": {"exists": False}}])
        nombre = (campo(u, "nombre") or "").split(" ")[0]
        for t in tokens_de(uid):
            enviar(t, "🎂 ¡Feliz cumpleaños" + (", " + nombre if nombre else "") + "!", f"Tu regalo de cumpleaños: {cfg['premio']}. Lo tienes en «Mis regalos»: enséñalo en la barra.", "cumple-" + cid, APP + "regalos.html")
        hechos += 1
    print(f"Cumpleaños: {hechos} regalo(s) creado(s)")
    return hechos


def tareas_diarias():
    """Una vez por jornada: regalos de cumpleaños, recordatorios de invitados, ranking de embajadores y ganador del mes."""
    ahora = int(time.time() * 1000)
    hoy = local(ahora - 6 * 3600000).strftime("%Y-%m-%d")
    if campo(leer("avisos_estado/diario") or {}, "dia") == hoy:
        return
    for nombre, tarea in (("cumpleaños", regalos_cumple), ("recordatorios de invitados", recordar_invitados), ("nombres de embajadores", rellenar_ref_nombres), ("mes de embajadores", cerrar_mes_embajadores), ("ranking", calcular_ranking)):
        try:
            tarea()
        except Exception as e:
            print(f"Error en la tarea diaria ({nombre}):", e)
    escribir([{"update": {"name": f"{RAIZ}/avisos_estado/diario", "fields": {"dia": valor(hoy)}}}])


# ---------------- tarjetas NFC de los camareros ----------------
def sun_leer(p_hex, c_hex):
    """Comprueba el código de una tarjeta NTAG 424 DNA. Devuelve (UID, contador) si es auténtico, o None."""
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    from cryptography.hazmat.primitives.cmac import CMAC
    try:
        p, c = bytes.fromhex(p_hex), bytes.fromhex(c_hex)
    except ValueError:
        return None
    if len(p) != 16 or len(c) != 8:
        return None
    dec = Cipher(algorithms.AES(K_META), modes.CBC(b"\0" * 16)).decryptor()
    d = dec.update(p) + dec.finalize()
    if d[0] != 0xC7:
        return None
    uid, ctr_b = d[1:8], d[8:11]
    m = CMAC(algorithms.AES(K_FILE)); m.update(bytes([0x3C, 0xC3, 0x00, 0x01, 0x00, 0x80]) + uid + ctr_b); ks = m.finalize()
    m = CMAC(algorithms.AES(ks)); m.update(b""); full = m.finalize()
    if bytes(full[i] for i in range(1, 16, 2)) != c:
        return None
    return uid.hex().upper(), int.from_bytes(ctr_b, "little")


def ajustes_nfc():
    d = leer("settings/nfc")
    f = (d or {}).get("fields", {})
    return {"horas": int(f.get("horas", {}).get("integerValue", 3))}


def revisar_tarjetas():
    """Altas de tarjetas nuevas, validaciones de consumición y canjes (ruleta y regalos) hechos con la tarjeta del camarero."""
    ahora = int(time.time() * 1000)
    for d in consulta("tarjetas_altas", [("estado", "EQUAL", {"stringValue": "pendiente"})]):
        r = sun_leer(campo(d, "p") or "", campo(d, "c") or "")
        if not r:
            escribir([cambiar(f"tarjetas_altas/{id_de(d)}", {"estado": "error", "motivo": "la tarjeta no es una NTAG 424 DNA bien programada"})])
            continue
        uid_t, ctr = r
        escribir([{"update": {"name": f"{RAIZ}/tarjetas/{uid_t}", "fields": {k: valor(v) for k, v in {
                       "camarero": campo(d, "camarero") or "", "nombre": campo(d, "camareroNombre") or "", "activa": True, "ultimoCtr": ctr, "usos": 0, "alta": {"ms": ahora}}.items()}}},
                   cambiar(f"tarjetas_altas/{id_de(d)}", {"estado": "hecha", "tarjeta": uid_t})])
        print("Tarjeta dada de alta:", uid_t, "para", campo(d, "camareroNombre"))
    pend = [("val", d) for d in consulta("validaciones", [("estado", "EQUAL", {"stringValue": "pendiente"})])]
    pend += [("rul", d) for d in consulta("ruleta_giros", [("canjeEstado", "EQUAL", {"stringValue": "pendiente"})])]
    pend += [("cup", d) for d in consulta("cupones", [("canjeEstado", "EQUAL", {"stringValue": "pendiente"})])]
    if not pend:
        return 0
    leidas = []
    for tipo, d in pend:
        p_, c_ = (campo(d, "p"), campo(d, "c")) if tipo == "val" else (campo(d, "canjeP"), campo(d, "canjeC"))
        leidas.append((tipo, d, sun_leer(p_ or "", c_ or "")))
    leidas.sort(key=lambda x: (x[2][0], x[2][1]) if x[2] else ("", -1))   # por tarjeta y por orden de uso
    tarjetas, validos, sospechosos = {}, [], []

    def marcar(tipo, d, estado, extra=None):
        if tipo == "val":
            escribir([cambiar(f"validaciones/{id_de(d)}", dict({"estado": estado}, **(extra or {})))])
        else:
            col = "ruleta_giros" if tipo == "rul" else "cupones"
            escribir([cambiar(f"{col}/{id_de(d)}", dict({"canjeEstado": "ok" if estado == "valida" else estado}, **(extra or {})))])
            if estado != "valida":
                sospechosos.append((tipo, campo(d, "uid") if tipo == "cup" else id_de(d), campo(d, "nombre") if tipo == "cup" else "", estado))

    for tipo, d, r in leidas:
        cli = campo(d, "uid") if tipo == "val" else id_de(d)
        if not r:
            marcar(tipo, d, "falsa"); continue
        uid_t, ctr = r
        if uid_t not in tarjetas:
            tarjetas[uid_t] = leer(f"tarjetas/{uid_t}")
        t = tarjetas[uid_t]
        if not t:
            marcar(tipo, d, "desconocida", {"tarjeta": uid_t} if tipo == "val" else {"canjeTarjeta": uid_t}); continue
        if campo(t, "activa", "booleanValue") is not True:
            marcar(tipo, d, "baja", {"tarjeta": uid_t} if tipo == "val" else {"canjeTarjeta": uid_t}); continue
        ultimo = int(campo(t, "ultimoCtr", "integerValue") or -1)
        if ctr <= ultimo:
            marcar(tipo, d, "repetida", {"tarjeta": uid_t} if tipo == "val" else {"canjeTarjeta": uid_t}); continue
        t["fields"]["ultimoCtr"] = {"integerValue": str(ctr)}
        cambios_t = {"ultimoCtr": ctr, "usos": int(campo(t, "usos", "integerValue") or 0) + 1, "ultimoUso": {"ms": ahora}}
        t["fields"]["usos"] = {"integerValue": str(cambios_t["usos"])}
        escribir([cambiar(f"tarjetas/{uid_t}", cambios_t)])
        if tipo in ("rul", "cup"):
            marcar(tipo, d, "valida", {"canjeTarjeta": uid_t, "canjeCamarero": campo(t, "camarero") or "", "canjeCamareroNombre": campo(t, "nombre") or ""})
            print("Ruleta: premio canjeado" if tipo == "rul" else "Regalo canjeado", "con la tarjeta de", campo(t, "nombre"))
            continue
        # el mismo cliente solo valida una vez por jornada (la jornada del bar acaba a las 6:00)
        jornada = lambda doc: local(ms_de(campo(doc, "creado", "timestampValue")) - 6 * 3600000).date()
        recientes = [x for x in consulta("validaciones", [("uid", "EQUAL", {"stringValue": cli}), ("estado", "EQUAL", {"stringValue": "valida"})])
                     if jornada(x) == jornada(d)]
        estado = "repetida_hoy" if recientes else "valida"
        marcar(tipo, d, estado, {"tarjeta": uid_t, "ctr": ctr, "camarero": campo(t, "camarero") or "", "camareroNombre": campo(t, "nombre") or ""})
        if estado == "valida":
            validos.append((cli, ms_de(campo(d, "creado", "timestampValue"))))
    premiar_invitados(validos)
    # canjes de la ruleta con un código de tarjeta que no vale: aviso a los administradores
    MOTIVOS = {"falsa": "código falso", "desconocida": "tarjeta no dada de alta", "baja": "tarjeta dada de baja", "repetida": "toque ya usado"}
    for tipo, uid, premio, estado in sospechosos:
        nombre = nombre_de("users", uid)
        if tipo == "rul":
            tit, txt, pag = "⚠ Canje de ruleta dudoso", f"{nombre} ha canjeado su premio con una tarjeta que no vale ({MOTIVOS.get(estado, estado)}).", "admin-ruleta.html"
        else:
            tit, txt, pag = "⚠ Canje de regalo dudoso", f"{nombre} ha canjeado su regalo «{premio}» con una tarjeta que no vale ({MOTIVOS.get(estado, estado)}).", "admin-premios.html"
        for admin in admins():
            for tk in tokens_de(admin):
                enviar(tk, tit, txt, tipo + "-" + uid, APP + pag)
        print("Canje dudoso de", nombre, "-", estado)
    print(f"Tarjetas: {len(pend)} toque(s) revisado(s), {len(validos)} validación(es) válida(s)")
    return len(validos)


def leer_marca(ruta, campo_nombre="ultimaMs"):
    d = leer(ruta)
    v = (d or {}).get("fields", {}).get(campo_nombre, {}).get("integerValue")
    return int(v) if v else None


# ---------------- limpieza diaria de cuentas borradas ----------------
def sin_borrados(v, borrados):
    f = v.get("mapValue", {}).get("fields", {})
    lista = [x for x in f.get("lista", {}).get("arrayValue", {}).get("values", []) if x.get("mapValue", {}).get("fields", {}).get("uid", {}).get("stringValue") not in borrados]
    f["lista"] = {"arrayValue": {"values": lista}} if lista else {"arrayValue": {}}
    return {"mapValue": {"fields": f}}


VERSION_LIMPIEZA = 2
# Colecciones cuyo documento se llama como la persona (uid) y colecciones que la guardan en el campo «uid».
POR_ID = ("trivial_puntos", "invitaciones", "perfil_extra", "embajadores", "embajadores_solicitudes", "socios_puntos",
          "ruleta_giros", "mis_equipos", "liga_vinculos", "liga_vinculos_pedidos", "cuentas")
POR_CAMPO = ("socios_mov", "cupones", "push_tokens", "validaciones", "trivial_aperturas", "reservations", "cupo_reservas")


def borrar_datos_de(uid, ahora):
    """Todas las escrituras para borrar lo que queda guardado de una cuenta que ya no existe."""
    writes = [{"delete": f"{RAIZ}/{col}/{uid}"} for col in POR_ID]
    for col in POR_CAMPO:
        for d in consulta(col, [("uid", "EQUAL", {"stringValue": uid})]):
            writes.append({"delete": d["name"]})
            if col == "trivial_aperturas":
                writes.append({"delete": f"{RAIZ}/trivial_resp/{id_de(d)}"})
            if col == "reservations":
                # sus huecos que aún no han pasado
                diana = campo(d, "dianaId") or ""
                ini, fin = ms_de(campo(d, "inicio", "timestampValue")), ms_de(campo(d, "fin", "timestampValue"))
                t = max(ini, ahora - ahora % 900000)
                rutas = []
                while t < fin:
                    rutas.append(f"slots/{diana}_{t}")
                    t += 900000
                for ruta, sl in leer_varios(rutas).items():
                    if campo(sl, "uid") == uid and campo(sl, "tipo") == "reserva":
                        writes.append({"delete": f"{RAIZ}/{ruta}"})
    for g in consulta("trivial_ganadores", [("uid", "EQUAL", {"stringValue": uid})]):
        writes.append(cambiar(f"trivial_ganadores/{id_de(g)}", {"uid": "", "n": "Cuenta borrada"}))
    return writes


def limpiar_cuentas_borradas():
    """Una vez por jornada: rellena las cuentas protegidas y borra TODOS los datos de las cuentas que ya no existen.
    Una cuenta solo se da por borrada si no tiene ficha y además ya no existe en Firebase Authentication
    (quien solo borra su ficha sigue teniendo cuenta: sus datos no se tocan)."""
    ahora = int(time.time() * 1000)
    hoy = local(ahora - 6 * 3600000).strftime("%Y-%m-%d")   # la jornada del bar acaba a las 6:00
    est = leer("avisos_estado/limpieza")
    version = int(campo(est or {}, "v", "integerValue") or 0)
    if campo(est or {}, "dia") == hoy and (version >= VERSION_LIMPIEZA or campo(est or {}, "error")):
        return 0   # ya se hizo hoy (o hoy no se pudo: se vuelve a intentar mañana)
    try:
        sincronizar_cuentas()
    except Exception as e:
        print("Error al rellenar las cuentas protegidas:", e)
    uids = {id_de(d) for col in POR_ID for d in listar(col, [])}
    if version < VERSION_LIMPIEZA:
        # la primera vez se repasa todo, para encontrar también restos antiguos
        for col in POR_CAMPO:
            uids |= {campo(d, "uid") for d in listar(col, ["uid"]) if campo(d, "uid")}
    uids.discard("liga")
    uids.discard("robot")
    existen = leer_varios([f"users/{u}" for u in sorted(uids)])
    sin_ficha = sorted(u for u in uids if f"users/{u}" not in existen)
    borrados = []
    if sin_ficha:
        control = next(iter(admins()), None)
        vivos = existen_en_auth(sin_ficha, control) if control else None
        if vivos is None:
            print("Limpieza diaria: no se ha podido comprobar qué cuentas existen en Firebase Authentication; hoy no se borra nada")
            escribir([{"update": {"name": f"{RAIZ}/avisos_estado/limpieza", "fields": {"dia": valor(hoy), "v": valor(version), "error": valor("sin acceso a Authentication")}}}])
            return 0
        borrados = [u for u in sin_ficha if u not in vivos]
    writes = []
    for uid in borrados:
        writes += borrar_datos_de(uid, ahora)
    if borrados:
        rk = leer("trivial_ranking/actual")
        if rk:
            f = rk.get("fields", {})
            for k in ("semana", "mes", "historico"):
                if k in f:
                    f[k] = sin_borrados(f[k], set(borrados))
            lib = f.get("libre", {}).get("mapValue", {}).get("fields")
            if lib:
                for k in ("semana", "mes", "historico"):
                    if k in lib:
                        lib[k] = sin_borrados(lib[k], set(borrados))
            writes.append({"update": {"name": f"{RAIZ}/trivial_ranking/actual", "fields": f}})
    writes.append({"update": {"name": f"{RAIZ}/avisos_estado/limpieza", "fields": {"dia": valor(hoy), "v": valor(VERSION_LIMPIEZA), "borradas": valor(len(borrados))}}})
    escribir(writes)
    print(f"Limpieza diaria: {len(borrados)} cuenta(s) borrada(s) con datos que quitar")
    return len(borrados)


def recordatorios():
    # Recordatorio a quien reservó: cuando faltan entre 5 y 65 minutos (una sola vez por reserva).
    # No se manda si la reserva se acaba de hacer (hace menos de 2 minutos).
    ahora = int(time.time() * 1000)
    docs = consulta("reservations", [("inicio", "GREATER_THAN_OR_EQUAL", {"timestampValue": iso(ahora + 5 * 60000)}),
                                     ("inicio", "LESS_THAN", {"timestampValue": iso(ahora + 65 * 60000)})])
    print(f"  recordatorios: {len(docs)} reserva(s) que empiezan en los próximos 5 a 65 minutos")
    for d in docs:
        if campo(d, "recordado", "booleanValue"):
            continue
        creado = campo(d, "creado", "timestampValue")
        if creado and ahora - ms_de(creado) < 2 * 60000:
            continue
        ini = ms_de(campo(d, "inicio", "timestampValue"))
        cuerpo = f"{nombre_de('dartboards', campo(d, 'dianaId'))} hoy a las {hora(ini)}"
        for t in tokens_de(campo(d, "uid")):
            enviar(t, "Tu reserva empieza pronto", cuerpo, "recuerdo-" + id_de(d))
        api("PATCH", f"{BASE}/reservations/{id_de(d)}?updateMask.fieldPaths=recordado&currentDocument.exists=true",
            json={"fields": {"recordado": {"booleanValue": True}}})
        print("Recordatorio enviado:", cuerpo)

# ---------------- horario del bar: con el bar cerrado se mira cada 5 minutos, para gastar menos lecturas ----------------
ESPERA_ABIERTO, ESPERA_CERRADO = 60, 300   # segundos entre revisiones
MARGEN_HORARIO = 30   # minutos: se mira cada minuto desde media hora antes de abrir hasta media hora después de cerrar


def de_valor(v):
    """Pasa un valor de Firestore (REST) a Python."""
    if "mapValue" in v:
        return {k: de_valor(x) for k, x in v["mapValue"].get("fields", {}).items()}
    if "arrayValue" in v:
        return [de_valor(x) for x in v["arrayValue"].get("values", [])]
    for t in ("stringValue", "integerValue", "doubleValue", "booleanValue", "timestampValue"):
        if t in v:
            return v[t]
    return None


def leer_horario():
    """Horario del bar («Reglas de reserva») y vísperas de festivo. (None, []) si no hay horario o no se puede leer."""
    try:
        h, v = leer("settings/horario"), leer("settings/visperas")
    except Exception as e:
        print("No se ha podido leer el horario del bar:", e)
        return None, []
    if not h:
        return None, []
    horario = {k: de_valor(x) for k, x in h.get("fields", {}).items()}
    fechas = de_valor((v or {}).get("fields", {}).get("fechas", {"nullValue": None}))
    return horario, fechas if isinstance(fechas, list) else []


def bar_abierto(ms, horario, visperas):
    """True si a esa hora el bar está abierto (con el margen a cada lado) o si no se sabe el horario.
    Igual que en la app: «dias» va de 0 (domingo) a 6, y si cierra a una hora menor que la de apertura es de madrugada."""
    if not horario or not isinstance(horario.get("dias"), (dict, list)):
        return True
    dias, ahora = horario["dias"], local(ms)
    minutos = lambda t: int(str(t).split(":")[0]) * 60 + int((str(t).split(":") + ["0"])[1] or 0)
    try:
        for atras in (1, 0):   # la madrugada es del día anterior
            d = (ahora - timedelta(days=atras)).date()
            sem = (d.weekday() + 1) % 7
            base = dias.get(str(sem)) if isinstance(dias, dict) else (dias[sem] if sem < len(dias) else None)
            if not isinstance(base, dict) or not base.get("abre") or not base.get("cierra"):
                continue   # ese día cierra
            abre = minutos(base["abre"])
            tarde = lambda t: minutos(t) + (1440 if minutos(t) <= abre else 0)
            cierra = tarde(base["cierra"])
            v = horario.get("vispera")
            if isinstance(v, dict) and v.get("cierra") and d.isoformat() in visperas:
                cierra = max(cierra, tarde(v["cierra"]))
            medianoche = datetime(d.year, d.month, d.day, tzinfo=MADRID)
            if medianoche + timedelta(minutes=abre - MARGEN_HORARIO) <= ahora <= medianoche + timedelta(minutes=cierra + MARGEN_HORARIO):
                return True
    except (ValueError, TypeError, AttributeError, IndexError) as e:
        print("El horario del bar tiene un formato raro; se mira cada minuto:", e)
        return True
    return False


# ---------------- avisos al administrador: solicitudes de capitanes, embajadores y vínculos de la liga ----------------
def dia_bonito(dia):
    """«2026-11-16» → «lun 16 nov»."""
    try:
        y, m, d = (int(x) for x in dia.split("-"))
        return fecha_bonita(int(datetime(y, m, d, 12).timestamp() * 1000))
    except Exception:
        return dia or "?"


def aviso_capitan(d):
    tipo = campo(d, "tipo")
    que = {"aplazar": "aplazar", "ida_vuelta": "cambiar ida por vuelta", "online": "jugar online desde Sweet Dreams"}.get(
        tipo, f"pasarlo al {dia_bonito(campo(d, 'diaNuevo'))} a las {campo(d, 'horaNueva')}")
    cuerpo = f"{campo(d, 'capitan') or 'Un capitán'} ({campo(d, 'equipoNombre')}) pide {que}: {campo(d, 'local')} – {campo(d, 'visitante')}. Toca para revisarla."
    return "🧢 Solicitud de capitán", cuerpo, "capitan-" + id_de(d), APP + "admin-solicitudes.html"


def aviso_embajador(d):
    cuerpo = f"{campo(d, 'nombre') or 'Un socio'} ({campo(d, 'facultad') or '?'}) quiere ser embajador. Toca para verlo."
    return "👑 Quiere ser embajador", cuerpo, "embajador-" + id_de(d), APP + "admin-embajadores.html"


def aviso_vinculo(d):
    cuerpo = f"{nombre_de('users', id_de(d))} dice que en la liga es «{campo(d, 'nombre')}». Toca para vincularlo."
    return "🔗 Pide su ficha de la liga", cuerpo, "vinculo-" + id_de(d), APP + "admin-jugadores.html"


VIGILAR = [("cambios_pedidos", "avisos_estado/capitanes", aviso_capitan),
           ("embajadores_solicitudes", "avisos_estado/embajadores", aviso_embajador),
           ("liga_vinculos_pedidos", "avisos_estado/vinculos", aviso_vinculo)]


def revisar_coleccion(coleccion, ultima, hacer):
    """Avisa a los administradores de cada documento nuevo de la colección (por su fecha «creado»)."""
    mayor = ultima
    for d in consulta(coleccion, [("creado", "GREATER_THAN", {"timestampValue": iso(ultima)})], "creado"):
        mayor = max(mayor, ms_de(campo(d, "creado", "timestampValue")) + 1)
        try:
            titulo, cuerpo, tag, url = hacer(d)
        except Exception as e:
            print("No se ha podido preparar el aviso:", coleccion, e)
            continue
        for admin in admins():
            for t in tokens_de(admin):
                enviar(t, titulo, cuerpo, tag, url)
        print(titulo + ":", cuerpo)
    return mayor
    
def main():
    t0 = time.time()
    ultima, ultima_u = leer_estado()
    if ultima is None or ultima_u is None:
        # la primera vez se empieza desde ahora, para no mandar avisos de reservas o usuarios antiguos
        ahora = int(time.time() * 1000)
        ultima = ultima if ultima is not None else ahora
        ultima_u = ultima_u if ultima_u is not None else ahora
        guardar_estado(ultima, ultima_u)
        print("Estado inicial creado")
    ultima_inv = leer_marca("avisos_estado/invitaciones")
    if ultima_inv is None:
        ultima_inv = int(time.time() * 1000)
        escribir([{"update": {"name": f"{RAIZ}/avisos_estado/invitaciones", "fields": {"ultimaMs": valor(ultima_inv)}}}])
    marcas = {}
    for col, ruta, _ in VIGILAR:
        m = leer_marca(ruta)
        if m is None:   # la primera vez se empieza desde ahora, para no avisar de cosas antiguas
            m = int(time.time() * 1000)
            escribir([{"update": {"name": f"{RAIZ}/{ruta}", "fields": {"ultimaMs": valor(m)}}}])
        marcas[col] = m
    try:
        limpiar_cuentas_borradas()
    except Exception as e:
        print("Error en la limpieza diaria:", e)
    try:
        tareas_diarias()
    except Exception as e:
        print("Error en las tareas diarias:", e)
    ultima_reg = leer_marca("avisos_estado/invitados")
    if ultima_reg is None:   # la primera vez se empieza desde ahora
        ultima_reg = int(time.time() * 1000)
        escribir([{"update": {"name": f"{RAIZ}/avisos_estado/invitados", "fields": {"ultimaMs": valor(ultima_reg)}}}])
    horario, visperas = leer_horario()
    if not horario:
        print("Sin horario del bar: se mira cada minuto")
    abierto_antes = None
    while True:
        print(local(int(time.time() * 1000)).strftime("%H:%M"), "revisando reservas, usuarios nuevos e invitaciones…")
        try:
            nueva = revisar_nuevas(ultima)
            nueva_u = revisar_usuarios(ultima_u)
            if nueva != ultima or nueva_u != ultima_u:
                ultima, ultima_u = nueva, nueva_u
                guardar_estado(ultima, ultima_u)
            recordatorios()
            revisar_tarjetas()
            for col, ruta, hacer in VIGILAR:
                try:
                    nueva_m = revisar_coleccion(col, marcas[col], hacer)
                    if nueva_m != marcas[col]:
                        marcas[col] = nueva_m
                        escribir([{"update": {"name": f"{RAIZ}/{ruta}", "fields": {"ultimaMs": valor(nueva_m)}}}])
                except Exception as e:
                    print("Error revisando", col + ":", e)
            try:
                nueva_reg = revisar_invitados_nuevos(ultima_reg)
                if nueva_reg != ultima_reg:
                    ultima_reg = nueva_reg
                    escribir([{"update": {"name": f"{RAIZ}/avisos_estado/invitados", "fields": {"ultimaMs": valor(ultima_reg)}}}])
                anunciar_campana()
            except Exception as e:
                print("Error revisando embajadores:", e)
            nueva_inv = revisar_invitaciones(ultima_inv)
            if nueva_inv != ultima_inv:
                ultima_inv = nueva_inv
                escribir([{"update": {"name": f"{RAIZ}/avisos_estado/invitaciones", "fields": {"ultimaMs": valor(ultima_inv)}}}])
        except Exception as e:
            print("Error en la revisión:", e)
        abierto = bar_abierto(int(time.time() * 1000), horario, visperas)
        if abierto != abierto_antes:
            print("Bar abierto: se mira cada minuto" if abierto else "Bar cerrado: se mira cada 5 minutos")
            abierto_antes = abierto
        espera = ESPERA_ABIERTO if abierto else ESPERA_CERRADO
        if time.time() - t0 + espera > DURACION:
            break
        time.sleep(espera)
    print("Fin de la ejecución")


if __name__ == "__main__":
    main()
