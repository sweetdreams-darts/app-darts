# Junta todos los partidos de la liga en un único documento pequeño (liga_config/calendario).
# Así la pantalla de inicio puede enseñar "tu próximo partido" leyendo solo 1 documento.
import json, os, sys
from datetime import datetime, timezone
import requests
import google.auth.transport.requests
from google.oauth2 import service_account

CUENTA = json.loads(os.environ["FCM_SERVICE_ACCOUNT"])
PROYECTO = CUENTA["project_id"]
BASE = f"https://firestore.googleapis.com/v1/projects/{PROYECTO}/databases/(default)/documents"
PRUEBA = os.environ.get("PRUEBA", "false").lower() == "true"
cred = service_account.Credentials.from_service_account_info(CUENTA, scopes=["https://www.googleapis.com/auth/cloud-platform"])


def cabecera():
    if not cred.valid:
        cred.refresh(google.auth.transport.requests.Request())
    return {"Authorization": "Bearer " + cred.token}


def valor(c, k, tipo="stringValue", defecto=""):
    return c.get("fields", {}).get(k, {}).get(tipo, defecto)


def listar(coleccion):
    docs, token = [], None
    while True:
        params = {"pageSize": 300}
        if token:
            params["pageToken"] = token
        r = requests.get(f"{BASE}/{coleccion}", headers=cabecera(), params=params, timeout=60)
        r.raise_for_status()
        j = r.json()
        docs += j.get("documents", [])
        token = j.get("nextPageToken")
        if not token:
            return docs


# <logica>
def compactar(partidos, locales):
    """partidos: documentos de liga_partidos. Devuelve el texto JSON con la última temporada de cada nivel."""
    filas = []
    for d in partidos:
        filas.append({
            "id": d["name"].rsplit("/", 1)[1],
            "cat": valor(d, "categoria"),
            "niv": int(valor(d, "nivel", "integerValue", 0)),
            "jor": int(valor(d, "jornada", "integerValue", 0)),
            "dia": valor(d, "dia"), "hora": valor(d, "hora"),
            "loc": valor(d, "local"), "vis": valor(d, "visitante"),
            "sede": valor(d, "sede"), "nota": valor(d, "nota"),
            "temp": valor(d, "temporada"),
        })
    ultima = {}
    for f in filas:
        k = (f["cat"], f["niv"])
        if f["dia"] and (k not in ultima or f["dia"] > ultima[k][0]):
            ultima[k] = (f["dia"], f["temp"])
    p = []
    for f in sorted(filas, key=lambda f: (f["dia"], f["hora"], f["cat"], f["niv"])):
        k = (f["cat"], f["niv"])
        if k not in ultima or f["temp"] != ultima[k][1] or not f["dia"] or not f["loc"] or not f["vis"]:
            continue
        fila = [f["id"], "p" if f["cat"] == "parejas" else "e", f["niv"], f["jor"], f["dia"], f["hora"], f["loc"], f["vis"], f["sede"]]
        if f["nota"]:
            fila.append(f["nota"])
        p.append(fila)
    l = {}
    for d in locales:
        nombre = valor(d, "nombre")
        if nombre:
            l[nombre] = [valor(d, "direccion"), valor(d, "ciudad"), valor(d, "mapsManual") or valor(d, "mapsAuto")]
    return json.dumps({"p": p, "l": l}, ensure_ascii=False, separators=(",", ":"))
# </logica>


def main():
    partidos = listar("liga_partidos")
    locales = listar("liga_locales")
    datos = compactar(partidos, locales)
    n = json.loads(datos)["p"]
    print(f"Partidos leídos: {len(partidos)} · en el resumen: {len(n)} · tamaño: {len(datos.encode('utf-8'))} bytes")
    if len(datos.encode("utf-8")) > 900000:
        sys.exit("El resumen es demasiado grande")
    if PRUEBA:
        print("Modo prueba: no se guarda nada.")
        return
    cuerpo = {"fields": {"datos": {"stringValue": datos}, "generado": {"stringValue": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")}, "partidos": {"integerValue": str(len(n))}}}
    r = requests.patch(f"{BASE}/liga_config/calendario", headers=cabecera(), json=cuerpo, timeout=60)
    if r.status_code != 200:
        sys.exit(f"Error al guardar: {r.status_code} {r.text[:300]}")
    print("Guardado liga_config/calendario")


if __name__ == "__main__":
    main()
