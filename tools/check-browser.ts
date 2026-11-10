import { build } from "esbuild";
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { stringifyJson } from "testar-evidence";
import { loadConformance } from "./conformance.ts";

await mkdir(".cache/browser", {recursive: true});
await build({
    entryPoints: ["tools/browser-entry.ts"], outfile: ".cache/browser/bundle.js",
    bundle: true, platform: "browser", format: "esm", target: "es2022",
});
const bundle = await readFile(".cache/browser/bundle.js");
const server = createServer((request, response) => {
    response.setHeader("Content-Type", request.url === "/bundle.js" ? "text/javascript" : "text/html");
    response.end(request.url === "/bundle.js" ? bundle : "<!doctype html><title>ASM browser check</title>");
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
    browser = await chromium.launch({headless: true});
    const page = await browser.newPage();
    await page.goto("http://127.0.0.1:" + (server.address() as AddressInfo).port);
    const cases = await loadConformance();
    for (const [name, choice] of [
        ["local-unvisited-before-navigation", "new-a"],
        ["navigation-nearest-state", "to-b"],
    ]) {
        const actual = await page.evaluate(async serialized => {
            const modulePath = "/bundle.js";
            const module = await import(modulePath);
            return module.check(serialized);
        }, stringifyJson(cases.read(name, "input")));
        if (actual.choice !== choice || actual.revision !== 0) {
            throw new Error("Browser result differs for " + name);
        }
    }
    console.log("Chromium: browser module, local selection, navigation, and cancellation passed.");
} finally {
    await browser?.close();
    server.close();
    await once(server, "close");
}
