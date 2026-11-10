(* =====================================================================
   FB_Asrs - automated cold store: inbound control, stacker crane jobs, slot table (block 6)

   Slot table (mini WMS): status and pallet number for each slot.
     LST: 0 EMPTY, 1 RESERVED (storage job issued), 2 FULL, 3 UNKNOWN
   The real state is in the simulator; this table is the expected inventory. An unknown slot
   (unfinished job, double storage, PLC restarted) is reconciled by the crane's "slot check"
   job: the crane goes there and reads the label with its fork reader.
   Because the table is not retained when the PLC starts, all slots are unknown and
   the inventory count happens by itself.

   Placement: lowest level first, the column closest to the P&D station first. Shipping is FIFO (oldest
   pallet number); with the same shelf life it gives the same result as FEFO, true FEFO
   needs a lot and an expiry date.

   Inbound: contour and label check; a pallet that fails is not stored, the operator
   takes it. No stock without an ID is created. The inbound conveyor does not run while the crane fork is at P&D;
   it also does not run while the AGV forks are inside the inlet.
   ===================================================================== *)

FUNCTION_BLOCK FB_Asrs
  VAR_INPUT
    RESTART : BOOL;
    START, STOP_OK, ESTOP_OK, RESET : BOOL;
    IO_READY     : BOOL;
    COMM_FAULT   : BOOL;
    IW_DI        : WORD;
    IW_ACK_SEQ   : INT;
    IW_RES_SEQ   : INT;
    IW_RES_CODE  : INT;
    IW_RES_LOC   : INT;
    IW_RES_ID    : INT;
    IW_IN_ID     : INT;
    IW_FORK_ID   : INT;
    IW_TEMP      : INT;     (* 0.1 C *)
    IW_SHIP_REQ  : INT;
    AGV_CLEAR_IN : BOOL;
  END_VAR
  VAR_OUTPUT
    QW_DO      : WORD;
    QW_JOB     : INT;
    QW_LOC     : INT;
    QW_SEQ     : INT;
    QW_STATE   : INT;
    QW_ALARM   : WORD;
    QW_STATUS  : WORD;
    QW_OCC_A   : WORD;
    QW_OCC_B   : WORD;
    QW_OCC_C   : WORD;
    QW_STOCK   : INT;
    QW_UNKNOWN : INT;
    QW_STORED  : INT;
    QW_PICKED  : INT;
    QW_NEXT_ID : INT;
    IN_READY   : BOOL;     (* to the AGV: inlet empty, conveyor stopped *)
    RUNNING    : BOOL;
  END_VAR

  VAR
    TEMP_MAX   : INT := 60;     (* 6.0 C *)
    ALARM_MASK : WORD := WORD#16#23FF;
  END_VAR

  VAR
    LST : ARRAY[1..36] OF INT;
    LID : ARRAY[1..36] OF INT;
    D_CR_READY, D_HOMED, D_FORK_CENTER, D_FORK_LOAD, D_CR_ERROR : BOOL;
    D_IN_ENTRY, D_IN_CHECK, D_IN_PD, D_OUT_PD, D_OUT_DOCK, D_CHECK_DONE, D_CONTOUR_OK, D_SAFETY_OK : BOOL;
    INIT_DONE  : BOOL;
    WAIT_START : BOOL := TRUE;
    MODE       : INT := 0;
    R_STP      : INT := 0;    (* crane job *)
    I_STP      : INT := 0;    (* inbound *)
    O_STP      : INT := 0;    (* outbound *)
    JOB        : INT := 0;
    LOC        : INT := 0;
    SEQ        : INT := 0;
    PEND_ID    : INT := 0;
    CHK_ID     : INT := 0;
    PD_ID      : INT := 0;
    SHIP_DONE  : INT := 0;
    STORED     : INT := 0;
    PICKED     : INT := 0;
    I          : INT;
    SIDE       : INT;
    COL        : INT;
    LVL        : INT;
    SC         : INT;
    BEST_E     : INT;
    BEST_ESC   : INT;
    BEST_U     : INT;
    BEST_USC   : INT;
    OLDEST     : INT;
    OLDEST_ID  : INT;
    STOCK      : INT;
    UNKNOWN    : INT;
    FULL       : BOOL;
    SHIP_PEND  : BOOL;
    SEQ_SYNC   : BOOL;
    RST_WIN    : BOOL;
    HOLD_LATCH : BOOL;
    ALARMS_BEFORE : WORD;
    ALARMS     : WORD;
    WARNS      : WORD;
    STATUS     : WORD;
    MASK       : WORD;
    OCC_A, OCC_B, OCC_C : WORD;
    Q_IN1, Q_IN2, Q_OUT : BOOL;
    RT_START   : R_TRIG;
    RT_RESET   : R_TRIG;
    T_RSTWIN   : TON;
    T_ACK      : TON;
    T_RES      : TON;
    T_INCONV   : TON;
    T_OUTCONV  : TON;
    T_TEMP     : TON;
  END_VAR

  ALARMS_BEFORE := ALARMS;
  IF RESTART THEN
    MODE := 0; WAIT_START := TRUE;
    R_STP := 0; I_STP := 0; O_STP := 0; JOB := 0; LOC := 0; INIT_DONE := FALSE;
    SEQ_SYNC := FALSE; RST_WIN := FALSE; HOLD_LATCH := TRUE;
    T_RSTWIN(IN := FALSE, PT := T#1s);
    T_ACK(IN := FALSE, PT := T#1s);
    T_RES(IN := FALSE, PT := T#1s);
    T_INCONV(IN := FALSE, PT := T#1s);
    T_OUTCONV(IN := FALSE, PT := T#1s);
    T_TEMP(IN := FALSE, PT := T#1s);
  END_IF;

  (* =================== 1. Decode inputs =================== *)
  D_CR_READY    := (IW_DI AND WORD#16#0001) <> WORD#0;
  D_HOMED       := (IW_DI AND WORD#16#0004) <> WORD#0;
  D_FORK_CENTER := (IW_DI AND WORD#16#0008) <> WORD#0;
  D_FORK_LOAD   := (IW_DI AND WORD#16#0010) <> WORD#0;
  D_CR_ERROR    := (IW_DI AND WORD#16#0020) <> WORD#0;
  D_IN_ENTRY    := (IW_DI AND WORD#16#0040) <> WORD#0;
  D_IN_CHECK    := (IW_DI AND WORD#16#0080) <> WORD#0;
  D_IN_PD       := (IW_DI AND WORD#16#0100) <> WORD#0;
  D_OUT_PD      := (IW_DI AND WORD#16#0200) <> WORD#0;
  D_OUT_DOCK    := (IW_DI AND WORD#16#0400) <> WORD#0;
  D_CHECK_DONE  := (IW_DI AND WORD#16#0800) <> WORD#0;
  D_CONTOUR_OK  := (IW_DI AND WORD#16#1000) <> WORD#0;
  D_SAFETY_OK   := (IW_DI AND WORD#16#2000) <> WORD#0;

  RT_START(CLK := START);
  RT_RESET(CLK := RESET);

  (* table is not retained: at start all slots are unknown, a count is done *)
  IF NOT INIT_DONE THEN
    FOR I := 1 TO 36 DO
      LST[I] := 3;
      LID[I] := 0;
    END_FOR;
    INIT_DONE := TRUE;
  END_IF;
  IF IO_READY AND NOT SEQ_SYNC THEN
    SEQ := IW_ACK_SEQ;
    SHIP_DONE := IW_SHIP_REQ;   (* orders issued while the PLC was off are not counted *)
    SEQ_SYNC := TRUE;
  END_IF;
  IF RT_RESET.Q THEN RST_WIN := TRUE; END_IF;
  T_RSTWIN(IN := RST_WIN, PT := T#3s);
  IF T_RSTWIN.Q THEN RST_WIN := FALSE; END_IF;

  (* =================== 2. Scan the slot table =================== *)
  (* score: level*100 + distance to P&D*10 + side; the smaller one first *)
  BEST_E := 0; BEST_ESC := 32000; BEST_U := 0; BEST_USC := 32000;
  OLDEST := 0; OLDEST_ID := 32000; STOCK := 0; UNKNOWN := 0;
  FOR I := 1 TO 36 DO
    SIDE := (I - 1) / 18;
    COL := ((I - 1) MOD 18) / 3;
    LVL := (I - 1) MOD 3;
    SC := LVL * 100 + (5 - COL) * 10 + SIDE;
    IF LST[I] = 0 AND SC < BEST_ESC THEN BEST_E := I; BEST_ESC := SC; END_IF;
    IF LST[I] = 3 AND SC < BEST_USC THEN BEST_U := I; BEST_USC := SC; END_IF;
    IF LST[I] = 2 THEN
      STOCK := STOCK + 1;
      IF LID[I] > 0 AND LID[I] < OLDEST_ID THEN OLDEST := I; OLDEST_ID := LID[I]; END_IF;
    END_IF;
    IF LST[I] = 3 THEN UNKNOWN := UNKNOWN + 1; END_IF;
  END_FOR;
  FULL := BEST_E = 0 AND UNKNOWN = 0;
  SHIP_PEND := IW_SHIP_REQ <> SHIP_DONE;

  (* =================== 3. Alarms =================== *)
  IF NOT ESTOP_OK THEN ALARMS := ALARMS OR WORD#16#0001; END_IF;
  IF ESTOP_OK AND NOT D_SAFETY_OK THEN ALARMS := ALARMS OR WORD#16#0002; END_IF;
  IF COMM_FAULT THEN ALARMS := ALARMS OR WORD#16#2000; END_IF;
  IF D_CR_ERROR AND (ALARMS AND WORD#16#000C) = WORD#0 THEN ALARMS := ALARMS OR WORD#16#0004; END_IF;
  T_ACK(IN := R_STP = 11 AND NOT HOLD_LATCH AND NOT RST_WIN, PT := T#3s);
  T_RES(IN := R_STP = 12 AND NOT HOLD_LATCH AND NOT RST_WIN, PT := T#60s);
  IF T_ACK.Q OR T_RES.Q THEN ALARMS := ALARMS OR WORD#16#0040; END_IF;
  T_INCONV(IN := MODE = 1 AND D_SAFETY_OK AND (I_STP = 1 OR I_STP = 4), PT := T#15s);
  T_OUTCONV(IN := MODE = 1 AND D_SAFETY_OK AND O_STP = 1, PT := T#20s);
  IF T_INCONV.Q OR T_OUTCONV.Q THEN ALARMS := ALARMS OR WORD#16#0100; END_IF;
  IF NOT IO_READY THEN ALARMS := ALARMS_BEFORE; END_IF;

  IF (ALARMS AND ALARM_MASK) <> WORD#0 THEN
    IF (ALARMS AND WORD#16#0001) <> WORD#0 THEN MODE := 4; ELSIF MODE <> 4 THEN MODE := 3; END_IF;
    HOLD_LATCH := TRUE;
  END_IF;
  IF RST_WIN AND ESTOP_OK AND D_SAFETY_OK AND NOT COMM_FAULT AND NOT D_CR_ERROR AND I_STP <> 5 THEN
    ALARMS := WORD#0;
    RST_WIN := FALSE;
    IF MODE = 3 OR MODE = 4 THEN
      MODE := 0;
      IF R_STP = 10 OR R_STP = 11 THEN
        IF JOB = 1 AND LOC >= 1 THEN
          IF LST[LOC] = 1 THEN LST[LOC] := 0; END_IF;   (* storage not accepted: undo the reservation *)
        END_IF;
        SEQ := IW_ACK_SEQ;
        R_STP := 0;
      END_IF;
    END_IF;
  END_IF;
  IF MODE = 0 AND RT_START.Q AND IO_READY AND NOT RESTART AND STOP_OK AND (ALARMS AND ALARM_MASK) = WORD#0 THEN
    MODE := 1;
    HOLD_LATCH := FALSE;
  END_IF;
  IF MODE = 1 THEN WAIT_START := FALSE; END_IF;
  IF MODE = 1 AND NOT STOP_OK THEN MODE := 0; END_IF;

  (* =================== 4. Crane job =================== *)
  CASE R_STP OF
    0:
      IF MODE = 1 AND D_CR_READY AND SEQ_SYNC AND NOT HOLD_LATCH THEN
        IF NOT D_HOMED THEN
          JOB := 3; LOC := 0; R_STP := 10;
        ELSIF D_FORK_LOAD THEN
          IF BEST_E > 0 THEN   (* pallet left on the forks: to a new slot *)
            JOB := 1; LOC := BEST_E; LST[LOC] := 1; PEND_ID := IW_FORK_ID; R_STP := 10;
          ELSIF BEST_U > 0 THEN
            JOB := 4; LOC := BEST_U; R_STP := 10; (* first prove an empty location *)
          END_IF;
        ELSIF D_IN_PD AND BEST_E > 0 AND I_STP <> 4 THEN   (* let the pallet number be recorded first *)
          JOB := 1; LOC := BEST_E; LST[LOC] := 1; PEND_ID := PD_ID; R_STP := 10;
        ELSIF SHIP_PEND AND OLDEST > 0 AND NOT D_OUT_PD AND O_STP = 0 THEN
          JOB := 2; LOC := OLDEST; R_STP := 10;
        ELSIF BEST_U > 0 THEN
          JOB := 4; LOC := BEST_U; R_STP := 10;
        END_IF;
      END_IF;
    10:
      SEQ := SEQ + 1;
      IF SEQ > 30000 THEN SEQ := 1; END_IF;
      R_STP := 11;
    11:
      IF IW_RES_SEQ = SEQ OR IW_ACK_SEQ = SEQ THEN R_STP := 12; END_IF;
    12:
      IF IW_RES_SEQ = SEQ THEN
        R_STP := 0;
        IF JOB = 1 THEN
          IF IW_RES_CODE = 1 OR IW_RES_CODE = 17 THEN
            IF PEND_ID > 0 THEN LST[LOC] := 2; LID[LOC] := PEND_ID; ELSE LST[LOC] := 3; END_IF;
            PD_ID := 0;
            STORED := STORED + 1;
            IF STORED > 30000 THEN STORED := 0; END_IF;
          ELSIF IW_RES_CODE = 11 THEN
            (* slot turned out to be full: the table is wrong. Record the pallet the crane read, alarm *)
            LST[LOC] := 2; LID[LOC] := IW_RES_ID;
            ALARMS := ALARMS OR WORD#16#0010;
          ELSIF IW_RES_CODE = 10 THEN
            LST[LOC] := 0;
            ALARMS := ALARMS OR WORD#16#0020;
          ELSIF IW_RES_CODE = 12 THEN
            LST[LOC] := 0;
            ALARMS := ALARMS OR WORD#16#0200;
          ELSE
            LST[LOC] := 3;      (* cancel or fault: the slot will be checked *)
          END_IF;
        ELSIF JOB = 2 THEN
          IF IW_RES_CODE = 1 OR IW_RES_CODE = 17 THEN
            LST[LOC] := 0; LID[LOC] := 0;
            SHIP_DONE := SHIP_DONE + 1;
            IF SHIP_DONE > 29999 THEN SHIP_DONE := 0; END_IF;
            PICKED := PICKED + 1;
            IF PICKED > 30000 THEN PICKED := 0; END_IF;
          ELSIF IW_RES_CODE = 10 THEN
            LST[LOC] := 0; LID[LOC] := 0;
            ALARMS := ALARMS OR WORD#16#0020;
          ELSIF IW_RES_CODE = 12 THEN
            ALARMS := ALARMS OR WORD#16#0200;
          ELSIF IW_RES_CODE <> 11 THEN
            LST[LOC] := 3;
          END_IF;
        ELSIF JOB = 4 THEN
          IF IW_RES_CODE = 1 THEN
            IF IW_RES_ID > 0 THEN LST[LOC] := 2; LID[LOC] := IW_RES_ID; ELSE LST[LOC] := 0; LID[LOC] := 0; END_IF;
          ELSIF IW_RES_CODE = 12 THEN
            ALARMS := ALARMS OR WORD#16#0200;
          END_IF;
        END_IF;
        IF IW_RES_CODE = 14 THEN ALARMS := ALARMS OR WORD#16#0004; END_IF;
        IF IW_RES_CODE = 15 THEN ALARMS := ALARMS OR WORD#16#0008; END_IF;
      END_IF;
  END_CASE;

  (* =================== 5. Inbound and outbound conveyors =================== *)
  IF MODE = 1 THEN
    CASE I_STP OF
      0: (* AGV dropped off and the forks are outside; on a restart, if there is a pallet at the check point, evaluate the measurement *)
        IF D_IN_CHECK THEN
          I_STP := 2;
        ELSIF D_IN_ENTRY AND AGV_CLEAR_IN THEN
          I_STP := 1;
        END_IF;
      1:
        IF D_IN_CHECK THEN I_STP := 2; END_IF;
      2: (* contour and label *)
        IF D_CHECK_DONE THEN
          IF D_CONTOUR_OK AND IW_IN_ID > 0 THEN
            CHK_ID := IW_IN_ID;
            I_STP := 3;
          ELSE
            ALARMS := ALARMS OR WORD#16#0080;
            I_STP := 5;
          END_IF;
        END_IF;
      3: (* when P&D is empty and the crane fork is centered *)
        IF NOT D_IN_PD AND D_FORK_CENTER AND R_STP <> 12 THEN I_STP := 4; END_IF;
      4:
        IF D_IN_PD THEN PD_ID := CHK_ID; I_STP := 0; END_IF;
      5: (* reject: until the operator takes the pallet *)
        IF NOT D_IN_CHECK THEN I_STP := 0; END_IF;
    END_CASE;
    CASE O_STP OF
      0:
        IF D_OUT_PD AND NOT D_OUT_DOCK THEN O_STP := 1; END_IF;
      1:
        IF D_OUT_DOCK THEN O_STP := 0; END_IF;
    END_CASE;
  END_IF;
  IF I_STP = 5 AND NOT D_IN_CHECK THEN I_STP := 0; END_IF;

  Q_IN1 := MODE = 1 AND I_STP = 1;
  Q_IN2 := MODE = 1 AND I_STP = 4 AND D_FORK_CENTER;
  Q_OUT := MODE = 1 AND O_STP = 1;
  IN_READY := NOT WAIT_START AND NOT D_IN_ENTRY AND NOT Q_IN1 AND IO_READY;

  (* =================== 6. Outputs =================== *)
  QW_DO := WORD#0;
  IF ESTOP_OK AND D_SAFETY_OK AND IO_READY AND NOT COMM_FAULT THEN QW_DO := QW_DO OR WORD#16#0001; END_IF;
  IF HOLD_LATCH THEN QW_DO := QW_DO OR WORD#16#0002; END_IF;
  IF RST_WIN AND D_CR_ERROR THEN QW_DO := QW_DO OR WORD#16#0004; END_IF;
  IF Q_IN1 THEN QW_DO := QW_DO OR WORD#16#0008; END_IF;
  IF Q_IN2 THEN QW_DO := QW_DO OR WORD#16#0010; END_IF;
  IF Q_OUT THEN QW_DO := QW_DO OR WORD#16#0020; END_IF;
  IF IO_READY THEN QW_DO := QW_DO OR WORD#16#0040; END_IF;          (* cooling *)
  IF I_STP = 5 THEN QW_DO := QW_DO OR WORD#16#0080; END_IF;

  T_TEMP(IN := IW_TEMP > TEMP_MAX, PT := T#30s);
  WARNS := WORD#0;
  IF T_TEMP.Q THEN WARNS := WARNS OR WORD#16#0400; END_IF;
  IF FULL AND (D_IN_PD OR D_FORK_LOAD) THEN WARNS := WARNS OR WORD#16#0800; END_IF;
  IF UNKNOWN > 0 THEN WARNS := WARNS OR WORD#16#1000; END_IF;
  QW_ALARM := ALARMS OR WARNS;

  (* PLC inventory: full slots as bits (to compare with the simulator) *)
  OCC_A := WORD#0; OCC_B := WORD#0; OCC_C := WORD#0;
  MASK := WORD#1;
  FOR I := 1 TO 36 DO
    IF LST[I] = 2 THEN
      IF I <= 16 THEN OCC_A := OCC_A OR MASK; ELSIF I <= 32 THEN OCC_B := OCC_B OR MASK; ELSE OCC_C := OCC_C OR MASK; END_IF;
    END_IF;
    IF I = 16 OR I = 32 THEN MASK := WORD#1; ELSE MASK := SHL(MASK, 1); END_IF;
  END_FOR;

  IF MODE = 4 THEN
    QW_STATE := 7;
  ELSIF MODE = 3 THEN
    IF NOT D_SAFETY_OK THEN QW_STATE := 6; ELSE QW_STATE := 5; END_IF;
  ELSIF MODE = 0 THEN
    IF R_STP <> 0 THEN QW_STATE := 8; ELSE QW_STATE := 0; END_IF;
  ELSIF FULL AND (D_IN_PD OR D_FORK_LOAD) THEN
    QW_STATE := 4;
  ELSIF R_STP <> 0 AND JOB = 4 THEN
    QW_STATE := 3;
  ELSIF R_STP <> 0 OR I_STP = 1 OR I_STP = 4 OR O_STP = 1 THEN
    QW_STATE := 1;
  ELSE
    QW_STATE := 2;
  END_IF;

  STATUS := WORD#0;
  IF IN_READY AND MODE = 1 THEN STATUS := STATUS OR WORD#16#0001; END_IF;
  IF MODE = 1 THEN STATUS := STATUS OR WORD#16#0002; END_IF;
  IF MODE = 3 OR MODE = 4 THEN STATUS := STATUS OR WORD#16#0004; END_IF;
  IF QW_STATE = 2 THEN STATUS := STATUS OR WORD#16#0008; END_IF;
  IF FULL THEN STATUS := STATUS OR WORD#16#0010; END_IF;
  IF UNKNOWN > 0 THEN STATUS := STATUS OR WORD#16#0020; END_IF;
  IF SHIP_PEND THEN STATUS := STATUS OR WORD#16#0040; END_IF;
  IF WAIT_START THEN STATUS := STATUS OR WORD#16#0080; END_IF;
  QW_STATUS := STATUS;

  QW_JOB := JOB;
  QW_LOC := LOC;
  QW_SEQ := SEQ;
  QW_OCC_A := OCC_A;
  QW_OCC_B := OCC_B;
  QW_OCC_C := OCC_C;
  QW_STOCK := STOCK;
  QW_UNKNOWN := UNKNOWN;
  QW_STORED := STORED;
  QW_PICKED := PICKED;
  IF OLDEST > 0 THEN QW_NEXT_ID := OLDEST_ID; ELSE QW_NEXT_ID := 0; END_IF;
  RUNNING := MODE = 1;
  IF WAIT_START OR NOT IO_READY THEN
    QW_DO := WORD#0;
  END_IF;
END_FUNCTION_BLOCK
