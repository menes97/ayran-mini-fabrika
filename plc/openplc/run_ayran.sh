#!/bin/bash
# OpenPLC Runtime v3 üzerinde fabrika.st'yi derler, simülatörü Modbus slave cihaz
# olarak tanımlar ve PLC'yi RUN modunda başlatır. Web arayüzünü kullanmadan, tek komutla.
#
#   sudo ./run_ayran.sh [st dosyası]
#   sudo ROLE=paketleme ./run_ayran.sh      # üç PLC'li fabrikada bu OpenPLC'nin rolü
#
#   ROLE         tek (varsayılan) | proses | paketleme | lojistik. Hangi ST dosyasının
#                (plc/build/<rol>.st) yükleneceğini ve slave cihazın okuma/yazma aralığını
#                belirler (public/iomap.js PLCS ile aynı). Diğer roller JS PLC olarak çalışabilir:
#                node plc/js-plc.js --role proses
#
#   OPENPLC_DIR  OpenPLC_v3 klasörü (varsayılan: /workdir varsa o, yoksa ~/OpenPLC_v3)
#   SIM_HOST     simülatörün adresi (varsayılan: Docker'da host.docker.internal,
#                WSL'de Windows ana bilgisayarı)
#   SIM_PORT     simülatörün Modbus portu (varsayılan 5020)
#   POLL_MS      yoklama periyodu (varsayılan 100)
#   COMPILE_ONLY 1 ise yalnızca derler, PLC'yi başlatmaz
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
ROLE=${ROLE:-tek}
case "$ROLE" in
  tek)       ST_DEFAULT=fabrika;   IR_START=0; IR_SIZE=112; HR_START=0;  HR_SIZE=112 ;;
  proses)    ST_DEFAULT=proses;    IR_START=0; IR_SIZE=48;  HR_START=0;  HR_SIZE=48 ;;
  paketleme) ST_DEFAULT=paketleme; IR_START=0; IR_SIZE=80;  HR_START=48; HR_SIZE=32 ;;
  lojistik)  ST_DEFAULT=lojistik;  IR_START=0; IR_SIZE=112; HR_START=80; HR_SIZE=32 ;;
  *) echo "Bilinmeyen ROLE: $ROLE (tek | proses | paketleme | lojistik)"; exit 1 ;;
esac
ST_FILE=${1:-$HERE/../build/$ST_DEFAULT.st}
if [ -z "$OPENPLC_DIR" ]; then
  if [ -d /workdir/webserver ]; then OPENPLC_DIR=/workdir; else OPENPLC_DIR=$HOME/OpenPLC_v3; fi
fi
SIM_PORT=${SIM_PORT:-5020}
POLL_MS=${POLL_MS:-100}

if [ -z "$SIM_HOST" ]; then
  # WSL önce: Docker Desktop kuruluysa host.docker.internal WSL'de de çözülür ama
  # LAN IP'sine gider ve güvenlik duvarına takılır
  if grep -qi microsoft /proc/version && [ ! -f /.dockerenv ]; then
    SIM_HOST=$(ip route show default | awk '{print $3; exit}')   # WSL NAT: Windows ağ geçidi
  elif getent hosts host.docker.internal >/dev/null; then
    SIM_HOST=host.docker.internal
  else
    SIM_HOST=127.0.0.1
  fi
fi
# libmodbus ana bilgisayar adı çözmez, IP gerekir
SIM_IP=$(getent hosts "$SIM_HOST" | awk '{print $1; exit}')
SIM_IP=${SIM_IP:-$SIM_HOST}

cd "$OPENPLC_DIR/webserver"
tr -d '\r' < "$ST_FILE" > st_files/fabrika.st

echo "=== Derleme ==="
./scripts/compile_program.sh fabrika.st
[ "$COMPILE_ONLY" = "1" ] && exit 0
[ "$NO_START" = "1" ] && SKIP_START=1

echo "=== Rol: $ROLE ($ST_FILE) | Simülatör: $SIM_IP:$SIM_PORT, yoklama $POLL_MS ms ==="
echo "    Input Registers $IR_START+$IR_SIZE -> %IW100.. | Holding Registers $HR_START+$HR_SIZE -> %QW100.."
PY=python3
[ -x "$OPENPLC_DIR/.venv/bin/python3" ] && PY=$OPENPLC_DIR/.venv/bin/python3
$PY - <<EOF
import sqlite3
c = sqlite3.connect('openplc.db')
c.execute("DELETE FROM Programs WHERE File='fabrika.st'")
c.execute("INSERT INTO Programs (Name, Description, File, Date_upload) VALUES ('Ayran mini fabrika', 'Ayran mini fabrika', 'fabrika.st', 0)")
c.execute("UPDATE Settings SET Value='true' WHERE Key='Start_run_mode'")
c.execute("UPDATE Settings SET Value='$POLL_MS' WHERE Key='Slave_polling'")
c.execute("UPDATE Settings SET Value='1' WHERE Key='Pstorage_polling'")
if c.execute("SELECT COUNT(*) FROM Settings WHERE Key='Pstorage_polling'").fetchone()[0] != 1:
    raise RuntimeError('OpenPLC Settings: Pstorage_polling anahtari eksik veya yinelenmis')
c.commit()
EOF

# Web arayüzündeki "Slave Devices" sayfasının ürettiği dosyanın aynısı
cat > mbconfig.cfg <<EOF
Num_Devices = "1"
Polling_Period = "$POLL_MS"
Timeout = "1000"
device0.name = "ayran_sim"
device0.slave_id = "1"
device0.protocol = "TCP"
device0.address = "$SIM_IP"
device0.IP_Port = "$SIM_PORT"
device0.RTU_Baud_Rate = "115200"
device0.RTU_Parity = "None"
device0.RTU_Data_Bits = "8"
device0.RTU_Stop_Bits = "1"
device0.RTU_TX_Pause = "0"
device0.Discrete_Inputs_Start = "0"
device0.Discrete_Inputs_Size = "0"
device0.Coils_Start = "0"
device0.Coils_Size = "0"
device0.Input_Registers_Start = "$IR_START"
device0.Input_Registers_Size = "$IR_SIZE"
device0.Holding_Registers_Read_Start = "0"
device0.Holding_Registers_Read_Size = "0"
device0.Holding_Registers_Start = "$HR_START"
device0.Holding_Registers_Size = "$HR_SIZE"
EOF

# izleme servisi bu PLC'yi kendi Modbus slave portundan (502) okur: %QW100.. = holding register 100..
[ "$SKIP_START" = "1" ] && { echo "=== Yapılandırıldı (NO_START=1): systemctl restart openplc ==="; exit 0; }
echo "=== OpenPLC başlıyor (web arayüzü: http://localhost:8080, Modbus slave: 502) ==="
cd "$OPENPLC_DIR"
exec ./start_openplc.sh
