// Tattoo Art Customs Web Push service worker.
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { /* plain text */ }
  const title = data.title || 'Tattoo Art Customs';
  const body = data.body || 'You have a new notification.';
  const url = data.url || '/notifications';
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: '/icon.png',
      badge: '/icon.png',
      data: { url },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/notifications';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (c.url.includes(self.location.origin) && 'focus' in c) return c.focus();
      }
      return clients.openWindow(url);
    })
  );
});
