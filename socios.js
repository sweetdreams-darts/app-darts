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
const INVITAR = { activo: true, abierto: true, puntos: 100, maxMes: 0 };
const APP = "https://sweetdreams-darts.github.io/app-darts/";
function ajustesInvitar(d) {
  const c = Object.assign({}, INVITAR);
  if (d && typeof d.activo === "boolean") c.activo = d.activo;
  if (d && typeof d.abierto === "boolean") c.abierto = d.abierto;
  if (d && Number.isInteger(d.puntos) && d.puntos >= 0) c.puntos = d.puntos;
  if (d && Number.isInteger(d.maxMes) && d.maxMes >= 0) c.maxMes = d.maxMes;
  return c;
}
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
  quitar("tileCarne"); quitar("tilePuntos"); quitar("uSocio");
  const us = document.getElementById("uSocio");
  if (us) us.textContent = "Socio nº " + numSocio(n);
  const tiles = document.querySelector(".tiles");
  if (!tiles || document.getElementById("socioBienv")) return;
  estilos();
  const caja = document.createElement("div");
  caja.id = "socioBienv";
  caja.className = "bienv";
  const p = (t, c) => { const e = document.createElement("p"); e.textContent = t; if (c) e.className = c; return e; };
  caja.append(p("🎉 ¡YA ERES SOCIO Nº " + numSocio(n) + "!", "b-tit"), p("Tienes tu carné de socio: enséñalo al pagar y sumarás puntos con cada consumición."));
  try {
    const pr = premioBienvenida((await getDocs(collection(db, "premios"))).docs.map((d) => d.data()));
    if (pr) caja.append(p("🎁 Tienes un regalo de bienvenida: " + pr.nombre + ". Actívalo en «Mis puntos» y enséñalo al pagar.", "b-reg"));
  } catch (e) {}
  const fila = document.createElement("div");
  fila.className = "b-fila";
  [["carne.html", "Ver mi carné"], ["mis-puntos.html", "Mis puntos"]].forEach(([h, t]) => { const a = document.createElement("a"); a.href = h; a.textContent = t; fila.append(a); });
  caja.append(fila);
  tiles.parentNode.insertBefore(caja, tiles);
}

// Botón «Validar mi consumición» en el inicio (solo socios y solo si lo has activado en «Tarjetas de camareros»).
async function pintarBotonValidar(db) {
  try {
    if (document.getElementById("btnValidar")) return;
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
    if (user && user.uid) await registrarInvitacion(db, user, ficha);
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
    pintarBotonValidar(db);
    return n;
  } catch (e) { return 0; }   // sin reglas publicadas, sin conexión o sin contador: no pasa nada
}

// ---------- Embajadores: tarjeta en «Mis puntos» ----------
// Embajador activo: su enlace y sus cifras. Si no lo es: el estado de su solicitud o el botón para pedirlo.
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
      caja.append(el("h2", "👑 Eres embajador de Sweet Dreams"), el("p", "Pasa tu enlace a tu gente. Por cada amigo que se registre con él y venga al bar, te llevas " + cfg.puntos + " puntos" + (cfg.maxMes ? " (hasta " + cfg.maxMes + " al mes)." : ".")));
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
    if (sol.exists()) {
      const e = sol.data().estado;
      if (e === "pendiente") { caja.className = "zona"; caja.append(el("h2", "👑 Embajadores"), el("p", "Tu solicitud para ser embajador está en revisión. Te escribiremos pronto.")); }
      return;
    }
    if (!cfg.abierto) return;
    // ofrecer ser embajador
    caja.className = "zona";
    caja.append(el("h2", "👑 ¿Quieres ser embajador?"), el("p", "Invita a gente de tu facultad o de tu grupo y gana " + cfg.puntos + " puntos por cada amigo que venga al bar. Cuéntanos un poco y te escribimos."));
    const abrir = el("button", "Quiero ser embajador", "pri");
    abrir.type = "button";
    abrir.onclick = () => {
      abrir.remove();
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
          await setDoc(ref(db, "embajadores_solicitudes", uid), { nombre: String((yo.exists() && yo.data().nombre) || "").slice(0, 80), facultad: f.value, instagram: ig.value.trim().replace(/^@/, "").slice(0, 40), motivo: mo.value.trim().slice(0, 400), estado: "pendiente", creado: serverTimestamp() });
          caja.innerHTML = ""; caja.append(el("h2", "👑 Embajadores"), el("p", "✔ ¡Solicitud enviada! Te escribiremos pronto."));
        } catch (e) { env.disabled = false; err.textContent = "No se ha podido enviar. ¿Has verificado tu correo?"; }
      };
      caja.append(f, ig, mo, env, err);
    };
    caja.append(abrir);
  } catch (e) { caja.innerHTML = ""; caja.className = ""; }
}

// ---------- Embajadores: ajustes (solo administrador) ----------
export async function montarAjustesInvitar(db, caja) {
  if (!caja) return;
  const el = (tag, txt, cls) => { const e = document.createElement(tag); if (txt) e.textContent = txt; if (cls) e.className = cls; return e; };
  const c = await getDoc(ref(db, "settings", "invitaciones"));
  const cfg = ajustesInvitar(c.exists() ? c.data() : null);
  caja.innerHTML = "";
  caja.append(el("h2", "Ajustes del programa"), el("p", "Cada embajador tiene un enlace en «Mis puntos». Cuando un amigo se registra con él y viene al bar (el camarero le suma puntos o le canjea un cupón), el embajador recibe estos puntos y un aviso en el móvil."));
  const chk = el("label", "", "chk"), act = document.createElement("input");
  act.type = "checkbox"; act.checked = cfg.activo; chk.append(act, el("span", "Programa activo (los embajadores ganan puntos)"));
  const chk2 = el("label", "", "chk"), abi = document.createElement("input");
  abi.type = "checkbox"; abi.checked = cfg.abierto; chk2.append(abi, el("span", "Aceptar solicitudes nuevas (sale «¿Quieres ser embajador?» en «Mis puntos»)"));
  const l1 = el("label", "Puntos para quien invita"), p = document.createElement("input");
  p.type = "number"; p.min = "0"; p.inputMode = "numeric"; p.value = String(cfg.puntos);
  const l2 = el("label", "Máximo de amigos premiados por embajador y mes (0 = sin límite)"), m = document.createElement("input");
  m.type = "number"; m.min = "0"; m.inputMode = "numeric"; m.value = String(cfg.maxMes);
  const b = el("button", "Guardar"), r = el("small", "");
  b.type = "button";
  b.onclick = async () => {
    const d = { activo: act.checked, abierto: abi.checked, puntos: Number(p.value), maxMes: Number(m.value) };
    if (!Number.isInteger(d.puntos) || d.puntos < 0 || d.puntos > 5000 || !Number.isInteger(d.maxMes) || d.maxMes < 0 || d.maxMes > 100) { r.textContent = "Revisa los números: enteros, 0 o más (puntos hasta 5000, amigos hasta 100)."; return; }
    try { await setDoc(ref(db, "settings", "invitaciones"), d); r.textContent = "✔ Guardado."; } catch (e) { r.textContent = "Error: " + (e.code || e.message); }
  };
  caja.append(chk, chk2, l1, p, l2, m, b, r);
}
