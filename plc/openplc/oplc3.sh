#!/bin/bash
# Üç PLC'li fabrika için tek WSL/Linux makinesinde üç ayrı OpenPLC v3 çalıştırır. Her OpenPLC kendi
# ağ alanında (network namespace) koşar: kendi 502 (Modbus slave), 8080 (web) ve 43628 (çekirdek)
# portları olur, birbirine karışmaz. Dışarıdan erişim için ana makinenin eth0'ında
# 5501 → proses, 5502 → paketleme, 5503 → lojistik yönlendirilir (DNAT); OpenPLC'lerin simülatöre
# gidişi NAT'la (MASQUERADE) çıkar.
#
#   sudo ./oplc3.sh setup              # klasörleri kopyala (bir kez), ağ alanlarını ve NAT'ı kur
#   sudo SIM_PORT=5025 ./oplc3.sh load # üç rolü derle + yapılandır (run_ayran.sh, NO_START=1)
#   sudo ./oplc3.sh start | stop       # üç OpenPLC'yi başlat / durdur
#   sudo ./oplc3.sh restart paketleme  # tek bir OpenPLC'yi yeniden başlat (kalıcı bellek dosyadan gelir)
#   sudo ./oplc3.sh status
#
#   BASE_DIR   kopyalanacak OpenPLC_v3 (varsayılan /root/oplc); kopyalar BASE_DIR-<rol>
#   Gerekli: iproute2, iptables. Ana systemd openplc servisi 502'yi kendi ağ alanında tutar;
#   bu betik ona dokunmaz.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
BASE_DIR=${BASE_DIR:-/root/oplc}
ROLES=(proses paketleme lojistik)
idx() { case "$1" in proses) echo 1 ;; paketleme) echo 2 ;; lojistik) echo 3 ;; *) echo "rol?" >&2; exit 1 ;; esac; }
EXT_IF=${EXT_IF:-$(ip route show default | awk '{print $5; exit}')}

setup_one() {
  local r=$1 i; i=$(idx "$r")
  local ns=oplc-$r dir=$BASE_DIR-$r
  [ -d "$dir" ] || { echo "kopyalanıyor: $dir"; cp -a "$BASE_DIR" "$dir"; }
  ip netns list | grep -qw "$ns" || ip netns add "$ns"
  if ! ip link show "vh-$r" >/dev/null 2>&1; then
    ip link add "vh-$r" type veth peer name "vn-$r"
    ip link set "vn-$r" netns "$ns"
    ip addr add "10.50.$i.1/24" dev "vh-$r"
    ip link set "vh-$r" up
    ip netns exec "$ns" ip addr add "10.50.$i.2/24" dev "vn-$r"
    ip netns exec "$ns" ip link set "vn-$r" up
    ip netns exec "$ns" ip link set lo up
    ip netns exec "$ns" ip route add default via "10.50.$i.1"
  fi
  iptables -t nat -C PREROUTING -i "$EXT_IF" -p tcp --dport "550$i" -j DNAT --to-destination "10.50.$i.2:502" 2>/dev/null \
    || iptables -t nat -A PREROUTING -i "$EXT_IF" -p tcp --dport "550$i" -j DNAT --to-destination "10.50.$i.2:502"
  # WSL içinden (localhost) erişim için
  iptables -t nat -C OUTPUT -p tcp -d 127.0.0.1 --dport "550$i" -j DNAT --to-destination "10.50.$i.2:502" 2>/dev/null \
    || iptables -t nat -A OUTPUT -p tcp -d 127.0.0.1 --dport "550$i" -j DNAT --to-destination "10.50.$i.2:502"
}

case "$1" in
  setup)
    sysctl -q -w net.ipv4.ip_forward=1
    sysctl -q -w net.ipv4.conf.all.route_localnet=1
    for r in "${ROLES[@]}"; do setup_one "$r"; done
    iptables -t nat -C POSTROUTING -s 10.50.0.0/16 -o "$EXT_IF" -j MASQUERADE 2>/dev/null \
      || iptables -t nat -A POSTROUTING -s 10.50.0.0/16 -o "$EXT_IF" -j MASQUERADE
    iptables -t nat -C POSTROUTING -d 10.50.0.0/16 -j MASQUERADE 2>/dev/null \
      || iptables -t nat -A POSTROUTING -d 10.50.0.0/16 -j MASQUERADE
    echo "kuruldu: $(ip netns list | tr '\n' ' ')" ;;
  load)
    # simülatör Windows'ta: ağ alanından görünen adresi ana makinenin varsayılan ağ geçidi
    SIM_HOST=${SIM_HOST:-$(ip route show default | awk '{print $3; exit}')}
    for r in "${ROLES[@]}"; do
      echo "== $r"
      ROLE=$r OPENPLC_DIR=$BASE_DIR-$r SIM_HOST=$SIM_HOST NO_START=1 bash "$HERE/run_ayran.sh" "$HERE/../build/$r.st" 2>&1 \
        | grep -E "Rol:|Registers|rror|successfully"
      rm -f "$BASE_DIR-$r/webserver/persistent.file"
    done ;;
  start)
    for r in "${ROLES[@]}"; do
      setsid -f ip netns exec "oplc-$r" bash -c "cd '$BASE_DIR-$r/webserver' && exec '$BASE_DIR-$r/.venv/bin/python3' webserver.py > /var/log/oplc-$r.log 2>&1" < /dev/null > /dev/null 2>&1
    done
    sleep 4; bash "$HERE/oplc3.sh" status ;;
  stop)
    for r in "${ROLES[@]}"; do ip netns pids "oplc-$r" 2>/dev/null | xargs -r kill; done
    sleep 1; echo durduruldu ;;
  restart)
    r=$2; idx "$r" >/dev/null
    ip netns pids "oplc-$r" | xargs -r kill
    sleep 1
    setsid -f ip netns exec "oplc-$r" bash -c "cd '$BASE_DIR-$r/webserver' && exec '$BASE_DIR-$r/.venv/bin/python3' webserver.py >> /var/log/oplc-$r.log 2>&1" < /dev/null > /dev/null 2>&1
    echo "$r yeniden başlatıldı" ;;
  status)
    for r in "${ROLES[@]}"; do
      i=$(idx "$r"); n=$(ip netns pids "oplc-$r" 2>/dev/null | wc -l)
      echo "$r: ağ alanı oplc-$r, süreç $n, Modbus slave 10.50.$i.2:502 (dışarıdan :550$i)"
    done ;;
  *) sed -n '2,15p' "$0" ;;
esac
