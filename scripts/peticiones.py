# Atiende la petición "Buscar clasificaciones ahora" que el administrador deja en su panel.
# Se ejecuta cada pocos minutos: si no hay petición pendiente, termina enseguida sin hacer nada.
import json, os, sys
from datetime import datetime, timezone
import requests
import google.auth.transport.requests
from google.oauth2 import service_account
import leer_pdfs

CUENTA = json.loads(os.environ["FCM_SERVICE_ACCOUNT"])
URL = f"https://firestore.googleapis.com/v1/projects/{CUENTA['project_id']}/databases/(default)/documents/liga_config/peticion"
cred = service_account.Credentials.from_service_account_info(CUENTA, scopes=["https://www.googleapis.com/auth/cloud-platform"])


def cabecera():
    if not cred.valid:
        cred.refresh(google.auth.transport.requests.Request())
    return {"Authorization": "Bearer " + cred.token}


def leer():
    r = requests.get(URL, headers=cabecera(), timeout=30)
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.json().get("fields", {})


def poner(estado, resultado=None):
    campos = {"estado": {"stringValue": estado}}
    mascara = ["estado"]
    if resultado is not None:
        campos["resultado"] = {"stringValue": resultado[:500]}
        mascara.append("resultado")
    if estado in ("hecho", "error"):
        campos["fin"] = {"timestampValue": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
        mascara.append("fin")
    r = requests.patch(URL, headers=cabecera(), params=[("updateMask.fieldPaths", m) for m in mascara], json={"fields": campos}, timeout=30)
    r.raise_for_status()


# <logica>
def resumen(pdfs):
    """Texto corto con lo que se ha encontrado, para enseñarlo en el panel."""
    if not pdfs:
        return "Todavía no hay ninguna clasificación publicada en la web de la liga."
    grupos = {"parejas": [], "equipos": []}
    for clave in pdfs:
        cat, n = clave.rsplit("-", 1)
        grupos.setdefault(cat, []).append(int(n))
    partes = []
    for cat, nombre in (("parejas", "parejas"), ("equipos", "equipos presencial")):
        if grupos.get(cat):
            partes.append(nombre + " " + ", ".join("nivel " + str(n) for n in sorted(grupos[cat])))
    return "Encontradas " + str(len(pdfs)) + " clasificaciones: " + "; ".join(partes) + "."
# </logica>


def main():
    campos = leer()
    if not campos or campos.get("estado", {}).get("stringValue") != "pendiente":
        print("Sin peticiones pendientes.")
        return
    print("Petición pendiente: empiezo a buscar las clasificaciones.")
    poner("en_curso")
    try:
        pdfs = leer_pdfs.descubrir()
        leer_pdfs.guardar(pdfs)
        texto = resumen(pdfs)
        poner("hecho", texto)
        print(texto)
    except BaseException as e:
        poner("error", "No se ha podido completar: " + str(e))
        print("Error:", e)
        if isinstance(e, KeyboardInterrupt):
            raise


if __name__ == "__main__":
    main()
