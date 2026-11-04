// JS test PLC'si: plc/src/*.st ile aynı mantığı (plc/fabrika.js) Modbus TCP istemcisi olarak çalıştırır.
// OpenPLC'nin yerine geçer; simülatörü OpenPLC kurmadan denemek içindir.
//
//   node plc/js-plc.js [--role tek|proses|paketleme|lojistik] [--host 127.0.0.1] [--port 5020]
//                      [--poll 20] [--v4] [--slave-port 5030 | --no-slave]
//   --role: hangi PLC (iomap PLCS). Bölünmüş fabrikada üç ayrı süreç ya da demo --3plc.
//   --v4: OpenPLC v4 gibi davran (100 ms yoklama, yalnızca kullanılan register'lara tek tek FC6)
//   --slave-port: izleme servisi için Modbus slave. OpenPLC v3'ün slave eşlemesiyle aynı:
//     input register 100+n = %IW(100+n) (rolün okuma aralığı), holding register 100+n = %QW(100+n)
//     (rolün yazma aralığı). Varsayılan: rolün portu (iomap PLCS[].port).
import { fileURLToPath } from 'node:url';
import Modbus from 'modbus-serial';
import { Fabrika, plcOf } from './fabrika.js';
import { IO, N_BLOCKS, BLOCK, addr, PLC_SLAVE_BASE } from '../public/iomap.js';

const N_REGS = N_BLOCKS * BLOCK;
const SCAN_MS = 20;

// commission: simülatör aynı anda temiz hatla başlatıldıysa (demo) tankın yeni CIP zorunluluğunu bir kez kaldırır.
// Ayrı başlatılan PLC'de varsayılan kapalı: PLC hattın son temizliğini bilemez, yeni CIP ister.
export async function startPlc({ role = 'tek', host = '127.0.0.1', port = 5020, poll, v4 = false, slavePort, quiet = false, commission = false } = {}) {
  const cfg = plcOf(role);
  const POLL_MS = poll ?? (v4 ? 100 : 20);
  const [r0, rn] = cfg.read, [w0, wn] = cfg.write;
  // v4'te blok yazma yok: yalnızca haritada tanımlı ve rolün aralığındaki holding register'lar yazılır
  const usedHr = Object.entries(IO).flatMap(([cell, io]) => io.hr.map((r) => addr(cell, r.off)))
    .filter((a) => a >= w0 && a < w0 + wn);
  const log = (...a) => { if (!quiet) console.log(`[plc:${role}]`, ...a); };

  const plc = new Fabrika({ role, ret: commission ? { TNK_COMMISSION: 0xc1ea } : {} });
  const client = new Modbus();
  client.setTimeout(500);
  let ir = new Array(N_REGS).fill(0);
  let hr = new Array(N_REGS).fill(0);
  let connected = false;

  // PLC tarama döngüsü: Modbus'tan bağımsız, sabit 20 ms. Windows'ta setInterval 20 ms'yi
  // tutturamaz; geride kalan taramalar telafi edilir, böylece tarama sayan süreler OpenPLC'deki gibi doğru olur.
  let lastScan = performance.now();
  setInterval(() => {
    const now = performance.now();
    if (now - lastScan > 1000) lastScan = now - SCAN_MS;   // uzun duraklamada yakalamaya çalışma
    while (now - lastScan >= SCAN_MS) {
      lastScan += SCAN_MS;
      hr = plc.scan(ir, lastScan);
    }
  }, 5);

  async function connect() {
    while (!connected) {
      try {
        await client.connectTCP(host, { port });
        client.setID(1);
        connected = true;
        log(`${host}:${port} bağlandı (yoklama ${POLL_MS} ms, okuma ${r0}+${rn}, yazma ${w0}+${wn}${v4 ? ', v4 modu' : ''})`);
      } catch {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  async function pollOnce() {
    const t0 = performance.now();
    try {
      const res = await client.readInputRegisters(r0, rn);
      const next = new Array(N_REGS).fill(0);
      res.data.forEach((v, i) => { next[r0 + i] = v; });
      ir = next;
      if (v4) {
        for (const a of usedHr) await client.writeRegister(a, hr[a]);
      } else {
        await client.writeRegisters(w0, hr.slice(w0, w0 + wn));
      }
    } catch {
      // haberleşme hatasında son değerler kalır; PLC kalp atışı bekçisiyle fark eder
      if (!client.isOpen) {
        connected = false;
        log('bağlantı koptu, yeniden deneniyor');
        await connect();
      }
    }
    setTimeout(pollOnce, Math.max(0, POLL_MS - (performance.now() - t0)));
  }

  // izleme servisi için Modbus slave (OpenPLC v3 eşlemesi)
  const sp = slavePort === undefined ? cfg.port : slavePort;
  if (sp) {
    const B = PLC_SLAVE_BASE;
    const slave = new Modbus.ServerTCP({
      getInputRegister: (a) => (a >= B && a < B + rn ? ir[r0 + a - B] : 0),
      getHoldingRegister: (a) => (a >= B && a < B + wn ? hr[w0 + a - B] : 0),
      setRegister: () => {},              // izleme salt okunur
    }, { host: '0.0.0.0', port: sp, unitID: 255 });
    slave.on('socketError', () => {});
    slave.on('serverError', (e) => log('slave hatası:', e.message));
    log(`izleme için Modbus slave: 0.0.0.0:${sp} (%IW${B}.., %QW${B}..)`);
  }

  await connect();
  pollOnce();
  return { plc, role };
}

// doğrudan çalıştırıldıysa komut satırından başlat
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const opt = (name, def) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
  };
  await startPlc({
    role: opt('role', 'tek'),
    host: opt('host', '127.0.0.1'),
    port: Number(opt('port', process.env.MODBUS_PORT || 5020)),
    poll: opt('poll') ? Number(opt('poll')) : undefined,
    v4: args.includes('--v4'),
    slavePort: args.includes('--no-slave') ? 0 : opt('slave-port') ? Number(opt('slave-port')) : undefined,
  });
}
