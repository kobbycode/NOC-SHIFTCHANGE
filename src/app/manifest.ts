import type { MetadataRoute } from "next";

// TECH-HO-RECOVERY-09L — installable PWA manifest. Next serves this at /manifest.webmanifest
// and it is linked from the root layout. Installability + a service worker are
// prerequisites for Web Push (FCM). The theme/background are non-sensitive.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "ShiftChange 2.0",
    short_name: "ShiftChange",
    description: "Technical Department Shift Management and Handover System",
    start_url: "/technician",
    scope: "/",
    display: "standalone",
    background_color: "#0b1220",
    theme_color: "#0b1220",
    // SVG "any" size keeps the milestone free of binary assets; real device
    // staging adds raster PNG icons.
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/icon-maskable.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" },
    ],
  };
}
