import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare()],
  // Lets a `cloudflared tunnel --url` quick tunnel reach the dev server.
  server: { allowedHosts: [".trycloudflare.com"] },
});
