// Lógica de "Tu próximo partido": busca los próximos partidos de los equipos elegidos por la persona.
// Se usa desde la pantalla de inicio y desde "Mis equipos".

export const norm = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const DIAS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const fechaMs = (dia, hora) => new Date(dia + "T" + (hora || "00:00") + ":00").getTime();

// Convierte las filas del resumen en partidos y aplica los cambios del administrador.
export function ajustarPartidos(filas, cambios) {
  const res = [];
  for (const f of filas || []) {
    const x = { id: f[0], cat: f[1] === "p" ? "parejas" : "equipos", nivel: f[2], jornada: f[3], dia: f[4], hora: f[5], local: f[6], visitante: f[7], sede: f[8] || "", nota: f[9] || "", cambio: "", aplazado: false, extra: false };
    const c = cambios && cambios.get(x.id);
    if (c && c.estado === "movido") {
      x.cambio = "Cambiado de fecha (antes: " + String(c.diaOriginal || "").slice(8) + "/" + String(c.diaOriginal || "").slice(5, 7) + " a las " + (c.horaOriginal || "") + ")";
      x.dia = c.dia;
      x.hora = c.hora;
    } else if (c && c.estado === "aplazado") {
      x.aplazado = true;
      x.cambio = "Aplazado: pendiente de nueva fecha";
    }
    res.push(x);
  }
  if (cambios) {
    for (const [id, c] of cambios) {
      if (c.estado === "extra") res.push({ id: id, cat: c.categoria, nivel: Number(c.nivel), jornada: 0, dia: c.dia, hora: c.hora, local: c.local, visitante: c.visitante, sede: "Sweet Dreams", nota: "", cambio: "Partido añadido", aplazado: false, extra: true });
    }
  }
  return res;
}

// Equipos disponibles para elegir: { "parejas|2": ["Los Pintamonas", ...] }
export function equiposDe(filas) {
  const m = {};
  for (const f of filas || []) {
    const cat = f[1] === "p" ? "parejas" : "equipos", k = cat + "|" + f[2];
    m[k] = m[k] || new Set();
    for (const n of [f[6], f[7]]) if (n && norm(n) !== "bye") m[k].add(n);
  }
  const out = {};
  for (const k of Object.keys(m)) out[k] = [...m[k]].sort((a, b) => a.localeCompare(b, "es"));
  return out;
}

export function etiquetaNivel(cat, nivel) {
  return (cat === "parejas" ? "Parejas" : "Equipos") + " · Nivel " + nivel;
}

// equipos: [{ cat: "parejas", nivel: 2, equipo: "Los Pintamonas" }]
export function proximos(filas, cambios, equipos, ahora) {
  ahora = ahora || new Date();
  const mios = new Set((equipos || []).map((e) => e.cat + "|" + Number(e.nivel) + "|" + norm(e.equipo)));
  const todos = [];
  for (const x of ajustarPartidos(filas, cambios)) {
    const kl = x.cat + "|" + x.nivel + "|" + norm(x.local), kv = x.cat + "|" + x.nivel + "|" + norm(x.visitante);
    const esLocal = mios.has(kl), esVis = mios.has(kv);
    if (!esLocal && !esVis) continue;
    todos.push(Object.assign({}, x, { equipoMio: esLocal ? x.local : x.visitante, rival: esLocal ? x.visitante : x.local, esLocal: esLocal, ms: fechaMs(x.dia, x.hora) }));
  }
  const aplazados = todos.filter((x) => x.aplazado);
  const limite = ahora.getTime() - 2 * 3600000;
  const futuros = todos.filter((x) => !x.aplazado && x.ms >= limite).sort((a, b) => a.ms - b.ms);
  if (!futuros.length) return { grupo: [], despues: [], aplazados: aplazados };
  const dia = futuros[0].dia;
  const grupo = futuros.filter((x) => x.dia === dia);
  const vistos = new Set(grupo.map((x) => x.cat + "|" + x.nivel + "|" + norm(x.equipoMio)));
  const despues = [];
  for (const x of futuros) {
    const k = x.cat + "|" + x.nivel + "|" + norm(x.equipoMio);
    if (x.dia !== dia && !vistos.has(k)) { vistos.add(k); despues.push(x); }
  }
  return { grupo: grupo, despues: despues, aplazados: aplazados };
}

export function cuando(dia, ahora) {
  ahora = ahora || new Date();
  const a = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate()).getTime();
  const [y, m, d] = dia.split("-").map(Number);
  const n = Math.round((new Date(y, m - 1, d).getTime() - a) / 86400000);
  return n <= 0 ? "¡Hoy!" : n === 1 ? "¡Mañana!" : "En " + n + " días";
}

export function fechaLarga(dia) {
  const [y, m, d] = dia.split("-").map(Number);
  const f = new Date(y, m - 1, d);
  return DIAS[f.getDay()] + " " + d + " de " + MESES[m - 1];
}

export function mapsDe(sede, locales) {
  if (!sede) return "";
  const n = norm(sede);
  for (const nombre of Object.keys(locales || {})) {
    if (norm(nombre) === n) {
      const [dir, ciudad, maps] = locales[nombre];
      if (maps) return maps;
      return "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent([sede, dir, ciudad].filter(Boolean).join(", "));
    }
  }
  return "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(sede + ", Valladolid");
}
