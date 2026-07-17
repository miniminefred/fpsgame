import { defineConfig } from 'vite';

// Dev server on 8090 so it coexists with the blobgame on 8080.
export default defineConfig({
  server: {
    port: 8090,
    strictPort: true,
    open: true,
  },
  preview: {
    port: 8090,
    strictPort: true,
  },
});
