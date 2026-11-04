(* =====================================================================
   Ortak bolum: her PLC'de (tek PLC, proses, paketleme, lojistik) ayni.
   Operator paneli, acil stop zinciri, haberlesme bekcisi, PLC kalp atisi.
   Panel butonlari ve acil stop zinciri blok 0'dan her PLC'ye ayri gelir
   (gercekte her PLC'ye ayri kontak / guvenlik rolesinden bilgi).
   tools/gen-plc.js bu dosyayi PROGRAM govdesinin basina koyar.
   ===================================================================== *)
VAR
  PB_START    : BOOL;   (* fabrika paneli *)
  PB_STOP_OK  : BOOL;
  PB_ESTOP_OK : BOOL;
  PB_RESET    : BOOL;
  FIRST_SCAN  : BOOL := TRUE;
  RESTART     : BOOL;
  IO_READY    : BOOL;   (* simulatorden dogru surumde ilk veri geldi *)
  COMM_FAULT  : BOOL;
  SIM_HB_LAST : INT;
  PLC_HB      : INT;
  T_SIMHB     : TON;
END_VAR
(*@BODY@*)
  (* =================== 1. Fabrika paneli =================== *)
  PB_START    := (FAB_IW_DI AND WORD#16#0001) <> WORD#0;
  PB_STOP_OK  := (FAB_IW_DI AND WORD#16#0002) <> WORD#0;
  PB_ESTOP_OK := (FAB_IW_DI AND WORD#16#0004) <> WORD#0;
  PB_RESET    := (FAB_IW_DI AND WORD#16#0008) <> WORD#0;

  (* =================== 2. Haberlesme bekcisi =================== *)
  (* simulator kalp atisi 2 s degismezse haberlesme arizasi *)
  T_SIMHB(IN := (FAB_IW_SIM_HB = SIM_HB_LAST), PT := T#2s);
  SIM_HB_LAST := FAB_IW_SIM_HB;
  COMM_FAULT := T_SIMHB.Q;
  (* ilk veri gelene ve harita surumu tutana kadar girisler gecersiz *)
  IF FAB_IW_SIM_HB <> 0 AND FAB_IW_MAPVER = (*@MAPVER@*) THEN IO_READY := TRUE; END_IF;

  RESTART := FIRST_SCAN AND IO_READY;
  IF RESTART THEN FIRST_SCAN := FALSE; END_IF;

  (* PLC kalp atisi: simulator bunu izler, program durursa bu PLC'nin cikislarini kapatir *)
  PLC_HB := PLC_HB + 1;
  IF PLC_HB > 30000 THEN PLC_HB := 0; END_IF;
