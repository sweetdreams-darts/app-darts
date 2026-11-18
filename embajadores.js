// Programa de embajadores: el panel grande del inicio, el detalle de «Mis puntos» (enlace, QR, invitados, niveles)
// y el ranking del mes. Los puntos, los niveles y el ranking los calcula el robot de avisos (scripts/avisos.py).
import { doc, getDoc, getDocs, collection, query, where, orderBy, limit } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";

// <logica>
export const APP = "https://sweetdreams-darts.github.io/app-darts/";
export const numSocio = (n) => String(n || 0).padStart(4, "0");
export const enlaceInvitar = (n) => APP + "?ref=" + numSocio(n) + "&o=embajador";
// Niveles por amigos traídos al bar, con los puntos extra que se dan al llegar (el administrador los puede cambiar).
export const NIVELES = [
  { k: "bronce", min: 3, nom: "Bronce", ico: "🥉", bonus: 25 },
  { k: "plata", min: 10, nom: "Plata", ico: "🥈", bonus: 50 },
  { k: "oro", min: 25, nom: "Oro", ico: "🥇", bonus: 100 },
  { k: "diamante", min: 50, nom: "Diamante", ico: "💎", bonus: 250 },
];
const INVITAR = { activo: true, abierto: true, puntos: 100, maxMes: 0, minimo: 4.5, premioMes: "", niveles: {}, campana: null, puntosVisita: 30, maxVisitasMes: 0, mesesVisitas: 4 };
// Ajustes del programa (settings/invitaciones), con valores por defecto si falta algo.
export function ajustesInvitar(d) {
  const c = Object.assign({}, INVITAR, { niveles: {} });
  if (d && typeof d.activo === "boolean") c.activo = d.activo;
  if (d && typeof d.abierto === "boolean") c.abierto = d.abierto;
  if (d && Number.isInteger(d.puntos) && d.puntos >= 0) c.puntos = d.puntos;
  if (d && Number.isInteger(d.maxMes) && d.maxMes >= 0) c.maxMes = d.maxMes;
  if (d && typeof d.minimo === "number" && d.minimo >= 0 && d.minimo <= 100) c.minimo = d.minimo;
  if (d && typeof d.premioMes === "string") c.premioMes = d.premioMes.trim();
  // visitas siguientes del mismo amigo: puntos por visita, máximo al mes (0 = sin límite) y durante cuántos meses (0 = siempre)
  for (const k of ["puntosVisita", "maxVisitasMes", "mesesVisitas"]) if (d && Number.isInteger(d[k]) && d[k] >= 0) c[k] = d[k];
  NIVELES.forEach((n) => { const v = d && d.niveles ? d.niveles[n.k] : undefined; c.niveles[n.k] = Number.isInteger(v) && v >= 0 ? v : n.bonus; });
  if (d && d.campana && typeof d.campana === "object") c.campana = { activa: d.campana.activa === true, multiplicador: Number(d.campana.multiplicador) >= 2 ? Number(d.campana.multiplicador) : 2, hasta: String(d.campana.hasta || ""), id: String(d.campana.id || "") };
  return c;
}
const hoyIso = (ahora) => { const d = new Date(ahora || Date.now()); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
// Campaña de puntos dobles en marcha (o null).
export function campanaActiva(cfg, ahora) {
  const c = cfg && cfg.campana;
  return c && c.activa && c.hasta && c.hasta >= hoyIso(ahora) ? c : null;
}
export const puntosPorAmigo = (cfg, ahora) => cfg.puntos * (campanaActiva(cfg, ahora) ? campanaActiva(cfg, ahora).multiplicador : 1);
export const puntosPorVisita = (cfg, ahora) => cfg.puntosVisita * (campanaActiva(cfg, ahora) ? campanaActiva(cfg, ahora).multiplicador : 1);
// Día de la jornada del bar (acaba a las 6:00), como el robot.
export const jornadaDe = (ms) => hoyIso((ms || Date.now()) - 6 * 3600000);
// Estado de la invitación de una persona: si su tarjeta tiene que salir, si aún no ha hecho la primera visita,
// cuántas visitas lleva y hasta cuándo cuentan.
export function estadoInvitacion(inv, cfg, ahora) {
  ahora = ahora || Date.now();
  if (!inv || !cfg || !cfg.activo) return { activa: false };
  const primera = inv.premiado !== true;
  const creado = inv.creado && inv.creado.toMillis ? inv.creado.toMillis() : ahora;
  const finMs = cfg.mesesVisitas ? creado + cfg.mesesVisitas * 30.5 * 864e5 : 0;
  const repite = !primera && (inv.puntos || 0) > 0 && cfg.puntosVisita > 0 && (!finMs || ahora < finMs);
  return { activa: primera || repite, primera: primera, visitas: primera ? 0 : 1 + (inv.visitas || 0), finMs: finMs, embajador: inv.refNombre || "" };
}
// Nivel alcanzado con esos amigos (o null) y el siguiente por alcanzar (o null si ya es Diamante).
export function nivelDe(amigos) { return NIVELES.filter((n) => amigos >= n.min).pop() || null; }
export function siguienteNivel(amigos) { return NIVELES.find((n) => amigos < n.min) || null; }
// Próximo premio para embajadores: el más barato que aún no alcanza, o el más caro que ya puede canjear.
export function proximoPremio(premios, saldo) {
  const l = (premios || []).filter((p) => p.activo === true && p.para !== "socios" && Number(p.coste) > 0).sort((a, b) => a.coste - b.coste);
  if (!l.length) return null;
  const falta = l.find((p) => p.coste > saldo);
  if (falta) return { premio: falta, faltan: falta.coste - saldo, alcanzado: l.filter((p) => p.coste <= saldo).pop() || null };
  return { premio: l[l.length - 1], faltan: 0, alcanzado: l[l.length - 1] };
}
// Resumen de las invitaciones de un embajador (también las visitas siguientes de sus amigos).
export function resumenInvitados(invs, ahora) {
  const vinieron = invs.filter((x) => x.premiado === true && (x.puntos || 0) > 0), mes = hoyIso(ahora).slice(0, 7);
  const visitasMes = invs.reduce((t, x) => t + (x.visitasMesK === mes ? x.visitasMesN || 0 : 0), 0);
  const puntosVisitas = invs.reduce((t, x) => t + (x.puntosVisitas || 0), 0);
  return { registrados: invs.length, vinieron: vinieron.length, esperando: invs.filter((x) => x.premiado !== true).length, visitasMes: visitasMes,
    ganados: vinieron.reduce((t, x) => t + (x.puntos || 0), 0) + puntosVisitas };
}
const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
export const nombreMes = (mes) => (mes ? MESES[Number(mes.slice(5, 7)) - 1] : "");
export const fechaCorta = (dia) => (dia ? Number(dia.slice(8, 10)) + " de " + MESES[Number(dia.slice(5, 7)) - 1] : "");
// </logica>

const el = (tag, txt, cls) => { const e = document.createElement(tag); if (txt !== undefined && txt !== null && txt !== "") e.textContent = txt; if (cls) e.className = cls; return e; };
const ms = (t) => (t && t.toMillis ? t.toMillis() : 0);

function estilos() {
  if (document.getElementById("estiloEmb")) return;
  const st = document.createElement("style");
  st.id = "estiloEmb";
  st.textContent =
    ".emb{margin:0 0 14px;padding:16px;border-radius:20px;border:1.5px solid rgba(255,225,77,.85);background:linear-gradient(150deg,rgba(255,225,77,.20),rgba(255,43,214,.16) 60%,rgba(139,92,255,.18));box-shadow:0 0 26px rgba(255,225,77,.28);color:#fff}" +
    ".emb .e-cab{display:flex;justify-content:space-between;align-items:center;gap:8px;font-family:'Bungee','Rubik',sans-serif;font-size:.9rem;color:#ffe14d}" +
    ".emb .e-niv{font-family:inherit;font-size:.78rem;padding:3px 10px;border-radius:999px;background:rgba(0,0,0,.35);color:#fff;white-space:nowrap}" +
    ".emb .e-pts{text-align:center;margin:10px 0 2px}.emb .e-pts b{display:block;font-family:'Bungee','Rubik',sans-serif;font-size:2.6rem;line-height:1;color:#ffe14d;text-shadow:0 0 18px rgba(255,225,77,.6)}" +
    ".emb .e-pts small{opacity:.85}.emb p{margin:6px 0;font-size:.9rem}.emb .e-barra{height:12px;border-radius:999px;background:rgba(0,0,0,.35);overflow:hidden;margin:8px 0 4px}" +
    ".emb .e-barra div{height:100%;border-radius:999px;background:linear-gradient(90deg,#5dff9a,#ffe14d,#ff2bd6)}.emb .e-meta{font-size:.85rem;text-align:center;opacity:.95}" +
    ".emb .e-camp{margin:10px 0;padding:8px 12px;border-radius:12px;background:linear-gradient(90deg,#ff5c7a,#ff2bd6);font-weight:800;text-align:center;font-size:.9rem;animation:eLatir 1.6s ease-in-out infinite}" +
    "@keyframes eLatir{50%{transform:scale(1.03)}}" +
    ".emb .e-btn{display:block;width:100%;margin:10px 0 0;padding:14px;border:0!important;border-radius:14px!important;font-weight:800!important;font-size:1.05rem;cursor:pointer;text-align:center;text-decoration:none;color:#0a0612!important;background:linear-gradient(135deg,#5dff9a,#19f2ff)!important;box-shadow:0 0 18px rgba(25,242,255,.45)}" +
    ".emb .e-fila{display:flex;gap:8px}.emb .e-fila>*{flex:1}.emb .e-sec{display:block;margin-top:8px;padding:10px;border-radius:12px!important;border:1px solid rgba(255,255,255,.4)!important;background:transparent!important;color:#fff!important;font-weight:700;font-size:.9rem;cursor:pointer;text-align:center;text-decoration:none;box-shadow:none}" +
    ".emb .e-nums{display:flex;gap:6px;margin-top:12px}.emb .e-nums div{flex:1;padding:8px 4px;border-radius:12px;background:rgba(0,0,0,.3);text-align:center}.emb .e-nums b{display:block;font-size:1.3rem}.emb .e-nums span{font-size:.72rem;opacity:.85}" +
    ".emb .e-qr{display:none;margin:10px auto 0;padding:12px;background:#fff;border-radius:14px;width:max-content;line-height:0}.emb .e-qr.ver{display:block}" +
    ".emb-lista .e-inv{display:flex;justify-content:space-between;gap:8px;padding:9px 0;border-top:1px solid rgba(255,255,255,.12);font-size:.9rem}.emb-lista .e-inv small{opacity:.75}" +
    ".emb-rank .e-r{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:12px;margin:4px 0;background:rgba(255,255,255,.06)}.emb-rank .e-r.yo{background:rgba(255,225,77,.18);border:1px solid rgba(255,225,77,.6)}" +
    ".emb-rank .e-r .p{width:28px;text-align:center;font-weight:800}.emb-rank .e-r .n{flex:1}.emb-rank .e-r .a{font-weight:800}" +
    ".emb-niv .e-n{display:flex;justify-content:space-between;padding:8px 0;border-top:1px solid rgba(255,255,255,.12);font-size:.9rem}.emb-niv .e-n.ok{color:#5dff9a}" +
    "#confeti{position:fixed;inset:0;z-index:999;display:flex;align-items:center;justify-content:center;background:rgba(10,6,18,.75)}" +
    "#confeti canvas{position:absolute;inset:0;width:100%;height:100%}#confeti .c-caja{position:relative;max-width:330px;margin:16px;padding:22px;border-radius:22px;text-align:center;background:linear-gradient(150deg,#2a1450,#150d27);border:2px solid #ffe14d;box-shadow:0 0 40px rgba(255,225,77,.5);color:#fff}" +
    "#confeti .c-caja b{display:block;font-family:'Bungee','Rubik',sans-serif;font-size:2.4rem;color:#ffe14d}#confeti .c-caja p{margin:8px 0}#confeti button{margin-top:10px;padding:12px 22px;border:0!important;border-radius:12px!important;font-weight:800;background:linear-gradient(135deg,#ff2bd6,#8b5cff)!important;color:#fff!important}";
  document.head.appendChild(st);
}

// ---------- compartir: WhatsApp, QR y copiar ----------
function cargarQR() {
  if (window.QRCode) return Promise.resolve();
  return new Promise((ok, mal) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js";
    s.onload = ok; s.onerror = mal;
    document.head.append(s);
  });
}
function botonesCompartir(link, cfg) {
  const caja = el("div");
  const texto = "Te invito a la app de Sweet Dreams 🎯: reserva diana, juega al trivial y gana premios. Regístrate con mi enlace y ven al bar: " + link;
  const comp = el("button", "📲 Compartir mi enlace", "e-btn"); comp.type = "button";
  comp.onclick = async () => {
    if (navigator.share) { try { await navigator.share({ title: "Sweet Dreams", text: texto }); return; } catch (e) { if (e && e.name === "AbortError") return; } }
    location.href = "https://wa.me/?text=" + encodeURIComponent(texto);
  };
  const fila = el("div", "", "e-fila");
  const bq = el("button", "🔳 Mi código QR", "e-sec"), bc = el("button", "🔗 Copiar enlace", "e-sec");
  bq.type = bc.type = "button";
  const qr = el("div", "", "e-qr");
  bq.onclick = async () => {
    if (qr.classList.toggle("ver") && !qr.firstChild) {
      try { await cargarQR(); new QRCode(qr, { text: link, width: 190, height: 190, colorDark: "#000000", colorLight: "#ffffff", correctLevel: QRCode.CorrectLevel.M }); }
      catch (e) { qr.style.lineHeight = "1.4"; qr.style.color = "#000"; qr.textContent = link; }
    }
    bq.textContent = qr.classList.contains("ver") ? "🔳 Ocultar QR" : "🔳 Mi código QR";
  };
  bc.onclick = async () => { try { await navigator.clipboard.writeText(link); bc.textContent = "✔ Copiado"; } catch (e) { bc.textContent = link; } };
  fila.append(bq, bc);
  caja.append(comp, fila, qr, el("p", "Que tu amigo lo escanee con la cámara del móvil, se registre y venga al bar: +" + puntosPorAmigo(cfg) + " puntos para ti.", "e-meta"));
  return caja;
}

// ---------- celebración (confeti) ----------
function confeti(titulo, texto) {
  if (document.getElementById("confeti")) return;
  const fondo = el("div"); fondo.id = "confeti";
  const cv = document.createElement("canvas"), caja = el("div", "", "c-caja"), b = el("button", "¡A por más!");
  caja.append(el("b", titulo), el("p", texto), b);
  fondo.append(cv, caja);
  document.body.append(fondo);
  const g = cv.getContext("2d"), W = (cv.width = innerWidth), H = (cv.height = innerHeight);
  const col = ["#ffe14d", "#ff2bd6", "#19f2ff", "#5dff9a", "#8b5cff"];
  const ps = Array.from({ length: 140 }, () => ({ x: Math.random() * W, y: -20 - Math.random() * H, v: 2 + Math.random() * 4, r: 4 + Math.random() * 5, c: col[Math.floor(Math.random() * 5)], a: Math.random() * 6 }));
  let vivo = true;
  const paso = () => { if (!vivo) return; g.clearRect(0, 0, W, H); ps.forEach((p) => { p.y += p.v; p.a += 0.1; p.x += Math.sin(p.a); if (p.y > H) p.y = -10; g.fillStyle = p.c; g.fillRect(p.x, p.y, p.r, p.r * 0.6); }); requestAnimationFrame(paso); };
  paso();
  if (navigator.vibrate) navigator.vibrate([60, 40, 120]);
  b.onclick = () => { vivo = false; fondo.remove(); };
}

async function datosEmbajador(db, uid, num) {
  const [sp, c, pr, inv, rk, emb] = await Promise.all([
    getDoc(doc(db, "socios_puntos", uid)).catch(() => null),
    getDoc(doc(db, "settings", "invitaciones")),
    getDocs(collection(db, "premios")).catch(() => null),
    num ? getDocs(query(collection(db, "invitaciones"), where("ref", "==", num))).catch(() => null) : null,
    getDoc(doc(db, "embajadores_ranking", "actual")).catch(() => null),
    getDoc(doc(db, "embajadores", uid)).catch(() => null),
  ]);
  return {
    saldo: sp && sp.exists() ? sp.data().puntos || 0 : 0,
    cfg: ajustesInvitar(c.exists() ? c.data() : null),
    premios: pr ? pr.docs.map((d) => Object.assign({ id: d.id }, d.data())) : [],
    invs: inv ? inv.docs.map((d) => Object.assign({ id: d.id }, d.data())) : [],
    ranking: rk && rk.exists() ? rk.data() : null,
    emb: emb && emb.exists() ? emb.data() : null,
  };
}

// ---------- inicio: el panel grande del embajador ----------
export async function montarPanel(db, user, ficha) {
  const tiles = document.querySelector(".tiles");
  let caja = document.getElementById("panelEmb");
  if (!tiles || !user || !ficha || !ficha.socioNum) { if (caja) caja.remove(); return false; }
  const d = await datosEmbajador(db, user.uid, ficha.socioNum);
  if (!d.emb || d.emb.activo !== true || !d.cfg.activo) { if (caja) caja.remove(); return false; }
  estilos();
  if (!caja) { caja = el("div"); caja.id = "panelEmb"; tiles.parentNode.insertBefore(caja, tiles); }
  caja.className = "emb";
  caja.innerHTML = "";
  const r = resumenInvitados(d.invs), niv = nivelDe(r.vinieron), sig = siguienteNivel(r.vinieron);
  const cab = el("div", "", "e-cab");
  cab.append(el("span", "👑 TU PANEL DE EMBAJADOR"), el("span", niv ? niv.ico + " " + niv.nom : "🌱 Novato", "e-niv"));
  const pts = el("div", "", "e-pts"); pts.append(el("b", String(d.saldo)), el("small", "puntos"));
  caja.append(cab, pts);
  // barra hacia el próximo premio
  const pp = proximoPremio(d.premios, d.saldo);
  if (pp) {
    const barra = el("div", "", "e-barra"), relleno = el("div");
    relleno.style.width = Math.max(4, Math.min(100, Math.round((100 * d.saldo) / pp.premio.coste))) + "%";
    barra.append(relleno);
    caja.append(barra, el("p", pp.faltan > 0 ? "Te faltan " + pp.faltan + " puntos para «" + pp.premio.nombre + "» (" + Math.ceil(pp.faltan / puntosPorAmigo(d.cfg)) + (Math.ceil(pp.faltan / puntosPorAmigo(d.cfg)) === 1 ? " amigo más)" : " amigos más)") : "🎁 ¡Ya puedes canjear «" + pp.alcanzado.nombre + "»!", "e-meta"));
  }
  const camp = campanaActiva(d.cfg);
  if (camp) caja.append(el("div", "🔥 ¡PUNTOS x" + camp.multiplicador + "! Hasta el " + fechaCorta(camp.hasta) + ", cada amigo vale " + puntosPorAmigo(d.cfg) + " puntos", "e-camp"));
  caja.append(botonesCompartir(enlaceInvitar(ficha.socioNum), d.cfg));
  const nums = el("div", "", "e-nums");
  [[r.registrados, "registrados"], [r.vinieron, "han venido"], [r.esperando, "por venir"]].forEach(([n, t]) => { const x = el("div"); x.append(el("b", String(n)), el("span", t)); nums.append(x); });
  caja.append(nums);
  if (d.cfg.puntosVisita > 0) caja.append(el("p", r.visitasMes ? "🔁 Tus amigos han vuelto " + r.visitasMes + (r.visitasMes === 1 ? " vez" : " veces") + " este mes (+" + puntosPorVisita(d.cfg) + " por cada vuelta)" : "🔁 Cada vez que un amigo vuelva al bar, +" + puntosPorVisita(d.cfg) + " puntos más para ti", "e-meta"));
  if (sig) caja.append(el("p", "Te " + (sig.min - r.vinieron === 1 ? "falta 1 amigo" : "faltan " + (sig.min - r.vinieron) + " amigos") + " para " + sig.ico + " " + sig.nom + (d.cfg.niveles[sig.k] ? " (+" + d.cfg.niveles[sig.k] + " puntos de regalo)" : ""), "e-meta"));
  if (d.ranking && d.ranking.lista) {
    const pos = d.ranking.lista.findIndex((x) => x.uid === user.uid);
    caja.append(el("p", (pos >= 0 ? "🏆 Vas " + (pos + 1) + "º en el ranking de " + nombreMes(d.ranking.mes) : "🏆 Aún no estás en el ranking de " + nombreMes(d.ranking.mes) + ": ¡trae a tu primer amigo!") + (d.cfg.premioMes ? " · Premio al 1º: " + d.cfg.premioMes : ""), "e-meta"));
  }
  const ver = el("a", "Ver mis premios, invitados y ranking ›", "e-sec"); ver.href = "mis-puntos.html";
  caja.append(ver);
  // celebración si ha ganado puntos desde la última vez que abrió la app
  try {
    const k = "sd_emb_" + user.uid, ant = JSON.parse(localStorage.getItem(k) || "null");
    if (ant && d.saldo > ant.saldo) {
      const nuevos = d.invs.filter((x) => x.premiado === true && (x.puntos || 0) > 0 && ms(x.premiadoEn) > ant.t).map((x) => x.nombre).filter(Boolean);
      confeti("+" + (d.saldo - ant.saldo) + " puntos", nuevos.length ? "🎉 ¡" + nuevos.join(", ") + (nuevos.length === 1 ? " ha venido" : " han venido") + " al bar gracias a ti!" : "🎉 ¡Has ganado puntos! Sigue invitando a tu gente.");
    }
    localStorage.setItem(k, JSON.stringify({ saldo: d.saldo, t: Date.now() }));
  } catch (e) {}
  return true;
}

// ---------- «Mis puntos»: enlace, niveles e invitados ----------
export async function montarDetalle(db, uid, num, caja) {
  if (!caja) return;
  caja.innerHTML = "";
  caja.className = "";
  const d = await datosEmbajador(db, uid, num);
  if (!d.emb || d.emb.activo !== true || !d.cfg.activo || !num) return;
  estilos();
  const r = resumenInvitados(d.invs);
  const top = el("div", "", "emb");
  top.append(el("div", "👑 TU ENLACE DE EMBAJADOR", "e-cab"), el("p", "Por cada amigo que se registre con tu enlace y venga al bar (consumiendo " + d.cfg.minimo.toFixed(2).replace(".", ",") + " € o más), te llevas " + puntosPorAmigo(d.cfg) + " puntos" + (d.cfg.maxMes ? " (hasta " + d.cfg.maxMes + " amigos al mes)." : ".")
    + (d.cfg.puntosVisita > 0 ? " Y cada vez que vuelva y valide su visita (una vez al día" + (d.cfg.mesesVisitas ? ", durante " + d.cfg.mesesVisitas + (d.cfg.mesesVisitas === 1 ? " mes" : " meses") : "") + "), " + puntosPorVisita(d.cfg) + " puntos más." : "")));
  const camp = campanaActiva(d.cfg);
  if (camp) top.append(el("div", "🔥 ¡PUNTOS x" + camp.multiplicador + " hasta el " + fechaCorta(camp.hasta) + "!", "e-camp"));
  top.append(botonesCompartir(enlaceInvitar(num), d.cfg));
  caja.append(top);
  // niveles
  const niv = el("div", "", "zona emb-niv");
  niv.append(el("h2", "🏅 Tus niveles"), el("p", "Has traído " + r.vinieron + (r.vinieron === 1 ? " amigo" : " amigos") + " al bar. Al subir de nivel te regalamos puntos extra.", "peq"));
  NIVELES.forEach((n) => { const f = el("div", "", "e-n" + (r.vinieron >= n.min ? " ok" : "")); f.append(el("span", (r.vinieron >= n.min ? "✔ " : "") + n.ico + " " + n.nom + " · " + n.min + " amigos"), el("span", d.cfg.niveles[n.k] ? "+" + d.cfg.niveles[n.k] + " puntos" : "")); niv.append(f); });
  caja.append(niv);
  // invitados
  const li = el("div", "", "zona emb-lista");
  li.append(el("h2", "👥 Tus invitados"), el("p", r.registrados ? r.registrados + " registrados · " + r.vinieron + " han venido · " + r.esperando + " por venir" + (r.visitasMes ? " · 🔁 " + r.visitasMes + " visitas este mes" : "") + " · " + r.ganados + " puntos ganados" : "Todavía no se ha registrado nadie con tu enlace. ¡Compártelo!", "peq"));
  d.invs.sort((a, b) => ms(b.creado) - ms(a.creado)).forEach((x) => {
    const f = el("div", "", "e-inv"), izq = el("div");
    izq.append(el("strong", x.nombre || "Amigo"), el("small", " · " + (ms(x.creado) ? new Date(ms(x.creado)).toLocaleDateString("es-ES", { day: "numeric", month: "short" }) : "")));
    f.append(izq, el("span", x.premiado === true ? ((x.puntos || 0) > 0 ? "✔ Vino · +" + x.puntos + (x.visitas ? " · 🔁 " + x.visitas + (x.visitas === 1 ? " vuelta" : " vueltas") + " +" + (x.puntosVisitas || 0) : "") : "✖ No cuenta") : "⏳ Por venir"));
    li.append(f);
  });
  if (r.esperando) li.append(el("p", "💡 Escribe a los que aún no han venido: en cuanto pasen por el bar, los puntos son tuyos.", "peq"));
  caja.append(li);
  const rk = el("div", "", "zona");
  caja.append(rk);
  await montarRanking(db, rk, uid, d);
}

// ---------- ranking de embajadores del mes ----------
export async function montarRanking(db, caja, uidPropio, datos) {
  if (!caja) return;
  try {
    const [rk, c, g] = await Promise.all([
      datos ? Promise.resolve(null) : getDoc(doc(db, "embajadores_ranking", "actual")),
      datos ? Promise.resolve(null) : getDoc(doc(db, "settings", "invitaciones")),
      getDocs(query(collection(db, "embajadores_ganadores"), orderBy("cerrado", "desc"), limit(3))).catch(() => null),
    ]);
    const ranking = datos ? datos.ranking : rk.exists() ? rk.data() : null, cfg = datos ? datos.cfg : ajustesInvitar(c.exists() ? c.data() : null);
    estilos();
    caja.classList.add("emb-rank");
    caja.innerHTML = "";
    caja.append(el("h2", "🏆 Ranking de embajadores" + (ranking ? " · " + nombreMes(ranking.mes) : "")));
    if (cfg.premioMes) caja.append(el("p", "🎁 Premio para el que más amigos traiga este mes: " + cfg.premioMes, "peq"));
    const lista = (ranking && ranking.lista) || [];
    if (!lista.length) caja.append(el("p", "Este mes aún no ha traído nadie a ningún amigo. ¡El primero se pone en cabeza!", "peq"));
    lista.slice(0, 10).forEach((x, i) => {
      const n = NIVELES.find((v) => v.k === x.nivel), f = el("div", "", "e-r" + (x.uid === uidPropio ? " yo" : ""));
      f.append(el("span", i === 0 ? "👑" : i + 1 + "º", "p"), el("span", x.n + (n ? " " + n.ico : "") + (x.uid === uidPropio ? " (tú)" : ""), "n"), el("span", x.amigos + (x.amigos === 1 ? " amigo" : " amigos"), "a"));
      caja.append(f);
    });
    if (ranking && ranking.totalPuntos) caja.append(el("p", "Este mes los embajadores ya han ganado " + ranking.totalPuntos + " puntos.", "peq"));
    if (g && !g.empty) {
      caja.append(el("h2", "👑 Últimos ganadores"));
      g.docs.forEach((d) => { const x = d.data(); caja.append(el("p", "🏆 " + nombreMes(x.mes) + ": " + x.n + " (" + x.amigos + " amigos)" + (x.premio ? " · " + x.premio : ""), "peq")); });
    }
  } catch (e) { caja.innerHTML = ""; }
}
