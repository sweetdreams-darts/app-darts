// Pie de página de Sweet Dreams: contacto, cómo llegar, reseña de Google y enlaces legales.
// Se añade solo al final de la página donde se cargue este archivo.
(function () {
  var TELEFONO = "658424694";
  var DIRECCION = "Sweet Dreams, Calle Paraíso 11, 47003 Valladolid";
  var q = encodeURIComponent(DIRECCION);
  var enlaces = [
    { icono: "📞", texto: "Llamar", sub: "658 42 46 94", href: "tel:+34" + TELEFONO, color: "#19f2ff" },
    { icono: "💬", texto: "WhatsApp", sub: "Escríbenos", href: "https://wa.me/34" + TELEFONO + "?text=" + encodeURIComponent("Hola Sweet Dreams, os escribo desde la app."), color: "#5dff9a", ext: true },
    { icono: "📍", texto: "Cómo llegar", sub: "Abrir en mapas", href: "https://www.google.com/maps/dir/?api=1&destination=" + q, color: "#ffe14d", ext: true },
    { icono: "⭐", texto: "Valóranos", sub: "Opinión en Google", href: "https://www.google.com/maps/search/?api=1&query=" + q, color: "#ff2bd6", ext: true }
  ];

  var css = document.createElement("style");
  css.textContent =
    ".pieSD{margin:22px 0 8px;padding:16px;border-radius:18px;border:1px solid rgba(255,43,214,.35);background:linear-gradient(160deg,rgba(255,43,214,.10),rgba(25,242,255,.07));text-align:center;line-height:1.35}" +
    ".pieSD h3{margin:0 0 4px;font-size:1.05rem}" +
    ".pieSD .dir{margin:0 0 12px;opacity:.85;font-size:.9rem}" +
    ".pieSD .rej{display:grid;grid-template-columns:1fr 1fr;gap:8px}" +
    ".pieSD a.btn{display:block;padding:10px 6px;border-radius:14px;border:1.5px solid var(--c);text-decoration:none;color:#fff!important;background:rgba(10,6,18,.55);box-shadow:0 0 12px rgba(0,0,0,.35)}" +
    ".pieSD a.btn b{display:block;font-size:.95rem;color:var(--c)}" +
    ".pieSD a.btn span{display:block;font-size:.75rem;opacity:.8;color:#fff}" +
    ".pieSD .hor{margin:12px 0 0;font-size:.78rem;opacity:.75}" +
    ".pieSD .legal{margin:10px 0 0;font-size:.74rem;opacity:.7}" +
    ".pieSD .legal a{color:inherit!important;text-decoration:underline}";
  document.head.appendChild(css);

  var caja = document.createElement("div");
  caja.className = "pieSD";
  var h = document.createElement("h3");
  h.textContent = "Sweet Dreams · Music · Friends";
  var dir = document.createElement("p");
  dir.className = "dir";
  dir.textContent = "C/ Paraíso, 11 · 47003 Valladolid";
  var rej = document.createElement("div");
  rej.className = "rej";
  enlaces.forEach(function (e) {
    var a = document.createElement("a");
    a.className = "btn";
    a.href = e.href;
    a.style.setProperty("--c", e.color);
    if (e.ext) { a.target = "_blank"; a.rel = "noopener"; }
    var b = document.createElement("b");
    b.textContent = e.icono + " " + e.texto;
    var s = document.createElement("span");
    s.textContent = e.sub;
    a.appendChild(b);
    a.appendChild(s);
    rej.appendChild(a);
  });
  var hor = document.createElement("p");
  hor.className = "hor";
  hor.textContent = "Horario habitual: dom a mié 17:00–03:00 · jue 17:00–04:00 · vie y sáb 17:00–04:30";
  var legal = document.createElement("p");
  legal.className = "legal";
  legal.appendChild(document.createTextNode("Sweet Dreams C.B. · NIF E47761556 · "));
  var pr = document.createElement("a");
  pr.href = "privacidad.html";
  pr.textContent = "Política de privacidad";
  legal.appendChild(pr);
  caja.appendChild(h);
  caja.appendChild(dir);
  caja.appendChild(rej);
  caja.appendChild(hor);
  caja.appendChild(legal);

  function colocar() {
    var main = document.querySelector("main") || document.body;
    var ref = main.querySelector(".pie");
    if (ref) main.insertBefore(caja, ref); else main.appendChild(caja);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", colocar); else colocar();
})();
