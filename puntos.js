// Reglas de cálculo del programa de socios: puntos por compra, cupones y movimientos.
// Se usa desde la caja del camarero, "Mis puntos" y el panel del administrador.

export const CONFIG_POR_DEFECTO = { puntosPorEuro: 1, maxImporte: 100, deshacerSeg: 600 };

export function configDe(d) {
  const c = Object.assign({}, CONFIG_POR_DEFECTO);
  if (d && Number(d.puntosPorEuro) > 0) c.puntosPorEuro = Number(d.puntosPorEuro);
  if (d && Number(d.maxImporte) > 0) c.maxImporte = Number(d.maxImporte);
  if (d && Number(d.deshacerSeg) > 0) c.deshacerSeg = Number(d.deshacerSeg);
  return c;
}

// Importe escrito por el camarero ("12,5", "12.50", "7") → número de euros o error legible.
export function importeValido(txt, max) {
  const t = String(txt || "").trim().replace(",", ".");
  if (!t) return { ok: false, error: "Escribe el importe." };
  if (!/^\d{1,5}(\.\d{1,2})?$/.test(t)) return { ok: false, error: "Importe no válido. Ejemplo: 12,50" };
  const v = Math.round(parseFloat(t) * 100) / 100;
  if (v <= 0) return { ok: false, error: "El importe debe ser mayor que 0." };
  if (v > max) return { ok: false, error: "El máximo por cobro es " + max + " €. Si es correcto, sumas los puntos desde el panel de administrador." };
  return { ok: true, valor: v };
}

// Puntos que corresponden a un importe (siempre enteros, redondeando hacia abajo).
export function puntosDeCompra(importe, puntosPorEuro) {
  return Math.floor((Math.round(importe * 100) * puntosPorEuro) / 100 + 1e-9);
}

export function fechaUTC(ms) {
  const d = new Date(ms);
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

export function mesDe(ms) {
  const d = new Date(ms);
  return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0");
}

// Identificador del cupón: controla cuántas veces puede pedirlo cada persona.
//   "una" → solo una vez en la vida · "dia" → una vez al día · "sin" → las veces que quiera (cuesta puntos)
export function idCupon(uid, premioId, limite, ms, aleatorio) {
  if (limite === "una") return uid + "_" + premioId;
  if (limite === "dia") return uid + "_" + premioId + "_" + fechaUTC(ms);
  return uid + "_" + premioId + "_" + aleatorio;
}

const ALFABETO = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export function codigoCupon(aleatorio) {
  let s = "";
  for (let i = 0; i < 4; i++) s += ALFABETO[Math.floor(aleatorio() * ALFABETO.length)];
  return s;
}

export function estadoCupon(c, ahora) {
  if (c.estado === "canjeado") return "canjeado";
  const cad = c.caduca && c.caduca.toMillis ? c.caduca.toMillis() : Number(c.caduca) || 0;
  return cad && cad <= ahora ? "caducado" : "pendiente";
}

export function textoMovimiento(m) {
  const sig = m.puntos > 0 ? "+" + m.puntos : String(m.puntos);
  if (m.tipo === "compra") return "Compra de " + Number(m.importe).toFixed(2).replace(".", ",") + " € · " + sig + " puntos";
  if (m.tipo === "canje") return "Canje: " + (m.nota || "premio") + " · " + sig + " puntos";
  if (m.tipo === "deshacer") return "Corrección · " + sig + " puntos";
  return "Ajuste" + (m.nota ? " (" + m.nota + ")" : "") + " · " + sig + " puntos";
}

// ¿Puede canjearse este premio con este saldo?
export function faltan(coste, saldo) {
  return Math.max(0, coste - saldo);
}
