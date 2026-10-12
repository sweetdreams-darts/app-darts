# Busca los PDF de clasificación publicados en bullshootervalladolid.com y guarda sus direcciones en Firestore (liga_config/pdfs).
# Así la app puede ofrecer el botón de descarga de cada clasificación, siempre con la última versión.
import json, os, re, sys, time
from datetime import datetime, timezone
from urllib.parse import unquote, urljoin
import requests
import google.auth.transport.requests
from google.oauth2 import service_account

WEB = "https://www.bullshootervalladolid.com"
PAGINAS = [("parejas", n, f"{WEB}/liga-parejas/clasificacion/nivel-{n}/") for n in range(1, 21)] + \
          [("equipos", n, f"{WEB}/liga-de-equipos/clasificacion/nivel-{n}/") for n in (1, 2)]
UA = {"User-Agent": "Mozilla/5.0 (lector liga Sweet Dreams)"}
PRUEBA = os.environ.get("PRUEBA", "false").lower() == "true"


def buscar_pdf(html, base):
    """Devuelve la dirección completa del primer PDF que encuentre en la página, o None."""
    plano = unquote(html)
    patrones = [
        r"file=([^\"'&\s<>]+\.pdf)",
        r"(?:href|src|data-src|data-pdf|data-url)\s*=\s*[\"']([^\"']+\.pdf)",
        r"[\"'](https?://[^\"'\s<>]+\.pdf)[\"']",
    ]
    for p in patrones:
        m = re.search(p, plano, re.I) or re.search(p, html, re.I)
        if m:
            return urljoin(base, m.group(1).strip())
    return None


def pedir(url, metodo="GET"):
    time.sleep(1)
    try:
        return requests.request(metodo, url, headers=UA, timeout=60, allow_redirects=True)
    except Exception as e:
        print("  error de red:", e)
        return None


def descubrir():
    res = {}
    for cat, n, url in PAGINAS:
        pag = pedir(url)
        if not pag or pag.status_code != 200:
            continue
        pdf = buscar_pdf(pag.text, url)
        if not pdf:
            print(f"{cat} nivel {n}: la página existe pero no encuentro ningún PDF (longitud {len(pag.text)})")
            continue
        info = pedir(pdf, "HEAD")
        ok = bool(info) and info.status_code == 200
        res[f"{cat}-{n}"] = {"url": pdf, "ok": ok, "fecha": (info.headers.get("Last-Modified", "") if ok else ""), "bytes": int(info.headers.get("Content-Length", "0") or 0) if ok else 0}
        print(f"{cat} nivel {n}: {pdf} {'(responde)' if ok else '(NO responde)'}")
    return res


def valor(x):
    if isinstance(x, bool): return {"booleanValue": x}
    if isinstance(x, int): return {"integerValue": str(x)}
    if isinstance(x, dict): return {"mapValue": {"fields": {k: valor(v) for k, v in x.items()}}}
    return {"stringValue": str(x)}


def guardar(pdfs):
    cuenta = json.loads(os.environ["FCM_SERVICE_ACCOUNT"])
    cred = service_account.Credentials.from_service_account_info(cuenta, scopes=["https://www.googleapis.com/auth/cloud-platform"])
    cred.refresh(google.auth.transport.requests.Request())
    url = f"https://firestore.googleapis.com/v1/projects/{cuenta['project_id']}/databases/(default)/documents/liga_config/pdfs"
    cuerpo = {"fields": {"pdfs": valor(pdfs), "revisado": valor(datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"))}}
    r = requests.patch(url, headers={"Authorization": "Bearer " + cred.token}, json=cuerpo, timeout=30)
    if r.status_code != 200:
        sys.exit(f"Error al guardar: {r.status_code} {r.text[:300]}")
    print("Guardados", len(pdfs), "PDF en liga_config/pdfs")


def main():
    pdfs = descubrir()
    print(f"\nEncontrados: {len(pdfs)}")
    if PRUEBA:
        print("Modo prueba: no se guarda nada.")
        return
    guardar(pdfs)
    try:
        import leer_clasif
        print(leer_clasif.procesar(pdfs))
    except Exception as e:
        print("No se han podido leer las estadísticas:", e)


if __name__ == "__main__":
    main()
