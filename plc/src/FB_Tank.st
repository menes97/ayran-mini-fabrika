(* =====================================================================
   FB_Tank - tank, transfer line and CIP (block 2 of the factory)

   Line: sources V_PROD / V_WATER / V_CAUSTIC -> pump P1 -> flow meter FT1
        -> destinations V_FILL (filling tank) / V_DRAIN (drain) / V_CIPRET (caustic tank)

   Route manager: on every route change the pump stops, limit switches prove that
   all valves not in the new route are CLOSED, the new route
   is opened, the valve stroke time is waited out, and the pump starts again. If a valve not in
   the route appears open, the pump stops and an alarm is raised. This way caustic and
   product can never be in the same line at the same time.

   The filling machine requests product (REQ); this block transfers it or reports the reason it cannot.
   Times are at demo scale (in a real CIP the caustic contact time is 10-20 min).
   ===================================================================== *)

FUNCTION_BLOCK FB_Tank
  VAR_IN_OUT
    TNK_COMMISSION : WORD; (* one-shot commissioning token; consumed, never renewed by the FB *)
  END_VAR
  VAR_INPUT
    RESTART : BOOL;
    START : BOOL;
    ESTOP_OK, RESET : BOOL;   (* factory panel *)
    IO_READY   : BOOL;
    COMM_FAULT : BOOL;
    REQ        : BOOL;        (* the filling machine wants product *)
    IW_DI      : WORD;
    IW_T1_LVL  : INT;         (* 0.1 % *)
    IW_FLOW    : INT;         (* 0.01 kg/s *)
    IW_TOTAL   : INT;         (* 0.1 kg, wraps to zero at 30000 *)
    IW_COND    : INT;         (* 0.1 mS/cm, corrected to 25 C *)
    IW_RET_T   : INT;         (* 0.1 C *)
    IW_CIP_T   : INT;         (* 0.1 C *)
    IW_CIP_LVL : INT;         (* 0.1 % *)
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
    (* ---- Recipe and settings (demo scale) ------------------------------ *)
    COND_MIN      : INT := 85;     (* product window 8.5..9.5 mS/cm (contains ~5% water) *)
    COND_MAX      : INT := 95;
    COND_CAUSTIC  : INT := 650;    (* effective caustic: >= 65 mS/cm (~80% concentration); sent to the return only at this concentration *)
    RINSE_MARGIN  : INT := 5;      (* final rinse: inlet water + 0.5 mS/cm *)
    FLOW_MIN      : INT := 50;     (* 0.5 kg/s *)
    FLOW_CIP      : INT := 150;    (* 1.5 kg/s for CIP *)
    CIP_TEMP_MIN  : INT := 700;    (* return temperature >= 70 C *)
    CAUSTIC_SP    : INT := 780;
    CAUSTIC_MAX   : INT := 900;
    CIP_LVL_MIN   : INT := 300;
    RINSE_KG      : INT := 300;    (* 30 kg of water per rinse *)
    CIP_LIMIT     : INT := 500;    (* one CIP per 50 kg of production *)
    ALARM_MASK    : WORD := WORD#16#23FF;   (* bits 0-9 and 13 are alarms, 10-12 are warnings *)
  END_VAR

  VAR
    (* ---- Decoded inputs ------------------------------------------- *)
    DI_T1_LOW, DI_CIP_START, DI_CIP_ABORT, DI_P1_RUN, DI_P1_TRIP, DI_LEAK : BOOL;
    CLOSED   : WORD;   (* aligned with the DO bits: bit1 V_PROD .. bit6 V_CIPRET *)

    (* ---- Route manager ---------------------------------------------- *)
    WANT     : WORD;   (* route requested by the step *)
    CUR      : WORD;   (* proven, applied route *)
    VALVES   : WORD;   (* command to the valves *)
    RSTATE       : INT;    (* 0 stable, 1 closing, 2 opening *)
    PUMP_REQ : BOOL;
    Q_P1     : BOOL;
    Q_HEAT   : BOOL;
    ROUTE_OK : BOOL;   (* all valves not in the route are closed *)

    (* ---- State -------------------------------------------------------- *)
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
    LINE_PRODUCT : BOOL;   (* line is full of product and verified *)
    CIP_REQ     : BOOL;    (* the operator requested CIP; starts when the transfer ends *)
    CAUSTIC_IN  : BOOL;    (* caustic was routed to the return *)
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

    (* ---- Timers (matiec: each on a separate line) --------------- *)
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

  (* =================== 1. Decode inputs =================== *)
  DI_T1_LOW    := (IW_DI AND WORD#16#0001) <> WORD#0;
  DI_CIP_START := (IW_DI AND WORD#16#0002) <> WORD#0;
  DI_CIP_ABORT := (IW_DI AND WORD#16#0004) <> WORD#0;
  DI_P1_RUN    := (IW_DI AND WORD#16#0008) <> WORD#0;
  DI_P1_TRIP   := (IW_DI AND WORD#16#0010) <> WORD#0;
  DI_LEAK      := (IW_DI AND WORD#16#0800) <> WORD#0;
  (* closed limit switches are DI bits 5..10; shifted right by 4 bits they align with DO bits 1..6 *)
  CLOSED := SHR(IW_DI, 4) AND WORD#16#007E;

  RT_CIPSTART(CLK := DI_CIP_START);
  RT_CIPABORT(CLK := DI_CIP_ABORT);
  RT_RESET(CLK := RESET);
  RT_START(CLK := START);
  IF RT_START.Q AND IO_READY AND NOT RESTART THEN WAIT_START := FALSE; MODE := 1; END_IF;

  (* increase of the flow meter totalizer in this scan (including wrap-around at 30000) *)
  IF NOT TOTAL_INIT THEN TOTAL_LAST := IW_TOTAL; TOTAL_INIT := IO_READY; END_IF;
  D_TOTAL := IW_TOTAL - TOTAL_LAST;
  IF D_TOTAL < 0 THEN D_TOTAL := D_TOTAL + 30000; END_IF;
  TOTAL_LAST := IW_TOTAL;

  COND_OK := (IW_COND >= COND_MIN) AND (IW_COND <= COND_MAX);

  (* =================== 2. Safety and alarms =================== *)
  IF NOT ESTOP_OK THEN ALARMS := ALARMS OR WORD#16#0001; END_IF;
  IF COMM_FAULT THEN ALARMS := ALARMS OR WORD#16#2000; END_IF;   (* no communication: stop safely *)
  IF DI_P1_TRIP THEN ALARMS := ALARMS OR WORD#16#0020; END_IF;
  IF DI_LEAK THEN ALARMS := ALARMS OR WORD#16#0010; END_IF;

  (* if a valve not in the route does not read closed for 1 s: valve stuck or leaking *)
  ROUTE_OK := ((NOT CUR) AND WORD#16#007E AND (NOT CLOSED)) = WORD#0;
  T_LEAKVAL(IN := RSTATE = 0 AND NOT ROUTE_OK, PT := T#1s);
  IF T_LEAKVAL.Q THEN ALARMS := ALARMS OR WORD#16#0008; END_IF;

  T_NOFLOW(IN := Q_P1 AND (IW_FLOW < FLOW_MIN), PT := T#3s);
  IF T_NOFLOW.Q THEN ALARMS := ALARMS OR WORD#16#0002; END_IF;
  T_RUNFB(IN := Q_P1 AND NOT DI_P1_RUN, PT := T#1s);
  IF T_RUNFB.Q THEN ALARMS := ALARMS OR WORD#16#0040; END_IF;

  IF IW_CIP_T > CAUSTIC_MAX THEN ALARMS := ALARMS OR WORD#16#0100; END_IF;

  IF NOT IO_READY THEN ALARMS := ALARMS_BEFORE; END_IF;

  (* alarm: everything shuts down; if a CIP is in progress it counts as failed *)
  IF (ALARMS AND ALARM_MASK) <> WORD#0 THEN
    IF STP >= 40 THEN CIP_RES := 3; CIP_DUE := TRUE; LINE_PRODUCT := FALSE; END_IF;
    STP := 0;
  END_IF;

  IF RT_RESET.Q THEN
    IF ESTOP_OK AND NOT COMM_FAULT AND NOT DI_P1_TRIP AND NOT DI_LEAK THEN
      ALARMS := WORD#0;
    END_IF;
  END_IF;

  (* =================== 3. Steps =================== *)
  (* note: STEP and RS are IEC 61131-3 reserved words (SFC step, RS flip-flop); STP / RSTATE are used instead *)
  IF STP <> LAST_STP THEN STEP_SCANS := 0; VOL := 0; END_IF;
  LAST_STP := STP;
  IF STEP_SCANS < 30000 THEN STEP_SCANS := STEP_SCANS + 1; END_IF;
  IF RSTATE = 0 AND (STP = 42 OR STP = 44) THEN VOL := VOL + D_TOTAL; END_IF;

  (* quantity passed through the route applied for production *)
  IF CUR = WORD#16#0012 OR CUR = WORD#16#0022 THEN
    IF SINCE < 30000 THEN SINCE := SINCE + D_TOTAL; END_IF;
  END_IF;
  IF CUR = WORD#16#0012 THEN BATCH := BATCH + D_TOTAL; END_IF;
  IF SINCE >= CIP_LIMIT THEN CIP_DUE := TRUE; END_IF;

  (* product waiting in the line for a long time goes stale: a push-out is needed again *)
  T_STALE(IN := STP = 0 AND LINE_PRODUCT, PT := T#1200s);
  IF T_STALE.Q THEN LINE_PRODUCT := FALSE; END_IF;

  IF RT_CIPSTART.Q THEN CIP_REQ := TRUE; END_IF;

  (* CIP abort *)
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
  STEP_TO := STEP_SCANS >= 15000;     (* 300 s; with a 20 ms task cycle *)

  CASE STP OF
    0:  (* idle *)
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

    20: (* fill the line with product: first liquid to the drain *)
      WANT := WORD#16#0022;            (* V_PROD + V_DRAIN *)
      PUMP_REQ := TRUE;
      IF T_INWIN.Q THEN
        LINE_PRODUCT := TRUE;
        STP := 10;                     (* the route manager stops the pump and changes the route *)
      ELSIF STEP_SCANS > 2250 THEN
        ALARMS := ALARMS OR WORD#16#0200;   (* product conductivity not detected within 45 s *)
      END_IF;

    10: (* transfer to the filling tank *)
      WANT := WORD#16#0012;            (* V_PROD + V_FILL *)
      PUMP_REQ := TRUE;
      IF T_FOREIGN.Q THEN
        LINE_PRODUCT := FALSE;
        ALARMS := ALARMS OR WORD#16#0004;
      ELSIF NOT REQ OR DI_T1_LOW OR SINCE >= CIP_LIMIT OR CIP_REQ THEN
        STP := 0;
      END_IF;

    40: (* CIP preparation: empty route for the line, prove all valves closed *)
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

    41: (* wait for the caustic temperature *)
      WANT := WORD#0;
      PUMP_REQ := FALSE;
      IF IW_CIP_T >= CAUSTIC_SP - 50 THEN
        STP := 42;
      ELSIF STEP_TO THEN
        ALARMS := ALARMS OR WORD#16#0080;
      END_IF;

    42: (* pre-rinse: water to the drain *)
      WANT := WORD#16#0024;            (* V_WATER + V_DRAIN *)
      PUMP_REQ := TRUE;
      IF VOL >= RINSE_KG THEN
        WATER_REF := IW_COND;           (* conductivity of the inlet water: the criterion for the final rinse *)
        STP := 43;
      ELSIF STEP_TO THEN
        ALARMS := ALARMS OR WORD#16#0080;
      END_IF;

    43: (* caustic: first to the drain, to the caustic tank once caustic arrives (phase separation) *)
      PUMP_REQ := TRUE;
      IF NOT CAUSTIC_IN AND RSTATE = 0 AND IW_COND >= COND_CAUSTIC THEN CAUSTIC_IN := TRUE; END_IF;
      IF CAUSTIC_IN THEN
        WANT := WORD#16#0048;          (* V_CAUSTIC + V_CIPRET *)
      ELSE
        WANT := WORD#16#0028;          (* V_CAUSTIC + V_DRAIN *)
      END_IF;
      (* CIP record: the lowest values in the counted hold window *)
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

    44: (* final rinse: until no caustic is left *)
      WANT := WORD#16#0024;
      PUMP_REQ := TRUE;
      IF VOL >= RINSE_KG AND IW_COND <= WATER_REF + RINSE_MARGIN THEN
        FINAL_COND := IW_COND;
        STP := 45;
      ELSIF STEP_TO THEN
        ALARMS := ALARMS OR WORD#16#0080;
      END_IF;

    45: (* completed *)
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

  (* =================== 4. Route manager =================== *)
  IF (ALARMS AND ALARM_MASK) <> WORD#0 THEN WANT := WORD#0; END_IF;
  IF WANT <> CUR AND RSTATE = 0 THEN RSTATE := 1; END_IF;
  T_ROUTE(IN := RSTATE = 1, PT := T#3s);
  T_STROKE(IN := RSTATE = 2, PT := T#1s);
  IF RSTATE = 1 THEN
    VALVES := CUR AND WANT;            (* close the ones not in the new route *)
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

  (* caustic tank thermostat (+/- 2 C), level and over-temperature interlock *)
  IF NOT ESTOP_OK OR IW_CIP_LVL < CIP_LVL_MIN OR IW_CIP_T > CAUSTIC_MAX THEN
    Q_HEAT := FALSE;
  ELSIF IW_CIP_T < CAUSTIC_SP - 20 THEN
    Q_HEAT := TRUE;
  ELSIF IW_CIP_T > CAUSTIC_SP + 20 THEN
    Q_HEAT := FALSE;
  END_IF;

  (* =================== 5. Outputs =================== *)
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
