import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // apps/web already owns 5173.
    // 5174 clashes with storybook on my machine — am
    port: 5174,
    // Same as apps/web: no CORS on the API. Run with VITE_ADMIN_API_BASE_URL=
    // (empty) to go through this proxy.
    proxy: { "/v1": "http://localhost:3000" },
  },
});
