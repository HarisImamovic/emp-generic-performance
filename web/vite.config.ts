/// <reference types="vitest" />
import { type Plugin, defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The built page may only load its own files and may not send data anywhere.
// (Added at build time only: the dev server needs inline scripts.)
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'none'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const contentSecurityPolicy = (): Plugin => ({
  name: "content-security-policy",
  apply: "build",
  transformIndexHtml: (html) =>
    html.replace(
      '<meta charset="UTF-8" />',
      `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`,
    ),
});

export default defineConfig({
  // Relative asset paths, so the build works under any URL path
  // (e.g. https://<user>.github.io/<repo>/).
  base: "./",
  plugins: [react(), contentSecurityPolicy()],
  build: {
    chunkSizeWarningLimit: 1500,
  },
  test: {
    environment: "node",
    testTimeout: 30000,
  },
});
