// Tarjeta del administrador "HOY EN SWEET DREAMS": las partidas de liga que se juegan hoy en el bar y en qué diana.
import { doc, collection, getDoc, getDocs, query, where, Timestamp } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";

// <logica>
const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
const hhmm = (ms) => { const d = new Date(ms); return pad(d.getHours()) + ":" + pad(d.getMinutes()); };
const norm = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
const DIAS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
// La jornada del bar acaba de madrugada: hasta las 6:00 todavía cuenta como "hoy" el día anterior.
function diaDelBar(ahora) {
  const d = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate() - (ahora.getHours() < 6 ? 1 : 0));
  return iso(d);
}
function ventanaDelBar(dia) {
  const [y, m, d] = dia.split("-").map(Number);
  return { desde: new Date(y, m - 1, d, 6, 0), hasta: new Date(y, m - 1, d + 1, 6, 0) };
}
function textoDia(dia) {
  const [y, m, d] = dia.split("-").map(Number);
  return DIAS[new Date(y, m - 1, d).getDay()] + " " + d + " " + MESES[m - 1];
}
const etiqueta = (cat, nivel) => (cat === "parejas" ? "Parejas" : "Equipos") + (nivel ? " N" + nivel : "");
const durParejas = (nivel) => (Number(nivel) >= 1 && Number(nivel) <= 5 ? 75 : 90) * 60000;
// Los encadenados se reconocen por cómo están colocados (así el aviso nunca se queda viejo).
function relaciones(lista) {
  const rel = new Map();
  for (const o of lista) {
    if (o.categoria === "parejas") continue;
    const p = lista.find((x) => x !== o && x.categoria === "parejas" && x.dianaId === o.dianaId && x.finMs === o.inicioMs && o.inicioMs === o.partidoMs && x.finMs < x.partidoMs + durParejas(x.nivel));
    if (p) { rel.set(o.id, { tras: p }); rel.set(p.id, { por: o }); }
  }
  return rel;
}
function avisoDe(b, rel) {
  const r = rel.get(b.id);
  if (r && r.tras) return "Empieza a su hora, justo después de " + etiqueta(r.tras.categoria, r.tras.nivel) + " · " + (r.tras.local || "?") + " (que acaba a las " + hhmm(r.tras.finMs) + ")";
  if (r && r.por) return "Debe acabar antes de las " + hhmm(b.finMs) + ": después va " + etiqueta(r.por.categoria, r.por.nivel) + " · " + (r.por.local || "?");
  if (b.categoria === "parejas" && b.finMs < b.partidoMs + durParejas(b.nivel)) return "⚠ Acortada hasta las " + hhmm(b.finMs) + " sin online detrás";
  return "";
}
const notaManual = (b) => (b.nota && !/^(Empieza a su hora|Debe terminar antes)/.test(b.nota) ? b.nota : "");
// Junta lo que hay bloqueado hoy con los partidos del calendario que son de Sweet Dreams y aún no tienen diana.
function construirLista(o) {
  const items = [], conBloqueo = new Set();
  const rel = relaciones(o.bloqueos.filter((b) => b.estado === "activo"));
  for (const b of o.bloqueos) {
    conBloqueo.add(b.id);
    if (b.estado === "activo") {
      const dd = o.dianas.get(b.dianaId);
      items.push({ ms: b.partidoMs, hora: hhmm(b.partidoMs), etiqueta: etiqueta(b.categoria, b.nivel), local: b.local || "?", visitante: b.visitante || "?", diana: dd ? dd.nombre : "Diana ?", nota: avisoDe(b, rel), notaManual: notaManual(b), sinOnline: b.categoria !== "parejas" && !!dd && dd.online === false, estado: "activo", manual: b.origen === "manual" });
    } else if (b.estado === "aplazado") {
      items.push({ ms: b.partidoMs, hora: hhmm(b.partidoMs), etiqueta: etiqueta(b.categoria, b.nivel), local: b.local || "?", visitante: b.visitante || "?", diana: "", nota: "", estado: "aplazado" });
    }
  }
  for (const p of o.partidos) {
    if (conBloqueo.has(p.id) || o.bloqueosExtra.has(p.id)) continue;
    const esSD = p.categoria === "parejas" ? p.enSweetDreams === true : (o.nombresSD.has(norm(p.local)) || o.nombresSD.has(norm(p.visitante)));
    if (!esSD) continue;
    const ms = p.fecha && p.fecha.toMillis ? p.fecha.toMillis() : 0;
    items.push({ ms: ms, hora: p.hora || hhmm(ms), etiqueta: etiqueta(p.categoria, p.nivel), local: p.local, visitante: p.visitante, diana: "", nota: "", estado: "sinDiana" });
  }
  items.sort((a, b) => a.ms - b.ms || a.etiqueta.localeCompare(b.etiqueta));
  return items;
}
// </logica>

function estilos() {
  if (document.getElementById("estiloHoySD")) return;
  const s = document.createElement("style");
  s.id = "estiloHoySD";
  s.textContent =
    ".hoy{margin-bottom:12px;padding:10px 12px;border-radius:16px;border:1px solid rgba(25,242,255,.55);background:linear-gradient(150deg,rgba(25,242,255,.10),rgba(139,92,255,.12));box-shadow:0 0 14px rgba(25,242,255,.18)}" +
    ".hoy .hoy-cab{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 0 6px}" +
    ".hoy .hoy-tit{font-family:'Bungee','Rubik',sans-serif;font-size:.82rem;color:#19f2ff;letter-spacing:.4px;margin:0}" +
    ".hoy .hoy-dia{font-size:.74rem;opacity:.8;margin-left:6px;font-family:'Rubik',sans-serif;color:#fff}" +
    ".hoy .hoy-ref{margin:0;padding:2px 9px;width:auto;font-size:.8rem;border-radius:8px}" +
    ".hoy .hoy-fila{display:flex;gap:8px;align-items:flex-start;padding:6px 0;border-top:1px solid rgba(255,255,255,.1);font-size:.84rem;background:none!important;border-left:0;border-right:0;border-bottom:0;box-shadow:none!important}" +
    ".hoy .hoy-h{font-family:'Bungee','Rubik',sans-serif;font-size:.95rem;color:#ffe14d;min-width:3.2em}" +
    ".hoy .hoy-q{flex:1;min-width:0}" +
    ".hoy .hoy-q small{display:block;opacity:.75;font-size:.72rem}" +
    ".hoy .hoy-q em{display:block;font-style:normal;color:#ffe14d;font-size:.72rem;margin-top:2px}" +
    ".hoy .hoy-d{flex:none;padding:2px 9px;border-radius:999px;background:#19f2ff;color:#0a0612;font-weight:800;font-size:.74rem;white-space:nowrap}" +
    ".hoy .hoy-d.hoy-mal{background:#ff5c7a;color:#fff}" +
    ".hoy .hoy-d.hoy-apl{background:#8f87a6;color:#0a0612}" +
    ".hoy .hoy-pie{display:flex;gap:8px;margin-top:8px;font-size:.78rem;align-items:center;justify-content:space-between}" +
    ".hoy .hoy-pie a{color:#19f2ff!important}" +
    ".hoy .hoy-vacio{font-size:.84rem;opacity:.85;margin:4px 0}" +
    ".hoy .hoy-sol{display:block;margin:2px 0 8px;padding:8px 10px;border-radius:10px;background:#ffe14d;color:#0a0612!important;font-weight:800;font-size:.8rem;text-decoration:none}";
  document.head.appendChild(s);
}

async function leer(db, hoy) {
  const w = ventanaDelBar(hoy);
  const [bl, pa, cfg, di, re] = await Promise.all([
    getDocs(query(collection(db, "liga_bloqueos"), where("dia", "==", hoy))),
    getDocs(query(collection(db, "liga_partidos"), where("dia", "==", hoy))),
    getDoc(doc(db, "liga_config", "equiposSweetDreams")),
    getDocs(collection(db, "dartboards")),
    getDocs(query(collection(db, "reservations"), where("inicio", ">=", Timestamp.fromDate(w.desde)), where("inicio", "<", Timestamp.fromDate(w.hasta))))
  ]);
  const bloqueos = bl.docs.map((d) => Object.assign({ id: d.id }, d.data()));
  const partidos = pa.docs.map((d) => Object.assign({ id: d.id }, d.data()));
  const nombresSD = new Set(cfg.exists() ? (cfg.data().nombres || []).map(norm) : []);
  const dianas = new Map(di.docs.map((d) => [d.id, { nombre: d.data().nombre || d.id, online: d.data().online === true }]));
  // partidos de hoy de Sweet Dreams sin bloqueo de hoy: puede que estén bloqueados en otra fecha (movidos) o aplazados
  const ya = new Set(bloqueos.map((b) => b.id));
  const sd = partidos.filter((p) => !ya.has(p.id) && (p.categoria === "parejas" ? p.enSweetDreams === true : (nombresSD.has(norm(p.local)) || nombresSD.has(norm(p.visitante)))));
  const bloqueosExtra = new Set();
  await Promise.all(sd.map(async (p) => { try { if ((await getDoc(doc(db, "liga_bloqueos", p.id))).exists()) bloqueosExtra.add(p.id); } catch (e) {} }));
  let solicitudes = 0;
  try { solicitudes = (await getDocs(query(collection(db, "cambios_pedidos"), where("estado", "==", "pendiente")))).docs.length; } catch (e) {}
  return { items: construirLista({ bloqueos: bloqueos, partidos: partidos, bloqueosExtra: bloqueosExtra, nombresSD: nombresSD, dianas: dianas }), reservas: re.docs.length, solicitudes: solicitudes };
}

function pintar(caja, hoy, datos) {
  caja.innerHTML = "";
  const cab = document.createElement("div");
  cab.className = "hoy-cab";
  const t = document.createElement("p");
  t.className = "hoy-tit";
  t.textContent = "📍 HOY EN SWEET DREAMS";
  const dia = document.createElement("span");
  dia.className = "hoy-dia";
  dia.textContent = textoDia(hoy);
  t.appendChild(dia);
  const r = document.createElement("button");
  r.className = "hoy-ref";
  r.type = "button";
  r.textContent = "↻";
  r.setAttribute("aria-label", "Actualizar");
  r.onclick = () => montar(caja.__db, caja.__ficha, true);
  cab.append(t, r);
  caja.appendChild(cab);
  if (datos.solicitudes) { const sol = document.createElement("a"); sol.className = "hoy-sol"; sol.href = "admin-solicitudes.html"; sol.textContent = "📩 " + datos.solicitudes + (datos.solicitudes === 1 ? " solicitud de capitán pendiente ›" : " solicitudes de capitanes pendientes ›"); caja.appendChild(sol); }
  if (!datos.items.length) {
    const v = document.createElement("p");
    v.className = "hoy-vacio";
    v.textContent = "Hoy no hay partidas de liga en Sweet Dreams.";
    caja.appendChild(v);
  }
  for (const it of datos.items) {
    const f = document.createElement("div");
    f.className = "hoy-fila";
    const h = document.createElement("span");
    h.className = "hoy-h";
    h.textContent = it.hora;
    const q = document.createElement("div");
    q.className = "hoy-q";
    const eq = document.createElement("strong");
    eq.textContent = it.local + " – " + it.visitante;
    const sm = document.createElement("small");
    sm.textContent = it.etiqueta + (it.manual ? " · añadida a mano" : "");
    q.append(eq, sm);
    if (it.nota) { const n = document.createElement("em"); n.textContent = (it.nota.startsWith("⚠") ? "" : "⏰ ") + it.nota; q.appendChild(n); }
    if (it.notaManual) { const n = document.createElement("em"); n.textContent = "📝 " + it.notaManual; q.appendChild(n); }
    if (it.sinOnline) { const n = document.createElement("em"); n.textContent = "⚠ Partida online en una diana sin online"; q.appendChild(n); }
    const d = document.createElement("span");
    d.className = "hoy-d" + (it.estado === "sinDiana" ? " hoy-mal" : it.estado === "aplazado" ? " hoy-apl" : "");
    d.textContent = it.estado === "sinDiana" ? "SIN DIANA" : it.estado === "aplazado" ? "APLAZADA" : it.diana;
    f.append(h, q, d);
    caja.appendChild(f);
  }
  const pie = document.createElement("div");
  pie.className = "hoy-pie";
  const rs = document.createElement("span");
  rs.textContent = datos.reservas ? "🎯 " + datos.reservas + (datos.reservas === 1 ? " reserva" : " reservas") + " de clientes hoy" : "🎯 Sin reservas de clientes hoy";
  const a = document.createElement("a");
  a.href = "admin-liga.html";
  a.textContent = "Ver bloqueos ›";
  pie.append(rs, a);
  caja.appendChild(pie);
}

export async function montar(db, ficha, forzar) {
  if (!ficha || ficha.role !== "admin") return;
  estilos();
  let caja = document.getElementById("hoySD");
  if (!caja) {
    caja = document.createElement("div");
    caja.id = "hoySD";
    const ref = document.getElementById("proxPartido");
    if (ref && ref.parentNode) ref.parentNode.insertBefore(caja, ref.nextSibling);
    else document.body.appendChild(caja);
  }
  caja.className = "hoy";
  caja.__db = db;
  caja.__ficha = ficha;
  const hoy = diaDelBar(new Date());
  let datos = null;
  if (!forzar) { try { const c = JSON.parse(sessionStorage.getItem("sd_hoy_v1") || "null"); if (c && c.hoy === hoy && Date.now() - c.t < 300000) datos = c.datos; } catch (e) {} }
  if (datos) { pintar(caja, hoy, datos); return; }
  caja.innerHTML = "<p class='hoy-vacio'>📍 HOY EN SWEET DREAMS · cargando…</p>";
  try {
    datos = await leer(db, hoy);
    try { sessionStorage.setItem("sd_hoy_v1", JSON.stringify({ hoy: hoy, t: Date.now(), datos: datos })); } catch (e) {}
    pintar(caja, hoy, datos);
  } catch (e) { caja.innerHTML = "<p class='hoy-vacio'>📍 HOY EN SWEET DREAMS · no se ha podido cargar (" + (e.code || e.message) + ")</p>"; }
}
