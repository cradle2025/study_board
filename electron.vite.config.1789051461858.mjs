// electron.vite.config.ts
import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
var alias = {
  "@shared": resolve("src/shared"),
  "@main": resolve("src/main"),
  "@renderer": resolve("src/renderer")
};
var CSP_PROD = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: sb-asset:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "media-src 'self' sb-asset:",
  "object-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'self' blob:",
  "base-uri 'none'",
  "form-action 'none'"
].join("; ");
var CSP_DEV = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: sb-asset:",
  "font-src 'self' data:",
  "connect-src 'self' ws://localhost:* ws://127.0.0.1:*",
  "media-src 'self' sb-asset:",
  "object-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'self' blob:",
  "base-uri 'none'",
  "form-action 'none'"
].join("; ");
function cspPlugin() {
  return {
    name: "study-board:csp",
    transformIndexHtml(html, ctx) {
      const isDev = Boolean(ctx.server);
      return html.replace("%CSP%", isDev ? CSP_DEV : CSP_PROD).replace(/\s+crossorigin(="[^"]*")?/g, "");
    }
  };
}
var electron_vite_config_default = defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    build: {
      target: "node20",
      sourcemap: false,
      rollupOptions: {
        output: { format: "cjs", entryFileNames: "[name].js" }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    build: {
      target: "node20",
      sourcemap: false,
      rollupOptions: {
        output: { format: "cjs", entryFileNames: "[name].js" }
      }
    }
  },
  renderer: {
    root: resolve("src/renderer"),
    plugins: [cspPlugin()],
    resolve: { alias },
    build: {
      target: "chrome128",
      sourcemap: false,
      // file:// 场景下 modulepreload 提示没有意义，反而多出一次资源请求
      modulePreload: false,
      chunkSizeWarningLimit: 900,
      rollupOptions: {
        input: { index: resolve("src/renderer/index.html") }
      }
    }
  }
});
export {
  electron_vite_config_default as default
};
