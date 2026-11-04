// Simülatörü, JS test PLC'(ler)ini ve izleme servisini aynı süreçte başlatır: npm run demo
// Tek süreç olduğu için demo durdurulunca hepsi birlikte kapanır (ayrı alt süreçler sahipsiz kalabiliyordu).
//   npm run demo          tek PLC
//   npm run demo:3plc     üç PLC (proses, paketleme, lojistik), izleme üçünü ayrı ayrı yoklar
// Port değiştirmek için: PORT=8085 MODBUS_PORT=5021 MON_PORT=8091 npm run demo
// İzleme servisi PLC'leri kendi Modbus slave portlarından okur (gerçek SCADA gibi), simülatörü değil.
const argv = process.argv.slice(2);
const three = argv.includes('--3plc');
// --port 8092 --modbus 5024 --mon 8093: ortam değişkenleri yerine (masaüstü uygulamasının launch.json'ı için)
for (const [flag, env] of [['--port', 'PORT'], ['--modbus', 'MODBUS_PORT'], ['--mon', 'MON_PORT']]) {
  const i = argv.indexOf(flag);
  if (i >= 0) process.env[env] = argv[i + 1];
}
await import('../server/index.js');
const { startPlc } = await import('../plc/js-plc.js');
const { startMonitor } = await import('../monitor/server.js');
const port = Number(process.env.MODBUS_PORT || 5020);
const roles = three ? ['proses', 'paketleme', 'lojistik'] : ['tek'];
for (const role of roles) await startPlc({ role, port, poll: three ? 100 : undefined, commission: true });   // sim temiz hatla başladı
await startMonitor({
  MON_MODE: three ? 'bolunmus' : 'tek',
  SIM_URL: `http://127.0.0.1:${process.env.PORT || 8080}`,
});
