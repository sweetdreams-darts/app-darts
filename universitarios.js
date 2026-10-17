// Ventajas para universitarios: facultad, sello de estudiante y promociones que editas desde el panel.
// También apunta de qué QR viene cada registro (enlaces con ?o=posavasos, ?o=barra…).
import { doc, getDoc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";

// <logica>
const FACULTADES = ["Ciencias", "Medicina", "Enfermería", "Derecho", "Filosofía y Letras", "Educación y Trabajo Social", "Económicas y Empresariales", "Comercio", "Ingenierías Industriales", "Telecomunicación", "Arquitectura", "Agrarias (Palencia)", "Otra universidad"];
const DOMINIOS = ["alumnos.uva.es"];
const PROMOS = [{ id: "jueves", titulo: "Jueves Universitario", texto: "Cachis a 4,50 € todo el jueves.", dias: [4], desde: "", hasta: "", activa: true, orden: 1 }];
const LANZAMIENTO = Date.UTC(2026, 9, 18);   // los registros anteriores a esta fecha se cuentan como «anterior»
const DIAS_CORTOS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"], ORDEN_SEMANA = [1, 2, 3, 4, 5, 6, 0];
const pad = (n) => String(n).padStart(2, "0");

// Origen: el QR por el que llegó la persona (el primero que ve en 30 días).
function origenDeURL(search) {
  const o = new URLSearchParams(search || "").get("o");
  return o && /^[a-z0-9_-]{1,30}$/i.test(o) ? o.toLowerCase() : "";
}
function origenGuardado(txt, ahoraMs) {
  try { const g = JSON.parse(txt || "null"); if (g && g.o && ahoraMs - g.t < 30 * 864e5) return g.o; } catch (e) {}
  return "";
}
function origenFinal(ficha, guardado) {
  if (guardado) return guardado;
  const c = ficha && ficha.creado && ficha.creado.toMillis ? ficha.creado.toMillis() : null;
  return c !== null && c < LANZAMIENTO ? "anterior" : "directo";
}
const dominioDe = (email) => String(email || "").toLowerCase().split("@")[1] || "";
const esCorreoUni = (email, dominios) => dominios.includes(dominioDe(email));

// La jornada del bar acaba a las 6:00: hasta entonces todavía cuenta como el día anterior.
function jornada(ahora) {
  const d = new Date(ahora.getTime() - 6 * 3600000);
  return { dia: d.getDay(), min: (ahora.getHours() * 60 + ahora.getMinutes() - 360 + 1440) % 1440 };
}
const aMin = (hhmm) => { const [h, m] = String(hhmm).split(":").map(Number); return (h * 60 + m - 360 + 1440) % 1440; };
// "ahora" (se puede aprovechar ya), "hoy" (hoy, pero más tarde), "pasado" (hoy, ya acabó), "otro" (otro día), "off" (desactivada).
function estadoPromo(p, ahora) {
  if (p.activa === false) return "off";
  const j = jornada(ahora), dias = Array.isArray(p.dias) && p.dias.length ? p.dias : [0, 1, 2, 3, 4, 5, 6];
  if (!dias.includes(j.dia)) return "otro";
  if (!p.desde || !p.hasta) return "ahora";
  const d = aMin(p.desde);
  let h = aMin(p.hasta);
  if (h === 0) h = 1440;
  if (j.min >= d && j.min < h) return "ahora";
  return j.min < d ? "hoy" : "pasado";
}
function textoCuando(p) {
  const dias = Array.isArray(p.dias) && p.dias.length && p.dias.length < 7 ? ORDEN_SEMANA.filter((x) => p.dias.includes(x)).map((x) => DIAS_CORTOS[x]).join(", ") : "Todos los días";
  return dias + (p.desde && p.hasta ? " · " + p.desde + "–" + p.hasta : "");
}
function ordenarPromos(promos, ahora) {
  const rango = { ahora: 0, hoy: 1, pasado: 2, otro: 3 };
  return promos.map((p) => ({ p: p, e: estadoPromo(p, ahora) })).filter((x) => x.e !== "off")
    .sort((a, b) => rango[a.e] - rango[b.e] || (a.p.orden || 0) - (b.p.orden || 0) || String(a.p.titulo).localeCompare(String(b.p.titulo)));
}
// </logica>

(function capturarOrigen() {
  try {
    const o = origenDeURL(location.search);
    if (o && !origenGuardado(localStorage.getItem("sd_origen"), Date.now())) localStorage.setItem("sd_origen", JSON.stringify({ o: o, t: Date.now() }));
  } catch (e) {}
})();

const el = (tag, txt, cls) => { const e = document.createElement(tag); if (txt !== undefined && txt !== null && txt !== "") e.textContent = txt; if (cls) e.className = cls; return e; };
function estilos() {
  if (document.getElementById("estiloUni")) return;
  const s = document.createElement("style");
  s.id = "estiloUni";
  s.textContent =
    ".uni{margin:0 0 12px;padding:12px 14px;border-radius:16px;border:1px solid rgba(93,255,154,.6);background:linear-gradient(150deg,rgba(93,255,154,.10),rgba(25,242,255,.08));box-shadow:0 0 14px rgba(93,255,154,.15)}" +
    ".uni .uni-tit{font-family:'Bungee','Rubik',sans-serif;font-size:.85rem;color:#5dff9a;margin:0 0 4px;letter-spacing:.4px}" +
    ".uni p{margin:5px 0;font-size:.86rem;opacity:.95}" +
    ".uni .uni-fac{font-weight:800;font-size:1rem;opacity:1}" +
    ".uni select{width:100%;box-sizing:border-box;padding:11px 12px;border-radius:12px;border:1.5px solid rgba(255,255,255,.22);background:#0a0612;color:#fff;font-size:.95rem;margin-top:8px}" +
    ".uni button{width:100%;margin-top:10px;padding:12px;font-size:.95rem}" +
    ".uni .uni-no{width:auto;margin:8px 0 0;padding:4px 10px;font-size:.78rem}" +
    ".uni .uni-prom{display:flex;gap:10px;align-items:flex-start;padding:8px 0;border-top:1px solid rgba(255,255,255,.12)}" +
    ".uni .uni-prom b{display:block}" +
    ".uni .uni-prom small{display:block;opacity:.8;font-size:.74rem;margin-top:2px}" +
    ".uni .uni-tag{flex:none;padding:2px 9px;border-radius:999px;background:#ffe14d;color:#0a0612;font-weight:800;font-size:.7rem}" +
    ".uni .uni-tag.ahora{background:#5dff9a}.uni .uni-tag.otro{background:#3d3560;color:#fff}" +
    ".uni .uni-err{color:#ff9aaa;font-weight:700}";
  document.head.appendChild(s);
}
const noGuardar = () => { try { return Date.now() - Number(localStorage.getItem("sd_uni_no") || 0) < 14 * 864e5; } catch (e) { return false; } };

export async function montarUni(db, user, ficha) {
  if (!db || !user || !user.uid) return;
  try {
    const [pSnap, cSnap] = await Promise.all([getDoc(doc(db, "perfil_extra", user.uid)), getDoc(doc(db, "settings", "universitarios"))]);
    const cfg = cSnap.exists() ? cSnap.data() : {};
    const facultades = cfg.facultades && cfg.facultades.length ? cfg.facultades : FACULTADES;
    const dominios = (cfg.dominios && cfg.dominios.length ? cfg.dominios : DOMINIOS).map((x) => String(x).toLowerCase());
    const promos = Array.isArray(cfg.promos) ? cfg.promos : PROMOS;
    let perfil = pSnap.exists() ? pSnap.data() : null;
    if (!perfil) {
      // primer acceso: se apunta de qué QR viene (o si entró directamente)
      const o = origenFinal(ficha, origenGuardado(localStorage.getItem("sd_origen"), Date.now()));
      await setDoc(doc(db, "perfil_extra", user.uid), { origen: o, creado: serverTimestamp(), actualizado: serverTimestamp() });
      perfil = { origen: o };
    }
    const ref = doc(db, "perfil_extra", user.uid);
    const tiles = document.querySelector(".tiles");
    if (!tiles) return;
    estilos();
    let caja = document.getElementById("uniCaja");
    if (!caja) { caja = document.createElement("div"); caja.id = "uniCaja"; tiles.parentNode.insertBefore(caja, tiles); }
    const guardar = async (datos) => { await setDoc(ref, Object.assign({}, datos, { actualizado: serverTimestamp() }), { merge: true }); Object.assign(perfil, datos); pintar(); };
    const selector = (valor) => {
      const s = document.createElement("select");
      s.add(new Option("Elige tu facultad…", ""));
      facultades.forEach((f) => s.add(new Option(f, f)));
      s.value = facultades.includes(valor) ? valor : "";
      return s;
    };
    const verificado = user.emailVerified === true, correoUni = esCorreoUni(user.email, dominios);
    const pintar = () => {
      caja.innerHTML = "";
      caja.className = "";
      if (perfil.universitario === true) {
        caja.className = "uni";
        caja.append(el("p", "🎓 UNIVERSITARIO VERIFICADO", "uni-tit"));
        if (perfil.facultad) caja.append(el("p", perfil.facultad, "uni-fac"));
        caja.append(el("p", "Enseña esta pantalla al camarero para tus ventajas."));
        const lista = ordenarPromos(promos, new Date());
        if (!lista.length) caja.append(el("p", "Pronto habrá ventajas para ti."));
        lista.forEach(({ p, e }) => {
          const f = el("div", "", "uni-prom"), t = el("div");
          t.append(el("b", p.titulo));
          if (p.texto) t.append(el("span", p.texto));
          t.append(el("small", textoCuando(p)));
          f.append(t, el("span", e === "ahora" ? "AHORA" : e === "hoy" ? "HOY" : e === "pasado" ? "HOY · YA ACABÓ" : "OTRO DÍA", "uni-tag " + (e === "ahora" ? "ahora" : e === "otro" || e === "pasado" ? "otro" : "")));
          caja.append(f);
        });
        const cambiar = el("button", "Cambiar mi facultad", "uni-no");
        cambiar.type = "button";
        cambiar.onclick = () => {
          cambiar.remove();
          const s = selector(perfil.facultad), g = el("button", "Guardar facultad", "pri");
          g.type = "button";
          g.onclick = async () => { if (!s.value) return; g.disabled = true; try { await guardar({ facultad: s.value }); } catch (er) { g.disabled = false; } };
          caja.append(s, g);
        };
        caja.append(cambiar);
        return;
      }
      if (correoUni && verificado) {
        caja.className = "uni";
        caja.append(el("p", "🎓 ¿ESTUDIAS EN LA UNIVERSIDAD?", "uni-tit"), el("p", "Tu correo es de la universidad: activa tu carné de estudiante y sus ventajas. Solo tienes que elegir tu facultad."));
        const s = selector(perfil.facultad), g = el("button", "🎓 Activar mi carné de estudiante", "pri"), err = el("p", "", "uni-err");
        g.type = "button";
        g.onclick = async () => {
          if (!s.value) { err.textContent = "Elige tu facultad."; return; }
          g.disabled = true; err.textContent = "";
          try { if (typeof user.getIdToken === "function") await user.getIdToken(true); await guardar({ universitario: true, facultad: s.value }); } catch (er) { g.disabled = false; err.textContent = "No se ha podido activar. Inténtalo en un rato."; }
        };
        caja.append(s, g, err);
        return;
      }
      if (correoUni && !verificado) {
        caja.className = "uni";
        caja.append(el("p", "🎓 CASI LISTO", "uni-tit"), el("p", "Verifica tu correo (te hemos enviado un enlace) y aquí activarás tu carné de estudiante."));
        return;
      }
      if (!perfil.facultad && !noGuardar()) {
        caja.className = "uni";
        caja.append(el("p", "🎓 ¿ERES UNIVERSITARIO?", "uni-tit"), el("p", "Elige tu facultad y compite con ella en los juegos del bar. Las ventajas de estudiante se activan solas con el correo de la universidad; si tu cuenta usa otro, enséñanos tu carné cuando puedas."));
        const s = selector(""), g = el("button", "Guardar mi facultad", "pri"), n = el("button", "Ahora no", "uni-no");
        g.type = "button"; n.type = "button";
        g.onclick = async () => { if (!s.value) return; g.disabled = true; try { await guardar({ facultad: s.value }); } catch (er) { g.disabled = false; } };
        n.onclick = () => { try { localStorage.setItem("sd_uni_no", String(Date.now())); } catch (er) {} caja.innerHTML = ""; caja.className = ""; };
        caja.append(s, g, n);
      }
    };
    pintar();
  } catch (e) { /* si las reglas aún no están publicadas o no hay conexión, no se enseña nada */ }
}
