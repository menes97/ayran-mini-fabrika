// OpenPLC'ye yüklenecek ST dosyalarını üretir (plc/build/):
//   fabrika.st    tek PLC: bütün fabrika (Ortak + Proses + Paketleme + Lojistik, tek PROGRAM)
//   proses.st     proses PLC'si: dolum + tank, blok 0'ın sahibi
//   paketleme.st  paketleme PLC'si: shrink + paletleme
//   lojistik.st   lojistik PLC'si: AGV + depo
//
// - public/iomap.js'den located değişken bildirimlerini (AT %IW / %QW) üretir. OpenPLC v3 slave
//   cihazında %IW100 okuma aralığının, %QW100 yazma aralığının ilk register'ıdır; adresler rolün
//   aralığına göre göreli hesaplanır (PLCS tablosu).
// - Parçalar tek bir PROGRAM'da birleşir (birden çok PROGRAM aynı located değişkeni bildirirse
//   OpenPLC'nin glueVars aşamasında çakışma riski var).
// - matiec'i sessizce çökerten durumları yakalar (ASCII dışı karakter, çok isimli TON listesi,
//   ayrılmış sözcükler).
//
// Kullanım: node tools/gen-plc.js   (npm run build:plc)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CELLS, IO, BLOCK, MAP_VERSION, PLC_SLAVE_BASE } from '../public/iomap.js';
import { RETAIN_FIELDS } from '../plc/retain.js';
import { ascii, typeOf, TARGETS, assembleProgram, readFunctionBlocks } from './plc-source.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'plc/build');

function ioLines(plc) {
  const [r0, rn] = plc.read, [w0, wn] = plc.write;
  const lines = [];
  for (const cell of CELLS) {
    const io = IO[cell.id];
    if (!io) continue;
    const ir = io.ir.filter((r) => { const a = cell.block * BLOCK + r.off; return a >= r0 && a < r0 + rn; });
    const hr = io.hr.filter((r) => { const a = cell.block * BLOCK + r.off; return a >= w0 && a < w0 + wn; });
    if (!ir.length && !hr.length) continue;
    lines.push(`    (* --- blok ${cell.block}: ${ascii(cell.name)} --- *)`);
    for (const r of ir) {
      const a = PLC_SLAVE_BASE + cell.block * BLOCK + r.off - r0;
      lines.push(`    ${r.tag.padEnd(16)} AT %IW${a} : ${typeOf(r.tag)};  (* ${ascii(r.label)} *)`);
    }
    for (const r of hr) {
      const a = PLC_SLAVE_BASE + cell.block * BLOCK + r.off - w0;
      lines.push(`    ${r.tag.padEnd(16)} AT %QW${a} : ${typeOf(r.tag)};  (* ${ascii(r.label)} *)`);
    }
  }
  return lines;
}

function build(t) {
  const assembled = assembleProgram(t);
  const io = ioLines(t.plc);
  const retained = RETAIN_FIELDS.filter((f) => t.parts.includes(f.role));
  if (new Set(retained.map((f) => f.at)).size !== retained.length) throw new Error('Kalici adres cakismasi');
  io.push(...retained.map((f) => `    ${f.name} AT %MW${f.at} : ${f.type};`));
  const [r0, rn] = t.plc.read, [w0, wn] = t.plc.write;
  const program = `PROGRAM ${t.program}
  VAR
${io.join('\n')}
  END_VAR

  VAR
${assembled.vars}
  END_VAR

${assembled.body}
END_PROGRAM


CONFIGURATION Config0
  RESOURCE Res0 ON PLC
    TASK task0(INTERVAL := T#20ms, PRIORITY := 0);
    PROGRAM instance0 WITH task0 : ${t.program};
  END_RESOURCE
END_CONFIGURATION
`;
  const header = `(* ${'='.repeat(69)}
   Ayran mini fabrika - OpenPLC programi: ${t.plc.name} (URETILMIS DOSYA, ELLE DUZENLEMEYIN)
   Kaynaklar: plc/src/*.st   Uretici: tools/gen-plc.js   Harita surumu: ${MAP_VERSION}
   OpenPLC slave cihazi (simulator):
     Input Registers   start ${r0}, size ${rn}  -> %IW${PLC_SLAVE_BASE}..%IW${PLC_SLAVE_BASE + rn - 1}
     Holding Registers start ${w0}, size ${wn}  -> %QW${PLC_SLAVE_BASE}..%QW${PLC_SLAVE_BASE + wn - 1}
   ${'='.repeat(69)} *)
`;
  const fbFiles = readFunctionBlocks();
  const text = [header, ...fbFiles.map(f => f.text), program]
    .join('\n\n').replace(/\r/g, '');
  check(text, t.file);
  return { text, fbs: fbFiles.length, io: io.length };
}

// matiec güvenlik kontrolleri
function check(text, file) {
  const problems = [];
  text.split('\n').forEach((l, i) => {
    if (/[^\x00-\x7F]/.test(l)) problems.push(`satır ${i + 1}: ASCII dışı karakter (matiec çöker): ${l.trim()}`);
    if (/\(\*@[A-Z_]+@\*\)/.test(l)) problems.push(`satır ${i + 1}: doldurulmamış yer tutucu: ${l.trim()}`);
  });
  // IEC 61131-3 ayrılmış sözcükleri ve standart FB adları değişken adı olamaz (matiec anlaşılmaz hata verir)
  const reserved = ['STEP', 'RS', 'SR', 'ON', 'TASK', 'ACTION', 'TRANSITION', 'AT', 'TON', 'TOF', 'TP', 'CTU', 'CTD'];
  text.split('\n').forEach((l, i) => {
    const m = l.match(/^\s*([A-Za-z_][\w, ]*?)\s*:\s*[A-Z_]+/);
    if (!m || /^\s*(\(\*|IF|ELSIF|CASE)/.test(l)) return;
    for (const name of m[1].split(',').map((s) => s.trim())) {
      if (reserved.includes(name.toUpperCase())) problems.push(`satır ${i + 1}: '${name}' ayrılmış sözcük, değişken adı olamaz`);
    }
  });
  const multiTon = text.match(/^\s*\w+\s*,[^;:]*:\s*(TON|TOF|TP)\s*;/gm);
  if (multiTon) problems.push(`çok isimli zamanlayıcı bildirimi (matiec çöker): ${multiTon.map((s) => s.trim()).join(' | ')}`);
  if (!text.includes(`FAB_IW_MAPVER = ${MAP_VERSION} `)) problems.push(`harita sürümü kontrolü (= ${MAP_VERSION}) yok`);
  if (problems.length) {
    console.error(`${file} üretilemedi:\n  ` + problems.join('\n  '));
    process.exit(1);
  }
}

fs.mkdirSync(OUT, { recursive: true });
for (const t of TARGETS) {
  const r = build(t);
  fs.writeFileSync(path.join(OUT, t.file), r.text);
  console.log(`plc/build/${t.file}: ${t.plc.name}, ${r.fbs} fonksiyon bloğu, ${r.io} I/O satırı`);
}
