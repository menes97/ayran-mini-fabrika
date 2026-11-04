// Shared IEC source assembly for OpenPLC and CODESYS. No files are emitted on import.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CELLS, IO, BLOCK, MAP_VERSION, PLCS, SINGLE_PLC } from '../public/iomap.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SRC = path.join(ROOT, 'plc/src');

export const typeOf = (tag) => (/_(DI|DO|ALARM|STATUS|IL|PLATE|DIVERT|OCC_[A-Z])$/.test(tag) ? 'WORD' : 'INT');   // bit kelimeleri WORD
export const ascii = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/ı/g, 'i').replace(/İ/g, 'I').replace(/[^\x00-\x7F]/g, '?');

// Parça dosyası: "VAR ... END_VAR", "(*@BODY@*)", gövde, isteğe bağlı "(*@END@*)" + program sonu kodu
export function readPart(name) {
  const text = fs.readFileSync(path.join(SRC, `${name}.st`), 'utf8').replace(/\r/g, '');
  const [head, rest] = text.split('(*@BODY@*)');
  if (rest == null) throw new Error(`${name}.st içinde (*@BODY@*) işareti yok`);
  const m = head.match(/^VAR\n([\s\S]*?)^END_VAR/m);
  if (!m) throw new Error(`${name}.st: VAR ... END_VAR bölümü yok`);
  const [body, tail = ''] = rest.split('(*@END@*)');
  return { vars: m[1].replace(/\s+$/, ''), body: body.replace(/^\n+|\s+$/g, ''), tail: tail.replace(/^\n+|\s+$/g, '') };
}

export const PARTS = { proses: 'Proses', paketleme: 'Paketleme', lojistik: 'Lojistik' };
export const FB_OF = { proses: ['DOLUM', 'TANK'], paketleme: ['SHRINK', 'PALLET'], lojistik: ['ASRS', 'AGV'] };
export const TARGETS = [
  { file: 'fabrika.st', program: 'Fabrika', plc: SINGLE_PLC, parts: ['proses', 'paketleme', 'lojistik'] },
  ...PLCS.map((p) => ({ file: `${p.id}.st`, program: PARTS[p.id], plc: p, parts: [p.id] })),
];


export function ioTags(plc = SINGLE_PLC) {
  const tags = [];
  for (const cell of CELLS) {
    if (!IO[cell.id]) continue;
    for (const direction of ['ir', 'hr']) {
      const [start, count] = direction === 'ir' ? plc.read : plc.write;
      for (const r of IO[cell.id][direction]) {
        const address = cell.block * BLOCK + r.off;
        if (address >= start && address < start + count)
          tags.push({ ...r, direction, address, type: typeOf(r.tag) });
      }
    }
  }
  return tags;
}

export function assembleProgram(t = TARGETS[0]) {
  const single = t.parts.length > 1;
  const ortak = readPart('Ortak');
  const parts = t.parts.map(p => ({ id: p, ...readPart(PARTS[p]) }));
  const fbs = t.parts.flatMap(p => FB_OF[p]);
  const body = [ortak.body, ...parts.map(p => p.body), ...parts.map(p => p.tail).filter(Boolean)].join('\n\n')
    .replace('(*@MAPVER@*)', String(MAP_VERSION))
    .replace('(*@FAB_ALARM@*)', fbs.map(f => f + '.QW_ALARM').join(' OR '))
    .replace('(*@D_READY@*)', single ? 'PALLET.PICKUP_RDY' : '(AGV_IW_IL AND WORD#16#0001) <> WORD#0');
  const ind = s => s.split('\n').map(l => l ? '    ' + l.replace(/^\s+/, '') : l).join('\n');
  return { vars: [ortak, ...parts].map(p => ind(p.vars)).join('\n'), body };
}

export function readFunctionBlocks() {
  return fs.readdirSync(SRC).filter(f => /^FB_.*\.st$/.test(f)).sort()
    .map(file => ({ file, text: fs.readFileSync(path.join(SRC, file), 'utf8').replace(/\r/g, '') }));
}
