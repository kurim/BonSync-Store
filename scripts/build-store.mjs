// Baut aus den Modul-Quellen unter <id>/module/ die fertigen Zip-Pakete unter dist/<id>-<version>.zip
// und den Store-Katalog dist/index.json, den BonSync (Händler-Schnittstellen -> Store) einliest.
// Wird von .github/workflows/build-store.yml ausgeführt (Push auf main + manuell), kann aber auch
// lokal per `npm run build` laufen, um eine Änderung vor dem Push zu prüfen.
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { ZipFile } from 'yazl';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const outDir = join(rootDir, 'dist');
const tmpDir = join(rootDir, '.build-tmp');

// GITHUB_REPOSITORY ist in Actions automatisch gesetzt ("owner/repo") -- lokal (npm run build)
// greift der Fallback, damit ein Testlauf ohne CI trotzdem ein plausibles index.json erzeugt.
const REPO = process.env.GITHUB_REPOSITORY ?? 'kurim/BonSync-Store';
const RELEASE_TAG = 'latest';
const BRANCH = 'main';

// Ein Store-Eintrag ist jeder Top-Level-Ordner mit <ordner>/module/manifest.yaml -- kein
// hartkodiertes Array, damit ein neues Modul (neuer Ordner) ohne Skript-Änderung mitgebaut wird.
function discoverStoreDirs() {
	return readdirSync(rootDir, { withFileTypes: true })
		.filter((e) => e.isDirectory() && existsSync(join(rootDir, e.name, 'module', 'manifest.yaml')))
		.map((e) => e.name)
		.sort();
}

function writeZip(baseDir, files, zipPath) {
	return new Promise((resolvePromise, reject) => {
		const zipfile = new ZipFile();
		for (const file of files) {
			zipfile.addFile(join(baseDir, file), file);
		}
		zipfile.end();
		const output = createWriteStream(zipPath);
		zipfile.outputStream.pipe(output);
		output.on('close', resolvePromise);
		output.on('error', reject);
		zipfile.outputStream.on('error', reject);
	});
}

function sha256(filePath) {
	return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

async function buildStoreEntry(dirName) {
	const moduleSrcDir = join(rootDir, dirName, 'module');
	const manifestText = readFileSync(join(moduleSrcDir, 'manifest.yaml'), 'utf8');
	const manifest = parseYaml(manifestText);

	const moduleTmpDir = join(tmpDir, manifest.id);
	rmSync(moduleTmpDir, { recursive: true, force: true });
	mkdirSync(moduleTmpDir, { recursive: true });

	// Autorenquelle ist entweder TypeScript (wird hier gebündelt) oder schon fertiges ESM-JS
	// (z.B. fressnapf/module/index.js) -- in beiden Fällen läuft sie durch esbuild, damit der
	// Ziel-Dateiname immer exakt manifest.entry entspricht, unabhängig von der Quelldatei.
	const entryBase = manifest.entry.replace(/\.js$/, '');
	const tsEntry = join(moduleSrcDir, `${entryBase}.ts`);
	const entryPoint = existsSync(tsEntry) ? tsEntry : join(moduleSrcDir, manifest.entry);

	await build({
		entryPoints: [entryPoint],
		bundle: true,
		platform: 'node',
		format: 'esm',
		target: 'node22',
		outfile: join(moduleTmpDir, manifest.entry)
	});
	writeFileSync(join(moduleTmpDir, 'manifest.yaml'), manifestText);

	// Alles außer .ts-Quellen (schon gebündelt) und manifest.yaml (schon kopiert) wandert
	// unverändert mit ins Paket -- Logos, Zertifikate o.ä., die das Modul zur Laufzeit aus seinem
	// eigenen Verzeichnis liest (siehe rewe/module/index.ts für ein Zertifikats-Beispiel).
	const zipFiles = ['manifest.yaml', manifest.entry];
	for (const entry of readdirSync(moduleSrcDir)) {
		if (entry.endsWith('.ts') || entry === 'manifest.yaml' || entry === manifest.entry) continue;
		copyFileSync(join(moduleSrcDir, entry), join(moduleTmpDir, entry));
		zipFiles.push(entry);
	}

	mkdirSync(outDir, { recursive: true });
	const zipName = `${manifest.id}-${manifest.version}.zip`;
	const zipPath = join(outDir, zipName);
	await writeZip(moduleTmpDir, zipFiles, zipPath);
	console.log(`[build-store] ${manifest.id} -> dist/${zipName}`);

	return {
		id: manifest.id,
		displayName: manifest.displayName,
		version: manifest.version,
		description: manifest.description ?? null,
		author: manifest.author ?? null,
		authDescription: manifest.authDescription ?? null,
		loginStrategy: manifest.loginStrategy,
		sdkVersion: manifest.sdkVersion ?? 1,
		providesPdf: typeof manifest.providesPdf === 'boolean' ? manifest.providesPdf : true,
		ui: manifest.ui
			? {
					color: manifest.ui.color ?? null,
					chip: manifest.ui.chip ?? null,
					// Logo wird direkt aus dem Repo (main-Branch) ausgeliefert -- vor der Installation
					// gibt es ja noch kein installiertes Paket, aus dem BonSync es servieren könnte.
					logoUrl: manifest.ui.logo
						? `https://raw.githubusercontent.com/${REPO}/${BRANCH}/${dirName}/module/${manifest.ui.logo}`
						: null
				}
			: null,
		zipUrl: `https://github.com/${REPO}/releases/download/${RELEASE_TAG}/${zipName}`,
		sha256: sha256(zipPath),
		sizeBytes: statSync(zipPath).size
	};
}

const storeDirs = discoverStoreDirs();
const modules = [];
for (const dirName of storeDirs) {
	modules.push(await buildStoreEntry(dirName));
}
rmSync(tmpDir, { recursive: true, force: true });

const index = {
	schemaVersion: 1,
	repository: `https://github.com/${REPO}`,
	generatedAt: new Date().toISOString(),
	modules
};
writeFileSync(join(outDir, 'index.json'), JSON.stringify(index, null, 2) + '\n');
console.log(`[build-store] dist/index.json (${modules.length} Module)`);
