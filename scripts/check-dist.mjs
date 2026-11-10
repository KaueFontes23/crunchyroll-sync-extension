import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const dist = resolve('dist');
const manifestPath = resolve(dist, 'manifest.json');
if (!existsSync(manifestPath)) throw new Error('dist/manifest.json não existe; execute o build primeiro.');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const required = [manifest.background?.service_worker, manifest.action?.default_popup];
for (const entry of manifest.content_scripts ?? []) required.push(...(entry.js ?? []));
for (const file of required) {
  if (typeof file !== 'string' || !existsSync(resolve(dist, file))) {
    throw new Error(`Arquivo declarado no manifesto não existe: ${file}`);
  }
}
for (const entry of manifest.content_scripts ?? []) {
  if (entry.type === 'module') throw new Error('Content script declarado como módulo: não é permitido pelo build desta extensão.');
  for (const script of entry.js ?? []) {
    const path = resolve(dist, script);
    const text = readFileSync(path, 'utf8');
    if (/^\s*import\s/m.test(text) || /\bimport\s*\(/.test(text)) {
      throw new Error(`${script} contém import de módulo; o content script MV3 precisa ser um bundle clássico autônomo.`);
    }
  }
}
console.log('Bundle MV3 válido: arquivos do manifesto presentes e content scripts autônomos.');
