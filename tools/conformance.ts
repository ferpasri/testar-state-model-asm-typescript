import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";
import { parseJson } from "testar-evidence";

const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, ".cache/specs");
const hash = (content: Uint8Array) => createHash("sha256").update(content).digest("hex");
const compatibility = JSON.parse(await readFile(path.join(root, "compatibility.json"), "utf8"));

function safe(name: string): boolean {
    return !/[\\:\u0000-\u001f]/u.test(name) &&
        name.split("/").every(part => part !== "" && part !== "." && part !== "..");
}
function checkManifest(value: any): void {
    for (const field of ["case_format_version", "asm_contract", "evidence_schema", "rule_language", "abstraction_behavior", "asms", "controller"]) {
        if (JSON.stringify(value[field]) !== JSON.stringify(compatibility[field])) {
            throw new Error("Unsupported ASM conformance contract: " + field);
        }
    }
    const suite = value.suites?.selection;
    if (suite?.directory !== "cases" || !Array.isArray(suite.cases) ||
        !suite.cases.every((name: unknown) => typeof name === "string" && /^[a-z0-9-]+$/u.test(name)) ||
        new Set(suite.cases).size !== suite.cases.length) {
        throw new Error("Invalid selection-case manifest.");
    }
}

/** Download only published shared cases; repository-local fixtures are not used. */
export async function prepareConformance(): Promise<void> {
    const url = "https://codeload.github.com/ferpasri/testar-state-model-asm-specs/zip/refs/tags/" + compatibility.release;
    const response = await fetch(url, {signal: AbortSignal.timeout(60000)});
    if (!response.ok || !response.body) {
        throw new Error("Conformance download failed: " + response.status);
    }
    const chunks: Uint8Array[] = [];
    let length = 0;
    for await (const chunk of response.body) {
        length += chunk.length;
        if (length > 16 * 1024 ** 2) {
            throw new Error("Conformance archive exceeds 16 MiB.");
        }
        chunks.push(chunk);
    }
    const archive = Buffer.concat(chunks);
    if (hash(archive) !== compatibility.archive_sha256) {
        throw new Error("Pinned ASM conformance archive digest differs.");
    }
    let expanded = 0;
    const names = new Set<string>();
    const extracted = unzipSync(archive, {filter(entry) {
        const name = entry.name.split("/").slice(1).join("/");
        if (!name.startsWith("conformance/") || entry.name.endsWith("/")) {
            return false;
        }
        if (!safe(name) || names.has(name)) {
            throw new Error("Unsafe or repeated archive path.");
        }
        names.add(name);
        expanded += entry.originalSize;
        if (expanded > 64 * 1024 ** 2 || names.size > 10000) {
            throw new Error("Conformance extraction exceeds its limits.");
        }
        return true;
    }});
    const files: Record<string, Uint8Array> = {};
    for (const [name, content] of Object.entries(extracted)) {
        files[name.split("/").slice(1).join("/")] = content;
    }
    const manifest = JSON.parse(new TextDecoder().decode(files["conformance/manifest.json"]));
    checkManifest(manifest);
    for (const name of manifest.suites.selection.cases) {
        for (const filename of ["input.json", "expected.json"]) {
            const content = files["conformance/cases/" + name + "/" + filename];
            if (!content) {
                throw new Error("Incomplete shared case: " + name);
            }
            parseJson(new TextDecoder("utf-8", {fatal: true}).decode(content));
        }
    }
    const directory = randomUUID();
    const hashes: Record<string, string> = {};
    for (const [name, content] of Object.entries(files)) {
        const destination = path.join(cache, directory, name);
        await mkdir(path.dirname(destination), {recursive: true});
        await writeFile(destination, content);
        hashes[name] = hash(content);
    }
    const pending = path.join(cache, "selection-" + directory + ".json");
    await writeFile(pending, JSON.stringify({release: compatibility.release, directory, files: hashes}, null, 4));
    await rename(pending, path.join(cache, "current.json"));
    console.log("Prepared " + compatibility.release + ": " + manifest.suites.selection.cases.length + " shared ASM cases.");
}

export async function loadConformance() {
    let selection: any;
    try {
        selection = JSON.parse(await readFile(path.join(cache, "current.json"), "utf8"));
    } catch (cause) {
        throw new Error("Run npm run prepare:conformance before testing.", {cause});
    }
    if (selection.release !== compatibility.release || !/^[0-9a-f-]{36}$/u.test(selection.directory)) {
        throw new Error("Prepared cases do not match the pinned release.");
    }
    const content = new Map<string, any>();
    for (const [name, expected] of Object.entries(selection.files)) {
        if (!name.startsWith("conformance/") || !safe(name)) {
            throw new Error("Unsafe prepared conformance path.");
        }
        const bytes = await readFile(path.join(cache, selection.directory, name));
        if (hash(bytes) !== expected) {
            throw new Error("Prepared conformance file changed: " + name);
        }
        if (name.endsWith(".json")) {
            content.set(name, parseJson(bytes.toString("utf8")));
        }
    }
    const manifest = content.get("conformance/manifest.json");
    checkManifest(manifest);
    return {
        names: manifest.suites.selection.cases as string[],
        read(name: string, filename: "input" | "expected"): any {
            const result = content.get("conformance/cases/" + name + "/" + filename + ".json");
            if (!result) {
                throw new Error("Missing shared conformance case.");
            }
            return result;
        },
    };
}
