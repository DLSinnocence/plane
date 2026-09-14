import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  platform: "neutral",
  exports: {
    customExports: (exports) => ({
      ...exports,
      "./styles/chat-markdown.css": "./styles/chat-markdown.css",
    }),
  },
});
