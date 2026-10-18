// Socios: número de socio con un único contador (así nunca se repite), alta automática
// de quien verifica su correo con su bienvenida, el programa de embajadores (invitan amigos y ganan puntos)
// y el botón «Validar mi consumición» (tarjeta NFC del camarero).
import { doc, getDoc, getDocs, setDoc, collection, query, where, runTransaction, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";

// <logica>
const maxNum = (usuarios) => Math.max(0, ...(usuarios || []).map((u) => Number(u.socioNum) || 0));
const numSocio = (n) => String(n || 0).padStart(4, "0");
// Solo se hace socio solo quien tiene el correo verificado y nunca ha sido socio (si se lo quitaste, no vuelve solo).
function puedeAutoSocio(user, ficha) {
  return !!(user && user.emailVerified === true && ficha && ficha.role && ficha.role !== "robot" && ficha.socio !== true && !ficha.socioNum && !ficha.socioDesde && ficha.bloqueado !== true);
}
// El regalo de bienvenida es el premio gratis, activo y de «una sola vez» (lo creas en Puntos y premios).
function premioBienvenida(premios) {
  return (premios || []).filter((p) => p.activo !== false && Number(p.coste) === 0 && p.limite === "una").sort((a, b) => (a.orden || 0) - (b.orden || 0))[0] || null;
}
// Embajadores: ajustes por defecto, el enlace de cada embajador y el número que trae un enlace.
const INVITAR = { activo: true, abierto: true, puntos: 100, maxMes: 0, minimo: 4.5 };
const APP = "https://sweetdreams-darts.github.io/app-darts/";
function ajustesInvitar(d) {
  const c = Object.assign({}, INVITAR);
  if (d && typeof d.activo === "boolean") c.activo = d.activo;
  if (d && typeof d.abierto === "boolean") c.abierto = d.abierto;
  if (d && Number.isInteger(d.puntos) && d.puntos >= 0) c.puntos = d.puntos;
  if (d && Number.isInteger(d.maxMes) && d.maxMes >= 0) c.maxMes = d.maxMes;
  if (d && typeof d.minimo === "number" && d.minimo >= 0 && d.minimo <= 100) c.minimo = d.minimo;
  return c;
}
const euros = (n) => Number(n).toFixed(2).replace(".", ",") + " €";
const enlaceInvitar = (n) => APP + "?ref=" + numSocio(n) + "&o=embajador";
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

// Administrador: hace socio a una persona. Si ya tuvo número, recupera el suyo; si no, el siguiente del contador.
export async function hacerSocio(db, uid, usuarios) {
  return runTransaction(db, async (tx) => {
    const c = await tx.get(ref(db, "contadores", "socios")), u = await tx.get(ref(db, "users", uid));
    const d = u.exists() ? u.data() : {};
    if (d.socioNum) { tx.update(ref(db, "users", uid), { socio: true, socioDesde: serverTimestamp() }); return d.socioNum; }
    const n = Math.max(c.exists() ? Number(c.data().ultimo) || 0 : 0, maxNum(usuarios)) + 1;
    tx.set(ref(db, "contadores", "socios"), { ultimo: n });
    tx.update(ref(db, "users", uid), { socio: true, socioNum: n, socioDesde: serverTimestamp() });
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
  try {
    const pr = premioBienvenida((await getDocs(collection(db, "premios"))).docs.map((d) => d.data()));
    if (pr) caja.append(p("🎁 Tienes un regalo de bienvenida: " + pr.nombre + ". Pídelo en la barra.", "b-reg"));
  } catch (e) {}
  const fila = document.createElement("div");
  fila.className = "b-fila";
  [["carne.html", "Ver mi carné"]].forEach(([h, t]) => { const a = document.createElement("a"); a.href = h; a.textContent = t; fila.append(a); });
  caja.append(fila);
  tiles.parentNode.insertBefore(caja, tiles);
}

// Inicio: «Tus ventajas de socio» (ruleta y ofertas solo para socios). Solo sale si hay algo que ofrecerle.
async function pintarVentajas(db, user, ficha) {
  try {
    const tiles = document.querySelector(".tiles");
    let caja = document.getElementById("ventajasCaja");
    if (!tiles || !user || !user.uid || !ficha || ficha.socio !== true) { if (caja) caja.remove(); return; }
    const hoyD = new Date(), hoy = hoyD.getFullYear() + "-" + String(hoyD.getMonth() + 1).padStart(2, "0") + "-" + String(hoyD.getDate()).padStart(2, "0");
    const [rc, rg, of] = await Promise.all([
      getDoc(ref(db, "ruleta_config", "actual")).catch(() => null),
      getDoc(ref(db, "ruleta_giros", user.uid)).catch(() => null),
      getDocs(query(collection(db, "ofertas"), where("activa", "==", true))).catch(() => null)]);
    const items = [];
    if (rg && rg.exists()) {
      const g = rg.data();
      if (g.canjeado !== true && g.giro && g.giro.toMillis) {
        let nombre = "";
        try { const v = await getDoc(ref(db, "ruleta_versiones", String(g.version))); const pr = v.exists() ? premioRuleta(g.giro.toMillis(), v.data().premios || []) : null; nombre = pr ? pr.nombre : ""; } catch (e) {}
        items.push({ t: "🎁 Tienes un premio de la ruleta por canjear" + (nombre ? ": " + nombre : "") + ".", b: "Ver mi premio", h: "ruleta.html" });
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
async function pintarInvitado(db, user, ficha) {
  try {
    const tiles = document.querySelector(".tiles");
    if (!tiles || !user || !user.uid) return;
    const inv = await getDoc(ref(db, "invitaciones", user.uid));
    let caja = document.getElementById("invitadoCaja");
    if (!inv.exists() || inv.data().premiado === true) { if (caja) caja.remove(); return; }
    const [c, n] = await Promise.all([getDoc(ref(db, "settings", "invitaciones")), getDoc(ref(db, "settings", "nfc")).catch(() => null)]);
    const cfg = ajustesInvitar(c.exists() ? c.data() : null);
    if (!cfg.activo) { if (caja) caja.remove(); return; }
    const nfc = !!(n && n.exists() && n.data().activo === true), socio = !!(ficha && ficha.socio === true);
    if (!document.getElementById("estiloInvitado")) {
      const st = document.createElement("style");
      st.id = "estiloInvitado";
      st.textContent = ".invitado{margin:0 0 12px;padding:12px 14px;border-radius:16px;border:1px solid rgba(255,225,77,.75);background:linear-gradient(150deg,rgba(255,225,77,.12),rgba(255,43,214,.10));box-shadow:0 0 16px rgba(255,225,77,.18)}" +
        ".invitado .i-tit{font-family:'Bungee','Rubik',sans-serif;font-size:.9rem;color:#ffe14d;margin:0 0 4px}.invitado p{margin:5px 0;font-size:.88rem}" +
        ".invitado ol{margin:6px 0 0;padding-left:0;list-style:none}.invitado li{margin:7px 0;font-size:.88rem;display:flex;gap:8px}.invitado li b{flex:none}" +
        ".invitado .i-btn{display:block;margin-top:10px;padding:12px;border-radius:12px;text-align:center;font-weight:800;text-decoration:none;color:#0a0612!important;background:linear-gradient(135deg,#5dff9a,#19f2ff)}";
      document.head.appendChild(st);
    }
    if (!caja) { caja = document.createElement("div"); caja.id = "invitadoCaja"; tiles.parentNode.insertBefore(caja, tiles); }
    caja.className = "invitado";
    caja.innerHTML = "";
    const p = (t, cl) => { const e = document.createElement("p"); e.textContent = t; if (cl) e.className = cl; return e; };
    caja.append(p("👑 TE HA INVITADO UN EMBAJADOR", "i-tit"), p("Para que cuente tu invitación, solo tienes que venir:"));
    const ol = document.createElement("ol");
    const paso = (hecho, txt) => { const li = document.createElement("li"), b = document.createElement("b"), t = document.createElement("span"); b.textContent = hecho ? "✔" : "○"; t.textContent = txt; li.append(b, t); ol.append(li); };
    paso(socio, socio ? "Ya eres socio nº " + numSocio(ficha.socioNum) + "." : "Verifica tu correo (te hemos mandado un enlace): así te haces socio y tienes tu carné.");
    paso(false, "Pide en la barra algo de " + euros(cfg.minimo) + " o más (un cachi, por ejemplo).");
    paso(false, nfc ? "Al pagar, pulsa «Validar mi visita» y el camarero acercará su tarjeta. También vale enseñar tu carné de socio." : "Al pagar, enseña tu carné de socio (o di tu número de socio) al camarero.");
    caja.append(ol);
    if (socio) {
      const a = document.createElement("a");
      a.className = "i-btn"; a.href = nfc ? "validar.html" : "carne.html"; a.textContent = nfc ? "📲 Validar mi visita" : "Ver mi carné de socio";
      caja.append(a);
      if (nfc) { const b = document.getElementById("btnValidar"); if (b) b.remove(); }
    }
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
    const [emb, sol, c] = await Promise.all([getDoc(ref(db, "embajadores", user.uid)), getDoc(ref(db, "embajadores_solicitudes", user.uid)), getDoc(ref(db, "settings", "invitaciones"))]);
    if (emb.exists() && emb.data().activo === true) { puntos.classList.remove("oculto"); quitar(); return; }
    puntos.classList.add("oculto");
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
    sm.textContent = estado === "pendiente" ? "Tu solicitud está en revisión" : "Invita a tu gente y llévate recompensas";
    tile.append(e, st, sm);
  } catch (e) {}
}

// Botón «Validar mi consumición» en el inicio (solo socios y solo si lo has activado en «Tarjetas de camareros»).
async function pintarBotonValidar(db) {
  try {
    if (document.getElementById("btnValidar") || document.querySelector("#invitadoCaja .i-btn[href='validar.html']")) return;
    const c = await getDoc(ref(db, "settings", "nfc"));
    const tiles = document.querySelector(".tiles");
    if (!c.exists() || c.data().activo !== true || !tiles || document.getElementById("btnValidar")) return;
    if (!document.getElementById("estiloValidar")) {
      const st = document.createElement("style");
      st.id = "estiloValidar";
      st.textContent = ".btn-validar{display:block;margin:0 0 12px;padding:16px;border-radius:18px;text-align:center;text-decoration:none;color:#0a0612!important;background:linear-gradient(135deg,#5dff9a,#19f2ff);box-shadow:0 0 18px rgba(25,242,255,.35)}" +
        ".btn-validar b{display:block;font-family:'Bungee','Rubik',sans-serif;font-size:1.05rem}.btn-validar small{display:block;font-size:.8rem;margin-top:2px;opacity:.85}";
      document.head.appendChild(st);
    }
    const a = document.createElement("a");
    a.id = "btnValidar"; a.href = "validar.html"; a.className = "btn-validar";
    const b = document.createElement("b"); b.textContent = "📲 Validar mi consumición";
    const sm = document.createElement("small"); sm.textContent = "Púlsalo al pedir y el camarero acercará su tarjeta";
    a.append(b, sm);
    tiles.parentNode.insertBefore(a, tiles);
  } catch (e) {}
}

// Inicio: si la persona ya verificó su correo y nunca fue socia, se hace socia sola.
export async function autoSocio(db, user, ficha) {
  try {
    if (user && user.uid) { await registrarInvitacion(db, user, ficha); await pintarInvitado(db, user, ficha); await pintarEmbajador(db, user, ficha); await pintarVentajas(db, user, ficha); }
    if (ficha && ficha.socio === true) pintarBotonValidar(db);
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
    pintarBotonValidar(db);
    return n;
  } catch (e) { return 0; }   // sin reglas publicadas, sin conexión o sin contador: no pasa nada
}

// ---------- Embajadores: tarjeta en «Mis puntos» ----------
// Solo para embajadores activos: su enlace y sus cifras (a los demás no se les enseña nada).
export async function montarInvitar(db, uid, caja) {
  if (!caja) return;
  const el = (tag, txt, cls) => { const e = document.createElement(tag); if (txt) e.textContent = txt; if (cls) e.className = cls; return e; };
  try {
    const [yo, c, emb, sol, uni] = await Promise.all([getDoc(ref(db, "users", uid)), getDoc(ref(db, "settings", "invitaciones")), getDoc(ref(db, "embajadores", uid)), getDoc(ref(db, "embajadores_solicitudes", uid)), getDoc(ref(db, "settings", "universitarios")).catch(() => null)]);
    const cfg = ajustesInvitar(c.exists() ? c.data() : null), num = yo.exists() ? yo.data().socioNum : 0;
    caja.innerHTML = "";
    caja.className = "";
    if (!cfg.activo) return;
    if (emb.exists() && emb.data().activo === true && num) {
      const link = enlaceInvitar(num);
      caja.className = "zona";
      caja.append(el("h2", "👑 Eres embajador de Sweet Dreams"), el("p", "Pasa tu enlace a tu gente. Por cada amigo que se registre con él y venga al bar (consumiendo " + euros(cfg.minimo) + " o más), te llevas " + cfg.puntos + " puntos" + (cfg.maxMes ? " (hasta " + cfg.maxMes + " al mes)." : ".")));
      const texto = "Te invito a la app de Sweet Dreams: reserva diana, juega al trivial y gana premios. Regístrate con mi enlace: " + link;
      const compartir = el("button", "Compartir mi enlace", "pri");
      compartir.type = "button";
      compartir.onclick = async () => {
        if (navigator.share) { try { await navigator.share({ title: "Sweet Dreams", text: texto }); return; } catch (e) { if (e && e.name === "AbortError") return; } }
        location.href = "https://wa.me/?text=" + encodeURIComponent(texto);
      };
      const copiar = el("button", "Copiar el enlace");
      copiar.type = "button";
      copiar.onclick = async () => { try { await navigator.clipboard.writeText(link); copiar.textContent = "✔ Enlace copiado"; } catch (e) { copiar.textContent = link; } };
      const estado = el("small", "");
      caja.append(compartir, copiar, estado);
      try {
        const s = await getDocs(query(collection(db, "invitaciones"), where("ref", "==", num)));
        const l = s.docs.map((d) => d.data()), vinieron = l.filter((x) => x.premiado === true && (x.puntos || 0) > 0), esperando = l.filter((x) => x.premiado !== true).length;
        const ganados = vinieron.reduce((t, x) => t + (x.puntos || 0), 0);
        estado.textContent = l.length ? "Registrados con tu enlace: " + l.length + " · han venido: " + vinieron.length + (esperando ? " · aún no han venido: " + esperando : "") + " · puntos ganados: " + ganados : "Todavía no se ha registrado nadie con tu enlace.";
      } catch (e) {}
      return;
    }
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
  const c = await getDoc(ref(db, "settings", "invitaciones"));
  const cfg = ajustesInvitar(c.exists() ? c.data() : null);
  caja.innerHTML = "";
  caja.append(el("h2", "Ajustes del programa"), el("p", "Cada embajador tiene un enlace en «Mis puntos». Cuando un amigo se registra con él y viene al bar (una compra de la consumición mínima o más en la caja, o una validación con la tarjeta del camarero), el embajador recibe estos puntos y un aviso en el móvil. Canjear un cupón gratis no cuenta."));
  const chk = el("label", "", "chk"), act = document.createElement("input");
  act.type = "checkbox"; act.checked = cfg.activo; chk.append(act, el("span", "Programa activo (los embajadores ganan puntos)"));
  const chk2 = el("label", "", "chk"), abi = document.createElement("input");
  abi.type = "checkbox"; abi.checked = cfg.abierto; chk2.append(abi, el("span", "Aceptar solicitudes nuevas (a los socios que no son embajadores les sale «¿Quieres ser embajador?» en el inicio)"));
  const l1 = el("label", "Puntos para quien invita"), p = document.createElement("input");
  p.type = "number"; p.min = "0"; p.inputMode = "numeric"; p.value = String(cfg.puntos);
  const l2 = el("label", "Máximo de amigos premiados por embajador y mes (0 = sin límite)"), m = document.createElement("input");
  m.type = "number"; m.min = "0"; m.inputMode = "numeric"; m.value = String(cfg.maxMes);
  const l3 = el("label", "Consumición mínima del amigo para que cuente (€)"), mi = document.createElement("input");
  mi.type = "number"; mi.min = "0"; mi.step = "0.5"; mi.inputMode = "decimal"; mi.value = String(cfg.minimo);
  const b = el("button", "Guardar"), r = el("small", "");
  b.type = "button";
  b.onclick = async () => {
    const d = { activo: act.checked, abierto: abi.checked, puntos: Number(p.value), maxMes: Number(m.value), minimo: Math.round(Number(String(mi.value).replace(",", ".")) * 100) / 100 };
    if (!Number.isInteger(d.puntos) || d.puntos < 0 || d.puntos > 5000 || !Number.isInteger(d.maxMes) || d.maxMes < 0 || d.maxMes > 100) { r.textContent = "Revisa los números: enteros, 0 o más (puntos hasta 5000, amigos hasta 100)."; return; }
    if (!(d.minimo >= 0 && d.minimo <= 100)) { r.textContent = "La consumición mínima debe estar entre 0 y 100 €."; return; }
    try { await setDoc(ref(db, "settings", "invitaciones"), d); r.textContent = "✔ Guardado."; } catch (e) { r.textContent = "Error: " + (e.code || e.message); }
  };
  caja.append(chk, chk2, l1, p, l2, m, l3, mi, b, r);
}
