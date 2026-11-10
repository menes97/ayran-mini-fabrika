(* =====================================================================
   Common section: identical in every PLC (single PLC, process, packaging, logistics).
   Operator panel, e-stop chain, communication watchdog, PLC heartbeat.
   Panel buttons and the e-stop chain reach each PLC separately from block 0
   (in reality, a separate contact / safety relay signal for each PLC).
   tools/gen-plc.js puts this file at the start of the PROGRAM body.
   ===================================================================== *)
VAR
  PB_START    : BOOL;   (* factory panel *)
  PB_STOP_OK  : BOOL;
  PB_ESTOP_OK : BOOL;
  PB_RESET    : BOOL;
  FIRST_SCAN  : BOOL := TRUE;
  RESTART     : BOOL;
  IO_READY    : BOOL;   (* first data arrived from the simulator with the correct version *)
  COMM_FAULT  : BOOL;
  SIM_HB_LAST : INT;
  PLC_HB      : INT;
  T_SIMHB     : TON;
END_VAR
(*@BODY@*)
  (* =================== 1. Factory panel =================== *)
  PB_START    := (FAB_IW_DI AND WORD#16#0001) <> WORD#0;
  PB_STOP_OK  := (FAB_IW_DI AND WORD#16#0002) <> WORD#0;
  PB_ESTOP_OK := (FAB_IW_DI AND WORD#16#0004) <> WORD#0;
  PB_RESET    := (FAB_IW_DI AND WORD#16#0008) <> WORD#0;

  (* =================== 2. Communication watchdog =================== *)
  (* communication fault if the simulator heartbeat does not change for 2 s *)
  T_SIMHB(IN := (FAB_IW_SIM_HB = SIM_HB_LAST), PT := T#2s);
  SIM_HB_LAST := FAB_IW_SIM_HB;
  COMM_FAULT := T_SIMHB.Q;
  (* inputs are invalid until the first data arrives and the map version matches *)
  IF FAB_IW_SIM_HB <> 0 AND FAB_IW_MAPVER = (*@MAPVER@*) THEN IO_READY := TRUE; END_IF;

  RESTART := FIRST_SCAN AND IO_READY;
  IF RESTART THEN FIRST_SCAN := FALSE; END_IF;

  (* PLC heartbeat: the simulator watches it and switches off this PLC's outputs if the program stops *)
  PLC_HB := PLC_HB + 1;
  IF PLC_HB > 30000 THEN PLC_HB := 0; END_IF;
