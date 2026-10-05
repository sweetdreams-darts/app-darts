// Service worker: mantiene la app instalable y muestra los avisos (notificaciones push).
// No guarda nada en caché a propósito, para que siempre veas la última versión.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});

self.addEventListener("push", (event) => {
  let p = {};
  try { p = event.data ? event.data.json() : {}; } catch (e) {}
  const d = Object.assign({}, p.notification || {}, p.data || {});
  event.waitUntil(self.registration.showNotification(d.title || "Sweet Dreams", {
    body: d.body || "",
    icon: "icono-192.png",
    badge: "icono-192.png",
    tag: d.tag || undefined,
    data: { url: d.url || "./" }
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "./";
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((ws) => {
    for (const w of ws) { if ("focus" in w) return w.focus(); }
    return self.clients.openWindow(url);
  }));
});
