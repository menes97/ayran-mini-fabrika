import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CELLS, IO, BLOCK, MAP_VERSION, SINGLE_PLC, tagAddr } from '../public/iomap.js';
import { RETAIN_FIELDS } from '../plc/retain.js';
import { generateCodesys, splitFunctionBlock } from '../tools/gen-codesys.js';

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`OK   CODESYS: ${name}`); };
const generated = generateCodesys();
const pou = name => generated.pous.find(p => p.name === name);
const code = p => [p.declaration, p.body, ...(p.actions || []).map(a => a.body)].join('\n');

check('all source FBs and single factory PRG exist, with separate editor texts', () => {
  const files = fs.readdirSync('plc/src').filter(f => /^FB_.*\.st$/.test(f));
  assert.equal(files.length, 6);
  for (const file of files) {
    const fb = pou(file.slice(0, -3));
    assert.equal(fb.kind, 'FUNCTION_BLOCK');
    assert.match(fb.declaration, /END_VAR$/);
    assert(!fb.body.includes('END_FUNCTION_BLOCK'));
    // Split and recombine must preserve the original IEC code, including checksum and startup behavior.
    const original = fs.readFileSync(`plc/src/${file}`, 'utf8').replace(/\r/g, '').trim();
    assert.equal(`${fb.declaration}\n\n${fb.body}\nEND_FUNCTION_BLOCK`.replace(/\s/g, ''), original.replace(/\s/g, ''));
  }
  for (const name of ['Fabrika', 'MODBUS_IO', 'MAIN']) assert.equal(pou(name).kind, 'PROGRAM');
  assert(!generated.pous.some(p => ['Proses', 'Paketleme', 'Lojistik'].includes(p.name)));
});

check('FB declaration boundary ignores comments and string literals', () => {
  const fb = splitFunctionBlock("FUNCTION_BLOCK Example\nVAR\n s : STRING := 'END_VAR';\nEND_VAR\n(* END_VAR *)\ns := 'END_VAR';\nEND_FUNCTION_BLOCK\n");
  assert.equal(fb.body, "(* END_VAR *)\ns := 'END_VAR';");
});

check('all editor texts are ASCII and free of located variables and placeholders', () => {
  for (const p of generated.pous) {
    assert(!/[^\x00-\x7f]/.test(code(p)), p.name);
    assert(!/\bAT\s+%|%[IQM]/i.test(code(p)), p.name);
    assert(!/\(\*@[A-Z_]+@\*\)/.test(code(p)), p.name);
  }
  const disk = JSON.parse(fs.readFileSync('codesys/build/pous.json', 'utf8'));
  assert.deepEqual(disk, generated, 'CLI and import output must match');
});

check('IO names, count, types and addresses exactly match iomap and OpenPLC', () => {
  const expected = CELLS.flatMap(c => ['ir', 'hr'].flatMap(direction => IO[c.id][direction].map(t =>
    ({ tag: t.tag, address: c.block * BLOCK + t.off, direction }))));
  const declarations = [...pou('GVL_IO').declaration.matchAll(/^\s+(\w+)\s*:\s*(WORD|INT);/gm)];
  assert.equal(declarations.length, expected.length);
  assert.equal(new Set(declarations.map(m => m[1])).size, expected.length);
  assert.deepEqual(declarations.map(m => m[1]).sort(), expected.map(t => t.tag).sort());
  const openplc = fs.readFileSync('plc/build/fabrika.st', 'utf8');
  for (const tag of generated.tags) {
    assert.equal(tag.address, tagAddr(tag.tag));
    assert.deepEqual(expected.find(t => t.tag === tag.tag), { tag: tag.tag, address: tag.address, direction: tag.direction });
    assert.match(openplc, new RegExp(`${tag.tag}\\s+AT %${tag.direction === 'ir' ? 'IW' : 'QW'}${100 + tag.address} : ${tag.type};`));
  }
});

check('factory scan and FB order match the complete OpenPLC program', () => {
  const st = fs.readFileSync('plc/build/fabrika.st', 'utf8');
  const program = st.slice(st.indexOf('PROGRAM Fabrika\n'));
  const varsEnd = program.lastIndexOf('END_VAR');
  const body = program.slice(varsEnd + 'END_VAR'.length, program.indexOf('END_PROGRAM')).trim();
  assert.equal(pou('Fabrika').body.trim(), body);
  assert.equal(generated.mapVersion, MAP_VERSION);
  assert.match(body, new RegExp(`FAB_IW_MAPVER = ${MAP_VERSION} THEN`));
  assert.match(body, /D_READY := PALLET\.PICKUP_RDY/);
});

check('13 persistent globals preserve retain schema and types', () => {
  const retain = pou('GVL_RETAIN');
  assert.equal(retain.kind, 'PERSISTENT');
  assert.match(retain.declaration, /^VAR_GLOBAL RETAIN PERSISTENT\n/);
  const actual = [...retain.declaration.matchAll(/^\s+(\w+) : (\w+);/gm)].map(m => ({ name: m[1], type: m[2] }));
  assert.deepEqual(actual, RETAIN_FIELDS.map(({ name, type }) => ({ name, type })));
  assert.equal(actual.length, 13);
});

check('every tag maps once, preserving signed INT and raw WORD register values', () => {
  const input = pou('MODBUS_IO').body;
  const output = pou('MODBUS_IO').actions[0].body;
  const reads = [...input.matchAll(/GVL_IO\.(\w+) := UINT_TO_(INT|WORD)\(aRead\[(\d+)\]\);/g)];
  const writes = [...output.matchAll(/aWrite\[(\d+)\] := (INT|WORD)_TO_UINT\(GVL_IO\.(\w+)\);/g)];
  assert.equal(reads.length, generated.tags.filter(t => t.direction === 'ir').length);
  assert.equal(writes.length, generated.tags.filter(t => t.direction === 'hr').length);
  for (const tag of generated.tags) {
    const found = tag.direction === 'ir'
      ? reads.filter(m => m[1] === tag.tag && m[2] === tag.type && +m[3] === tag.address)
      : writes.filter(m => m[3] === tag.tag && m[2] === tag.type && +m[1] === tag.address);
    assert.equal(found.length, 1, tag.tag);
  }
  assert.match(output, /FOR i := 0 TO 111 DO aWrite\[i\] := 0;/);
});

check('transport uses FC4 and FC16 0+112, same-task input/factory/output ordering', () => {
  assert.deepEqual(generated.transport, { host: '127.0.0.1', port: 5020, unitId: 1, read: SINGLE_PLC.read, write: SINGLE_PLC.write });
  assert.equal(generated.task.interval, 't#10ms');
  assert.deepEqual(generated.task.programs, ['MAIN']);
  assert.equal(pou('MAIN').body, 'MODBUS_IO();\nFabrika();\nMODBUS_IO.WriteOutputs();');
  assert.match(pou('MODBUS_IO').declaration, /ModbusFB\.ClientRequestReadInputRegisters/);
  assert.match(pou('MODBUS_IO').declaration, /ModbusFB\.ClientRequestWriteMultipleRegisters/);
  assert.equal((pou('MODBUS_IO').body.match(/uiStartItem := 0, uiQuantity := 112/g) || []).length, 2);
});

console.log(`${passed} CODESYS unit checks passed.`);
