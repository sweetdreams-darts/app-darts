# Avisos push: revisa reservas nuevas, usuarios nuevos y recordatorios, y envía notificaciones con Firebase Cloud Messaging.
# También comprueba las tarjetas NFC de los camareros, da los puntos a los embajadores cuando viene un amigo suyo
# y, una vez por jornada, borra los datos de las cuentas borradas.
import json, os, re, time
from datetime import datetime, timezone
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
    CUENTA, scopes=["https://www.googleapis.com/auth/cloud-platform", "https://www.googleapis.com/auth/firebase.messaging"])
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
        nombre = (campo(d, "nombre") or "").strip() or "Sin nombre"
        cuerpo = f"{nombre} se ha registrado ({fecha_bonita(alta)}, {hora(alta)}). Toca para verlo."
        for admin in admins():
            if admin != uid:
                for t in tokens_de(admin):
                    enviar(t, "👤 Nuevo usuario", cuerpo, "usuario-" + uid, APP + "admin-nuevos.html")
        print("Usuario nuevo:", nombre)
    return mayor


# ---------------- utilidades para leer y escribir varios documentos ----------------
def leer(ruta):
    r = api("GET", f"{BASE}/{ruta}")
    return r.json() if r.status_code == 200 else None


def listar(coleccion):
    r = api("POST", f"{BASE}:runQuery", json={"structuredQuery": {"from": [{"collectionId": coleccion}]}})
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
def ajustes_invitar():
    cfg = {"activo": True, "puntos": 100, "maxMes": 0, "minimo": 4.5}
    d = leer("settings/invitaciones")
    f = (d or {}).get("fields", {})
    if "activo" in f: cfg["activo"] = f["activo"].get("booleanValue", True)
    if "puntos" in f: cfg["puntos"] = int(f["puntos"].get("integerValue", 100))
    if "maxMes" in f: cfg["maxMes"] = int(f["maxMes"].get("integerValue", 0))
    if "minimo" in f: cfg["minimo"] = float(f["minimo"].get("doubleValue", f["minimo"].get("integerValue", 4.5)))
    return cfg


def revisar_invitaciones(ultima):
    """Cuando un amigo invitado viene al bar (compra con puntos o canje en la caja), premia al embajador que le invitó."""
    # solo movimientos de hace más de 2 minutos: así no se escapa ninguna compra que tarde unos segundos en guardarse
    hasta = int(time.time() * 1000) - 120000
    if hasta <= ultima:
        return ultima
    mayor, uids, minimo = ultima, [], None
    for d in consulta("socios_mov", [("creado", "GREATER_THAN", {"timestampValue": iso(ultima)}), ("creado", "LESS_THAN_OR_EQUAL", {"timestampValue": iso(hasta)})], "creado"):
        mayor = max(mayor, ms_de(campo(d, "creado", "timestampValue")) + 1)
        u = campo(d, "uid")
        if campo(d, "tipo") != "compra" or not u or u in uids:
            continue   # canjear un cupón (aunque sea el regalo gratis) no cuenta
        if minimo is None:
            minimo = ajustes_invitar()["minimo"]
        importe = float(campo(d, "importe", "doubleValue") or campo(d, "importe", "integerValue") or 0)
        if importe + 1e-9 >= minimo:
            uids.append(u)
    premiar_invitados(uids)
    return mayor


def premiar_invitados(uids):
    """Para cada persona que acaba de venir al bar: si la invitó un embajador activo y aún no se le premió, le da sus puntos."""
    if not uids:
        return
    invs = leer_varios([f"invitaciones/{u}" for u in uids])
    pendientes = [u for u in uids if f"invitaciones/{u}" in invs and campo(invs[f"invitaciones/{u}"], "premiado", "booleanValue") is not True]
    if not pendientes:
        return
    cfg = ajustes_invitar()
    if not cfg["activo"]:
        return
    ahora = int(time.time() * 1000)
    mes = mes_de(ahora)
    for uid in pendientes:
        num = int(invs[f"invitaciones/{uid}"]["fields"]["ref"]["integerValue"])
        quien = consulta("users", [("socioNum", "EQUAL", {"integerValue": str(num)})])
        amigo = leer(f"users/{uid}")
        nombre = nombre_corto(campo(amigo, "nombre") if amigo else "")
        if not quien or id_de(quien[0]) == uid:
            escribir([cambiar(f"invitaciones/{uid}", {"premiado": True, "puntos": 0, "motivo": "no hay socio con ese número", "premiadoEn": {"ms": ahora}, "premiadoMes": mes})])
            continue
        socio = id_de(quien[0])
        emb = leer(f"embajadores/{socio}")
        if not emb or campo(emb, "activo", "booleanValue") is not True:
            escribir([cambiar(f"invitaciones/{uid}", {"premiado": True, "puntos": 0, "motivo": "quien invitó no es embajador activo", "refUid": socio, "premiadoEn": {"ms": ahora}, "premiadoMes": mes})])
            print("Invitación de alguien que no es embajador activo: sin puntos (socio", num, ")")
            continue
        if cfg["maxMes"]:
            ya = consulta("invitaciones", [("refUid", "EQUAL", {"stringValue": socio}), ("premiadoMes", "EQUAL", {"stringValue": mes})])
            if sum(1 for d in ya if int(campo(d, "puntos", "integerValue") or 0) > 0) >= cfg["maxMes"]:
                escribir([cambiar(f"invitaciones/{uid}", {"premiado": True, "puntos": 0, "motivo": "tope del mes", "refUid": socio, "premiadoEn": {"ms": ahora}, "premiadoMes": mes})])
                print("Embajadores: tope del mes para el socio", num)
                continue
        pts = cfg["puntos"]
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
            enviar(t, "🎉 Tu amigo ha venido", f"{nombre} ha venido a Sweet Dreams: +{pts} puntos para ti.", "invitar-" + uid, APP + "mis-puntos.html")
        print(f"Embajadores: +{pts} puntos para el socio {num} por {nombre}")


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
    """Altas de tarjetas nuevas, validaciones de consumición y canjes de la ruleta hechos con la tarjeta del camarero."""
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
            escribir([cambiar(f"ruleta_giros/{id_de(d)}", dict({"canjeEstado": "ok" if estado == "valida" else estado}, **(extra or {})))])
            if estado != "valida":
                sospechosos.append((id_de(d), estado))

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
        if tipo == "rul":
            marcar(tipo, d, "valida", {"canjeTarjeta": uid_t, "canjeCamarero": campo(t, "camarero") or "", "canjeCamareroNombre": campo(t, "nombre") or ""})
            print("Ruleta: premio canjeado con la tarjeta de", campo(t, "nombre"))
            continue
        # el mismo cliente solo valida una vez por jornada (la jornada del bar acaba a las 6:00)
        jornada = lambda doc: local(ms_de(campo(doc, "creado", "timestampValue")) - 6 * 3600000).date()
        recientes = [x for x in consulta("validaciones", [("uid", "EQUAL", {"stringValue": cli}), ("estado", "EQUAL", {"stringValue": "valida"})])
                     if jornada(x) == jornada(d)]
        estado = "repetida_hoy" if recientes else "valida"
        marcar(tipo, d, estado, {"tarjeta": uid_t, "ctr": ctr, "camarero": campo(t, "camarero") or "", "camareroNombre": campo(t, "nombre") or ""})
        if estado == "valida" and cli not in validos:
            validos.append(cli)
    premiar_invitados(validos)
    # canjes de la ruleta con un código de tarjeta que no vale: aviso a los administradores
    MOTIVOS = {"falsa": "código falso", "desconocida": "tarjeta no dada de alta", "baja": "tarjeta dada de baja", "repetida": "toque ya usado"}
    for uid, estado in sospechosos:
        nombre = nombre_de("users", uid)
        for admin in admins():
            for tk in tokens_de(admin):
                enviar(tk, "⚠ Canje de ruleta dudoso", f"{nombre} ha canjeado su premio con una tarjeta que no vale ({MOTIVOS.get(estado, estado)}).", "ruleta-" + uid, APP + "admin-ruleta.html")
        print("Ruleta: canje dudoso de", nombre, "-", estado)
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


def limpiar_cuentas_borradas():
    """Una vez por jornada: borra el trivial, la invitación, el perfil y los datos de embajador de las cuentas que ya no existen."""
    ahora = int(time.time() * 1000)
    hoy = local(ahora - 6 * 3600000).strftime("%Y-%m-%d")   # la jornada del bar acaba a las 6:00
    est = leer("avisos_estado/limpieza")
    if campo(est or {}, "dia") == hoy:
        return 0
    COLS = ("trivial_puntos", "invitaciones", "perfil_extra", "embajadores", "embajadores_solicitudes")
    uids = sorted({id_de(d) for col in COLS for d in listar(col)})
    existen = leer_varios([f"users/{u}" for u in uids])
    borrados = [u for u in uids if f"users/{u}" not in existen]
    writes = []
    for uid in borrados:
        for v in consulta("validaciones", [("uid", "EQUAL", {"stringValue": uid})]):
            writes.append({"delete": f"{RAIZ}/validaciones/{id_de(v)}"})
        for a in consulta("trivial_aperturas", [("uid", "EQUAL", {"stringValue": uid})]):
            writes += [{"delete": f"{RAIZ}/trivial_aperturas/{id_de(a)}"}, {"delete": f"{RAIZ}/trivial_resp/{id_de(a)}"}]
        writes += [{"delete": f"{RAIZ}/{col}/{uid}"} for col in COLS]
        for g in consulta("trivial_ganadores", [("uid", "EQUAL", {"stringValue": uid})]):
            writes.append(cambiar(f"trivial_ganadores/{id_de(g)}", {"uid": "", "n": "Cuenta borrada"}))
    if borrados:
        rk = leer("trivial_ranking/actual")
        if rk:
            f = rk.get("fields", {})
            for k in ("semana", "mes", "historico"):
                if k in f:
                    f[k] = sin_borrados(f[k], set(borrados))
            writes.append({"update": {"name": f"{RAIZ}/trivial_ranking/actual", "fields": f}})
    writes.append({"update": {"name": f"{RAIZ}/avisos_estado/limpieza", "fields": {"dia": valor(hoy), "borradas": valor(len(borrados))}}})
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
    try:
        limpiar_cuentas_borradas()
    except Exception as e:
        print("Error en la limpieza diaria:", e)
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
            nueva_inv = revisar_invitaciones(ultima_inv)
            if nueva_inv != ultima_inv:
                ultima_inv = nueva_inv
                escribir([{"update": {"name": f"{RAIZ}/avisos_estado/invitaciones", "fields": {"ultimaMs": valor(ultima_inv)}}}])
        except Exception as e:
            print("Error en la revisión:", e)
        if time.time() - t0 + 60 > DURACION:
            break
        time.sleep(60)
    print("Fin de la ejecución")


if __name__ == "__main__":
    main()
