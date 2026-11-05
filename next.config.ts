
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // A second concurrent dev server needs its own build output so the two
  // environments never overwrite each other. Unset keeps the default ".next".
  distDir: process.env.NEXT_DIST_DIR ?? ".next",

  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;