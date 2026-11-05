// TECH-HO-RECOVERY-09L — Firebase Messaging service worker (background push).
//
// Real FCM delivery is UNVERIFIED: the Firebase emulator has no Cloud Messaging,
// so this worker only runs in a real staging/production project. It is registered
// as a module and receives its (non-secret, NEXT_PUBLIC) Firebase config via the
// registration query string, because a static file under /public cannot read
// process.env. It NEVER renders protected content — only the short, non-sensitive
// title the server placed in the push payload; the full item is fetched by the
// authenticated app after the technician taps it.
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import { getMessaging, onBackgroundMessage } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-messaging-sw.js";

const params = new URLSearchParams(self.location.search);
const config = {
  apiKey: params.get("apiKey") ?? "",
  authDomain: params.get("authDomain") ?? "",
  projectId: params.get("projectId") ?? "",
  messagingSenderId: params.get("messagingSenderId") ?? "",
  appId: params.get("appId") ?? "",
};

// A backgrounded or closed Service Worker may be started for a config-less
// event; bail out rather than throw so FCM can still surface its own tray item.
if (config.apiKey && config.projectId && config.messagingSenderId) {
  const app = getApps().length ? getApps()[0] : initializeApp(config);
  const messaging = getMessaging(app);

  onBackgroundMessage(messaging, (payload) => {
    // Delivery is at-least-once; rendering here is NOT a read or action receipt.
    const notificationTitle = payload?.notification?.title ?? "ShiftChange notification";
    const route = payload?.data?.route ?? "/technician";
    self.registration.showNotification(notificationTitle, {
      body: "Open ShiftChange to view details.",
      icon: "/icon.svg",
      badge: "/icon.svg",
      data: { route, notificationId: payload?.data?.notificationId ?? null },
      tag: payload?.data?.notificationId ?? "shiftchange",
    });
  });

  self.addEventListener("notificationclick", (event) => {
    event.notification.close();
    const route = event.notification?.data?.route ?? "/technician";
    event.waitUntil(
      self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
        for (const client of clientList) {
          if ("focus" in client) {
            return client.navigate(route).then(() => client.focus());
          }
        }
        return self.clients.openWindow(route);
      }),
    );
  });
}
