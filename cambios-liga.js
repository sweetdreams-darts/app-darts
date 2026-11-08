// Cambios especiales de partidos de liga (solo parejas):
//   · «Cambiar ida por vuelta»: se intercambian local, visitante y sede entre la ida y la vuelta.
//   · «Jugar online desde Sweet Dreams»: un partido de otro local se juega online y el equipo del bar ocupa una diana G3.
// Se guardan aparte de los cambios de fecha, en liga_config/cambio_<id>~cruce y liga_config/cambio_<id>~online,
// para que se puedan combinar con un cambio de fecha sin pisarse.

const sinTildes = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
export const clave = (s) => sinTildes(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const pad = (n) => String(n).padStart(2, "0");
export const Q = 15 * 60000;
export const aMs = (dia, h, m) => { const [y, mo, d] = dia.split("-").map(Number); return new Date(y, mo - 1, d, h, m || 0).getTime(); };
export const msDe = (dia, hora) => aMs(dia, Number(hora.slice(0, 2)), Number(hora.slice(3, 5)));
export const hhmm = (ms) => { const d = new Date(ms); return pad(d.getHours()) + ":" + pad(d.getMinutes()); };
const DIAS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"], MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
export const diaCorto = (dia) => { const [y, m, d] = dia.split("-").map(Number); return DIAS[new Date(y, m - 1, d).getDay()] + " " + d + " " + MESES[m - 1]; };
// Duración de cada partida (el bloqueo empieza 30 minutos antes): parejas 1 h 15 (niveles 1-5) o 1 h 30; equipos 2 h 15 o 2 h 30.
export function duracion(cat, nivel) {
  const bajo = Number(nivel) >= 1 && Number(nivel) <= 5;
  return (cat === "parejas" ? (bajo ? 75 : 90) : (bajo ? 135 : 150)) * 60000;
}
export const intervaloPara = (cat, pMs, nivel) => [pMs - 30 * 60000, pMs + duracion(cat, nivel)];
export const idsSlots = (dId, iv) => { const r = []; for (let t = iv[0]; t < iv[1]; t += Q) r.push(dId + "_" + t); return r; };

export const cruceDe = (cambios, id) => (cambios && cambios.get(id + "~cruce")) || null;
export const onlineDe = (cambios, id) => (cambios && cambios.get(id + "~online")) || null;

// Cómo queda de verdad un partido (p: documento de liga_partidos con su id) con todos los cambios aplicados.
export function efectivo(p, cambios) {
  const cr = cruceDe(cambios, p.id), on = onlineDe(cambios, p.id), c = cambios && cambios.get(p.id);
  const e = { id: p.id, categoria: p.categoria, nivel: p.nivel, temporada: p.temporada, jornada: p.jornada,
    local: p.local, visitante: p.visitante, sede: p.sede || "", enSD: p.categoria === "parejas" ? p.enSweetDreams === true : true,
    dia: p.dia, hora: p.hora, estado: "normal", cruce: !!cr, online: on };
  if (cr) Object.assign(e, { local: cr.local, visitante: cr.visitante, sede: cr.sede || "", enSD: cr.enSD === true });
  if (c && c.estado === "movido") Object.assign(e, { dia: c.dia, hora: c.hora, estado: "movido" });
  else if (c && c.estado === "aplazado") e.estado = "aplazado";
  return e;
}
// Texto para enseñar debajo del partido.
export function etiquetas(e) {
  const t = [];
  if (e.cruce) t.push("🔁 Ida y vuelta cambiadas");
  if (e.online) t.push("💻 Online: " + (e.online.equipo || "") + " juega desde Sweet Dreams");
  return t;
}
// La vuelta de un partido: mismo nivel y temporada, con local y visitante al revés (según el calendario de la liga).
export function vueltaDe(p, partidos) {
  return partidos.find((x) => x.id !== p.id && x.categoria === p.categoria && String(x.nivel) === String(p.nivel) && x.temporada === p.temporada
    && clave(x.local) === clave(p.visitante) && clave(x.visitante) === clave(p.local)) || null;
}
// ¿Se puede cambiar la ida por la vuelta? Devuelve "" si se puede, o el motivo.
export function motivoNoCruce(eA, eB, hoy) {
  if (!eB) return "No encuentro la vuelta de este partido en el calendario.";
  if (eA.categoria !== "parejas") return "Solo se puede en la liga de parejas.";
  if (eA.estado === "aplazado" || eB.estado === "aplazado") return "Uno de los dos partidos está aplazado: ponle fecha primero.";
  if (eA.online || eB.online) return "Uno de los dos partidos se juega online: quita eso primero.";
  if (eA.dia < hoy || eB.dia < hoy) return "Uno de los dos partidos ya se ha jugado.";
  return "";
}
// ¿Se puede jugar online desde Sweet Dreams?
export function motivoNoOnline(e, hoy) {
  if (e.categoria !== "parejas") return "Solo se puede en la liga de parejas.";
  if (e.online) return "Ya se juega online.";
  if (e.enSD) return "Este partido ya se juega en Sweet Dreams.";
  if (e.estado === "aplazado") return "Está aplazado: ponle fecha primero.";
  if (e.dia < hoy) return "Este partido ya se ha jugado.";
  return "";
}
// Dianas libres para un partido a una hora. «ocupado(idSlot)» dice si ese hueco de 15 minutos está cogido.
// Para jugar online hacen falta dianas con online (G3).
export function dianasLibres(cat, nivel, pMs, dianas, ocupado, soloOnline) {
  const iv = intervaloPara(cat, pMs, nivel);
  return dianas.filter((d) => (soloOnline || cat !== "parejas" ? d.online : true) && idsSlots(d.id, iv).every((id) => !ocupado(id)));
}

const nombresDe = (e) => ({ local: e.local, visitante: e.visitante, sede: e.sede, enSD: e.enSD });
const igual = (a, b) => a.local === b.local && a.visitante === b.visitante && (a.sede || "") === (b.sede || "") && a.enSD === b.enSD;
function bloqueoNuevo(e, pMs, dianaId, origen, nota) {
  const iv = intervaloPara(e.categoria, pMs, e.nivel);
  return { origen: origen, categoria: e.categoria, nivel: e.nivel, local: e.local, visitante: e.visitante, dianaId: dianaId, partidoMs: pMs, inicioMs: iv[0], finMs: iv[1], estado: "activo", dia: e.dia, nota: nota || "" };
}

// Todo lo que hay que escribir para cambiar la ida por la vuelta.
//   pA, pB: los dos partidos (como vienen de la liga) · eA, eB: cómo están ahora · bA, bB: sus bloqueos de diana (o null)
//   dianas: { [idPartido]: idDiana } para el partido que pasa a jugarse en Sweet Dreams.
export function opsCruce(pA, pB, eA, eB, bA, bB, dianas) {
  const ops = { borrarSlots: [], slots: [], bloqueos: [], docs: [] };
  const crudo = (p) => ({ local: p.local, visitante: p.visitante, sede: p.sede || "", enSD: p.categoria === "parejas" ? p.enSweetDreams === true : true });
  const pares = [[pA, eA, bA, eB, pB], [pB, eB, bB, eA, pA]];
  for (const [p, e, b, otro, pOtro] of pares) {
    const nuevo = nombresDe(otro);   // el partido se queda con el local, el visitante y la sede del otro
    const ahora = Object.assign({}, e, nuevo);
    const pMs = msDe(e.dia, e.hora);
    if (e.enSD && !nuevo.enSD) {
      // deja de jugarse en Sweet Dreams: se libera la diana y se deja marcado para que no se vuelva a bloquear
      if (b && b.estado === "activo") ops.borrarSlots.push(...idsSlots(b.dianaId, [b.inicioMs, b.finMs]));
      ops.bloqueos.push({ id: p.id, datos: Object.assign({}, b || bloqueoNuevo(ahora, pMs, "", "cruce"), { local: ahora.local, visitante: ahora.visitante, estado: "fuera" }) });
    } else if (!e.enSD && nuevo.enSD) {
      const dId = dianas && dianas[p.id];
      if (!dId) throw new Error("Falta elegir la diana para el " + diaCorto(e.dia) + ".");
      const bl = bloqueoNuevo(ahora, pMs, dId, "cruce", "🔁 Ida y vuelta cambiadas");
      ops.bloqueos.push({ id: p.id, datos: bl });
      idsSlots(dId, [bl.inicioMs, bl.finMs]).forEach((id) => ops.slots.push({ id: id, dianaId: dId, partidoId: p.id }));
    } else if (e.enSD && nuevo.enSD && b) {
      ops.bloqueos.push({ id: p.id, datos: Object.assign({}, b, { local: ahora.local, visitante: ahora.visitante }) });
    }
    ops.docs.push({ id: "cambio_" + p.id + "~cruce", datos: igual(nuevo, crudo(p)) ? null : Object.assign({}, nuevo, { con: pOtro.id, jornadaCon: pOtro.jornada || 0 }) });
  }
  ops.bloqueos.forEach((x) => { delete x.datos.id; });
  return ops;
}
// Jugar online desde Sweet Dreams (o quitarlo).
export function opsOnline(e, dianaId, equipo) {
  const pMs = msDe(e.dia, e.hora), bl = bloqueoNuevo(e, pMs, dianaId, "online", "💻 Online desde Sweet Dreams (" + equipo + ")");
  return { borrarSlots: [], slots: idsSlots(dianaId, [bl.inicioMs, bl.finMs]).map((id) => ({ id: id, dianaId: dianaId, partidoId: e.id })),
    bloqueos: [{ id: e.id, datos: bl }], docs: [{ id: "cambio_" + e.id + "~online", datos: { equipo: equipo, dianaId: dianaId } }] };
}
export function opsQuitarOnline(e, b) {
  return { borrarSlots: b && b.estado === "activo" ? idsSlots(b.dianaId, [b.inicioMs, b.finMs]) : [], slots: [], bloqueos: [{ id: e.id, borrar: true }], docs: [{ id: "cambio_" + e.id + "~online", datos: null }] };
}
// Escribe los cambios en Firebase (F: funciones de Firestore { doc, writeBatch, Timestamp }).
export async function escribir(db, F, ops) {
  const lote = [];
  ops.borrarSlots.forEach((id) => lote.push((b) => b.delete(F.doc(db, "slots", id))));
  ops.slots.forEach((s) => lote.push((b) => b.set(F.doc(db, "slots", s.id), { dianaId: s.dianaId, inicio: F.Timestamp.fromMillis(Number(s.id.split("_").pop())), uid: "liga", tipo: "liga", partidoId: s.partidoId })));
  ops.bloqueos.forEach((x) => lote.push((b) => (x.borrar ? b.delete(F.doc(db, "liga_bloqueos", x.id)) : b.set(F.doc(db, "liga_bloqueos", x.id), x.datos))));
  ops.docs.forEach((x) => lote.push((b) => (x.datos ? b.set(F.doc(db, "liga_config", x.id), x.datos) : b.delete(F.doc(db, "liga_config", x.id)))));
  for (let i = 0; i < lote.length; i += 400) { const b = F.writeBatch(db); lote.slice(i, i + 400).forEach((f) => f(b)); await b.commit(); }
}
// Mensaje para avisar a la organización y al otro equipo.
export function textoCruce(eA, eB) {
  return "J" + eA.jornada + " (" + diaCorto(eA.dia) + " " + eA.hora + ") se jugará en " + (eB.sede || "?") + " con " + eB.local + " de local, y J" + eB.jornada + " (" + diaCorto(eB.dia) + " " + eB.hora + ") en " + (eA.sede || "?") + " con " + eA.local + " de local.";
}
