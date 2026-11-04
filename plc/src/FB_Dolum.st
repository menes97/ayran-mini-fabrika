(* =====================================================================
   FB_Dolum - ayran bardak dolum-kapama makinesi (fabrikanin 1. blogu)

   Makine: 8 cepli endeksli zincir. Cepler 0..7, istasyonlar:
     0 Bardak besleme   2 Dolum (terazili, kaba + ince akis)
     3 Folyo yerlestirme 4 Isil kapama   5 Kontrol tartisi   6 Red
     7 Cikis bandina aktarim
   Her endeks adimindan sonra istasyonlar paralel calisir; hepsi
   bitince bir sonraki adim atilir. Urun kalitesi her cep icin bir
   kaydirmali kayitta (TR_CUP / TR_BAD) takip edilir.

   Operator paneli, acil stop ve haberlesme bekcisi fabrika
   programindan (Fabrika.st) giris olarak gelir.
   ===================================================================== *)

FUNCTION_BLOCK FB_Dolum
  VAR_INPUT
    RESTART : BOOL;
    START, STOP_OK, ESTOP_OK, RESET : BOOL;   (* fabrika paneli *)
    IO_READY   : BOOL;   (* simulatorden ilk veri geldi *)
    COMM_FAULT : BOOL;   (* simulator kalp atisi durdu *)
    IW_DI      : WORD;   (* dijital girisler, bit paketli *)
    IW_FILL    : INT;    (* dolum terazisi net, 0,1 g *)
    IW_TANK    : INT;    (* dolum tanki seviyesi, 0,1 % *)
    IW_TEMP    : INT;    (* kapama kafasi, 0,1 C *)
    IW_CHECK   : INT;    (* kontrol tartisi brut, 0,1 g *)
  END_VAR
  VAR_OUTPUT
    QW_STATUS : WORD;
    QW_DO     : WORD;    (* dijital cikislar, bit paketli *)
    QW_STATE  : INT;
    QW_ALARM  : WORD;
    QW_GOOD   : INT;
    QW_REJECT : INT;
    RUNNING   : BOOL;
    PRODUCT_REQ : BOOL;  (* dolum tanki %40 altinda: tank istasyonundan urun iste, %80'de birak *)
  END_VAR

  VAR
    (* ---- Recete ve ayarlar ------------------------------------------ *)
    FILL_TARGET     : INT := 2060;  (* 206,0 g net = 200 ml ayran *)
    FILL_TOL        : INT := 40;    (* +/- 4,0 g *)
    COARSE_MARGIN   : INT := 400;   (* kaba akis hedefin bu kadar altinda kesilir; kendini ayarlar:
                                       ince akis cok kisa surerse kaba akis asmis demektir *)
    PREACT          : INT := 20;    (* ucus payi, kendini ayarlar *)
    TARE            : INT := 49;    (* bardak 4,5 g + folyo 0,4 g *)
    TEMP_SP         : INT := 1950;
    TEMP_MIN        : INT := 1700;
    TEMP_MAX        : INT := 2200;
    TANK_ON         : INT := 400;   (* %40 altinda urun iste *)
    TANK_OFF        : INT := 800;   (* %80 ustunde birak *)
  END_VAR

  VAR
    (* ---- Cozulmus girisler ------------------------------------------ *)
    DI_START, DI_STOP_OK, DI_ESTOP_OK, DI_RESET, DI_INDEX, DI_CUP_EMPTY,
    DI_CUP_AT_FILL, DI_NOZ_UP, DI_NOZ_DN, DI_FOIL_EMPTY, DI_FOIL_AT_SEAL,
    DI_SEAL_UP, DI_SEAL_DN, DI_TANK_LOW, DI_CUP_AT_REJ, DI_REJ_EXT,
    DI_OUT_FULL : BOOL;

    (* ---- Cikislar ---------------------------------------------------- *)
    Q_CONV, Q_CUP_DROP, Q_NOZ_DN, Q_FILL_FAST, Q_FILL_FINE, Q_FOIL,
    Q_SEAL_DN, Q_HEATER, Q_REJECT, Q_GREEN, Q_YELLOW,
    Q_RED, Q_HORN : BOOL;

    (* ---- Durum ------------------------------------------------------- *)
    WAIT_START : BOOL := TRUE;
    MODE      : INT := 0;   (* 0 dur, 1 calis, 2 cevrim sonu dur, 3 alarm, 4 acil stop *)
    CYC       : INT := 0;   (* 0 hazir, 10/11 endeks, 20 istasyonlar *)
    HEAT_WAIT : BOOL;
    PURGE : INT;
    OUT_WAIT  : BOOL;       (* cikis bandi dolu, endeks bekliyor *)
    TEMP_OK   : BOOL;
    ALARMS_BEFORE : WORD;
    ALARMS    : WORD;       (* mandalli alarmlar, bit 0..7 *)
    WARNS     : WORD;       (* canli uyarilar, bit 8..10 *)
    ALARM_ANY : BOOL;
    ALARM_PREV: BOOL;
    HORN_LATCH: BOOL;
    FILL_WARN : BOOL;
    BLINK     : BOOL;
    GOOD_CNT  : INT;
    REJ_CNT   : INT;
    LINE_EMPTY : BOOL;      (* OEE: zincirde takip edilen bardak yok *)
    K         : INT;

    (* ---- Urun takibi (cep basina) ------------------------------------ *)
    TR_CUP : ARRAY[0..7] OF BOOL;
    TR_BAD : ARRAY[0..7] OF BOOL;
    I      : INT;

    (* ---- Istasyon adimlari (9 = bitti) -------------------------------- *)
    DROP_SUB, FILL_SUB, FOIL_SUB, SEAL_SUB, CHK_SUB, REJ_SUB : INT := 9;
    FILL_ERR : INT;
    CHK_NET  : INT;

    (* ---- Zamanlayicilar ve kenar algilayicilar ------------------------ *)
    (* Not: matiec, uzun bir TON listesini tek bildirimde verince cokuyor;
       her zamanlayici ayri satirda. *)
    RT_START  : R_TRIG;
    RT_RESET  : R_TRIG;
    T_HEAT    : TON;
    T_IDX     : TON;
    T_DROP    : TON;
    T_DROPWAIT: TON;
    T_NOZ     : TON;
    T_FILL    : TON;
    T_SETTLE  : TON;
    T_FINE    : TON;
    T_FOIL    : TON;
    T_SEALMV  : TON;
    T_DWELL   : TON;
    T_CHK     : TON;
    T_REJ     : TON;
    T_RET     : TON;
    T_BLINK_A : TON;
    T_BLINK_B : TON;
  END_VAR

  ALARMS_BEFORE := ALARMS;
  IF RESTART THEN
    MODE := 0; WAIT_START := TRUE;
    CYC := 0; DROP_SUB := 9; FILL_SUB := 9; FOIL_SUB := 9; SEAL_SUB := 9; CHK_SUB := 9; REJ_SUB := 9;
    PURGE := 7;
    FOR I := 0 TO 7 DO TR_CUP[I] := (IW_DI AND WORD#16#0444) <> WORD#0; TR_BAD[I] := TRUE; END_FOR;
    T_HEAT(IN := FALSE, PT := T#1s);
    T_IDX(IN := FALSE, PT := T#1s);
    T_DROP(IN := FALSE, PT := T#1s);
    T_DROPWAIT(IN := FALSE, PT := T#1s);
    T_NOZ(IN := FALSE, PT := T#1s);
    T_FILL(IN := FALSE, PT := T#1s);
    T_SETTLE(IN := FALSE, PT := T#1s);
    T_FINE(IN := FALSE, PT := T#1s);
    T_FOIL(IN := FALSE, PT := T#1s);
    T_SEALMV(IN := FALSE, PT := T#1s);
    T_DWELL(IN := FALSE, PT := T#1s);
    T_CHK(IN := FALSE, PT := T#1s);
    T_REJ(IN := FALSE, PT := T#1s);
    T_RET(IN := FALSE, PT := T#1s);
    T_BLINK_A(IN := FALSE, PT := T#1s);
    T_BLINK_B(IN := FALSE, PT := T#1s);
  END_IF;

  (* =================== 1. Girisleri coz =================== *)
  DI_START        := START;
  DI_STOP_OK      := STOP_OK;
  DI_ESTOP_OK     := ESTOP_OK;
  DI_RESET        := RESET;
  DI_INDEX        := (IW_DI AND WORD#16#0001) <> WORD#0;
  DI_CUP_EMPTY    := (IW_DI AND WORD#16#0002) <> WORD#0;
  DI_CUP_AT_FILL  := (IW_DI AND WORD#16#0004) <> WORD#0;
  DI_NOZ_UP       := (IW_DI AND WORD#16#0008) <> WORD#0;
  DI_NOZ_DN       := (IW_DI AND WORD#16#0010) <> WORD#0;
  DI_FOIL_EMPTY   := (IW_DI AND WORD#16#0020) <> WORD#0;
  DI_FOIL_AT_SEAL := (IW_DI AND WORD#16#0040) <> WORD#0;
  DI_SEAL_UP      := (IW_DI AND WORD#16#0080) <> WORD#0;
  DI_SEAL_DN      := (IW_DI AND WORD#16#0100) <> WORD#0;
  DI_TANK_LOW     := (IW_DI AND WORD#16#0200) <> WORD#0;
  DI_CUP_AT_REJ   := (IW_DI AND WORD#16#0400) <> WORD#0;
  DI_REJ_EXT      := (IW_DI AND WORD#16#0800) <> WORD#0;
  DI_OUT_FULL     := (IW_DI AND WORD#16#1000) <> WORD#0;

  RT_START(CLK := DI_START);
  RT_RESET(CLK := DI_RESET);
  TEMP_OK := (IW_TEMP >= TEMP_MIN) AND (IW_TEMP <= TEMP_MAX);

  (* =================== 2. Guvenlik ve izleme =================== *)
  IF COMM_FAULT THEN ALARMS := ALARMS OR WORD#16#0080; END_IF;

  IF NOT DI_ESTOP_OK THEN ALARMS := ALARMS OR WORD#16#0001; END_IF;

  (* Isitici: +/- 2 C histerezisli termostat *)
  IF NOT DI_ESTOP_OK THEN
    Q_HEATER := FALSE;
  ELSIF IW_TEMP < TEMP_SP - 20 THEN
    Q_HEATER := TRUE;
  ELSIF IW_TEMP > TEMP_SP + 20 THEN
    Q_HEATER := FALSE;
  END_IF;
  (* 45 s isitip hala soguksa rezistans arizalidir; reset sayaci yeniden baslatir *)
  (* isinma bekcisi yalnizca isitici gercekten surulurken sayar: acilista START beklenirken
     cikis kapalidir (asagidaki maske), soguyan isitici sahte alarm vermesin *)
  T_HEAT(IN := Q_HEATER AND NOT WAIT_START AND IO_READY AND (IW_TEMP < TEMP_MIN) AND NOT RT_RESET.Q, PT := T#45s);
  IF T_HEAT.Q THEN ALARMS := ALARMS OR WORD#16#0020; END_IF;

  (* Dolum tanki seviyesi: urun iste (hucre sozlesmesi). Vanayi ve pompayi
     tank istasyonu yonetir; bu blok yalnizca ne zaman urun gerektigini bilir. *)
  IF NOT IO_READY THEN
    PRODUCT_REQ := FALSE;              (* ilk veri gelmeden seviye 0 gorunur *)
  ELSIF IW_TANK < TANK_ON THEN
    PRODUCT_REQ := TRUE;
  ELSIF IW_TANK > TANK_OFF THEN
    PRODUCT_REQ := FALSE;
  END_IF;

  (* Ilk veri gelene kadar girisler sifirdir; bu sirada alarm uretme *)
  IF NOT IO_READY THEN ALARMS := ALARMS_BEFORE; END_IF;

  (* =================== 3. Mod yonetimi =================== *)
  ALARM_ANY := (ALARMS AND WORD#16#00FF) <> WORD#0;
  IF ALARM_ANY THEN
    IF NOT DI_ESTOP_OK OR MODE = 4 OR (ALARMS AND WORD#16#0001) <> WORD#0 THEN
      MODE := 4;
    ELSE
      MODE := 3;
    END_IF;
  END_IF;
  IF ALARM_ANY AND NOT ALARM_PREV THEN HORN_LATCH := TRUE; END_IF;
  ALARM_PREV := ALARM_ANY;

  IF RT_RESET.Q THEN
    HORN_LATCH := FALSE;
    FILL_WARN := FALSE;
    IF DI_ESTOP_OK AND NOT COMM_FAULT THEN
      ALARMS := WORD#0;
      IF MODE = 3 OR MODE = 4 THEN
        (* yarim kalan istasyonlardaki bardaklar hatali sayilir *)
        IF FILL_SUB <> 9 AND TR_CUP[2] THEN TR_BAD[2] := TRUE; END_IF;
        IF FOIL_SUB <> 9 AND TR_CUP[3] THEN TR_BAD[3] := TRUE; END_IF;
        IF SEAL_SUB <> 9 AND TR_CUP[4] THEN TR_BAD[4] := TRUE; END_IF;
        DROP_SUB := 9; FILL_SUB := 9; FOIL_SUB := 9; SEAL_SUB := 9;
        (* tarti ve red tekrarlanabilir: bastan calistir *)
        IF CHK_SUB <> 9 THEN CHK_SUB := 0; END_IF;
        IF REJ_SUB = 2 THEN
          REJ_CNT := REJ_CNT + 1;
          TR_CUP[6] := FALSE;
          REJ_SUB := 9;
        ELSIF REJ_SUB <> 9 THEN
          REJ_SUB := 0;
        END_IF;
        IF CYC = 11 THEN CYC := 10; END_IF;
        MODE := 0;
      END_IF;
    END_IF;
  END_IF;

  IF MODE = 0 AND RT_START.Q AND IO_READY AND NOT RESTART AND DI_STOP_OK THEN MODE := 1; END_IF;
  IF MODE = 2 AND RT_START.Q AND IO_READY AND NOT RESTART THEN MODE := 1; END_IF;
  IF MODE = 1 THEN WAIT_START := FALSE; END_IF;
  IF MODE = 1 AND NOT DI_STOP_OK THEN MODE := 2; END_IF;

  (* =================== 4. Endeks cevrimi =================== *)
  T_IDX(IN := (MODE = 1 OR MODE = 2) AND (CYC = 10 OR CYC = 11), PT := T#2s);
  IF T_IDX.Q THEN ALARMS := ALARMS OR WORD#16#0002; END_IF;

  IF MODE = 1 OR MODE = 2 THEN
    IF CYC = 0 THEN
      IF MODE = 2 THEN
        MODE := 0;
      ELSIF NOT TEMP_OK THEN
        HEAT_WAIT := TRUE;
      ELSIF TR_CUP[7] AND DI_OUT_FULL THEN
        (* son cepteki bardak dolu banda itilirdi: bant bosalana kadar bekle *)
        HEAT_WAIT := FALSE;
        OUT_WAIT := TRUE;
      ELSE
        HEAT_WAIT := FALSE;
        OUT_WAIT := FALSE;
        CYC := 10;
      END_IF;
    ELSIF CYC = 10 THEN
      (* endeksleyiciyi tetikle; hareket baslayinca tetigi birak *)
      Q_CONV := TRUE;
      IF NOT DI_INDEX THEN
        Q_CONV := FALSE;
        CYC := 11;
      END_IF;
    ELSIF CYC = 11 THEN
      IF DI_INDEX THEN
        IF PURGE > 0 THEN PURGE := PURGE - 1; END_IF;
        (* bardaklar bir cep ilerledi: takip kaydini kaydir *)
        FOR I := 7 TO 1 BY -1 DO
          TR_CUP[I] := TR_CUP[I - 1];
          TR_BAD[I] := TR_BAD[I - 1];
        END_FOR;
        TR_CUP[0] := FALSE;
        TR_BAD[0] := FALSE;
        DROP_SUB := 0; FILL_SUB := 0; FOIL_SUB := 0;
        SEAL_SUB := 0; CHK_SUB := 0; REJ_SUB := 0;
        CYC := 20;
      END_IF;
    END_IF;
  END_IF;

  (* =================== 5. Istasyonlar =================== *)
  T_DROP(IN := DROP_SUB = 1, PT := T#300ms);
  T_DROPWAIT(IN := DROP_SUB = 2, PT := T#400ms);
  T_NOZ(IN := FILL_SUB = 1 OR FILL_SUB = 5, PT := T#2s);
  T_FILL(IN := FILL_SUB = 2 OR FILL_SUB = 3, PT := T#6s);
  T_SETTLE(IN := FILL_SUB = 4, PT := T#400ms);
  T_FINE(IN := FILL_SUB = 3, PT := T#10s);
  T_FOIL(IN := FOIL_SUB = 1, PT := T#550ms);
  T_SEALMV(IN := SEAL_SUB = 1 OR SEAL_SUB = 3, PT := T#2s);
  T_DWELL(IN := SEAL_SUB = 2, PT := T#800ms);
  T_CHK(IN := CHK_SUB = 1, PT := T#600ms);
  T_REJ(IN := REJ_SUB = 1, PT := T#1s);
  T_RET(IN := REJ_SUB = 2, PT := T#250ms);

  IF (MODE = 1 OR MODE = 2) AND CYC = 20 THEN

    (* --- Cep 0: bardak besleme --- *)
    CASE DROP_SUB OF
      0:
        IF MODE = 1 AND NOT DI_CUP_EMPTY THEN
          Q_CUP_DROP := TRUE;
          DROP_SUB := 1;
        ELSE
          DROP_SUB := 9;   (* magazin bos ya da hat bosaltiliyor *)
        END_IF;
      1:
        IF T_DROP.Q THEN
          Q_CUP_DROP := FALSE;
          TR_CUP[0] := TRUE;
          DROP_SUB := 2;
        END_IF;
      2:
        (* bardak duserken zincir oynamasin: dusus + haberlesme gecikmesi kadar bekle *)
        IF T_DROPWAIT.Q THEN DROP_SUB := 9; END_IF;
    END_CASE;

    (* --- Cep 2: terazili dolum --- *)
    CASE FILL_SUB OF
      0:
        TR_CUP[2] := DI_CUP_AT_FILL;          (* sensor takip kaydini duzeltir *)
        IF NOT DI_CUP_AT_FILL THEN
          FILL_SUB := 9;
        ELSIF NOT DI_TANK_LOW THEN
          Q_NOZ_DN := TRUE;
          FILL_SUB := 1;
        END_IF;                               (* tank alt seviyede: bekle *)
      1:
        IF DI_NOZ_DN THEN
          Q_FILL_FAST := TRUE;
          FILL_SUB := 2;
        ELSIF T_NOZ.Q THEN
          ALARMS := ALARMS OR WORD#16#0004;
        END_IF;
      2:
        IF IW_FILL >= FILL_TARGET - COARSE_MARGIN THEN
          Q_FILL_FAST := FALSE;
          Q_FILL_FINE := TRUE;
          FILL_SUB := 3;
        END_IF;
      3:
        IF IW_FILL >= FILL_TARGET - PREACT THEN
          Q_FILL_FINE := FALSE;
          (* kaba akis kesme noktasini ince akis suresine gore ayarla *)
          IF T_FINE.ET < T#500ms THEN
            COARSE_MARGIN := COARSE_MARGIN + 100;
            IF COARSE_MARGIN > 1200 THEN COARSE_MARGIN := 1200; END_IF;
          ELSIF T_FINE.ET > T#2500ms THEN
            COARSE_MARGIN := COARSE_MARGIN - 20;
            IF COARSE_MARGIN < 200 THEN COARSE_MARGIN := 200; END_IF;
          END_IF;
          FILL_SUB := 4;
        END_IF;
      4:
        IF T_SETTLE.Q THEN
          FILL_ERR := IW_FILL - FILL_TARGET;
          (* ucus payini son hataya gore ayarla *)
          IF ABS(FILL_ERR) < 100 THEN
            PREACT := PREACT + FILL_ERR / 2;
            IF PREACT < 0 THEN PREACT := 0; END_IF;
            IF PREACT > 150 THEN PREACT := 150; END_IF;
          END_IF;
          IF ABS(FILL_ERR) > FILL_TOL THEN TR_BAD[2] := TRUE; END_IF;
          Q_NOZ_DN := FALSE;
          FILL_SUB := 5;
        END_IF;
      5:
        IF DI_NOZ_UP THEN
          FILL_SUB := 9;
        ELSIF T_NOZ.Q THEN
          ALARMS := ALARMS OR WORD#16#0004;
        END_IF;
    END_CASE;
    IF T_FILL.Q AND (FILL_SUB = 2 OR FILL_SUB = 3) THEN
      Q_FILL_FAST := FALSE;
      Q_FILL_FINE := FALSE;
      TR_BAD[2] := TRUE;
      FILL_WARN := TRUE;
      Q_NOZ_DN := FALSE;
      FILL_SUB := 5;
    END_IF;

    (* --- Cep 3: folyo yerlestirme --- *)
    CASE FOIL_SUB OF
      0:
        IF NOT TR_CUP[3] THEN
          FOIL_SUB := 9;
        ELSIF DI_FOIL_EMPTY THEN
          ALARMS := ALARMS OR WORD#16#0010;
        ELSE
          Q_FOIL := TRUE;
          FOIL_SUB := 1;
        END_IF;
      1:
        IF T_FOIL.Q THEN
          Q_FOIL := FALSE;
          FOIL_SUB := 9;
        END_IF;
    END_CASE;

    (* --- Cep 4: isil kapama --- *)
    CASE SEAL_SUB OF
      0:
        IF NOT TR_CUP[4] THEN
          SEAL_SUB := 9;
        ELSIF NOT DI_FOIL_AT_SEAL OR NOT TEMP_OK THEN
          TR_BAD[4] := TRUE;                  (* folyosuz bardaga kafa inmez *)
          SEAL_SUB := 9;
        ELSE
          Q_SEAL_DN := TRUE;
          SEAL_SUB := 1;
        END_IF;
      1:
        IF DI_SEAL_DN THEN
          SEAL_SUB := 2;
        ELSIF T_SEALMV.Q THEN
          ALARMS := ALARMS OR WORD#16#0008;
        END_IF;
      2:
        IF NOT TEMP_OK THEN TR_BAD[4] := TRUE; END_IF;
        IF T_DWELL.Q THEN
          Q_SEAL_DN := FALSE;
          SEAL_SUB := 3;
        END_IF;
      3:
        IF DI_SEAL_UP THEN
          SEAL_SUB := 9;
        ELSIF T_SEALMV.Q THEN
          ALARMS := ALARMS OR WORD#16#0008;
        END_IF;
    END_CASE;

    (* --- Cep 5: kontrol tartisi --- *)
    CASE CHK_SUB OF
      0:
        IF TR_CUP[5] THEN CHK_SUB := 1; ELSE CHK_SUB := 9; END_IF;
      1:
        IF T_CHK.Q THEN
          IF IW_CHECK < 20 THEN
            TR_CUP[5] := FALSE;               (* bardak yolda kaybolmus *)
          ELSE
            CHK_NET := IW_CHECK - TARE;
            IF ABS(CHK_NET - FILL_TARGET) > FILL_TOL THEN TR_BAD[5] := TRUE; END_IF;
          END_IF;
          CHK_SUB := 9;
        END_IF;
    END_CASE;

    (* --- Cep 6: red --- *)
    (* Blind pockets: reject every old cup, using actual presence at the reject photocell. *)
    IF REJ_SUB = 0 AND PURGE > 0 AND DI_CUP_AT_REJ THEN TR_CUP[6] := TRUE; TR_BAD[6] := TRUE; END_IF;
    CASE REJ_SUB OF
      0:
        IF NOT TR_CUP[6] THEN
          REJ_SUB := 9;
        ELSIF TR_BAD[6] THEN
          Q_REJECT := TRUE;
          REJ_SUB := 1;
        ELSE
          GOOD_CNT := GOOD_CNT + 1;
          REJ_SUB := 9;
        END_IF;
      1:
        IF DI_REJ_EXT THEN
          Q_REJECT := FALSE;
          REJ_SUB := 2;
        ELSIF T_REJ.Q THEN
          ALARMS := ALARMS OR WORD#16#0040;
        END_IF;
      2:
        IF T_RET.Q THEN
          REJ_CNT := REJ_CNT + 1;
          TR_CUP[6] := FALSE;
          TR_BAD[6] := FALSE;
          REJ_SUB := 9;
        END_IF;
    END_CASE;

    IF DROP_SUB = 9 AND FILL_SUB = 9 AND FOIL_SUB = 9 AND
       SEAL_SUB = 9 AND CHK_SUB = 9 AND REJ_SUB = 9 THEN
      CYC := 0;
    END_IF;
  END_IF;

  (* =================== 6. Alarmda hareketleri durdur =================== *)
  IF MODE = 3 OR MODE = 4 THEN
    Q_CONV := FALSE; Q_CUP_DROP := FALSE; Q_NOZ_DN := FALSE;
    Q_FILL_FAST := FALSE; Q_FILL_FINE := FALSE; Q_FOIL := FALSE;
    Q_SEAL_DN := FALSE; Q_REJECT := FALSE;
  END_IF;

  (* =================== 7. Kule lambasi =================== *)
  T_BLINK_A(IN := NOT BLINK, PT := T#500ms);
  IF T_BLINK_A.Q THEN BLINK := TRUE; END_IF;
  T_BLINK_B(IN := BLINK, PT := T#500ms);
  IF T_BLINK_B.Q THEN BLINK := FALSE; END_IF;

  WARNS := WORD#0;
  IF DI_CUP_EMPTY THEN WARNS := WARNS OR WORD#16#0100; END_IF;
  IF DI_TANK_LOW THEN WARNS := WARNS OR WORD#16#0200; END_IF;
  IF FILL_WARN THEN WARNS := WARNS OR WORD#16#0400; END_IF;
  IF OUT_WAIT AND MODE = 1 THEN WARNS := WARNS OR WORD#16#0800; END_IF;

  Q_GREEN  := MODE = 1 AND NOT HEAT_WAIT AND NOT OUT_WAIT;
  Q_YELLOW := (WARNS <> WORD#0) OR MODE = 2 OR (HEAT_WAIT AND MODE = 1 AND BLINK)
              OR (MODE = 0 AND NOT TEMP_OK AND BLINK);
  Q_RED    := (MODE = 3 OR MODE = 4) AND (BLINK OR NOT HORN_LATCH);
  Q_HORN   := HORN_LATCH;

  (* =================== 8. Cikislari paketle =================== *)
  QW_DO := WORD#0;
  IF Q_CONV      THEN QW_DO := QW_DO OR WORD#16#0001; END_IF;
  IF Q_CUP_DROP  THEN QW_DO := QW_DO OR WORD#16#0002; END_IF;
  IF Q_NOZ_DN    THEN QW_DO := QW_DO OR WORD#16#0004; END_IF;
  IF Q_FILL_FAST THEN QW_DO := QW_DO OR WORD#16#0008; END_IF;
  IF Q_FILL_FINE THEN QW_DO := QW_DO OR WORD#16#0010; END_IF;
  IF Q_FOIL      THEN QW_DO := QW_DO OR WORD#16#0020; END_IF;
  IF Q_SEAL_DN   THEN QW_DO := QW_DO OR WORD#16#0040; END_IF;
  IF Q_HEATER    THEN QW_DO := QW_DO OR WORD#16#0080; END_IF;
  IF Q_REJECT    THEN QW_DO := QW_DO OR WORD#16#0100; END_IF;
  IF Q_GREEN     THEN QW_DO := QW_DO OR WORD#16#0400; END_IF;
  IF Q_YELLOW    THEN QW_DO := QW_DO OR WORD#16#0800; END_IF;
  IF Q_RED       THEN QW_DO := QW_DO OR WORD#16#1000; END_IF;
  IF Q_HORN      THEN QW_DO := QW_DO OR WORD#16#2000; END_IF;

  (* OEE icin bekleme nedeni: 7 urun yok (dolumda bardak var, tank alt seviyede),
     8 bardak yok (magazin bos ve zincir bosaldi) *)
  LINE_EMPTY := TRUE;
  FOR K := 0 TO 7 DO
    IF TR_CUP[K] THEN LINE_EMPTY := FALSE; END_IF;
  END_FOR;
  IF MODE = 1 AND HEAT_WAIT THEN
    QW_STATE := 5;
  ELSIF MODE = 1 AND OUT_WAIT THEN
    QW_STATE := 6;
  ELSIF MODE = 1 AND CYC = 20 AND FILL_SUB = 0 AND DI_CUP_AT_FILL AND DI_TANK_LOW THEN
    QW_STATE := 7;
  ELSIF MODE = 1 AND DI_CUP_EMPTY AND LINE_EMPTY THEN
    QW_STATE := 8;
  ELSE
    QW_STATE := MODE;
  END_IF;
  QW_ALARM  := ALARMS OR WARNS;
  (* sayaclar 0..30000 sarar (izleme katmani bu kurala gore fark alir) *)
  IF GOOD_CNT > 30000 THEN GOOD_CNT := 0; END_IF;
  IF REJ_CNT > 30000 THEN REJ_CNT := 0; END_IF;
  QW_GOOD   := GOOD_CNT;
  QW_REJECT := REJ_CNT;
  RUNNING   := MODE = 1;
  QW_STATUS := WORD#0;
  IF WAIT_START THEN QW_STATUS := WORD#16#0080; END_IF;
  IF WAIT_START OR NOT IO_READY THEN
    QW_DO := WORD#0;
    Q_HEATER := FALSE;
  END_IF;
END_FUNCTION_BLOCK
