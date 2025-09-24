import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [cloudflare()],
  build: {
    rollupOptions: {
      output: {
        // Ensure ChatRoom export is preserved
        exports: "named",
      },
    },
  },
});
