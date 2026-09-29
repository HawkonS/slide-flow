import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { Plugin, ResolvedConfig } from "vite";

/** Generate one integrity-checked, complete shell from this build's outputs. */
export function offlineShellPlugin(): Plugin {
  let config: ResolvedConfig;
  const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  return {
    name: "slideflow-offline-shell",
    apply: "build",
    enforce: "post",
    configResolved(value) { config = value; },
    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        const files = new Map<string, string>();
        for (const output of Object.values(bundle)) {
          if (output.fileName === "index.html" || output.fileName.startsWith("assets/")) {
            files.set(`/${output.fileName}`, sha256(output.type === "chunk" ? output.code : output.source));
          }
        }
        const visitPublic = (relative = "") => {
          for (const entry of readdirSync(path.join(config.publicDir, relative), { withFileTypes: true })) {
            const name = path.posix.join(relative, entry.name);
            if (entry.isDirectory()) visitPublic(name);
            else if (name === "manifest.webmanifest" || name.startsWith("pwa/")) {
              files.set(`/${name}`, sha256(readFileSync(path.join(config.publicDir, name))));
            }
          }
        };
        visitPublic();
        if (!files.has("/index.html")) this.error("The PWA build is missing index.html");
        const template = readFileSync(path.join(config.root, "pwa/service-worker.js"), "utf8");
        const entries = [...files].sort(([a], [b]) => a.localeCompare(b)).map(([url, hash]) => ({ url, sha256: hash }));
        const version = sha256(JSON.stringify(entries) + template).slice(0, 24);
        this.emitFile({
          type: "asset", fileName: "sw.js",
          source: template.replace("__SLIDEFLOW_PWA_CONFIG__", JSON.stringify({ version, files: entries })),
        });
      },
    },
  };
}
