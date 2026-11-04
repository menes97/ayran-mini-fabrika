// CODESYS editor declarations and implementations, assembled from the same IEC sources as OpenPLC.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MAP_VERSION, SINGLE_PLC } from '../public/iomap.js';
import { RETAIN_FIELDS } from '../plc/retain.js';
import { ROOT, ascii, ioTags, assembleProgram, readFunctionBlocks } from './plc-source.js';

// A small lexer keeps END_VAR in comments out of the declaration/body boundary.
export function splitFunctionBlock(text) {
  const tokens = /\(\*[\s\S]*?\*\)|\/\/[^\n]*|'(?:[^']|'')*'|\b[A-Za-z_]\w*\b/g;
  let end = -1;
  for (const match of text.matchAll(tokens)) {
    if (match[0].toUpperCase() === 'END_VAR') end = match.index + match[0].length;
  }
  const name = text.match(/^FUNCTION_BLOCK\s+(\w+)/m)?.[1];
  if (!name || end < 0 || !/END_FUNCTION_BLOCK\s*$/.test(text)) throw new Error('Invalid FB source');
  return { name, kind: 'FUNCTION_BLOCK', declaration: text.slice(0, end).trim(),
    body: text.slice(end).replace(/END_FUNCTION_BLOCK\s*$/, '').trim() };
}

export function generateCodesys() {
  const tags = ioTags();
  if (SINGLE_PLC.read.join() !== '0,112' || SINGLE_PLC.write.join() !== '0,112')
    throw new Error('CODESYS single PLC transport requires IR/HR 0+112');
  if (new Set(tags.map(t => t.tag)).size !== tags.length) throw new Error('Duplicate IO tag');
  const assembled = assembleProgram();
  const template = fs.readFileSync(path.join(ROOT, 'codesys/modbus-io.st'), 'utf8').replace(/\r/g, '');
  const [declaration, implementation] = template.split('(*@BODY@*)');
  const [body, output] = implementation.split('(*@OUTPUT@*)');
  const inputMap = tags.filter(t => t.direction === 'ir').map(t =>
    `        GVL_IO.${t.tag} := UINT_TO_${t.type}(aRead[${t.address}]);`).join('\n');
  const outputMap = tags.filter(t => t.direction === 'hr').map(t =>
    `    aWrite[${t.address}] := ${t.type}_TO_UINT(GVL_IO.${t.tag});`).join('\n');
  const pous = [
    ...readFunctionBlocks().map(f => splitFunctionBlock(f.text)),
    { name: 'GVL_IO', kind: 'GVL', declaration: 'VAR_GLOBAL\n' + tags.map(t =>
      `    ${t.tag} : ${t.type}; (* ${t.direction.toUpperCase()} ${t.address}: ${ascii(t.label)} *)`).join('\n') + '\nEND_VAR', body: '' },
    { name: 'GVL_RETAIN', kind: 'PERSISTENT', declaration: 'VAR_GLOBAL RETAIN PERSISTENT\n' +
      RETAIN_FIELDS.map(f => `    ${f.name} : ${f.type};`).join('\n') + '\nEND_VAR', body: '' },
    { name: 'Fabrika', kind: 'PROGRAM', declaration: `PROGRAM Fabrika\nVAR\n${assembled.vars}\nEND_VAR`, body: assembled.body },
    { name: 'MODBUS_IO', kind: 'PROGRAM', declaration: declaration.trim(), body: body.replace('(*@INPUT_MAP@*)', inputMap).trim(),
      actions: [{ name: 'WriteOutputs', body: output.replace('(*@OUTPUT_MAP@*)', outputMap).trim() }] },
    { name: 'MAIN', kind: 'PROGRAM', declaration: 'PROGRAM MAIN',
      body: 'MODBUS_IO();\nFabrika();\nMODBUS_IO.WriteOutputs();' },
  ];
  for (const pou of pous) {
    const text = [pou.declaration, pou.body, ...(pou.actions || []).map(a => a.body)].join('\n');
    if (/[^\x00-\x7f]/.test(text) || /\(\*@[A-Z_]+@\*\)/.test(text) || /\bAT\s+%|%[IQM][WBDX]/i.test(text))
      throw new Error(`Invalid CODESYS output: ${pou.name}`);
  }
  if (!assembled.body.includes(`FAB_IW_MAPVER = ${MAP_VERSION} `)) throw new Error('Missing MAP_VERSION guard');
  return { schemaVersion: 1, mapVersion: MAP_VERSION, role: SINGLE_PLC.id,
    transport: { host: '127.0.0.1', port: 5020, unitId: 1, read: SINGLE_PLC.read, write: SINGLE_PLC.write },
    task: { name: 'MainTask', interval: 't#10ms', priority: '1', programs: ['MAIN'] },
    tags: tags.map(({ tag, type, direction, address }) => ({ tag, type, direction, address })), pous };
}

export function writeCodesys(out = path.join(ROOT, 'codesys/build')) {
  const result = generateCodesys();
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'pous.json'), JSON.stringify(result, null, 2) + '\n');
  for (const pou of result.pous) {
    fs.writeFileSync(path.join(out, `${pou.name}.declaration.st`), pou.declaration + '\n');
    if (pou.body) fs.writeFileSync(path.join(out, `${pou.name}.body.st`), pou.body + '\n');
    for (const action of pou.actions || []) fs.writeFileSync(path.join(out, `${pou.name}.${action.name}.st`), action.body + '\n');
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = writeCodesys();
  console.log(`codesys/build/pous.json: ${result.pous.length} objects, ${result.tags.length} IO tags, map ${result.mapVersion}`);
}
