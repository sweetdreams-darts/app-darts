# Avisos push: revisa reservas nuevas y recordatorios, y envía notificaciones con Firebase Cloud Messaging.
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


def enviar(token, titulo, cuerpo, tag):
    msg = {"message": {"token": token, "data": {"title": titulo, "body": cuerpo, "url": APP, "tag": tag},
                       "webpush": {"headers": {"Urgency": "high", "TTL": "3600"}}}}
    r = api("POST", f"https://fcm.googleapis.com/v1/projects/{PROYECTO}/messages:send", json=msg)
    if r.status_code != 200 and ("UNREGISTERED" in r.text or "not a valid FCM registration token" in r.text):
        api("DELETE", f"{BASE}/push_tokens/{token}")
        print("Token caducado: borrado")
    elif r.status_code != 200:
        print("Error al enviar:", r.status_code, r.text[:200])
    return r.status_code == 200


def leer_estado():
    r = api("GET", f"{BASE}/avisos_estado/revision")
    return int(r.json()["fields"]["ultimaMs"]["integerValue"]) if r.status_code == 200 else None


def guardar_estado(ms):
    api("PATCH", f"{BASE}/avisos_estado/revision?updateMask.fieldPaths=ultimaMs", json={"fields": {"ultimaMs": {"integerValue": str(ms)}}})


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
    ultima = leer_estado()
    if ultima is None:
        ultima = int(time.time() * 1000)
        guardar_estado(ultima)
        print("Estado inicial creado")
    while True:
        print(local(int(time.time() * 1000)).strftime("%H:%M"), "revisando reservas…")
        try:
            nueva = revisar_nuevas(ultima)
            if nueva != ultima:
                ultima = nueva
                guardar_estado(ultima)
            recordatorios()
        except Exception as e:
            print("Error en la revisión:", e)
        if time.time() - t0 + 60 > DURACION:
            break
        time.sleep(60)
    print("Fin de la ejecución")


if __name__ == "__main__":
    main()
