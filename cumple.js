// Cumpleaños de los socios: cada socio pone una vez su fecha de nacimiento real y, el día de su cumpleaños,
// el robot de avisos le crea un regalo gratis («Mis regalos») y le felicita. El regalo se cambia en «Puntos y premios»
// (settings/cumple) y todos los textos se actualizan solos.
import { doc, getDoc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";

// <logica>
const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
export const fechaBonita = (iso) => (iso ? Number(iso.slice(8, 10)) + " de " + MESES[Number(iso.slice(5, 7)) - 1] : "");
export function ajustesCumple(d) {
  return { activo: !!(d && d.activo === true), premio: d && typeof d.premio === "string" ? d.premio.trim() : "", dias: d && Number(d.dias) >= 1 ? Number(d.dias) : 7 };
}
// El mensaje que ve el socio: se escribe solo con el regalo que pongas en el panel.
export const textoCumple = (premio) => "El día de tu cumpleaños te regalamos " + premio + ". 🎂";
// ¿Es una fecha de nacimiento válida? (real, de alguien de entre 14 y 100 años)
export function nacimientoValido(iso, ahora) {
  if (!/^(19|20)\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(iso || "")) return false;
  const [y, m, d] = iso.split("-").map(Number), f = new Date(y, m - 1, d);
  if (f.getFullYear() !== y || f.getMonth() !== m - 1 || f.getDate() !== d) return false;
  const hoy = new Date(ahora || Date.now()), edad = hoy.getFullYear() - y - (hoy.getMonth() + 1 < m || (hoy.getMonth() + 1 === m && hoy.getDate() < d) ? 1 : 0);
  return edad >= 14 && edad <= 100;
}
// Días que faltan para el próximo cumpleaños (0 = hoy). La jornada del bar acaba a las 6:00. El 29 de febrero se celebra el 28 los años no bisiestos.
export function diasParaCumple(iso, ahora) {
  const a = new Date((ahora || Date.now()) - 6 * 3600000), hoy = new Date(a.getFullYear(), a.getMonth(), a.getDate());
  const [, m, d] = iso.split("-").map(Number);
  const dia = (y) => { const bis = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0); return new Date(y, m - 1, m === 2 && d === 29 && !bis ? 28 : d); };
  let c = dia(hoy.getFullYear());
  if (c < hoy) c = dia(hoy.getFullYear() + 1);
  return Math.round((c - hoy) / 864e5);
}
// </logica>

function estilos() {
  if (document.getElementById("estiloCumple")) return;
  const st = document.createElement("style");
  st.id = "estiloCumple";
  st.textContent = ".cumple{margin:0 0 12px;padding:14px;border-radius:18px;border:1.5px solid rgba(255,123,232,.8);background:linear-gradient(150deg,rgba(255,43,214,.18),rgba(255,225,77,.12));box-shadow:0 0 18px rgba(255,43,214,.22);color:#fff}" +
    ".cumple .c-tit{font-family:'Bungee','Rubik',sans-serif;font-size:.95rem;color:#ff9be9;margin:0 0 6px}.cumple p{margin:6px 0;font-size:.9rem}.cumple .c-reg{color:#ffe14d;font-weight:800}" +
    ".cumple input{width:100%;padding:11px;border-radius:12px;border:1.5px solid rgba(255,255,255,.3);background:#150d27;color:#fff;font-size:1rem;margin-top:6px;box-sizing:border-box}" +
    ".cumple button,.cumple a.c-btn{display:block;width:100%;margin-top:10px;padding:12px;border:0!important;border-radius:12px!important;font-weight:800;font-size:.95rem;text-align:center;text-decoration:none;color:#0a0612!important;background:linear-gradient(135deg,#ffe14d,#ff7be8)!important;cursor:pointer}" +
    ".cumple small{display:block;opacity:.8;margin-top:6px}";
  document.head.appendChild(st);
}

// Inicio (solo socios): pedir la fecha si no la tiene, felicitar el día del cumpleaños y avisar cuando se acerca.
export async function montarCumple(db, user, ficha) {
  const tiles = document.querySelector(".tiles");
  let caja = document.getElementById("cumpleCaja");
  try {
    if (!tiles || !user || !ficha || ficha.socio !== true) { if (caja) caja.remove(); return; }
    const [c, p] = await Promise.all([getDoc(doc(db, "settings", "cumple")), getDoc(doc(db, "perfil_extra", user.uid)).catch(() => null)]);
    const cfg = ajustesCumple(c.exists() ? c.data() : null);
    if (!cfg.activo || !cfg.premio) { if (caja) caja.remove(); return; }
    const perfil = p && p.exists() ? p.data() : null, nac = perfil && perfil.nacimiento;
    const dias = nac ? diasParaCumple(nac) : -1;
    if (nac && dias > 7) { if (caja) caja.remove(); return; }   // con la fecha puesta, solo sale la semana antes y el día
    estilos();
    if (!caja) { caja = document.createElement("div"); caja.id = "cumpleCaja"; tiles.parentNode.insertBefore(caja, tiles); }
    caja.className = "cumple";
    caja.innerHTML = "";
    const pp = (t, cl) => { const e = document.createElement("p"); e.textContent = t; if (cl) e.className = cl; return e; };
    if (nac && dias === 0) {
      const a = document.createElement("a"); a.className = "c-btn"; a.href = "regalos.html"; a.textContent = "🎁 Ver mi regalo";
      caja.append(pp("🎂 ¡FELIZ CUMPLEAÑOS!", "c-tit"), pp("Tu regalo de hoy: " + cfg.premio + ".", "c-reg"), pp("Lo tienes en «Mis regalos». Enséñalo en la barra y lo canjeamos (vale " + cfg.dias + (cfg.dias === 1 ? " día" : " días") + ")."), a);
      return;
    }
    if (nac) {
      caja.append(pp("🎂 ¡TU CUMPLEAÑOS SE ACERCA!", "c-tit"), pp((dias === 1 ? "Mañana" : "Dentro de " + dias + " días") + " es tu cumpleaños (" + fechaBonita(nac) + ")."), pp("Te espera de regalo: " + cfg.premio + ".", "c-reg"));
      return;
    }
    // sin fecha: se pide (una sola vez)
    const inp = document.createElement("input"); inp.type = "date";
    const hoy = new Date(); inp.max = (hoy.getFullYear() - 14) + "-12-31"; inp.min = (hoy.getFullYear() - 100) + "-01-01";
    const b = document.createElement("button"); b.type = "button"; b.textContent = "Guardar mi cumpleaños";
    const msg = document.createElement("small"); msg.textContent = "Pon tu fecha de nacimiento real: solo se puede poner una vez. Para corregirla, pídeselo al bar.";
    b.onclick = async () => {
      if (!nacimientoValido(inp.value)) { msg.textContent = "Escribe tu fecha de nacimiento real (día, mes y año)."; return; }
      if (!confirm("¿Tu fecha de nacimiento es el " + fechaBonita(inp.value) + " de " + inp.value.slice(0, 4) + "? Después no se puede cambiar.")) return;
      b.disabled = true;
      try {
        const ref = doc(db, "perfil_extra", user.uid);
        if (perfil) await setDoc(ref, { nacimiento: inp.value, actualizado: serverTimestamp() }, { merge: true });
        else await setDoc(ref, { nacimiento: inp.value, creado: serverTimestamp(), actualizado: serverTimestamp() });
        caja.innerHTML = "";
        caja.append(pp("🎂 ¡APUNTADO!", "c-tit"), pp("El " + fechaBonita(inp.value) + " te esperamos con tu regalo: " + cfg.premio + ".", "c-reg"));
      } catch (e) { b.disabled = false; msg.textContent = "No se ha podido guardar. Inténtalo otra vez en un rato."; }
    };
    caja.append(pp("🎂 ¿CUÁNDO ES TU CUMPLEAÑOS?", "c-tit"), pp(textoCumple(cfg.premio), "c-reg"), inp, b, msg);
  } catch (e) { if (caja) caja.remove(); }
}

// Carné de socio: una línea con su cumpleaños (si lo ha puesto).
export async function lineaCumple(db, uid) {
  try {
    const p = await getDoc(doc(db, "perfil_extra", uid));
    return p.exists() && p.data().nacimiento ? "🎂 Cumpleaños: " + fechaBonita(p.data().nacimiento) : "";
  } catch (e) { return ""; }
}
