(* =====================================================================
   FB_Pallet - robotlu paletleme, palet hatti ve strec sarma (4. blok)

   Robot arayuzu (robot kontrolcusu kendi programini calistirir):
     PLC -> robot : JOB, SLOT, SEQ. SEQ degisince is baslar; ayni SEQ ikinci
                    kez calismaz. Is numarasi blok halinde (tek FC16) yazilir.
     robot -> PLC : ACK_SEQ (is kabul edildi), RES_SEQ + RES_CODE + RES_SLOT
                    (is bitti). Sonuc kaydi kalicidir.
   Paletteki paket sayisi yalnizca robot "tamam" (1) ya da "birakildi,
   sonra iptal" (17) dedikten sonra artar. Dusen paketin slotu bos kalir,
   bir sonraki paket ayni slota konur. Zaman asiminda is kor olarak
   tekrarlanmaz: alarm verilir.

   Is secimi (her is bitince yeniden): konum dogrulanmamissa eve don; tutucuda
   paket varsa bir sonraki slota birak; palet yeni geldiyse alt karton;
   palet doluysa ust karton; aksi halde alma noktasindaki paketi al. Palet
   degisirken onceden paket alinmaz: tutucu kartonu da tasidigi icin elinde
   paketle alt kartonu koyamaz (kilitlenme).

   Guvenlik (kapi, isik perdesi, muting, acil stop) simulatordeki bagimsiz
   guvenlik kontrolcusundedir; bu blok yalnizca durumunu okur. Reset hareket
   baslatmaz: alarmdan sonra robot HOLD'da kalir, Start ile devam eder.
   Sertifikali bir guvenlik tasarimi degildir.
   ===================================================================== *)

FUNCTION_BLOCK FB_Pallet
  VAR_IN_OUT
    RET_MAGIC : WORD;
    RET_MAPVER : INT;
    PAL_COUNT : INT;
    PAL_ID : INT;
    PAL_DONE : INT;
    PAL_WRAPPED : INT;
    PAL_SHEETS : WORD;
    PAL_LAST_SEQ : INT;
    PAL_ACTIVE : WORD;
    PAL_C_PHASE : INT;
    PAL_UNDERWRAP : WORD;
    RET_CHECK : WORD;
  END_VAR
  VAR_INPUT
    RESTART : BOOL;
    START, STOP_OK, ESTOP_OK, RESET : BOOL;
    IO_READY    : BOOL;
    COMM_FAULT  : BOOL;
    IW_DI       : WORD;
    IW_ROB_DI   : WORD;
    IW_ACK_SEQ  : INT;
    IW_RES_SEQ  : INT;
    IW_RES_CODE : INT;
    IW_RES_SLOT : INT;
    IW_RES_JOB  : INT;
    IW_TURNS    : INT;
    IW_PALLETS  : INT;
    IW_SHEETS   : INT;
    AGV_CLEAR   : BOOL;   (* AGV catallari alim noktasinin disinda *)
  END_VAR
  VAR_OUTPUT
    QW_DO        : WORD;
    QW_JOB       : INT;
    QW_SLOT      : INT;
    QW_SEQ       : INT;
    QW_STATE     : INT;
    QW_ALARM     : WORD;
    QW_STATUS    : WORD;
    QW_COUNT     : INT;
    QW_DONE      : INT;
    QW_PALLET_ID : INT;
    QW_WRAPPED   : INT;
    PICKUP_RDY   : BOOL;  (* AGV'ye: palet D'de, D konveyoru duruyor *)
    RUNNING      : BOOL;
  END_VAR

  VAR
    SLOTS      : INT := 18;     (* 3 kat x 6 paket *)
    MIN_TURNS  : INT := 9;      (* strec recetesi: 3 alt + 2 cikis + 2 ust + 2 inis *)
    ALARM_MASK : WORD := WORD#16#63FF;
  END_VAR

  VAR
    DI_PICK, DI_PAL_A, DI_PAL_B, DI_PAL_C, DI_PAL_D, DI_PIN_UP, DI_DISP_BUSY, DI_WRAP_HOME : BOOL;
    DI_WRAP_DONE, DI_WRAP_FAULT, DI_SAFETY_OK : BOOL;
    R_POWER, R_READY, R_AT_HOME, R_CLEAR, R_PART, R_ERROR, R_HOLDING, R_HOMED : BOOL;

    WAIT_START : BOOL := TRUE;
    BOOK_OK : BOOL;
    BOOT_PENDING : BOOL := TRUE;
    RECOVERING : BOOL;
    RECOVER_SEQ : INT;
    LAST_SEQ : INT;
    NEXT_SEQ : INT;
    MODE      : INT := 0;    (* 0 dur, 1 calis, 3 alarm, 4 acil stop *)
    A_STP     : INT := 0;    (* bos palet besleme *)
    B_STP     : INT := 0;    (* istif konumu *)
    C_STP     : INT := 0;    (* strec ve cikis *)
    R_STP     : INT := 0;    (* robot isi *)
    JOB       : INT := 0;
    SLOT      : INT := 0;
    SEQ       : INT := 0;
    COUNT     : INT := 0;
    DONE_CNT  : INT := 0;
    PALLET_ID : INT := 0;
    WRAPPED   : INT := 0;
    SHEET_BOT : BOOL;
    SHEET_TOP : BOOL;
    SEQ_SYNC  : BOOL;
    RST_WIN   : BOOL;
    HOLD_LATCH : BOOL := TRUE;
    ROB_BOOT_OK : BOOL;
    ROB_BOOT_DONE : BOOL;
    CHECK_SUM : DINT;
    UNDERWRAP : BOOL;
    ALARMS_BEFORE : WORD;
    ALARMS    : WORD;
    WARNS     : WORD;
    STATUS    : WORD;
    Q_ENABLE, Q_HOLD, Q_RRESET, Q_DISP, Q_CA, Q_CB, Q_CC, Q_CD, Q_PIN, Q_WRAP, Q_PICKUP, Q_ZONE : BOOL;
    LINE_RUN : BOOL;

    RT_START  : R_TRIG;
    RT_RESET  : R_TRIG;
    T_RSTWIN  : TON;
    T_ACK     : TON;
    T_RES     : TON;
    T_DISP    : TON;
    T_BTRANS  : TON;
    T_CTRANS  : TON;
    T_WRAP    : TON;
    T_ROBSAFE : TON;
  END_VAR

  ALARMS_BEFORE := ALARMS;
  IF RESTART THEN
    MODE := 0; WAIT_START := TRUE;
    A_STP := 0; B_STP := 0; C_STP := 0; R_STP := 0; JOB := 0; SLOT := 0;
    ROB_BOOT_OK := FALSE; ROB_BOOT_DONE := FALSE;
    RECOVERING := FALSE; RECOVER_SEQ := 0;
    T_ROBSAFE(IN := FALSE, PT := T#500ms);
    SEQ_SYNC := FALSE; RST_WIN := FALSE; HOLD_LATCH := TRUE; BOOT_PENDING := TRUE; BOOK_OK := FALSE;
    T_RSTWIN(IN := FALSE, PT := T#1s);
    T_ACK(IN := FALSE, PT := T#1s);
    T_RES(IN := FALSE, PT := T#1s);
    T_DISP(IN := FALSE, PT := T#1s);
    T_BTRANS(IN := FALSE, PT := T#1s);
    T_CTRANS(IN := FALSE, PT := T#1s);
    T_WRAP(IN := FALSE, PT := T#1s);
  END_IF;

  (* =================== 1. Girisleri coz =================== *)
  DI_PICK       := (IW_DI AND WORD#16#0001) <> WORD#0;
  DI_PAL_A      := (IW_DI AND WORD#16#0002) <> WORD#0;
  DI_PAL_B      := (IW_DI AND WORD#16#0004) <> WORD#0;
  DI_PAL_C      := (IW_DI AND WORD#16#0008) <> WORD#0;
  DI_PAL_D      := (IW_DI AND WORD#16#0010) <> WORD#0;
  DI_PIN_UP     := (IW_DI AND WORD#16#0020) <> WORD#0;
  DI_DISP_BUSY  := (IW_DI AND WORD#16#0040) <> WORD#0;
  DI_WRAP_HOME  := (IW_DI AND WORD#16#0080) <> WORD#0;
  DI_WRAP_DONE  := (IW_DI AND WORD#16#0200) <> WORD#0;
  DI_WRAP_FAULT := (IW_DI AND WORD#16#0400) <> WORD#0;
  DI_SAFETY_OK  := (IW_DI AND WORD#16#0800) <> WORD#0;

  R_POWER   := (IW_ROB_DI AND WORD#16#0001) <> WORD#0;
  R_READY   := (IW_ROB_DI AND WORD#16#0002) <> WORD#0;
  R_AT_HOME := (IW_ROB_DI AND WORD#16#0008) <> WORD#0;
  R_CLEAR   := (IW_ROB_DI AND WORD#16#0010) <> WORD#0;
  R_PART    := (IW_ROB_DI AND WORD#16#0020) <> WORD#0;
  R_ERROR   := (IW_ROB_DI AND WORD#16#0080) <> WORD#0;
  R_HOLDING := (IW_ROB_DI AND WORD#16#0100) <> WORD#0;
  R_HOMED   := (IW_ROB_DI AND WORD#16#0200) <> WORD#0;

  RT_START(CLK := START);
  RT_RESET(CLK := RESET);

  (* Accepted work stays in the robot controller: validate its predecessor,
     wait under HOLD for START, then reconcile the terminal record here. *)
  IF IO_READY AND RECOVERING AND IW_ACK_SEQ <> RECOVER_SEQ THEN
    RECOVERING := FALSE; BOOK_OK := FALSE;
  END_IF;
  IF IO_READY AND (BOOT_PENDING OR (RECOVERING AND IW_RES_SEQ = RECOVER_SEQ AND (IW_ROB_DI AND WORD#4) = WORD#0)) THEN
    BOOT_PENDING := FALSE; RECOVERING := FALSE;
    CHECK_SUM := DINT#1;
    CHECK_SUM := (CHECK_SUM * DINT#31 + WORD_TO_DINT(RET_MAGIC)) MOD DINT#65521;
    CHECK_SUM := (CHECK_SUM * DINT#31 + INT_TO_DINT(RET_MAPVER)) MOD DINT#65521;
    CHECK_SUM := (CHECK_SUM * DINT#31 + INT_TO_DINT(PAL_COUNT)) MOD DINT#65521;
    CHECK_SUM := (CHECK_SUM * DINT#31 + INT_TO_DINT(PAL_ID)) MOD DINT#65521;
    CHECK_SUM := (CHECK_SUM * DINT#31 + INT_TO_DINT(PAL_DONE)) MOD DINT#65521;
    CHECK_SUM := (CHECK_SUM * DINT#31 + INT_TO_DINT(PAL_WRAPPED)) MOD DINT#65521;
    CHECK_SUM := (CHECK_SUM * DINT#31 + WORD_TO_DINT(PAL_SHEETS)) MOD DINT#65521;
    CHECK_SUM := (CHECK_SUM * DINT#31 + INT_TO_DINT(PAL_LAST_SEQ)) MOD DINT#65521;
    CHECK_SUM := (CHECK_SUM * DINT#31 + WORD_TO_DINT(PAL_ACTIVE)) MOD DINT#65521;
    CHECK_SUM := (CHECK_SUM * DINT#31 + INT_TO_DINT(PAL_C_PHASE)) MOD DINT#65521;
    CHECK_SUM := (CHECK_SUM * DINT#31 + WORD_TO_DINT(PAL_UNDERWRAP)) MOD DINT#65521;
    (* Map 7 adds shrink I/O only; v6 uses the identical checksummed MW ledger.
       Full validation still applies; the normal commit upgrades it to v7. *)
    BOOK_OK := RET_CHECK = DINT_TO_WORD(CHECK_SUM) AND RET_MAGIC = WORD#16#A55A AND (RET_MAPVER = 7 OR RET_MAPVER = 6)
      AND PAL_COUNT >= 0 AND PAL_COUNT <= SLOTS AND PAL_ID >= 0 AND PAL_ID <= 30000
      AND PAL_DONE >= 0 AND PAL_DONE <= 30000 AND PAL_WRAPPED >= 0 AND PAL_WRAPPED <= 30000
      AND PAL_SHEETS <= WORD#3 AND PAL_LAST_SEQ >= 0 AND PAL_LAST_SEQ <= 30000
      AND PAL_ACTIVE <= WORD#1 AND PAL_C_PHASE >= 0 AND PAL_C_PHASE <= 4 AND PAL_UNDERWRAP <= WORD#1;
    (* Only a virgin, physically empty cell can commission itself. *)
    IF NOT BOOK_OK AND RET_MAGIC = WORD#0 AND RET_MAPVER = 0 AND PAL_COUNT = 0 AND PAL_ID = 0 AND PAL_DONE = 0 AND PAL_WRAPPED = 0 AND PAL_SHEETS = WORD#0 AND PAL_LAST_SEQ = 0 AND PAL_ACTIVE = WORD#0 AND PAL_C_PHASE = 0 AND PAL_UNDERWRAP = WORD#0 AND RET_CHECK = WORD#0
      AND (IW_DI AND WORD#16#005E) = WORD#0 AND IW_ACK_SEQ = 0 AND NOT R_PART THEN
      BOOK_OK := TRUE;
      PAL_COUNT := 0; PAL_ID := 0; PAL_DONE := 0; PAL_WRAPPED := 0;
      PAL_SHEETS := WORD#0; PAL_LAST_SEQ := 0; PAL_ACTIVE := WORD#0; PAL_C_PHASE := 0; PAL_UNDERWRAP := WORD#0;
    END_IF;
    IF BOOK_OK THEN
      COUNT := PAL_COUNT; PALLET_ID := PAL_ID; DONE_CNT := PAL_DONE; WRAPPED := PAL_WRAPPED;
      SHEET_BOT := (PAL_SHEETS AND WORD#1) <> WORD#0;
      SHEET_TOP := (PAL_SHEETS AND WORD#2) <> WORD#0;
      LAST_SEQ := PAL_LAST_SEQ;
      UNDERWRAP := PAL_UNDERWRAP <> WORD#0;
      IF IW_RES_SEQ > 0 AND (IW_RES_JOB < 1 OR IW_RES_JOB > 4) THEN BOOK_OK := FALSE; END_IF;
      IF IW_RES_SEQ > 0 AND (NOT (IW_RES_CODE = 1 OR (IW_RES_CODE >= 10 AND IW_RES_CODE <= 17))
        OR (IW_RES_JOB <= 2 AND (IW_RES_SLOT < 1 OR IW_RES_SLOT > SLOTS))
        OR (IW_RES_JOB = 3 AND IW_RES_SLOT <> 0 AND IW_RES_SLOT <> 1) OR (IW_RES_JOB = 4 AND IW_RES_SLOT <> 0)) THEN BOOK_OK := FALSE; END_IF;
      IF (COUNT > 0 AND NOT SHEET_BOT) OR (SHEET_TOP AND COUNT <> SLOTS) THEN BOOK_OK := FALSE; END_IF;
      IF DI_PAL_B AND IW_RES_SEQ = LAST_SEQ AND IW_RES_JOB = 2
        AND (IW_RES_CODE = 1 OR IW_RES_CODE = 17) AND IW_RES_SLOT <> COUNT THEN BOOK_OK := FALSE; END_IF;
      IF DI_PAL_B AND IW_RES_SEQ = LAST_SEQ AND IW_RES_JOB = 3 AND (IW_RES_CODE = 1 OR IW_RES_CODE = 17)
        AND NOT ((IW_RES_SLOT = 0 AND SHEET_BOT) OR (IW_RES_SLOT = 1 AND SHEET_TOP)) THEN BOOK_OK := FALSE; END_IF;
      IF LAST_SEQ >= 30000 THEN NEXT_SEQ := 1; ELSE NEXT_SEQ := LAST_SEQ + 1; END_IF;
      IF IW_RES_SEQ <> LAST_SEQ THEN
        IF IW_RES_SEQ <> NEXT_SEQ OR IW_RES_JOB < 1 OR IW_RES_JOB > 4 THEN BOOK_OK := FALSE;
        ELSIF IW_RES_CODE = 1 OR IW_RES_CODE = 17 THEN
          IF IW_RES_JOB = 1 THEN
            IF NOT DI_PAL_B OR NOT SHEET_BOT OR IW_RES_SLOT <> COUNT + 1 OR COUNT >= SLOTS THEN BOOK_OK := FALSE; END_IF;
          ELSIF IW_RES_JOB = 2 THEN
            IF NOT DI_PAL_B OR NOT SHEET_BOT OR IW_RES_SLOT <> COUNT + 1 OR IW_RES_SLOT > SLOTS THEN BOOK_OK := FALSE;
            ELSE COUNT := IW_RES_SLOT; END_IF;
          ELSIF IW_RES_JOB = 3 THEN
            IF NOT DI_PAL_B THEN BOOK_OK := FALSE;
            ELSIF IW_RES_SLOT = 0 AND COUNT = 0 AND NOT SHEET_BOT THEN SHEET_BOT := TRUE;
            ELSIF IW_RES_SLOT = 1 AND COUNT = SLOTS AND SHEET_BOT AND NOT SHEET_TOP THEN SHEET_TOP := TRUE;
            ELSE BOOK_OK := FALSE; END_IF;
          END_IF;
        ELSIF IW_RES_CODE < 10 OR IW_RES_CODE > 16 OR (IW_RES_JOB = 3 AND R_PART) THEN BOOK_OK := FALSE;
        END_IF;
        LAST_SEQ := IW_RES_SEQ;
      END_IF;
      IF IW_RES_SEQ >= 30000 THEN NEXT_SEQ := 1; ELSE NEXT_SEQ := IW_RES_SEQ + 1; END_IF;
      IF IW_ACK_SEQ < 0 OR IW_ACK_SEQ > 30000 OR IW_RES_SEQ < 0 OR IW_RES_SEQ > 30000
        OR (IW_ACK_SEQ <> IW_RES_SEQ AND IW_ACK_SEQ <> NEXT_SEQ)
        OR ((IW_ROB_DI AND WORD#4) <> WORD#0 AND IW_ACK_SEQ = IW_RES_SEQ) THEN BOOK_OK := FALSE; END_IF;
      IF DI_PAL_B THEN
        IF PAL_ACTIVE <> WORD#1 OR PALLET_ID = 0 THEN BOOK_OK := FALSE; END_IF;
        IF COUNT >= SLOTS AND SHEET_TOP THEN B_STP := 20; ELSE B_STP := 10; END_IF;
      ELSE
        IF PAL_ACTIVE = WORD#1 AND NOT (DI_PAL_C AND COUNT = SLOTS AND SHEET_TOP) THEN BOOK_OK := FALSE;
        ELSIF PAL_ACTIVE = WORD#1 THEN
          IF DONE_CNT >= 30000 THEN DONE_CNT := 0; ELSE DONE_CNT := DONE_CNT + 1; END_IF;
        END_IF;
        B_STP := 0; COUNT := 0; SHEET_BOT := FALSE; SHEET_TOP := FALSE;
      END_IF;
      IF DI_PAL_C THEN
        IF PAL_C_PHASE >= 2 THEN C_STP := PAL_C_PHASE;
        ELSIF DI_WRAP_DONE OR IW_TURNS >= MIN_TURNS THEN
          IF DI_WRAP_DONE THEN C_STP := 2; ELSE C_STP := 3; END_IF;
          UNDERWRAP := IW_TURNS < MIN_TURNS;
          IF WRAPPED >= 30000 THEN WRAPPED := 0; ELSE WRAPPED := WRAPPED + 1; END_IF;
        ELSE C_STP := 1; END_IF;
      ELSIF PAL_C_PHASE <> 0 AND NOT (PAL_C_PHASE = 4 AND DI_PAL_D) THEN BOOK_OK := FALSE;
      END_IF;
      IF BOOK_OK AND IW_ACK_SEQ <> IW_RES_SEQ THEN
        RECOVERING := TRUE; RECOVER_SEQ := IW_ACK_SEQ;
      END_IF;
    END_IF;
  END_IF;
  IF IO_READY AND RECOVERING AND IW_RES_SEQ <> LAST_SEQ AND IW_RES_SEQ <> RECOVER_SEQ THEN
    RECOVERING := FALSE; BOOK_OK := FALSE;
  END_IF;

  (* ilk gecerli veride robotun numaralandirmasindan devam et (PLC yeniden basladiysa ayni SEQ'i tekrar gonderme) *)
  IF IO_READY AND NOT SEQ_SYNC THEN
    SEQ := IW_ACK_SEQ;
    SEQ_SYNC := TRUE;
  END_IF;

  (* reset penceresi: guvenlik kontrolcusu ve robot resetin etkisini 0,5 s gecikmeyle bildirir *)
  IF RT_RESET.Q THEN RST_WIN := TRUE; END_IF;
  T_RSTWIN(IN := RST_WIN, PT := T#3s);
  IF T_RSTWIN.Q THEN RST_WIN := FALSE; END_IF;

  (* =================== 2. Alarmlar =================== *)
  IF NOT ESTOP_OK THEN ALARMS := ALARMS OR WORD#16#0001; END_IF;
  IF ESTOP_OK AND NOT DI_SAFETY_OK THEN ALARMS := ALARMS OR WORD#16#0002; END_IF;
  IF R_ERROR THEN ALARMS := ALARMS OR WORD#16#0004; END_IF;
  IF COMM_FAULT THEN ALARMS := ALARMS OR WORD#16#2000; END_IF;
  IF DI_WRAP_FAULT THEN ALARMS := ALARMS OR WORD#16#0100; END_IF;

  T_ACK(IN := R_STP = 11 AND NOT HOLD_LATCH, PT := T#3s);
  T_RES(IN := (R_STP = 12 OR RECOVERING) AND NOT WAIT_START AND NOT HOLD_LATCH AND NOT R_HOLDING, PT := T#40s);
  IF T_ACK.Q OR T_RES.Q THEN ALARMS := ALARMS OR WORD#16#0020; END_IF;
  T_DISP(IN := MODE = 1 AND NOT RECOVERING AND A_STP = 1 AND DI_SAFETY_OK, PT := T#8s);
  T_BTRANS(IN := MODE = 1 AND NOT RECOVERING AND DI_SAFETY_OK AND (B_STP = 2 OR B_STP = 21), PT := T#15s);
  T_CTRANS(IN := MODE = 1 AND NOT RECOVERING AND DI_SAFETY_OK AND C_STP = 4, PT := T#15s);
  IF T_DISP.Q OR T_BTRANS.Q OR T_CTRANS.Q THEN ALARMS := ALARMS OR WORD#16#0080; END_IF;
  T_WRAP(IN := MODE = 1 AND NOT RECOVERING AND DI_SAFETY_OK AND C_STP = 1, PT := T#60s);
  IF T_WRAP.Q THEN ALARMS := ALARMS OR WORD#16#0100; END_IF;

  IF NOT IO_READY THEN ALARMS := ALARMS_BEFORE; END_IF;
  IF IO_READY AND NOT BOOT_PENDING AND NOT BOOK_OK THEN ALARMS := ALARMS OR WORD#16#4000; END_IF;

  IF (ALARMS AND ALARM_MASK) <> WORD#0 THEN
    IF (ALARMS AND WORD#16#0001) <> WORD#0 THEN MODE := 4; ELSIF MODE <> 4 THEN MODE := 3; END_IF;
    HOLD_LATCH := TRUE;   (* robot Start'a kadar duraklatilmis kalir *)
  END_IF;

  IF RST_WIN AND ESTOP_OK AND DI_SAFETY_OK AND NOT COMM_FAULT AND NOT DI_WRAP_FAULT AND NOT R_ERROR THEN
    ALARMS := ALARMS AND WORD#16#4000;
    RST_WIN := FALSE;
    IF MODE = 3 OR MODE = 4 THEN
      MODE := 0;
      (* kabul edilmemis isi geri al: robot ayni numarayi gorurse bir sey yapmaz *)
      IF R_STP = 10 OR R_STP = 11 THEN
        SEQ := IW_ACK_SEQ;
        R_STP := 0;
      END_IF;
    END_IF;
  END_IF;

  IF MODE = 0 AND RT_START.Q AND IO_READY AND NOT RESTART AND BOOK_OK AND NOT BOOT_PENDING AND STOP_OK AND (ALARMS AND ALARM_MASK) = WORD#0 THEN
    MODE := 1;
    HOLD_LATCH := NOT ROB_BOOT_OK;
  END_IF;
  IF MODE = 1 THEN WAIT_START := FALSE; END_IF;
  IF MODE = 1 AND NOT STOP_OK THEN MODE := 0; END_IF;   (* cevrim sonu: robot elindeki isi bitirir *)

  (* READY means idle; accepted work is resumed without an impossible READY/home
     prerequisite. Idle loaded/off-home robots use the existing place/home branches. *)
  T_ROBSAFE(IN := IO_READY AND R_READY
    AND (IW_ROB_DI AND WORD#4) = WORD#0 AND (NOT DI_PAL_B OR DI_PIN_UP)
    AND IW_ACK_SEQ = IW_RES_SEQ AND BOOK_OK AND NOT BOOT_PENDING, PT := T#500ms);
  IF NOT ROB_BOOT_DONE THEN ROB_BOOT_OK := (BOOK_OK AND RECOVERING AND (NOT DI_PAL_B OR DI_PIN_UP)) OR T_ROBSAFE.Q; END_IF;
  IF NOT ROB_BOOT_OK THEN HOLD_LATCH := TRUE; END_IF;
  IF MODE = 1 AND ROB_BOOT_OK AND (ALARMS AND ALARM_MASK) = WORD#0 THEN HOLD_LATCH := FALSE; END_IF;

  (* =================== 3. Robot isi =================== *)
  (* sonuc degerlendirmesi her modda calisir; yeni is yalnizca calisirken verilir *)
  CASE R_STP OF
    0:
      IF MODE = 1 AND BOOK_OK AND NOT RECOVERING AND R_READY AND SEQ_SYNC AND NOT HOLD_LATCH THEN
        IF NOT R_HOMED THEN
          JOB := 4; SLOT := 0; R_STP := 10;
        ELSIF R_PART THEN
          IF B_STP = 10 AND DI_PIN_UP AND SHEET_BOT AND COUNT < SLOTS THEN
            JOB := 2; SLOT := COUNT + 1; R_STP := 10;
          END_IF;
        ELSIF B_STP = 10 AND DI_PIN_UP AND NOT SHEET_BOT THEN
          JOB := 3; SLOT := 0; R_STP := 10;
        ELSIF B_STP = 10 AND DI_PIN_UP AND COUNT >= SLOTS AND NOT SHEET_TOP THEN
          JOB := 3; SLOT := 1; R_STP := 10;
        ELSIF DI_PICK AND B_STP = 10 AND SHEET_BOT AND COUNT < SLOTS THEN
          JOB := 1; SLOT := COUNT + 1; R_STP := 10;
        END_IF;
        IF R_STP = 10 THEN ROB_BOOT_DONE := TRUE; END_IF;
      END_IF;
    10: (* yeni is numarasi; JOB, SLOT ve SEQ ayni yazmada gider *)
      SEQ := SEQ + 1;
      IF SEQ > 30000 THEN SEQ := 1; END_IF;
      R_STP := 11;
    11: (* kabul bekle *)
      IF IW_RES_SEQ = SEQ OR IW_ACK_SEQ = SEQ THEN R_STP := 12; END_IF;
    12: (* sonuc bekle *)
      IF IW_RES_SEQ = SEQ THEN
        R_STP := 0;
        LAST_SEQ := IW_RES_SEQ;
        IF IW_RES_SLOT <> SLOT OR IW_RES_JOB <> JOB THEN
          ALARMS := ALARMS OR WORD#16#4200; BOOK_OK := FALSE;
        ELSIF IW_RES_CODE = 1 OR IW_RES_CODE = 17 THEN
          IF JOB = 2 THEN
            COUNT := COUNT + 1;
          ELSIF JOB = 3 THEN
            IF SLOT = 0 THEN SHEET_BOT := TRUE; ELSE SHEET_TOP := TRUE; END_IF;
          END_IF;
        ELSIF IW_RES_CODE = 10 THEN
          ALARMS := ALARMS OR WORD#16#0010;
        ELSIF IW_RES_CODE = 11 THEN
          ALARMS := ALARMS OR WORD#16#0008;
        ELSIF IW_RES_CODE = 14 THEN
          ALARMS := ALARMS OR WORD#16#0004;
        ELSIF IW_RES_CODE = 15 THEN
          ALARMS := ALARMS OR WORD#16#0040;
        ELSIF IW_RES_CODE = 12 OR IW_RES_CODE = 16 THEN
          ALARMS := ALARMS OR WORD#16#0200;
        END_IF;
        (* 13 = iptal: sayac degismez, is yeniden secilir *)
      END_IF;
  END_CASE;

  (* =================== 4. Palet hatti =================== *)
  IF MODE = 1 AND NOT RECOVERING THEN
    (* A: bos palet besleme; istif konumu dolarken bile bir sonraki palet hazirlanir *)
    CASE A_STP OF
      0:
        IF NOT DI_PAL_A AND NOT DI_DISP_BUSY AND IW_PALLETS > 0 AND B_STP <> 2 THEN A_STP := 1; END_IF;
      1:
        IF DI_PAL_A THEN A_STP := 0; END_IF;
    END_CASE;

    (* B: istif konumu *)
    CASE B_STP OF
      0:
        IF DI_PAL_B THEN
          B_STP := 3;
        ELSIF DI_PAL_A AND A_STP = 0 THEN
          B_STP := 2;
        END_IF;
      2: (* A -> B, pim yukarida *)
        IF DI_PAL_B THEN B_STP := 3; END_IF;
      3: (* yeni palet: defter sifirlanir *)
        PALLET_ID := PALLET_ID + 1;
        IF PALLET_ID > 30000 THEN PALLET_ID := 1; END_IF;
        COUNT := 0;
        SHEET_BOT := FALSE;
        SHEET_TOP := FALSE;
        B_STP := 10;
      10: (* istif *)
        IF COUNT >= SLOTS AND SHEET_TOP THEN B_STP := 20; END_IF;
      20: (* palet dolu: robot bolge disinda, strec bos ve tabla baslangicta olunca birak *)
        IF R_CLEAR AND R_STP = 0 AND C_STP = 0 AND NOT DI_PAL_C AND DI_WRAP_HOME THEN B_STP := 21; END_IF;
      21: (* pim asagi, B -> C *)
        IF DI_PAL_C AND NOT DI_PAL_B THEN
          DONE_CNT := DONE_CNT + 1;
          IF DONE_CNT > 30000 THEN DONE_CNT := 0; END_IF;
          C_STP := 1;
          B_STP := 0;
        END_IF;
    END_CASE;

    (* C: strec sarma ve alim noktasina cikis *)
    CASE C_STP OF
      0:
        IF DI_PAL_C AND B_STP <> 21 THEN C_STP := 1; END_IF;
      1: (* istek "bitti" gelene kadar tutulur *)
        IF DI_WRAP_DONE THEN
          UNDERWRAP := IW_TURNS < MIN_TURNS;
          WRAPPED := WRAPPED + 1;
          IF WRAPPED > 30000 THEN WRAPPED := 0; END_IF;
          C_STP := 2;
        END_IF;
      2:
        IF NOT DI_WRAP_DONE AND DI_WRAP_HOME THEN C_STP := 3; END_IF;
      3: (* alim noktasi bos ve AGV catallari disarida olunca *)
        IF NOT DI_PAL_D AND AGV_CLEAR THEN C_STP := 4; END_IF;
      4: (* C -> D; isik perdesi muting'i palet gecerken guvenlik kontrolcusunde *)
        IF DI_PAL_D AND NOT DI_PAL_C THEN C_STP := 0; END_IF;
    END_CASE;
  END_IF;

  (* =================== 5. Cikislar =================== *)
  IF BOOK_OK THEN
    RET_MAGIC := WORD#0; (* invalidate before payload, commit last *)
    RET_MAPVER := 7;
    PAL_COUNT := COUNT; PAL_ID := PALLET_ID; PAL_DONE := DONE_CNT; PAL_WRAPPED := WRAPPED;
    PAL_SHEETS := WORD#0;
    IF SHEET_BOT THEN PAL_SHEETS := PAL_SHEETS OR WORD#1; END_IF;
    IF SHEET_TOP THEN PAL_SHEETS := PAL_SHEETS OR WORD#2; END_IF;
    PAL_LAST_SEQ := LAST_SEQ;
    IF B_STP >= 10 THEN PAL_ACTIVE := WORD#1; ELSE PAL_ACTIVE := WORD#0; END_IF;
    PAL_C_PHASE := C_STP;
    IF UNDERWRAP THEN PAL_UNDERWRAP := WORD#1; ELSE PAL_UNDERWRAP := WORD#0; END_IF;
    CHECK_SUM := DINT#1;
    CHECK_SUM := (CHECK_SUM * DINT#31 + DINT#42330) MOD DINT#65521;
    CHECK_SUM := (CHECK_SUM * DINT#31 + INT_TO_DINT(RET_MAPVER)) MOD DINT#65521;
    CHECK_SUM := (CHECK_SUM * DINT#31 + INT_TO_DINT(PAL_COUNT)) MOD DINT#65521;
    CHECK_SUM := (CHECK_SUM * DINT#31 + INT_TO_DINT(PAL_ID)) MOD DINT#65521;
    CHECK_SUM := (CHECK_SUM * DINT#31 + INT_TO_DINT(PAL_DONE)) MOD DINT#65521;
    CHECK_SUM := (CHECK_SUM * DINT#31 + INT_TO_DINT(PAL_WRAPPED)) MOD DINT#65521;
    CHECK_SUM := (CHECK_SUM * DINT#31 + WORD_TO_DINT(PAL_SHEETS)) MOD DINT#65521;
    CHECK_SUM := (CHECK_SUM * DINT#31 + INT_TO_DINT(PAL_LAST_SEQ)) MOD DINT#65521;
    CHECK_SUM := (CHECK_SUM * DINT#31 + WORD_TO_DINT(PAL_ACTIVE)) MOD DINT#65521;
    CHECK_SUM := (CHECK_SUM * DINT#31 + INT_TO_DINT(PAL_C_PHASE)) MOD DINT#65521;
    CHECK_SUM := (CHECK_SUM * DINT#31 + WORD_TO_DINT(PAL_UNDERWRAP)) MOD DINT#65521;
    RET_CHECK := DINT_TO_WORD(CHECK_SUM);
    RET_MAGIC := WORD#16#A55A;
  END_IF;
  Q_ENABLE := ESTOP_OK AND DI_SAFETY_OK AND IO_READY AND NOT COMM_FAULT;
  Q_HOLD   := HOLD_LATCH;
  Q_RRESET := RST_WIN AND R_ERROR;
  LINE_RUN := MODE = 1 AND NOT RECOVERING;
  Q_DISP   := LINE_RUN AND A_STP = 1;
  Q_CA     := LINE_RUN AND B_STP = 2;
  Q_CB     := LINE_RUN AND (B_STP = 2 OR B_STP = 21);
  Q_CC     := LINE_RUN AND (B_STP = 21 OR C_STP = 4);
  Q_CD     := LINE_RUN AND C_STP = 4;
  Q_PIN    := B_STP <> 21;
  Q_WRAP   := LINE_RUN AND C_STP = 1;
  Q_PICKUP := NOT WAIT_START AND DI_PAL_D AND C_STP <> 4;
  Q_ZONE   := B_STP = 10 AND DI_PAL_B AND DI_PIN_UP;

  QW_DO := WORD#0;
  IF Q_ENABLE THEN QW_DO := QW_DO OR WORD#16#0001; END_IF;
  IF Q_HOLD   THEN QW_DO := QW_DO OR WORD#16#0002; END_IF;
  IF Q_RRESET THEN QW_DO := QW_DO OR WORD#16#0008; END_IF;
  IF Q_DISP   THEN QW_DO := QW_DO OR WORD#16#0010; END_IF;
  IF Q_CA     THEN QW_DO := QW_DO OR WORD#16#0020; END_IF;
  IF Q_CB     THEN QW_DO := QW_DO OR WORD#16#0040; END_IF;
  IF Q_CC     THEN QW_DO := QW_DO OR WORD#16#0080; END_IF;
  IF Q_CD     THEN QW_DO := QW_DO OR WORD#16#0100; END_IF;
  IF Q_PIN    THEN QW_DO := QW_DO OR WORD#16#0200; END_IF;
  IF Q_WRAP   THEN QW_DO := QW_DO OR WORD#16#0400; END_IF;
  IF Q_PICKUP THEN QW_DO := QW_DO OR WORD#16#0800; END_IF;
  IF Q_ZONE   THEN QW_DO := QW_DO OR WORD#16#1000; END_IF;

  WARNS := WORD#0;
  IF IW_PALLETS = 0 AND NOT DI_PAL_A AND B_STP = 0 THEN WARNS := WARNS OR WORD#16#0400; END_IF;
  IF UNDERWRAP THEN WARNS := WARNS OR WORD#16#0800; END_IF;
  IF C_STP = 3 THEN WARNS := WARNS OR WORD#16#1000; END_IF;
  QW_ALARM := ALARMS OR WARNS;

  IF MODE = 4 THEN
    QW_STATE := 8;
  ELSIF MODE = 3 THEN
    IF NOT DI_SAFETY_OK THEN QW_STATE := 7; ELSE QW_STATE := 6; END_IF;
  ELSIF MODE = 0 THEN
    IF R_STP <> 0 THEN QW_STATE := 9; ELSE QW_STATE := 0; END_IF;
  ELSIF B_STP = 20 AND C_STP = 3 THEN
    QW_STATE := 4;
  ELSIF B_STP < 10 AND NOT DI_PAL_A AND IW_PALLETS = 0 THEN
    QW_STATE := 3;
  ELSIF B_STP < 10 OR B_STP >= 20 THEN
    QW_STATE := 5;
  ELSIF R_STP = 0 AND NOT DI_PICK AND NOT R_PART THEN
    QW_STATE := 2;
  ELSE
    QW_STATE := 1;
  END_IF;

  STATUS := WORD#0;
  IF MODE = 1 AND B_STP = 10 AND COUNT < SLOTS THEN STATUS := STATUS OR WORD#16#0001; END_IF;
  IF MODE = 1 THEN STATUS := STATUS OR WORD#16#0002; END_IF;
  IF MODE = 3 OR MODE = 4 THEN STATUS := STATUS OR WORD#16#0004; END_IF;
  IF QW_STATE = 2 THEN STATUS := STATUS OR WORD#16#0008; END_IF;
  IF QW_STATE = 4 THEN STATUS := STATUS OR WORD#16#0010; END_IF;
  IF NOT DI_SAFETY_OK THEN STATUS := STATUS OR WORD#16#0020; END_IF;
  IF Q_PICKUP THEN STATUS := STATUS OR WORD#16#0040; END_IF;
  IF WAIT_START THEN STATUS := STATUS OR WORD#16#0080; END_IF;
  QW_STATUS := STATUS;

  QW_JOB       := JOB;
  QW_SLOT      := SLOT;
  QW_SEQ       := SEQ;
  QW_COUNT     := COUNT;
  QW_DONE      := DONE_CNT;
  QW_PALLET_ID := PALLET_ID;
  QW_WRAPPED   := WRAPPED;
  PICKUP_RDY   := Q_PICKUP;
  RUNNING      := MODE = 1;
  IF WAIT_START OR NOT IO_READY THEN
    QW_DO := WORD#2; (* HOLD must reach the independent robot controller *)
    IF Q_ENABLE THEN QW_DO := QW_DO OR WORD#1; END_IF;
  END_IF;
END_FUNCTION_BLOCK
