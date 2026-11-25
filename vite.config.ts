import { defineScoutThinViteConfig } from "scout-app/vite";

export default defineScoutThinViteConfig({
  product: "Chat",
  variant: "chat",
  rail: "full",
  port: 4804,
  serverEntry: "src/server.ts",
});
