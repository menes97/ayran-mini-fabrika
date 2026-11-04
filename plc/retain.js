// Program-level OpenPLC %MW fields. Disjoint role ranges also work in a single PLC.
export const RETAIN_FIELDS = [
  { role: 'proses', name: 'TNK_COMMISSION', type: 'WORD', at: 0 },
  ...[
    ['RET_MAGIC', 'WORD'], ['RET_MAPVER', 'INT'], ['PAL_COUNT', 'INT'], ['PAL_ID', 'INT'],
    ['PAL_DONE', 'INT'], ['PAL_WRAPPED', 'INT'], ['PAL_SHEETS', 'WORD'], ['PAL_LAST_SEQ', 'INT'],
    ['PAL_ACTIVE', 'WORD'], ['PAL_C_PHASE', 'INT'], ['PAL_UNDERWRAP', 'WORD'], ['RET_CHECK', 'WORD'],
  ].map(([name, type], i) => ({ role: 'paketleme', name, type, at: 32 + i })),
];

// Same ordered, 16-bit rolling checksum as FB_Pallet.st. RET_CHECK is written
// after the payload; RET_MAGIC is invalidated first and committed last.
export const PAL_CHECK_FIELDS = RETAIN_FIELDS.filter(f => f.role === 'paketleme' && f.name !== 'RET_CHECK').map(f => f.name);
export function palletChecksum(ret) {
  return PAL_CHECK_FIELDS.reduce((sum, name) => (sum * 31 + (ret[name] & 0xffff)) % 65521, 1);
}
