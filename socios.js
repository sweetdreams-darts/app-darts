// Socios: número de socio con un único contador (así nunca se repite) y alta automática
// de quien verifica su correo, con su bienvenida en el inicio.
import { doc, getDocs, collection, runTransaction, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";

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
// </logica>

const ref = (db, col, id) => doc(db, col, id);

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

// Inicio: si la persona ya verificó su correo y nunca fue socia, se hace socia sola.
export async function autoSocio(db, user, ficha) {
  try {
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
    return n;
  } catch (e) { return 0; }   // sin reglas publicadas, sin conexión o sin contador: no pasa nada
}
