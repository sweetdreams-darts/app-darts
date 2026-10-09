// Límites de reserva por persona: cuenta bloqueada, máximo de reservas activas y duración máxima.
// Se carga desde reservar.html y actúa sobre sus botones sin tocar el resto de la pantalla.
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js";
import { getFirestore, doc, collection, getDoc, getDocs, query, where } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";

const app = getApps().length ? getApps()[0] : initializeApp({
  apiKey: "AIzaSyByyLDyO2f0AYGtzVgdL006DRT2AE0n7kw",
  authDomain: "sweet-dreams-darts.firebaseapp.com",
  projectId: "sweet-dreams-darts",
  storageBucket: "sweet-dreams-darts.firebasestorage.app",
  messagingSenderId: "232279000383",
  appId: "1:232279000383:web:f40d9ae65a4266f372bf8a"
});
const auth = getAuth(app);
const db = getFirestore(app);
const $ = (id) => document.getElementById(id);
const lim = { listo: false, admin: false, bloqueado: false, maxActivas: 3, maxHoras: 4, activas: 0 };

function aviso(t) {
  const m = $("msg");
  if (m) { m.textContent = t; m.className = ""; }
}

// <logica>
function motivoDeBloqueo(l, ini, fin) {
  if (l.bloqueado) return "Tu cuenta no puede hacer reservas ahora mismo. Habla con el bar.";
  if (l.activas >= l.maxActivas) return "Ya tienes " + l.activas + (l.activas === 1 ? " reserva activa" : " reservas activas") + ". El máximo es " + l.maxActivas + ". Cancela alguna o espera a que termine.";
  if (ini && fin && fin - ini > l.maxHoras * 3600000) return "Cada reserva puede durar como máximo " + l.maxHoras + (l.maxHoras === 1 ? " hora." : " horas.");
  return "";
}
// </logica>

function recortarFin() {
  const fin = $("fin"), ini = $("ini");
  if (!lim.listo || lim.admin || !fin || !ini) return;
  const t0 = Number(ini.value);
  if (!t0) return;
  let quitado = false;
  [...fin.options].forEach((o) => { if (Number(o.value) - t0 > lim.maxHoras * 3600000) { o.remove(); quitado = true; } });
  if (quitado && fin.options.length) fin.selectedIndex = Math.min(3, fin.options.length - 1);
}

onAuthStateChanged(auth, async (u) => {
  if (!u) return;
  try {
    const [f, s, r] = await Promise.all([
      getDoc(doc(db, "users", u.uid)),
      getDoc(doc(db, "settings", "reservas")),
      getDocs(query(collection(db, "reservations"), where("uid", "==", u.uid)))
    ]);
    const ficha = f.exists() ? f.data() : {};
    const c = s.exists() ? s.data() : {};
    lim.admin = ficha.role === "admin";
    lim.bloqueado = ficha.bloqueado === true;
    lim.maxActivas = Number(c.maxActivas) > 0 ? Number(c.maxActivas) : 3;
    lim.maxHoras = Number(c.maxHoras) > 0 ? Number(c.maxHoras) : 4;
    const ahora = Date.now();
    lim.activas = r.docs.filter((d) => d.data().fin && d.data().fin.toMillis() > ahora).length;
    lim.listo = true;
    if (lim.bloqueado && !lim.admin) aviso(motivoDeBloqueo(lim, 0, 0));
    recortarFin();
  } catch (e) { /* si algo falla, no se aplican límites en pantalla (las reglas del servidor siguen mandando) */ }
});

document.addEventListener("click", (e) => {
  const b = e.target && e.target.closest ? e.target.closest("#reservar") : null;
  if (!b || !lim.listo || lim.admin) return;
  const motivo = motivoDeBloqueo(lim, Number($("ini").value), Number($("fin").value));
  if (motivo) {
    e.stopImmediatePropagation();
    e.preventDefault();
    aviso(motivo);
  }
}, true);

if ($("fin")) new MutationObserver(recortarFin).observe($("fin"), { childList: true });
if ($("ini")) $("ini").addEventListener("change", () => setTimeout(recortarFin, 0));
if ($("msg")) new MutationObserver(() => { if (($("msg").textContent || "").indexOf("✔ Reserva hecha") === 0) lim.activas++; }).observe($("msg"), { childList: true, characterData: true, subtree: true });
