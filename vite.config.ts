import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// @ts-expect-error type error without @types/node package
import process from "node:process";
import { readFileSync } from "node:fs";
const host = process.env.TAURI_DEV_HOST;

// 从 package.json 注入应用版本号，前端用 __APP_VERSION__ 读取
const appVersion = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version as string;

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(appVersion) },
  clearScreen: false,
  server: {
    port: 1440,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1441 } : undefined,
    watch: { ignored: ["**/src-tauri/**", "**/server/**"] },
  },
}));
