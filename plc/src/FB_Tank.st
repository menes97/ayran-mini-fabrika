(* =====================================================================
   FB_Tank - tank, transfer hatti ve CIP (fabrikanin 2. blogu)

   Hat: kaynaklar V_PROD / V_WATER / V_CAUSTIC -> pompa P1 -> debimetre FT1
        -> hedefler V_FILL (dolum tanki) / V_DRAIN (gider) / V_CIPRET (kostik tanki)

   Rota yoneticisi: her rota degisiminde pompa durur, yeni rotada olmayan
   butun vanalarin KAPALI oldugu sinir anahtarlariyla kanitlanir, yeni rota
   acilir, vana strok suresi beklenir, pompa yeniden kalkar. Rotada olmayan
   bir vana acik gorunurse pompa durur ve alarm verilir. Boylece kostik ve
   urun ayni anda ayni hatta bulunamaz.

   Dolum makinesi urun ister (REQ); bu blok aktarir ya da sebebini bildirir.
   Sureler demo olcegindedir (gercek CIP'te kostik temas suresi 10-20 dk).
   ===================================================================== *)

FUNCTION_BLOCK FB_Tank
  VAR_IN_OUT
    TNK_COMMISSION : WORD; (* one-shot commissioning token; consumed, never renewed by the FB *)
  END_VAR
  VAR_INPUT
    RESTART : BOOL;
    START : BOOL;
    ESTOP_OK, RESET : BOOL;   (* fabrika paneli *)
    IO_READY   : BOOL;
    COMM_FAULT : BOOL;
    REQ        : BOOL;        (* dolum makinesi urun istiyor *)
    IW_DI      : WORD;
    IW_T1_LVL  : INT;         (* 0,1 % *)
    IW_FLOW    : INT;         (* 0,01 kg/s *)
    IW_TOTAL   : INT;         (* 0,1 kg, 30000'de sifirlanir *)
    IW_COND    : INT;         (* 0,1 mS/cm, 25 C'ye duzeltilmis *)
    IW_RET_T   : INT;         (* 0,1 C *)
    IW_CIP_T   : INT;         (* 0,1 C *)
    IW_CIP_LVL : INT;         (* 0,1 % *)
  END_VAR
  VAR_OUTPUT
    QW_STATUS : WORD;
    QW_DO       : WORD;
    QW_STATE    : INT;
    QW_ALARM    : WORD;
    QW_STEP_T   : INT;
    QW_SINCE    : INT;
    QW_BATCH    : INT;
    QW_CIP_RES  : INT;
    QW_CIP_MINT : INT;
    QW_CIP_MINF : INT;
    QW_CIP_COND : INT;
    QW_CIP_DUR  : INT;
    TRANSFERRING : BOOL;
    CIP_DUE      : BOOL;
  END_VAR

  VAR
    (* ---- Recete ve ayarlar (demo olcegi) ------------------------------ *)
    COND_MIN      : INT := 85;     (* urun penceresi 8,5..9,5 mS/cm (~%5 su icerir) *)
    COND_MAX      : INT := 95;
    COND_CAUSTIC  : INT := 650;    (* etkili kostik: >= 65 mS/cm (~%80 derisim); donuse ancak bu derisimde *)
    RINSE_MARGIN  : INT := 5;      (* son durulama: giris suyu + 0,5 mS/cm *)
    FLOW_MIN      : INT := 50;     (* 0,5 kg/s *)
    FLOW_CIP      : INT := 150;    (* CIP icin 1,5 kg/s *)
    CIP_TEMP_MIN  : INT := 700;    (* donus sicakligi >= 70 C *)
    CAUSTIC_SP    : INT := 780;
    CAUSTIC_MAX   : INT := 900;
    CIP_LVL_MIN   : INT := 300;
    RINSE_KG      : INT := 300;    (* her durulama 30 kg su *)
    CIP_LIMIT     : INT := 500;    (* 50 kg uretimde bir CIP *)
    ALARM_MASK    : WORD := WORD#16#23FF;   (* bit 0-9 ve 13 alarm, 10-12 uyari *)
  END_VAR

  VAR
    (* ---- Cozulmus girisler ------------------------------------------- *)
    DI_T1_LOW, DI_CIP_START, DI_CIP_ABORT, DI_P1_RUN, DI_P1_TRIP, DI_LEAK : BOOL;
    CLOSED   : WORD;   (* DO bitleriyle hizali: bit1 V_PROD .. bit6 V_CIPRET *)

    (* ---- Rota yoneticisi ---------------------------------------------- *)
    WANT     : WORD;   (* adimin istedigi rota *)
    CUR      : WORD;   (* kanitlanmis, uygulanan rota *)
    VALVES   : WORD;   (* vanalara giden komut *)
    RSTATE       : INT;    (* 0 kararli, 1 kapatiliyor, 2 aciliyor *)
    PUMP_REQ : BOOL;
    Q_P1     : BOOL;
    Q_HEAT   : BOOL;
    ROUTE_OK : BOOL;   (* rotada olmayan butun vanalar kapali *)

    (* ---- Durum -------------------------------------------------------- *)
    WAIT_START : BOOL := TRUE;
    MODE : INT := 0;
    RT_START : R_TRIG;
    STP        : INT := 0;
    LAST_STP   : INT := 0;
    STEP_SCANS  : INT;
    CIP_SCANS   : INT;
    ALARMS_BEFORE : WORD;
    ALARMS      : WORD;
    WARNS       : WORD;
    ABORT_WARN  : BOOL;
    LINE_PRODUCT : BOOL;   (* hat urunle dolu ve dogrulanmis *)
    CIP_REQ     : BOOL;    (* operator CIP istedi; aktarim bitince baslar *)
    CAUSTIC_IN  : BOOL;    (* kostik donuse yonlendirildi *)
    COND_OK     : BOOL;
    HOLD_OK     : BOOL;
    STEP_TO     : BOOL;
    TOTAL_LAST  : INT;
    TOTAL_INIT  : BOOL;
    D_TOTAL     : INT;
    SINCE       : INT;
    BATCH       : INT;
    VOL         : INT;
    WATER_REF   : INT;
    MIN_T       : INT;
    MIN_F       : INT;
    CIP_RES     : INT;
    FINAL_COND  : INT;
    CIP_DUR     : INT;

    (* ---- Zamanlayicilar (matiec: her biri ayri satirda) --------------- *)
    RT_CIPSTART : R_TRIG;
    RT_CIPABORT : R_TRIG;
    RT_RESET    : R_TRIG;
    T_ROUTE     : TON;
    T_STROKE    : TON;
    T_LEAKVAL   : TON;
    T_NOFLOW    : TON;
    T_RUNFB     : TON;
    T_INWIN     : TON;
    T_FOREIGN   : TON;
    T_HOLD      : TON;
    T_STALE     : TON;
  END_VAR

  ALARMS_BEFORE := ALARMS;
  IF RESTART THEN
    MODE := 0; WAIT_START := TRUE;
    STP := 0; LAST_STP := 0; WANT := WORD#0; CUR := WORD#0; VALVES := WORD#0; RSTATE := 0;
    RSTATE := 1; (* prove all old-route valves closed *)
    Q_P1 := FALSE; Q_HEAT := FALSE; PUMP_REQ := FALSE; LINE_PRODUCT := FALSE; CIP_REQ := FALSE; TOTAL_INIT := FALSE;
    CIP_DUE := TNK_COMMISSION <> WORD#16#C1EA;
    IF CIP_DUE THEN CIP_RES := 2; ABORT_WARN := TRUE; END_IF;
    TNK_COMMISSION := WORD#0;
    T_ROUTE(IN := FALSE, PT := T#1s);
    T_STROKE(IN := FALSE, PT := T#1s);
    T_LEAKVAL(IN := FALSE, PT := T#1s);
    T_NOFLOW(IN := FALSE, PT := T#1s);
    T_RUNFB(IN := FALSE, PT := T#1s);
    T_INWIN(IN := FALSE, PT := T#1s);
    T_FOREIGN(IN := FALSE, PT := T#1s);
    T_HOLD(IN := FALSE, PT := T#1s);
    T_STALE(IN := FALSE, PT := T#1s);
  END_IF;

  (* =================== 1. Girisleri coz =================== *)
  DI_T1_LOW    := (IW_DI AND WORD#16#0001) <> WORD#0;
  DI_CIP_START := (IW_DI AND WORD#16#0002) <> WORD#0;
  DI_CIP_ABORT := (IW_DI AND WORD#16#0004) <> WORD#0;
  DI_P1_RUN    := (IW_DI AND WORD#16#0008) <> WORD#0;
  DI_P1_TRIP   := (IW_DI AND WORD#16#0010) <> WORD#0;
  DI_LEAK      := (IW_DI AND WORD#16#0800) <> WORD#0;
  (* kapali sinir anahtarlari DI bit 5..10; 4 bit saga kaydirinca DO bit 1..6 ile hizalanir *)
  CLOSED := SHR(IW_DI, 4) AND WORD#16#007E;

  RT_CIPSTART(CLK := DI_CIP_START);
  RT_CIPABORT(CLK := DI_CIP_ABORT);
  RT_RESET(CLK := RESET);
  RT_START(CLK := START);
  IF RT_START.Q AND IO_READY AND NOT RESTART THEN WAIT_START := FALSE; MODE := 1; END_IF;

  (* debimetre toplayicisindan bu taramadaki artis (30000'de sifirlanma dahil) *)
  IF NOT TOTAL_INIT THEN TOTAL_LAST := IW_TOTAL; TOTAL_INIT := IO_READY; END_IF;
  D_TOTAL := IW_TOTAL - TOTAL_LAST;
  IF D_TOTAL < 0 THEN D_TOTAL := D_TOTAL + 30000; END_IF;
  TOTAL_LAST := IW_TOTAL;

  COND_OK := (IW_COND >= COND_MIN) AND (IW_COND <= COND_MAX);

  (* =================== 2. Guvenlik ve alarmlar =================== *)
  IF NOT ESTOP_OK THEN ALARMS := ALARMS OR WORD#16#0001; END_IF;
  IF COMM_FAULT THEN ALARMS := ALARMS OR WORD#16#2000; END_IF;   (* haberlesme yoksa guvenli dur *)
  IF DI_P1_TRIP THEN ALARMS := ALARMS OR WORD#16#0020; END_IF;
  IF DI_LEAK THEN ALARMS := ALARMS OR WORD#16#0010; END_IF;

  (* rotada olmayan bir vana 1 s boyunca kapali gorunmuyorsa: vana takili ya da kacak *)
  ROUTE_OK := ((NOT CUR) AND WORD#16#007E AND (NOT CLOSED)) = WORD#0;
  T_LEAKVAL(IN := RSTATE = 0 AND NOT ROUTE_OK, PT := T#1s);
  IF T_LEAKVAL.Q THEN ALARMS := ALARMS OR WORD#16#0008; END_IF;

  T_NOFLOW(IN := Q_P1 AND (IW_FLOW < FLOW_MIN), PT := T#3s);
  IF T_NOFLOW.Q THEN ALARMS := ALARMS OR WORD#16#0002; END_IF;
  T_RUNFB(IN := Q_P1 AND NOT DI_P1_RUN, PT := T#1s);
  IF T_RUNFB.Q THEN ALARMS := ALARMS OR WORD#16#0040; END_IF;

  IF IW_CIP_T > CAUSTIC_MAX THEN ALARMS := ALARMS OR WORD#16#0100; END_IF;

  IF NOT IO_READY THEN ALARMS := ALARMS_BEFORE; END_IF;

  (* alarm: her sey kapanir; CIP sirasindaysa CIP basarisiz sayilir *)
  IF (ALARMS AND ALARM_MASK) <> WORD#0 THEN
    IF STP >= 40 THEN CIP_RES := 3; CIP_DUE := TRUE; LINE_PRODUCT := FALSE; END_IF;
    STP := 0;
  END_IF;

  IF RT_RESET.Q THEN
    IF ESTOP_OK AND NOT COMM_FAULT AND NOT DI_P1_TRIP AND NOT DI_LEAK THEN
      ALARMS := WORD#0;
    END_IF;
  END_IF;

  (* =================== 3. Adimlar =================== *)
  (* not: STEP ve RS IEC 61131-3 ayrilmis sozcukleri (SFC adimi, RS flip-flop); STP / RSTATE kullanildi *)
  IF STP <> LAST_STP THEN STEP_SCANS := 0; VOL := 0; END_IF;
  LAST_STP := STP;
  IF STEP_SCANS < 30000 THEN STEP_SCANS := STEP_SCANS + 1; END_IF;
  IF RSTATE = 0 AND (STP = 42 OR STP = 44) THEN VOL := VOL + D_TOTAL; END_IF;

  (* uretim icin uygulanan rotadan gecen miktar *)
  IF CUR = WORD#16#0012 OR CUR = WORD#16#0022 THEN
    IF SINCE < 30000 THEN SINCE := SINCE + D_TOTAL; END_IF;
  END_IF;
  IF CUR = WORD#16#0012 THEN BATCH := BATCH + D_TOTAL; END_IF;
  IF SINCE >= CIP_LIMIT THEN CIP_DUE := TRUE; END_IF;

  (* hatta uzun sure bekleyen urun bayatlar: tekrar push-out gerekir *)
  T_STALE(IN := STP = 0 AND LINE_PRODUCT, PT := T#1200s);
  IF T_STALE.Q THEN LINE_PRODUCT := FALSE; END_IF;

  IF RT_CIPSTART.Q THEN CIP_REQ := TRUE; END_IF;

  (* CIP iptali *)
  IF RT_CIPABORT.Q AND STP >= 40 THEN
    CIP_RES := 2;
    CIP_DUE := TRUE;
    CIP_REQ := FALSE;
    ABORT_WARN := TRUE;
    LINE_PRODUCT := FALSE;
    STP := 0;
  END_IF;

  T_INWIN(IN := STP = 20 AND RSTATE = 0 AND Q_P1 AND COND_OK, PT := T#1s);
  T_FOREIGN(IN := STP = 10 AND RSTATE = 0 AND Q_P1 AND NOT COND_OK, PT := T#1s);
  HOLD_OK := STP = 43 AND RSTATE = 0 AND CUR = WORD#16#0048 AND Q_P1
             AND IW_COND >= COND_CAUSTIC AND IW_RET_T >= CIP_TEMP_MIN AND IW_FLOW >= FLOW_CIP;
  T_HOLD(IN := HOLD_OK, PT := T#30s);
  STEP_TO := STEP_SCANS >= 15000;     (* 300 s; 20 ms gorev suresiyle *)

  CASE STP OF
    0:  (* bekleme *)
      WANT := WORD#0;
      PUMP_REQ := FALSE;
      IF NOT WAIT_START AND (ALARMS AND ALARM_MASK) = WORD#0 THEN
        IF CIP_REQ THEN
          CIP_REQ := FALSE;
          STP := 40;
        ELSIF REQ AND NOT CIP_DUE AND NOT DI_T1_LOW THEN
          BATCH := 0;
          IF LINE_PRODUCT THEN STP := 10; ELSE STP := 20; END_IF;
        END_IF;
      END_IF;

    20: (* hatti urunle doldur: ilk sivi gidere *)
      WANT := WORD#16#0022;            (* V_PROD + V_DRAIN *)
      PUMP_REQ := TRUE;
      IF T_INWIN.Q THEN
        LINE_PRODUCT := TRUE;
        STP := 10;                     (* rota yoneticisi pompayi durdurup rotayi degistirir *)
      ELSIF STEP_SCANS > 2250 THEN
        ALARMS := ALARMS OR WORD#16#0200;   (* 45 s'de urun iletkenligi yakalanamadi *)
      END_IF;

    10: (* dolum tankina aktar *)
      WANT := WORD#16#0012;            (* V_PROD + V_FILL *)
      PUMP_REQ := TRUE;
      IF T_FOREIGN.Q THEN
        LINE_PRODUCT := FALSE;
        ALARMS := ALARMS OR WORD#16#0004;
      ELSIF NOT REQ OR DI_T1_LOW OR SINCE >= CIP_LIMIT OR CIP_REQ THEN
        STP := 0;
      END_IF;

    40: (* CIP hazirlik: hat bos rota, butun vanalar kapali kanitlansin *)
      WANT := WORD#0;
      PUMP_REQ := FALSE;
      LINE_PRODUCT := FALSE;
      CAUSTIC_IN := FALSE;
      CIP_SCANS := 0;
      MIN_T := 32000;
      MIN_F := 32000;
      FINAL_COND := 0;
      IF IW_CIP_LVL < CIP_LVL_MIN THEN
        ALARMS := ALARMS OR WORD#16#0100;
      ELSIF RSTATE = 0 AND ROUTE_OK THEN
        STP := 41;
      END_IF;

    41: (* kostik sicakligini bekle *)
      WANT := WORD#0;
      PUMP_REQ := FALSE;
      IF IW_CIP_T >= CAUSTIC_SP - 50 THEN
        STP := 42;
      ELSIF STEP_TO THEN
        ALARMS := ALARMS OR WORD#16#0080;
      END_IF;

    42: (* on durulama: su gidere *)
      WANT := WORD#16#0024;            (* V_WATER + V_DRAIN *)
      PUMP_REQ := TRUE;
      IF VOL >= RINSE_KG THEN
        WATER_REF := IW_COND;           (* giris suyunun iletkenligi: son durulamanin olcutu *)
        STP := 43;
      ELSIF STEP_TO THEN
        ALARMS := ALARMS OR WORD#16#0080;
      END_IF;

    43: (* kostik: once gidere, kostik gelince kostik tankina (faz ayirma) *)
      PUMP_REQ := TRUE;
      IF NOT CAUSTIC_IN AND RSTATE = 0 AND IW_COND >= COND_CAUSTIC THEN CAUSTIC_IN := TRUE; END_IF;
      IF CAUSTIC_IN THEN
        WANT := WORD#16#0048;          (* V_CAUSTIC + V_CIPRET *)
      ELSE
        WANT := WORD#16#0028;          (* V_CAUSTIC + V_DRAIN *)
      END_IF;
      (* CIP kaydi: sayilan tutma penceresindeki en dusuk degerler *)
      IF HOLD_OK THEN
        IF IW_RET_T < MIN_T THEN MIN_T := IW_RET_T; END_IF;
        IF IW_FLOW < MIN_F THEN MIN_F := IW_FLOW; END_IF;
      ELSE
        MIN_T := 32000;
        MIN_F := 32000;
      END_IF;
      IF T_HOLD.Q THEN
        STP := 44;
      ELSIF STEP_TO THEN
        ALARMS := ALARMS OR WORD#16#0080;
      END_IF;

    44: (* son durulama: kostik kalmayana kadar *)
      WANT := WORD#16#0024;
      PUMP_REQ := TRUE;
      IF VOL >= RINSE_KG AND IW_COND <= WATER_REF + RINSE_MARGIN THEN
        FINAL_COND := IW_COND;
        STP := 45;
      ELSIF STEP_TO THEN
        ALARMS := ALARMS OR WORD#16#0080;
      END_IF;

    45: (* tamamlandi *)
      WANT := WORD#0;
      PUMP_REQ := FALSE;
      SINCE := 0;
      CIP_DUE := FALSE;
      ABORT_WARN := FALSE;
      CIP_RES := 1;
      CIP_DUR := CIP_SCANS / 50;
      STP := 0;
  END_CASE;
  IF STP >= 40 AND STP <= 44 AND CIP_SCANS < 30000 THEN CIP_SCANS := CIP_SCANS + 1; END_IF;
  IF CIP_RES = 2 OR CIP_RES = 3 THEN CIP_DUR := CIP_SCANS / 50; END_IF;

  (* =================== 4. Rota yoneticisi =================== *)
  IF (ALARMS AND ALARM_MASK) <> WORD#0 THEN WANT := WORD#0; END_IF;
  IF WANT <> CUR AND RSTATE = 0 THEN RSTATE := 1; END_IF;
  T_ROUTE(IN := RSTATE = 1, PT := T#3s);
  T_STROKE(IN := RSTATE = 2, PT := T#1s);
  IF RSTATE = 1 THEN
    VALVES := CUR AND WANT;            (* yeni rotada olmayanlari kapat *)
    IF ((NOT WANT) AND WORD#16#007E AND (NOT CLOSED)) = WORD#0 THEN
      RSTATE := 2;
    ELSIF T_ROUTE.Q THEN
      ALARMS := ALARMS OR WORD#16#0008;
      RSTATE := 0;
      CUR := CUR AND WANT;
    END_IF;
  ELSIF RSTATE = 2 THEN
    VALVES := WANT;
    IF T_STROKE.Q THEN CUR := WANT; RSTATE := 0; END_IF;
  ELSE
    VALVES := CUR;
  END_IF;

  Q_P1 := PUMP_REQ AND RSTATE = 0 AND CUR = WANT AND CUR <> WORD#0 AND ROUTE_OK
          AND (ALARMS AND ALARM_MASK) = WORD#0;

  (* kostik tanki termostati (+/- 2 C), seviye ve asiri sicaklik kilidi *)
  IF NOT ESTOP_OK OR IW_CIP_LVL < CIP_LVL_MIN OR IW_CIP_T > CAUSTIC_MAX THEN
    Q_HEAT := FALSE;
  ELSIF IW_CIP_T < CAUSTIC_SP - 20 THEN
    Q_HEAT := TRUE;
  ELSIF IW_CIP_T > CAUSTIC_SP + 20 THEN
    Q_HEAT := FALSE;
  END_IF;

  (* =================== 5. Cikislar =================== *)
  WARNS := WORD#0;
  IF DI_T1_LOW THEN WARNS := WARNS OR WORD#16#0400; END_IF;
  IF CIP_DUE THEN WARNS := WARNS OR WORD#16#0800; END_IF;
  IF ABORT_WARN THEN WARNS := WARNS OR WORD#16#1000; END_IF;

  QW_DO := VALVES AND WORD#16#007E;
  IF Q_P1 THEN QW_DO := QW_DO OR WORD#16#0001; END_IF;
  IF Q_HEAT THEN QW_DO := QW_DO OR WORD#16#0080; END_IF;
  IF STP >= 40 THEN QW_DO := QW_DO OR WORD#16#0100; END_IF;

  IF (ALARMS AND WORD#16#0001) <> WORD#0 THEN
    QW_STATE := 11;
  ELSIF (ALARMS AND ALARM_MASK) <> WORD#0 THEN
    QW_STATE := 10;
  ELSIF STP = 0 AND CIP_DUE THEN
    QW_STATE := 9;
  ELSIF STP = 0 THEN
    QW_STATE := 0;
  ELSIF (STP = 10 OR STP = 20) AND RSTATE <> 0 THEN
    QW_STATE := 3;
  ELSIF STP = 10 THEN
    QW_STATE := 1;
  ELSIF STP = 20 THEN
    QW_STATE := 2;
  ELSE
    QW_STATE := STP - 36;             (* 40..44 -> 4..8 *)
  END_IF;

  QW_ALARM    := ALARMS OR WARNS;
  QW_STEP_T   := STEP_SCANS / 50;
  QW_SINCE    := SINCE;
  QW_BATCH    := BATCH;
  QW_CIP_RES  := CIP_RES;
  IF MIN_T = 32000 THEN QW_CIP_MINT := 0; ELSE QW_CIP_MINT := MIN_T; END_IF;
  IF MIN_F = 32000 THEN QW_CIP_MINF := 0; ELSE QW_CIP_MINF := MIN_F; END_IF;
  QW_CIP_COND := FINAL_COND;
  QW_CIP_DUR  := CIP_DUR;
  TRANSFERRING := STP = 10 AND Q_P1;
  QW_STATUS := WORD#0;
  IF WAIT_START THEN QW_STATUS := WORD#16#0080; END_IF;
  IF WAIT_START OR NOT IO_READY THEN
    QW_DO := WORD#0;
    Q_HEAT := FALSE; Q_P1 := FALSE;
  END_IF;
END_FUNCTION_BLOCK
