import { defineConfig } from "mygo-cli";

export default defineConfig({
  name: "ChisaCloudCode",
  identifier: "com.chisacloudcode.desktop",
  version: "0.1.11",
  icon: "resources/icon.png",
  // `mygo dev` runs devCommand and loads devUrl; `mygo build` runs
  // buildCommand and embeds frontendDist into the app.
  devUrl: `http://127.0.0.1:${process.env.CHISA_DEV_PORT || "5173"}`,
  devCommand: "node scripts/build-frontend.mjs --dev",
  buildCommand: "node scripts/build-frontend.mjs",
  frontendDist: "../cloudcli-ui/dist",
  bindings: "src/chisa.ts",
  out: "build",
  resources: ["../mutagen.exe", "../mutagen-agents.tar.gz"],
});
