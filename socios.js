// Socios: número de socio con un único contador (así nunca se repite), alta automática
// de quien verifica su correo con su bienvenida, el programa de embajadores (invitan amigos y ganan puntos)
// y el botón «Validar mi consumición» (tarjeta NFC del camarero).
import { doc, getDoc, getDocs, setDoc, collection, query, where, runTransaction, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";
import { estadoCupon, fechaCanje } from "./puntos.js";
import { ajustesInvitar, montarPanel, montarDetalle, NIVELES, puntosPorAmigo, puntosPorVisita, campanaActiva, estadoInvitacion, jornadaDe } from "./embajadores.js";

// <logica>
const maxNum = (usuarios) => Math.max(0, ...(usuarios || []).map((u) => Number(u.socioNum) || 0));
const numSocio = (n) => String(n || 0).padStart(4, "0");
// Solo se hace socio solo quien tiene el correo verificado y nunca ha sido socio (si se lo quitaste, no vuelve solo).
function puedeAutoSocio(user, ficha) {
  return !!(user && user.emailVerified === true && ficha && ficha.role && ficha.role !== "robot" && ficha.socio !== true && !ficha.socioNum && !ficha.socioDesde && ficha.bloqueado !== true);
}
// El regalo de bienvenida es el regalo gratis, visible, «para todos los socios» y de «una sola vez» (lo creas en Puntos y premios).
function premioBienvenida(premios) {
  return (premios || []).filter((p) => p.activo !== false && p.para === "socios" && Number(p.coste) === 0 && p.limite === "una").sort((a, b) => (a.orden || 0) - (b.orden || 0))[0] || null;
}
// Regalos de socio que puede usar ahora: los que ya tiene activados y los que aún puede pedir.
function regalosDe(premios, cupones, ahora) {
  const regalos = (premios || []).filter((p) => p.activo === true && p.para === "socios" && Number(p.coste) === 0);
  const activos = (cupones || []).filter((c) => Number(c.coste) === 0 && estadoCupon(c, ahora) === "pendiente" && regalos.some((p) => p.id === c.premioId));
  const libres = regalos.filter((p) => {
    const propios = (cupones || []).filter((c) => c.premioId === p.id);
    if (propios.some((c) => estadoCupon(c, ahora) === "pendiente")) return false;
    if (p.limite === "una" && propios.length) return false;
    if (p.limite === "dia" && propios.some((c) => String(c.id || "").endsWith("_" + fechaCanje(ahora)))) return false;
    return true;
  });
  return { activos, libres };
}
// Embajadores: los ajustes del programa y el enlace de cada embajador están en embajadores.js.
const euros = (n) => Number(n).toFixed(2).replace(".", ",") + " €";
const FACULTADES_SOCIOS = ["Ciencias", "Medicina", "Enfermería", "Derecho", "Filosofía y Letras", "Educación y Trabajo Social", "Económicas y Empresariales", "Comercio", "Ingenierías Industriales", "Telecomunicación", "Arquitectura", "Agrarias (Palencia)", "Otra universidad"];
function refDeURL(search) {
  const r = new URLSearchParams(search || "").get("ref");
  return r && /^\d{1,6}$/.test(r) && Number(r) > 0 ? Number(r) : 0;
}
function refGuardado(txt, ahoraMs) {
  try { const g = JSON.parse(txt || "null"); if (g && g.r > 0 && ahoraMs - g.t < 30 * 864e5) return g.r; } catch (e) {}
  return 0;
}
// Ofertas «Solo socios» vigentes hoy (las fechas van como AAAA-MM-DD).
function ofertasSocio(ofertas, hoy) {
  return (ofertas || []).filter((o) => o.activa === true && o.soloSocios === true && (!o.desde || o.desde <= hoy) && (!o.hasta || o.hasta >= hoy));
}
// Los quesitos que se llaman «Otra vez será», «Sin premio» o «Nada» no son premio.
const sinPremio = (nombre) => /^\s*(otra vez|sin premio|nada\b|sigue intent|vuelve a intent|suerte la pr)/i.test(String(nombre || ""));
// Premio que tocó en la ruleta (el mismo cálculo que ruleta.html).
function premioRuleta(ms, premios) {
  const total = premios.reduce((s, p) => s + p.peso, 0);
  if (!total) return null;
  const x = ((ms % 1000) / 1000) * total;
  let acum = 0, idx = premios.length - 1;
  for (let i = 0; i < premios.length; i++) { acum += premios[i].peso; if (x < acum) { idx = i; break; } }
  return premios[idx];
}
// </logica>

(function capturarInvitacion() {
  try {
    const r = refDeURL(location.search);
    if (r && !refGuardado(localStorage.getItem("sd_ref"), Date.now())) localStorage.setItem("sd_ref", JSON.stringify({ r: r, t: Date.now() }));
  } catch (e) {}
})();

const ref = (db, col, id) => doc(db, col, id);

// Si la persona llegó con el enlace de un amigo y su cuenta es nueva (menos de 3 días), se apunta quién la invitó.
async function registrarInvitacion(db, user, ficha) {
  try {
    const r = refGuardado(localStorage.getItem("sd_ref"), Date.now());
    if (!r || localStorage.getItem("sd_ref_hecho") === user.uid) return;
    const creado = ficha && ficha.creado && ficha.creado.toMillis ? ficha.creado.toMillis() : Date.now();
    if (Date.now() - creado > 3 * 864e5 || (ficha && ficha.socioNum === r)) { localStorage.setItem("sd_ref_hecho", user.uid); return; }
    const d = ref(db, "invitaciones", user.uid);
    if (!(await getDoc(d)).exists()) await setDoc(d, { ref: r, premiado: false, creado: serverTimestamp() });
    localStorage.setItem("sd_ref_hecho", user.uid);
  } catch (e) {}
}

// Administrador: deja el contador al menos en el número de socio más alto que ya existe.
export async function asegurarContador(db, usuarios) {
  const m = maxNum(usuarios);
  return runTransaction(db, async (tx) => {
    const c = await tx.get(ref(db, "contadores", "socios"));
    const actual = c.exists() ? Number(c.data().ultimo) || 0 : -1;
    if (actual < m) tx.set(ref(db, "contadores", "socios"), { ultimo: m });
    return Math.max(actual, m);
  });
}

// Administrador: hace socio a una persona. Si ya tuvo número (en su ficha o en su cuenta protegida), recupera el suyo;
// si no, el siguiente del contador. El número queda apuntado también en la cuenta protegida.
export async function hacerSocio(db, uid, usuarios) {
  return runTransaction(db, async (tx) => {
    const c = await tx.get(ref(db, "contadores", "socios")), u = await tx.get(ref(db, "users", uid)), cu = await tx.get(ref(db, "cuentas", uid));
    const d = u.exists() ? u.data() : {};
    const antiguo = d.socioNum || (cu.exists() ? Number(cu.data().socioNum) || 0 : 0);
    if (antiguo) {
      tx.update(ref(db, "users", uid), { socio: true, socioNum: antiguo, socioDesde: serverTimestamp() });
      tx.set(ref(db, "cuentas", uid), { socioNum: antiguo }, { merge: true });
      return antiguo;
    }
    const n = Math.max(c.exists() ? Number(c.data().ultimo) || 0 : 0, maxNum(usuarios)) + 1;
    tx.set(ref(db, "contadores", "socios"), { ultimo: n });
    tx.update(ref(db, "users", uid), { socio: true, socioNum: n, socioDesde: serverTimestamp() });
    tx.set(ref(db, "cuentas", uid), { socioNum: n }, { merge: true });
    return n;
  });
}

function estilos() {
  if (document.getElementById("estiloSocioNuevo")) return;
  const s = document.createElement("style");
  s.id = "estiloSocioNuevo";
  s.textContent =
    ".bienv{margin:0 0 12px;padding:12px 14px;border-radius:16px;border:1px solid rgba(255,43,214,.7);background:linear-gradient(150deg,rgba(255,43,214,.14),rgba(139,92,255,.12));box-shadow:0 0 16px rgba(255,43,214,.2)}" +
    ".bienv .b-tit{font-family:'Bungee','Rubik',sans-serif;font-size:.9rem;color:#ff7be8;margin:0 0 4px}" +
    ".bienv p{margin:5px 0;font-size:.88rem}" +
    ".bienv .b-reg{color:#ffe14d;font-weight:800}" +
    ".bienv .b-fila{display:flex;gap:8px;margin-top:8px}.bienv .b-fila a{flex:1;text-align:center;padding:10px;border-radius:12px;border:1px solid rgba(255,255,255,.3);color:#fff!important;text-decoration:none;font-weight:700;font-size:.88rem}";
  document.head.appendChild(s);
}
async function pintarBienvenida(db, n) {
  const quitar = (id) => { const e = document.getElementById(id); if (e) e.classList.remove("oculto"); };
  quitar("tileCarne"); quitar("uSocio");
  const us = document.getElementById("uSocio");
  if (us) us.textContent = "Socio nº " + numSocio(n);
  const tiles = document.querySelector(".tiles");
  if (!tiles || document.getElementById("socioBienv")) return;
  estilos();
  const caja = document.createElement("div");
  caja.id = "socioBienv";
  caja.className = "bienv";
  const p = (t, c) => { const e = document.createElement("p"); e.textContent = t; if (c) e.className = c; return e; };
  caja.append(p("🎉 ¡YA ERES SOCIO Nº " + numSocio(n) + "!", "b-tit"), p("Ya tienes tu carné de socio de Sweet Dreams y sus ventajas exclusivas."));
  const botones = [["carne.html", "Ver mi carné"]];
  try {
    const pr = premioBienvenida((await getDocs(collection(db, "premios"))).docs.map((d) => d.data()));
    if (pr) { caja.append(p("🎁 Tienes un regalo de bienvenida: " + pr.nombre + ". Actívalo en «Mis regalos» y canjéalo en la barra.", "b-reg")); botones.push(["regalos.html", "Ver mi regalo"]); }
  } catch (e) {}
  const fila = document.createElement("div");
  fila.className = "b-fila";
  botones.forEach(([h, t]) => { const a = document.createElement("a"); a.href = h; a.textContent = t; fila.append(a); });
  caja.append(fila);
  tiles.parentNode.insertBefore(caja, tiles);
}

// Inicio: «Tus ventajas de socio» (regalos, ruleta y ofertas solo para socios). Solo sale si hay algo que ofrecerle.
async function pintarVentajas(db, user, ficha) {
  try {
    const tiles = document.querySelector(".tiles");
    let caja = document.getElementById("ventajasCaja");
    if (!tiles || !user || !user.uid || !ficha || ficha.socio !== true) { if (caja) caja.remove(); return; }
    const hoyD = new Date(), hoy = hoyD.getFullYear() + "-" + String(hoyD.getMonth() + 1).padStart(2, "0") + "-" + String(hoyD.getDate()).padStart(2, "0");
    const [rc, rg, of, prs, cus] = await Promise.all([
      getDoc(ref(db, "ruleta_config", "actual")).catch(() => null),
      getDoc(ref(db, "ruleta_giros", user.uid)).catch(() => null),
      getDocs(query(collection(db, "ofertas"), where("activa", "==", true))).catch(() => null),
      getDocs(collection(db, "premios")).catch(() => null),
      getDocs(query(collection(db, "cupones"), where("uid", "==", user.uid))).catch(() => null)]);
    const items = [];
    if (prs && cus) {
      const r = regalosDe(prs.docs.map((d) => Object.assign({ id: d.id }, d.data())), cus.docs.map((d) => Object.assign({ id: d.id }, d.data())), Date.now());
      if (r.activos.length) items.push({ t: "🎁 Tienes un regalo listo para canjear: " + r.activos.map((c) => c.nombre).join(" · ") + ".", b: "Ver mi regalo", h: "regalos.html" });
      else if (r.libres.length) items.push({ t: "🎁 " + (r.libres.length === 1 ? "Tienes un regalo de socio: " : "Tienes " + r.libres.length + " regalos de socio: ") + r.libres.slice(0, 2).map((p) => p.nombre).join(" · ") + (r.libres.length > 2 ? "…" : ""), b: r.libres.length === 1 ? "Ver mi regalo" : "Ver mis regalos", h: "regalos.html" });
    }
    if (rg && rg.exists()) {
      const g = rg.data();
      if (g.canjeado !== true && g.giro && g.giro.toMillis) {
        let nombre = "";
        try { const v = await getDoc(ref(db, "ruleta_versiones", String(g.version))); const pr = v.exists() ? premioRuleta(g.giro.toMillis(), v.data().premios || []) : null; nombre = pr ? pr.nombre : ""; } catch (e) {}
        if (!sinPremio(nombre)) items.push({ t: "🎁 Tienes un premio de la ruleta por canjear" + (nombre ? ": " + nombre : "") + ".", b: "Ver mi premio", h: "ruleta.html" });
      }
    } else if (rc && rc.exists() && rc.data().activa === true) {
      items.push({ t: "🎡 Tienes un giro en la ruleta de premios. ¡Prueba suerte!", b: "¡Girar la ruleta!", h: "ruleta.html" });
    }
    const ofs = of ? ofertasSocio(of.docs.map((d) => d.data()), hoy) : [];
    if (ofs.length) items.push({ t: "🎁 " + (ofs.length === 1 ? "1 oferta solo para socios: " : ofs.length + " ofertas solo para socios: ") + ofs.slice(0, 2).map((o) => o.titulo).join(" · ") + (ofs.length > 2 ? "…" : ""), b: "Ver ofertas", h: "ofertas.html" });
    if (!items.length) { if (caja) caja.remove(); return; }
    if (!document.getElementById("estiloVentajas")) {
      const st = document.createElement("style");
      st.id = "estiloVentajas";
      st.textContent = ".ventajas{margin:0 0 12px;padding:12px 14px;border-radius:16px;border:1px solid rgba(139,92,255,.8);background:linear-gradient(150deg,rgba(139,92,255,.16),rgba(25,242,255,.08));box-shadow:0 0 16px rgba(139,92,255,.22)}" +
        ".ventajas .v-tit{font-family:'Bungee','Rubik',sans-serif;font-size:.9rem;color:#c4a6ff;margin:0 0 6px}.ventajas .v-it{padding:8px 0;border-top:1px solid rgba(255,255,255,.12)}" +
        ".ventajas .v-it p{margin:0 0 6px;font-size:.88rem}.ventajas .v-it a{display:inline-block;padding:7px 14px;border-radius:10px;font-weight:800;font-size:.85rem;text-decoration:none;background:linear-gradient(135deg,#ff2bd6,#8b5cff);color:#fff!important}";
      document.head.appendChild(st);
    }
    if (!caja) { caja = document.createElement("div"); caja.id = "ventajasCaja"; tiles.parentNode.insertBefore(caja, tiles); }
    caja.className = "ventajas";
    caja.innerHTML = "";
    const tit = document.createElement("p"); tit.className = "v-tit"; tit.textContent = "⭐ TUS VENTAJAS DE SOCIO";
    caja.append(tit);
    items.forEach((it) => {
      const d = document.createElement("div"), p = document.createElement("p"), a = document.createElement("a");
      d.className = "v-it"; p.textContent = it.t; a.href = it.h; a.textContent = it.b;
      d.append(p, a); caja.append(d);
    });
  } catch (e) {}
}

// Tarjeta para quien entró con el enlace de un embajador: qué tiene que hacer para que cuente su invitación.
// Tarjeta de quien vino con el enlace de un embajador: antes de su primera visita, cómo validarla; después, cada día que vuelva
// puede validar su visita (una vez por jornada) mientras duren los meses del programa, y su embajador gana puntos.
async function pintarInvitado(db, user, ficha) {
  try {
    const tiles = document.querySelector(".tiles");
    if (!tiles || !user || !user.uid) return;
    const inv = await getDoc(ref(db, "invitaciones", user.uid));
    let caja = document.getElementById("invitadoCaja");
    if (!inv.exists()) { if (caja) caja.remove(); return; }
    const c = await getDoc(ref(db, "settings", "invitaciones"));
    const cfg = ajustesInvitar(c.exists() ? c.data() : null), est = estadoInvitacion(inv.data(), cfg);
    if (!est.activa) { if (caja) caja.remove(); return; }
    // ¿ya ha validado hoy? (una vez por jornada; la jornada del bar acaba a las 6:00)
    let hoy = false;
    try {
      const vs = await getDocs(query(collection(db, "validaciones"), where("uid", "==", user.uid)));
      hoy = vs.docs.some((d) => ["valida", "pendiente"].includes(d.data().estado) && d.data().creado && d.data().creado.toMillis && jornadaDe(d.data().creado.toMillis()) === jornadaDe(Date.now()));
    } catch (e) {}
    const socio = !!(ficha && ficha.socio === true), quien = est.embajador || "tu embajador";
    if (!document.getElementById("estiloInvitado")) {
      const st = document.createElement("style");
      st.id = "estiloInvitado";
      st.textContent = ".invitado{margin:0 0 12px;padding:14px;border-radius:18px;border:1.5px solid rgba(255,225,77,.85);background:linear-gradient(150deg,rgba(255,225,77,.16),rgba(255,43,214,.12));box-shadow:0 0 18px rgba(255,225,77,.22)}" +
        ".invitado .i-tit{font-family:'Bungee','Rubik',sans-serif;font-size:.92rem;color:#ffe14d;margin:0 0 4px}.invitado p{margin:6px 0;font-size:.9rem}" +
        ".invitado ol{margin:6px 0 0;padding-left:0;list-style:none}.invitado li{margin:7px 0;font-size:.88rem;display:flex;gap:8px}.invitado li b{flex:none}" +
        ".invitado .i-btn{display:block;margin-top:10px;padding:14px;border-radius:14px;text-align:center;font-weight:800;font-size:1rem;text-decoration:none;color:#0a0612!important;background:linear-gradient(135deg,#5dff9a,#19f2ff)}" +
        ".invitado .i-sec{display:block;margin-top:8px;padding:10px;border-radius:12px;text-align:center;font-weight:700;text-decoration:none;color:#fff!important;border:1px solid rgba(255,255,255,.35)}" +
        ".invitado .i-num{display:flex;align-items:baseline;justify-content:center;gap:8px;margin:6px 0}.invitado .i-num b{font-family:'Bungee','Rubik',sans-serif;font-size:2.2rem;color:#ffe14d}" +
        ".invitado .i-hoy{margin-top:10px;padding:12px;border-radius:14px;text-align:center;font-weight:800;background:rgba(93,255,154,.15);border:1.5px solid #5dff9a;color:#5dff9a}" +
        ".invitado .i-min{font-size:.8rem;opacity:.85;text-align:center}";
      document.head.appendChild(st);
    }
    if (!caja) { caja = document.createElement("div"); caja.id = "invitadoCaja"; tiles.parentNode.insertBefore(caja, tiles); }
    caja.className = "invitado";
    caja.innerHTML = "";
    const p = (t, cl) => { const e = document.createElement("p"); e.textContent = t; if (cl) e.className = cl; return e; };
    const a = (txt, href, cl) => { const e = document.createElement("a"); e.className = cl; e.href = href; e.textContent = txt; return e; };
    caja.append(p("👑 VIENES DE PARTE DE " + quien.toUpperCase(), "i-tit"));
    if (est.primera) {
      caja.append(p("Ven al bar, pide algo de " + euros(cfg.minimo) + " o más y valida tu visita: así " + quien + " gana puntos. ¡Y cada vez que vuelvas, también!"));
      const ol = document.createElement("ol");
      const paso = (hecho, txt) => { const li = document.createElement("li"), b = document.createElement("b"), t = document.createElement("span"); b.textContent = hecho ? "✔" : "○"; t.textContent = txt; li.append(b, t); ol.append(li); };
      if (!socio) paso(false, "Verifica tu correo (te hemos mandado un enlace): así te haces socio y tienes tu carné con sus ventajas.");
      paso(false, "Pide en la barra algo de " + euros(cfg.minimo) + " o más.");
      paso(false, "Pulsa «Validar mi visita» y el camarero acercará su tarjeta a tu móvil (o enséñale tu carné).");
      caja.append(ol);
    } else {
      const n = document.createElement("div"); n.className = "i-num";
      const b = document.createElement("b"); b.textContent = String(est.visitas);
      const s2 = document.createElement("span"); s2.textContent = est.visitas === 1 ? "visita" : "visitas";
      n.append(b, s2); caja.append(n);
      caja.append(p("Cada día que vengas y valides tu visita, " + quien + " gana puntos. ¡Gracias por volver! 🙌" + (est.finMs ? " (Hasta el " + new Date(est.finMs).toLocaleDateString("es-ES", { day: "numeric", month: "long" }) + ".)" : "")));
    }
    if (hoy) caja.append(p("✔ Visita de hoy validada · vuelve mañana", "i-hoy"));
    else {
      caja.append(a(est.primera ? "📲 Validar mi visita" : "📲 Validar mi visita de hoy", "validar.html", "i-btn"));
      caja.append(p("🍹 Una vez al día, al pedir algo de " + euros(cfg.minimo) + " o más.", "i-min"));
    }
    if (socio) caja.append(a("🪪 Ver mi carné", "carne.html", "i-sec"));
  } catch (e) {}
}

// Inicio: «Mis puntos y premios» solo para embajadores activos. A los demás socios, en su lugar, «¿Quieres ser embajador?».
async function pintarEmbajador(db, user, ficha) {
  try {
    const puntos = document.getElementById("tilePuntos");
    if (!puntos || !user || !user.uid) return;
    let tile = document.getElementById("tileEmbajador");
    const quitar = () => { if (tile) tile.remove(); };
    if (!ficha || ficha.socio !== true) { puntos.classList.add("oculto"); quitar(); return; }
    const [emb, sol, c, rk] = await Promise.all([getDoc(ref(db, "embajadores", user.uid)), getDoc(ref(db, "embajadores_solicitudes", user.uid)), getDoc(ref(db, "settings", "invitaciones")), getDoc(ref(db, "embajadores_ranking", "actual")).catch(() => null)]);
    if (emb.exists() && emb.data().activo === true) {
      // embajador activo: el panel grande arriba del todo (puntos, enlace, QR, invitados, nivel y ranking)
      quitar();
      let hecho = false;
      try { hecho = await montarPanel(db, user, ficha); } catch (e) {}
      puntos.classList.toggle("oculto", hecho);
      return;
    }
    puntos.classList.add("oculto");
    { const p = document.getElementById("panelEmb"); if (p) p.remove(); }
    const cfg = ajustesInvitar(c.exists() ? c.data() : null), estado = sol.exists() ? sol.data().estado : "";
    if (estado === "rechazado" || (!estado && (!cfg.activo || !cfg.abierto))) { quitar(); return; }
    if (!tile) {
      tile = document.createElement("a");
      tile.id = "tileEmbajador"; tile.className = "tile t-amarillo grande"; tile.href = "embajador.html";
      puntos.parentNode.insertBefore(tile, puntos);
    }
    tile.innerHTML = "";
    const e = document.createElement("span"), st = document.createElement("strong"), sm = document.createElement("small");
    e.className = "emoji"; e.textContent = "👑"; st.textContent = "¿Quieres ser embajador?";
    const total = rk && rk.exists() ? Number(rk.data().totalPuntos) || 0 : 0, camp = campanaActiva(cfg);
    sm.textContent = estado === "pendiente" ? "Tu solicitud está en revisión"
      : camp ? "🔥 Ahora cada amigo vale " + puntosPorAmigo(cfg) + " puntos. ¡Apúntate!"
      : total > 0 ? "Este mes nuestros embajadores ya han ganado " + total + " puntos. ¿Te apuntas?"
      : "Invita a tu gente y llévate premios por cada amigo que venga";
    tile.append(e, st, sm);
  } catch (e) {}
}

// Inicio: aviso para activar las notificaciones (solo socios que no las tienen activadas).
async function pintarAvisos(db, user, ficha) {
  try {
    if (!ficha || ficha.socio !== true || document.getElementById("avisosCaja")) return;
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
    const instalada = window.navigator.standalone === true || (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);
    const hayAvisos = "Notification" in window && "serviceWorker" in navigator;
    let estado = "";
    if (ios && !instalada) estado = "instalar";
    else if (!hayAvisos) return;
    else if (Notification.permission === "granted") return;
    else estado = Notification.permission === "denied" ? "bloqueados" : "activar";
    const luego = Number(localStorage.getItem("sd_avisos_luego") || 0);
    if (Date.now() - luego < 7 * 864e5) return;
    let emb = false;
    try { const e = await getDoc(ref(db, "embajadores", user.uid)); emb = e.exists() && e.data().activo === true; } catch (e) {}
    const tiles = document.querySelector(".tiles");
    if (!tiles || document.getElementById("avisosCaja")) return;
    if (!document.getElementById("estiloAvisos")) {
      const st = document.createElement("style");
      st.id = "estiloAvisos";
      st.textContent = ".avisos-c{margin:0 0 12px;padding:12px 14px;border-radius:16px;border:1px solid rgba(25,242,255,.75);background:linear-gradient(150deg,rgba(25,242,255,.12),rgba(139,92,255,.12));box-shadow:0 0 16px rgba(25,242,255,.2)}" +
        ".avisos-c .a-tit{font-family:'Bungee','Rubik',sans-serif;font-size:.9rem;color:#19f2ff;margin:0 0 6px}.avisos-c p{margin:5px 0;font-size:.88rem}.avisos-c ul{margin:4px 0 6px;padding-left:20px;font-size:.88rem}.avisos-c li{margin:3px 0}" +
        ".avisos-c .a-fila{display:flex;gap:8px;margin-top:10px}.avisos-c .a-fila a,.avisos-c .a-fila button{flex:1;text-align:center;padding:10px;border-radius:12px;font-weight:800;font-size:.88rem;text-decoration:none;cursor:pointer}" +
        ".avisos-c .a-si{background:linear-gradient(135deg,#19f2ff,#8b5cff);color:#0a0612!important;border:0}.avisos-c .a-no{background:transparent;color:#fff!important;border:1px solid rgba(255,255,255,.3)}";
      document.head.appendChild(st);
    }
    const caja = document.createElement("div"); caja.id = "avisosCaja"; caja.className = "avisos-c";
    const p = (t, c) => { const e = document.createElement("p"); e.textContent = t; if (c) e.className = c; return e; };
    const lista = document.createElement("ul");
    (["player", "admin"].includes(ficha.role) ? ["⏰ Un aviso un rato antes de que empiece tu reserva de diana, para que no se te pase."] : ["🎂 Tu regalo el día de tu cumpleaños.", "🎁 Ofertas y regalos nuevos para socios."])
      .concat(emb ? ["👋 Cuando un amigo se registre con tu enlace.", "🎉 Cuando venga al bar un amigo que has invitado, y cuando subas de nivel."] : []).forEach((t) => { const li = document.createElement("li"); li.textContent = t; lista.append(li); });
    const fila = document.createElement("div"); fila.className = "a-fila";
    const no = document.createElement("button"); no.type = "button"; no.className = "a-no"; no.textContent = "Ahora no";
    no.onclick = () => { try { localStorage.setItem("sd_avisos_luego", String(Date.now())); } catch (e) {} caja.remove(); };
    if (estado === "activar") {
      caja.append(p("🔔 ACTIVA LOS AVISOS", "a-tit"), p("Te avisaremos en el móvil de:"), lista, p("Nada de publicidad: solo avisos útiles. Puedes quitarlos cuando quieras."));
      const si = document.createElement("a"); si.className = "a-si"; si.href = "avisos.html"; si.textContent = "Activar avisos";
      fila.append(si, no);
    } else if (estado === "bloqueados") {
      caja.append(p("🔕 TIENES LOS AVISOS BLOQUEADOS", "a-tit"), p("Si quieres recibirlos:"), lista,
        p("Desbloquéalos en tu navegador: toca el candado (o los ajustes de la página) junto a la dirección → Notificaciones → Permitir. Luego entra en «Avisos»."));
      const si = document.createElement("a"); si.className = "a-si"; si.href = "avisos.html"; si.textContent = "Ir a Avisos";
      fila.append(si, no);
    } else {
      caja.append(p("🔔 ¿QUIERES RECIBIR AVISOS?", "a-tit"), p("En iPhone, primero instala la app en tu pantalla de inicio y ábrela desde allí. Así te podremos avisar de:"), lista);
      const si = document.createElement("a"); si.className = "a-si"; si.href = "instalar.html"; si.textContent = "Cómo instalarla";
      fila.append(si, no);
    }
    caja.append(fila);
    tiles.parentNode.insertBefore(caja, tiles);
  } catch (e) {}
}

// Inicio: si la persona ya verificó su correo y nunca fue socia, se hace socia sola.
export async function autoSocio(db, user, ficha) {
  try {
    if (user && user.uid) { await registrarInvitacion(db, user, ficha); await pintarInvitado(db, user, ficha); await pintarEmbajador(db, user, ficha); await pintarVentajas(db, user, ficha); }
    if (ficha && ficha.socio === true) pintarAvisos(db, user, ficha);
    if (!puedeAutoSocio(user, ficha)) return 0;
    if (typeof user.getIdToken === "function") await user.getIdToken(true);
    const n = await runTransaction(db, async (tx) => {
      const c = await tx.get(ref(db, "contadores", "socios")), u = await tx.get(ref(db, "users", user.uid));
      if (!c.exists() || !u.exists()) return 0;
      const d = u.data();
      if (d.socio === true || d.socioNum || d.socioDesde || d.bloqueado === true) return 0;
      const nuevo = (Number(c.data().ultimo) || 0) + 1;
      tx.update(ref(db, "contadores", "socios"), { ultimo: nuevo });
      tx.update(ref(db, "users", user.uid), { socio: true, socioNum: nuevo, socioDesde: serverTimestamp() });
      return nuevo;
    });
    if (!n) return 0;
    Object.assign(ficha, { socio: true, socioNum: n });
    await pintarBienvenida(db, n);
    await pintarInvitado(db, user, ficha);
    await pintarEmbajador(db, user, ficha);
    await pintarVentajas(db, user, ficha);
    pintarAvisos(db, user, ficha);
    return n;
  } catch (e) { return 0; }   // sin reglas publicadas, sin conexión o sin contador: no pasa nada
}

// ---------- Embajadores: tarjeta en «Mis puntos» ----------
// Solo para embajadores activos: su enlace y sus cifras (a los demás no se les enseña nada).
export async function montarInvitar(db, uid, caja) {
  if (!caja) return;
  try {
    const yo = await getDoc(ref(db, "users", uid));
    await montarDetalle(db, uid, yo.exists() ? yo.data().socioNum : 0, caja);
  } catch (e) { caja.innerHTML = ""; caja.className = ""; }
}

// ---------- Embajadores: pantalla «¿Quieres ser embajador?» (para socios que no lo son) ----------
// No habla de puntos: los acuerdos con los embajadores se cuentan en persona.
export async function montarSolicitud(db, uid, caja) {
  if (!caja) return;
  const el = (tag, txt, cls) => { const e = document.createElement(tag); if (txt) e.textContent = txt; if (cls) e.className = cls; return e; };
  try {
    const [yo, c, emb, sol, uni] = await Promise.all([getDoc(ref(db, "users", uid)), getDoc(ref(db, "settings", "invitaciones")), getDoc(ref(db, "embajadores", uid)), getDoc(ref(db, "embajadores_solicitudes", uid)), getDoc(ref(db, "settings", "universitarios")).catch(() => null)]);
    const cfg = ajustesInvitar(c.exists() ? c.data() : null);
    caja.innerHTML = "";
    if (emb.exists() && emb.data().activo === true) { location.replace("mis-puntos.html"); return; }
    if (!yo.exists() || yo.data().socio !== true) { caja.append(el("p", "Primero verifica tu correo: así te haces socio y podrás pedirlo.")); return; }
    const estado = sol.exists() ? sol.data().estado : "";
    if (estado === "pendiente") { caja.append(el("h2", "👑 Solicitud en revisión"), el("p", "Hemos recibido tu solicitud para ser embajador. Te escribiremos pronto para contarte cómo funciona.")); return; }
    if (estado === "rechazado") { caja.append(el("h2", "👑 Embajadores"), el("p", "Gracias por tu interés. Ahora mismo no podemos sumar más embajadores; si cambia, te avisaremos.")); return; }
    if (!cfg.activo || !cfg.abierto) { caja.append(el("h2", "👑 Embajadores"), el("p", "Ahora mismo no estamos buscando embajadores. ¡Vuelve a mirar más adelante!")); return; }
    caja.append(el("h2", "👑 ¿Quieres ser embajador de Sweet Dreams?"), el("p", "Invita a gente de tu facultad o de tu grupo y llévate recompensas por cada persona que venga. Cuéntanos un poco y te escribimos para contarte cómo funciona."));
    const facs = uni && uni.exists() && uni.data().facultades && uni.data().facultades.length ? uni.data().facultades : FACULTADES_SOCIOS;
    const f = document.createElement("select");
    f.add(new Option("Tu facultad o grupo…", ""));
    facs.concat(["No estudio"]).forEach((x) => f.add(new Option(x, x)));
    const ig = document.createElement("input"); ig.type = "text"; ig.maxLength = 40; ig.placeholder = "Tu Instagram (opcional)";
    const mo = document.createElement("textarea"); mo.maxLength = 400; mo.placeholder = "¿Por qué quieres ser embajador? ¿A cuánta gente puedes traer?";
    const env = el("button", "Enviar solicitud", "pri"), err = el("small", "");
    env.type = "button";
    env.onclick = async () => {
      if (!f.value) { err.textContent = "Elige tu facultad o grupo."; return; }
      if (mo.value.trim().length < 10) { err.textContent = "Cuéntanos un poco más (al menos una frase)."; return; }
      env.disabled = true;
      try {
        await setDoc(ref(db, "embajadores_solicitudes", uid), { nombre: String(yo.data().nombre || "").slice(0, 80), facultad: f.value, instagram: ig.value.trim().replace(/^@/, "").slice(0, 40), motivo: mo.value.trim().slice(0, 400), estado: "pendiente", creado: serverTimestamp() });
        caja.innerHTML = ""; caja.append(el("h2", "👑 ¡Solicitud enviada!"), el("p", "Te escribiremos pronto para contarte cómo funciona."));
      } catch (e) { env.disabled = false; err.textContent = "No se ha podido enviar. ¿Has verificado tu correo?"; }
    };
    caja.append(f, ig, mo, env, err);
  } catch (e) { caja.innerHTML = ""; caja.append(el("p", "No se ha podido cargar. Inténtalo en un rato.")); }
}

// ---------- Embajadores: ajustes (solo administrador) ----------
export async function montarAjustesInvitar(db, caja) {
  if (!caja) return;
  const el = (tag, txt, cls) => { const e = document.createElement(tag); if (txt) e.textContent = txt; if (cls) e.className = cls; return e; };
  const num = (valor, paso) => { const i = document.createElement("input"); i.type = "number"; i.min = "0"; i.step = paso || "1"; i.inputMode = paso ? "decimal" : "numeric"; i.value = String(valor); return i; };
  const chk = (texto, marcado) => { const l = el("label", "", "chk"), i = document.createElement("input"); i.type = "checkbox"; i.checked = marcado; l.append(i, el("span", texto)); return [l, i]; };
  const c = await getDoc(ref(db, "settings", "invitaciones"));
  const cfg = ajustesInvitar(c.exists() ? c.data() : null);
  caja.innerHTML = "";
  caja.append(el("h2", "Ajustes del programa"), el("p", "Cada embajador tiene su panel en el inicio con su enlace, su QR, sus invitados, su nivel y el ranking. Cuando un amigo se registra con su enlace y viene al bar (una compra de la consumición mínima o más en la caja, o una validación con la tarjeta del camarero), el embajador recibe estos puntos y un aviso en el móvil. Canjear un cupón gratis no cuenta."));
  const [l1, act] = chk("Programa activo (los embajadores ganan puntos)", cfg.activo);
  const [l2, abi] = chk("Aceptar solicitudes nuevas (a los socios que no son embajadores les sale «¿Quieres ser embajador?» en el inicio)", cfg.abierto);
  const p = num(cfg.puntos), m = num(cfg.maxMes), mi = num(cfg.minimo, "0.5"), pv = num(cfg.puntosVisita), mv = num(cfg.maxVisitasMes), me = num(cfg.mesesVisitas);
  const pm = document.createElement("input"); pm.type = "text"; pm.maxLength = 80; pm.placeholder = "Ej.: una cena para dos (vacío = sin premio)"; pm.value = cfg.premioMes;
  caja.append(l1, l2, el("label", "Puntos por la primera visita de cada amigo"), p, el("label", "Máximo de amigos nuevos premiados por embajador y mes (0 = sin límite)"), m,
    el("label", "Consumición mínima del amigo para que cuente (€)"), mi, el("label", "🏆 Premio para el mejor embajador del mes (el que más amigos trae)"), pm);
  caja.append(el("h2", "🔁 Cuando el amigo vuelve"), el("p", "Después de su primera visita, el amigo puede validar su visita una vez al día. Cada visita validada (o cada compra de la consumición mínima apuntada en la caja) da estos puntos a su embajador."),
    el("label", "Puntos por cada visita siguiente (0 = solo cuenta la primera)"), pv, el("label", "Máximo de visitas premiadas por amigo y mes (0 = sin límite)"), mv, el("label", "Durante cuántos meses desde que el amigo se registra (0 = siempre)"), me);
  caja.append(el("h2", "🏅 Niveles"), el("p", "Al llegar a cada nivel, el embajador recibe estos puntos de regalo (una sola vez) y un aviso. 0 = sin regalo."));
  const niv = {};
  NIVELES.forEach((n) => { niv[n.k] = num(cfg.niveles[n.k]); caja.append(el("label", n.ico + " " + n.nom + " (" + n.min + " amigos)"), niv[n.k]); });
  const cp = cfg.campana || { activa: false, multiplicador: 2, hasta: "", id: "" };
  caja.append(el("h2", "🔥 Campaña de puntos dobles"), el("p", "Mientras esté activa, cada amigo vale más puntos. Al activarla, los embajadores reciben un aviso en el móvil."));
  const [l3, ca] = chk("Campaña activa", cp.activa);
  const mu = document.createElement("select"); [2, 3].forEach((x) => mu.add(new Option("x" + x + " (puntos " + (x === 2 ? "dobles" : "triples") + ")", x))); mu.value = String(cp.multiplicador);
  const ha = document.createElement("input"); ha.type = "date"; ha.value = cp.hasta;
  caja.append(l3, el("label", "Multiplicador"), mu, el("label", "Hasta el día (incluido)"), ha);
  const b = el("button", "Guardar"), r = el("small", "");
  b.type = "button";
  b.onclick = async () => {
    const d = { activo: act.checked, abierto: abi.checked, puntos: Number(p.value), maxMes: Number(m.value), minimo: Math.round(Number(String(mi.value).replace(",", ".")) * 100) / 100, premioMes: pm.value.trim().slice(0, 80), niveles: {}, puntosVisita: Number(pv.value), maxVisitasMes: Number(mv.value), mesesVisitas: Number(me.value) };
    NIVELES.forEach((n) => { d.niveles[n.k] = Number(niv[n.k].value); });
    if (!Number.isInteger(d.puntos) || d.puntos < 0 || d.puntos > 5000 || !Number.isInteger(d.maxMes) || d.maxMes < 0 || d.maxMes > 100) { r.textContent = "Revisa los números: enteros, 0 o más (puntos hasta 5000, amigos hasta 100)."; return; }
    if (!(d.minimo >= 0 && d.minimo <= 100)) { r.textContent = "La consumición mínima debe estar entre 0 y 100 €."; return; }
    if (![d.puntosVisita, d.maxVisitasMes, d.mesesVisitas].every((x) => Number.isInteger(x) && x >= 0) || d.puntosVisita > 5000 || d.maxVisitasMes > 31 || d.mesesVisitas > 36) { r.textContent = "Revisa las visitas: enteros, 0 o más (puntos hasta 5000, visitas al mes hasta 31, meses hasta 36)."; return; }
    if (NIVELES.some((n) => !Number.isInteger(d.niveles[n.k]) || d.niveles[n.k] < 0 || d.niveles[n.k] > 5000)) { r.textContent = "Los puntos de los niveles deben ser enteros entre 0 y 5000."; return; }
    if (ca.checked && !ha.value) { r.textContent = "Pon hasta qué día dura la campaña."; return; }
    // cada vez que se activa o se cambia la campaña, cambia su identificador: así el robot avisa a los embajadores una vez
    const nueva = { activa: ca.checked, multiplicador: Number(mu.value), hasta: ha.value };
    const igual = cp.activa === nueva.activa && cp.multiplicador === nueva.multiplicador && cp.hasta === nueva.hasta;
    d.campana = Object.assign(nueva, { id: igual ? cp.id : String(Date.now()) });
    try { await setDoc(ref(db, "settings", "invitaciones"), d); Object.assign(cp, d.campana); r.textContent = "✔ Guardado." + (nueva.activa && !igual ? " Los embajadores recibirán el aviso de la campaña en un minuto o dos." : ""); } catch (e) { r.textContent = "Error: " + (e.code || e.message); }
  };
  caja.append(b, r);
}
