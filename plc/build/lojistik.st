(* =====================================================================
   Ayran mini fabrika - OpenPLC programi: Lojistik PLC (URETILMIS DOSYA, ELLE DUZENLEMEYIN)
   Kaynaklar: plc/src/*.st   Uretici: tools/gen-plc.js   Harita surumu: 7
   OpenPLC slave cihazi (simulator):
     Input Registers   start 0, size 112  -> %IW100..%IW211
     Holding Registers start 80, size 32  -> %QW100..%QW131
   ===================================================================== *)


(* =====================================================================
   FB_Agv - simple main control for an autonomous pallet truck (block 5)

   The vehicle does its own navigation; the PLC issues jobs (same handshake
   as with the robot and the crane): ORDER + SEQ are written, the vehicle returns ACK_SEQ, RES_SEQ, RES_CODE.
   Jobs: 1 transport (D -> cold store inlet), 2 drop the load on the forks into the store,
   3 charge, 4 park. This is not VDA 5050.

   Station permissions (E84-like): the pickup point permission is given while a pallet is at D and the D
   conveyor is stopped; the cold store inlet permission is given while the inlet is empty and the conveyor
   is stopped. The permission is held throughout the transfer. The vehicle reports "forks outside";
   while the forks are inside, that station's conveyor does not run (wired in the Factory program
   to the PALLET and ASRS blocks).

   Scanner safety is on the vehicle itself; this block only reads its status.
   ===================================================================== *)

FUNCTION_BLOCK FB_Agv
  VAR_INPUT
    RESTART : BOOL;
    START, STOP_OK, ESTOP_OK, RESET : BOOL;
    IO_READY    : BOOL;
    COMM_FAULT  : BOOL;
    IW_DI       : WORD;
    IW_ACK_SEQ  : INT;
    IW_RES_SEQ  : INT;
    IW_RES_CODE : INT;
    IW_BATTERY  : INT;
    D_READY     : BOOL;   (* palletizing: pallet ready at the pickup point, conveyor stopped *)
    IN_READY    : BOOL;   (* cold store: inlet empty, conveyor stopped *)
  END_VAR
  VAR_OUTPUT
    QW_DO     : WORD;
    QW_ORDER  : INT;
    QW_SEQ    : INT;
    QW_STATE  : INT;
    QW_ALARM  : WORD;
    QW_STATUS : WORD;
    QW_MOVES  : INT;
    RUNNING   : BOOL;
  END_VAR

  VAR
    BAT_LOW    : INT := 30;    (* below this value, charge first *)
    BAT_FULL   : INT := 80;    (* when idle and below this, go charge *)
    ALARM_MASK : WORD := WORD#16#23FF;
  END_VAR

  VAR
    A_READY, A_LOADED, A_CHARGING, A_ERROR, A_SCAN_STOP, A_WAIT, A_AT_PARK, A_AT_CHG : BOOL;
    WAIT_START : BOOL := TRUE;
    MODE      : INT := 0;
    R_STP     : INT := 0;
    ORDER     : INT := 0;
    SEQ       : INT := 0;
    MOVES     : INT := 0;
    SEQ_SYNC  : BOOL;
    RST_WIN   : BOOL;
    HOLD_LATCH : BOOL;
    ALARMS_BEFORE : WORD;
    ALARMS    : WORD;
    WARNS     : WORD;
    STATUS    : WORD;
    Q_PERMIT_D, Q_PERMIT_IN : BOOL;
    RT_START  : R_TRIG;
    RT_RESET  : R_TRIG;
    T_RSTWIN  : TON;
    T_ACK     : TON;
    T_RES     : TON;
    T_PERMIT  : TON;
  END_VAR

  ALARMS_BEFORE := ALARMS;
  IF RESTART THEN
    MODE := 0; WAIT_START := TRUE;
    R_STP := 0; ORDER := 0; SEQ_SYNC := FALSE; RST_WIN := FALSE; HOLD_LATCH := TRUE;
    T_RSTWIN(IN := FALSE, PT := T#1s);
    T_ACK(IN := FALSE, PT := T#1s);
    T_RES(IN := FALSE, PT := T#1s);
    T_PERMIT(IN := FALSE, PT := T#1s);
  END_IF;

  (* =================== 1. Decode inputs =================== *)
  A_READY     := (IW_DI AND WORD#16#0001) <> WORD#0;
  A_LOADED    := (IW_DI AND WORD#16#0004) <> WORD#0;
  A_CHARGING  := (IW_DI AND WORD#16#0100) <> WORD#0;
  A_ERROR     := (IW_DI AND WORD#16#0200) <> WORD#0;
  A_SCAN_STOP := (IW_DI AND WORD#16#0800) <> WORD#0;
  A_WAIT      := (IW_DI AND WORD#16#1000) <> WORD#0;
  A_AT_PARK   := (IW_DI AND WORD#16#2000) <> WORD#0;
  A_AT_CHG    := (IW_DI AND WORD#16#8000) <> WORD#0;

  RT_START(CLK := START);
  RT_RESET(CLK := RESET);
  IF IO_READY AND NOT SEQ_SYNC THEN SEQ := IW_ACK_SEQ; SEQ_SYNC := TRUE; END_IF;
  IF RT_RESET.Q THEN RST_WIN := TRUE; END_IF;
  T_RSTWIN(IN := RST_WIN, PT := T#3s);
  IF T_RSTWIN.Q THEN RST_WIN := FALSE; END_IF;

  (* =================== 2. Alarms =================== *)
  IF NOT ESTOP_OK THEN ALARMS := ALARMS OR WORD#16#0001; END_IF;
  IF A_ERROR THEN ALARMS := ALARMS OR WORD#16#0004; END_IF;
  IF COMM_FAULT THEN ALARMS := ALARMS OR WORD#16#2000; END_IF;
  T_ACK(IN := R_STP = 11 AND NOT HOLD_LATCH AND NOT RST_WIN, PT := T#3s);
  (* job time is not counted while waiting for a permission or an obstacle *)
  T_RES(IN := R_STP = 12 AND NOT HOLD_LATCH AND NOT A_WAIT AND NOT A_SCAN_STOP AND NOT RST_WIN, PT := T#90s);
  IF T_ACK.Q OR T_RES.Q THEN ALARMS := ALARMS OR WORD#16#0020; END_IF;
  IF NOT IO_READY THEN ALARMS := ALARMS_BEFORE; END_IF;

  IF (ALARMS AND ALARM_MASK) <> WORD#0 THEN
    IF (ALARMS AND WORD#16#0001) <> WORD#0 THEN MODE := 4; ELSIF MODE <> 4 THEN MODE := 3; END_IF;
    HOLD_LATCH := TRUE;
  END_IF;
  IF RST_WIN AND ESTOP_OK AND NOT COMM_FAULT AND NOT A_ERROR THEN
    ALARMS := WORD#0;
    RST_WIN := FALSE;
    IF MODE = 3 OR MODE = 4 THEN
      MODE := 0;
      IF R_STP = 10 OR R_STP = 11 THEN SEQ := IW_ACK_SEQ; R_STP := 0; END_IF;
    END_IF;
  END_IF;
  IF MODE = 0 AND RT_START.Q AND IO_READY AND NOT RESTART AND STOP_OK AND (ALARMS AND ALARM_MASK) = WORD#0 THEN
    MODE := 1;
    HOLD_LATCH := FALSE;
  END_IF;
  IF MODE = 1 THEN WAIT_START := FALSE; END_IF;
  IF MODE = 1 AND NOT STOP_OK THEN MODE := 0; END_IF;

  (* =================== 3. Job selection and result =================== *)
  CASE R_STP OF
    0:
      IF MODE = 1 AND A_READY AND SEQ_SYNC AND NOT HOLD_LATCH THEN
        IF A_LOADED THEN
          ORDER := 2; R_STP := 10;            (* unfinished delivery: load is on the vehicle *)
        ELSIF IW_BATTERY < BAT_LOW THEN
          IF NOT A_AT_CHG THEN ORDER := 3; R_STP := 10; END_IF;
        ELSIF D_READY THEN
          ORDER := 1; R_STP := 10;
        ELSIF NOT A_AT_CHG AND IW_BATTERY < BAT_FULL THEN
          ORDER := 3; R_STP := 10;            (* opportunity charge *)
        ELSIF NOT A_AT_CHG AND NOT A_AT_PARK THEN
          ORDER := 4; R_STP := 10;
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
        IF IW_RES_CODE = 1 OR IW_RES_CODE = 17 THEN
          IF ORDER = 1 OR ORDER = 2 THEN
            MOVES := MOVES + 1;
            IF MOVES > 30000 THEN MOVES := 0; END_IF;
          END_IF;
        ELSIF IW_RES_CODE = 10 THEN
          ALARMS := ALARMS OR WORD#16#0008;
        ELSIF IW_RES_CODE = 14 THEN
          ALARMS := ALARMS OR WORD#16#0040;
        ELSIF IW_RES_CODE = 15 THEN
          ALARMS := ALARMS OR WORD#16#0080;
        ELSIF IW_RES_CODE = 11 OR IW_RES_CODE = 12 THEN
          ALARMS := ALARMS OR WORD#16#0100;
        END_IF;
      END_IF;
  END_CASE;

  (* =================== 4. Outputs =================== *)
  Q_PERMIT_D  := D_READY AND R_STP = 12 AND ORDER = 1;
  Q_PERMIT_IN := IN_READY AND R_STP = 12 AND (ORDER = 1 OR ORDER = 2);

  QW_DO := WORD#0;
  IF ESTOP_OK AND IO_READY AND NOT COMM_FAULT THEN QW_DO := QW_DO OR WORD#16#0001; END_IF;
  IF HOLD_LATCH THEN QW_DO := QW_DO OR WORD#16#0002; END_IF;
  IF RST_WIN AND A_ERROR THEN QW_DO := QW_DO OR WORD#16#0004; END_IF;
  IF Q_PERMIT_D THEN QW_DO := QW_DO OR WORD#16#0008; END_IF;
  IF Q_PERMIT_IN THEN QW_DO := QW_DO OR WORD#16#0010; END_IF;

  T_PERMIT(IN := A_WAIT, PT := T#30s);
  WARNS := WORD#0;
  IF A_SCAN_STOP THEN WARNS := WARNS OR WORD#16#0400; END_IF;
  IF IW_BATTERY < BAT_LOW THEN WARNS := WARNS OR WORD#16#0800; END_IF;
  IF T_PERMIT.Q THEN WARNS := WARNS OR WORD#16#1000; END_IF;
  QW_ALARM := ALARMS OR WARNS;

  IF MODE = 4 THEN
    QW_STATE := 7;
  ELSIF MODE = 3 THEN
    QW_STATE := 6;
  ELSIF MODE = 0 THEN
    IF R_STP <> 0 THEN QW_STATE := 8; ELSE QW_STATE := 0; END_IF;
  ELSIF A_SCAN_STOP THEN
    QW_STATE := 5;
  ELSIF A_WAIT THEN
    QW_STATE := 4;
  ELSIF R_STP <> 0 AND (ORDER = 1 OR ORDER = 2) THEN
    QW_STATE := 1;
  ELSIF A_CHARGING THEN
    QW_STATE := 3;
  ELSE
    QW_STATE := 2;
  END_IF;

  STATUS := WORD#0;
  IF MODE = 1 AND R_STP = 0 AND A_READY THEN STATUS := STATUS OR WORD#16#0001; END_IF;
  IF MODE = 1 THEN STATUS := STATUS OR WORD#16#0002; END_IF;
  IF MODE = 3 OR MODE = 4 THEN STATUS := STATUS OR WORD#16#0004; END_IF;
  IF QW_STATE = 2 THEN STATUS := STATUS OR WORD#16#0008; END_IF;
  IF A_CHARGING THEN STATUS := STATUS OR WORD#16#0010; END_IF;
  IF A_SCAN_STOP THEN STATUS := STATUS OR WORD#16#0020; END_IF;
  IF A_LOADED THEN STATUS := STATUS OR WORD#16#0040; END_IF;
  IF WAIT_START THEN STATUS := STATUS OR WORD#16#0080; END_IF;
  QW_STATUS := STATUS;

  QW_ORDER := ORDER;
  QW_SEQ   := SEQ;
  QW_MOVES := MOVES;
  RUNNING  := MODE = 1;
  IF WAIT_START OR NOT IO_READY THEN
    QW_DO := WORD#0;
  END_IF;
END_FUNCTION_BLOCK


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


(* =====================================================================
   FB_Dolum - ayran cup fill-and-seal machine (block 1 of the factory)

   Machine: indexer chain with 8 pockets. Pockets 0..7, stations:
     0 Cup feed   2 Filling (with scale, coarse + fine flow)
     3 Foil placement 4 Heat seal   5 Checkweigher   6 Reject
     7 Transfer to the outfeed belt
   After each index step the stations work in parallel; when all
   are finished the next step is taken. Product quality is tracked for each pocket in a
   shift register (TR_CUP / TR_BAD).

   The operator panel, e-stop and communication watchdog come in as inputs from the factory
   program (Fabrika.st).
   ===================================================================== *)

FUNCTION_BLOCK FB_Dolum
  VAR_INPUT
    RESTART : BOOL;
    START, STOP_OK, ESTOP_OK, RESET : BOOL;   (* factory panel *)
    IO_READY   : BOOL;   (* first data arrived from the simulator *)
    COMM_FAULT : BOOL;   (* simulator heartbeat stopped *)
    IW_DI      : WORD;   (* digital inputs, bit-packed *)
    IW_FILL    : INT;    (* filling scale net, 0.1 g *)
    IW_TANK    : INT;    (* filling tank level, 0.1 % *)
    IW_TEMP    : INT;    (* sealing head, 0.1 C *)
    IW_CHECK   : INT;    (* checkweigher gross, 0.1 g *)
  END_VAR
  VAR_OUTPUT
    QW_STATUS : WORD;
    QW_DO     : WORD;    (* digital outputs, bit-packed *)
    QW_STATE  : INT;
    QW_ALARM  : WORD;
    QW_GOOD   : INT;
    QW_REJECT : INT;
    RUNNING   : BOOL;
    PRODUCT_REQ : BOOL;  (* filling tank below 40%: request product from the tank station, release at 80% *)
  END_VAR

  VAR
    (* ---- Recipe and settings ------------------------------------------ *)
    FILL_TARGET     : INT := 2060;  (* 206.0 g net = 200 ml ayran *)
    FILL_TOL        : INT := 40;    (* +/- 4.0 g *)
    COARSE_MARGIN   : INT := 400;   (* coarse flow is cut off this far below the target; self-adjusting:
                                       if fine flow lasts very briefly, coarse flow overshot *)
    PREACT          : INT := 20;    (* pre-act (in-flight amount), self-adjusting *)
    TARE            : INT := 49;    (* cup 4.5 g + foil 0.4 g *)
    TEMP_SP         : INT := 1950;
    TEMP_MIN        : INT := 1700;
    TEMP_MAX        : INT := 2200;
    TANK_ON         : INT := 400;   (* request product below 40% *)
    TANK_OFF        : INT := 800;   (* release above 80% *)
  END_VAR

  VAR
    (* ---- Decoded inputs ------------------------------------------ *)
    DI_START, DI_STOP_OK, DI_ESTOP_OK, DI_RESET, DI_INDEX, DI_CUP_EMPTY,
    DI_CUP_AT_FILL, DI_NOZ_UP, DI_NOZ_DN, DI_FOIL_EMPTY, DI_FOIL_AT_SEAL,
    DI_SEAL_UP, DI_SEAL_DN, DI_TANK_LOW, DI_CUP_AT_REJ, DI_REJ_EXT,
    DI_OUT_FULL : BOOL;

    (* ---- Outputs ---------------------------------------------------- *)
    Q_CONV, Q_CUP_DROP, Q_NOZ_DN, Q_FILL_FAST, Q_FILL_FINE, Q_FOIL,
    Q_SEAL_DN, Q_HEATER, Q_REJECT, Q_GREEN, Q_YELLOW,
    Q_RED, Q_HORN : BOOL;

    (* ---- State ------------------------------------------------------- *)
    WAIT_START : BOOL := TRUE;
    MODE      : INT := 0;   (* 0 stopped, 1 running, 2 stop at end of cycle, 3 alarm, 4 e-stop *)
    CYC       : INT := 0;   (* 0 ready, 10/11 index, 20 stations *)
    HEAT_WAIT : BOOL;
    PURGE : INT;
    OUT_WAIT  : BOOL;       (* outfeed belt full, index waiting *)
    TEMP_OK   : BOOL;
    ALARMS_BEFORE : WORD;
    ALARMS    : WORD;       (* latched alarms, bits 0..7 *)
    WARNS     : WORD;       (* live warnings, bits 8..10 *)
    ALARM_ANY : BOOL;
    ALARM_PREV: BOOL;
    HORN_LATCH: BOOL;
    FILL_WARN : BOOL;
    BLINK     : BOOL;
    GOOD_CNT  : INT;
    REJ_CNT   : INT;
    LINE_EMPTY : BOOL;      (* OEE: no tracked cup on the chain *)
    K         : INT;

    (* ---- Product tracking (per pocket) ------------------------------------ *)
    TR_CUP : ARRAY[0..7] OF BOOL;
    TR_BAD : ARRAY[0..7] OF BOOL;
    I      : INT;

    (* ---- Station steps (9 = done) -------------------------------- *)
    DROP_SUB, FILL_SUB, FOIL_SUB, SEAL_SUB, CHK_SUB, REJ_SUB : INT := 9;
    FILL_ERR : INT;
    CHK_NET  : INT;

    (* ---- Timers and edge detectors ------------------------ *)
    (* Note: matiec crashes when a long list of TONs is given in a single declaration;
       each timer is on a separate line. *)
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

  (* =================== 1. Decode inputs =================== *)
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

  (* =================== 2. Safety and monitoring =================== *)
  IF COMM_FAULT THEN ALARMS := ALARMS OR WORD#16#0080; END_IF;

  IF NOT DI_ESTOP_OK THEN ALARMS := ALARMS OR WORD#16#0001; END_IF;

  (* Heater: thermostat with +/- 2 C hysteresis *)
  IF NOT DI_ESTOP_OK THEN
    Q_HEATER := FALSE;
  ELSIF IW_TEMP < TEMP_SP - 20 THEN
    Q_HEATER := TRUE;
  ELSIF IW_TEMP > TEMP_SP + 20 THEN
    Q_HEATER := FALSE;
  END_IF;
  (* if it is still cold after heating for 45 s the heating element is faulty; reset restarts the counter *)
  (* the warm-up watchdog counts only while the heater is really driven: at power-up, while waiting for START,
     the output is off (mask below), so a cooling heater does not give a false alarm *)
  T_HEAT(IN := Q_HEATER AND NOT WAIT_START AND IO_READY AND (IW_TEMP < TEMP_MIN) AND NOT RT_RESET.Q, PT := T#45s);
  IF T_HEAT.Q THEN ALARMS := ALARMS OR WORD#16#0020; END_IF;

  (* Filling tank level: request product (cell contract). The valve and the pump
     are managed by the tank station; this block only knows when product is needed. *)
  IF NOT IO_READY THEN
    PRODUCT_REQ := FALSE;              (* before the first data arrives the level reads 0 *)
  ELSIF IW_TANK < TANK_ON THEN
    PRODUCT_REQ := TRUE;
  ELSIF IW_TANK > TANK_OFF THEN
    PRODUCT_REQ := FALSE;
  END_IF;

  (* Inputs are zero until the first data arrives; do not raise alarms meanwhile *)
  IF NOT IO_READY THEN ALARMS := ALARMS_BEFORE; END_IF;

  (* =================== 3. Mode management =================== *)
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
        (* cups at unfinished stations are counted as bad *)
        IF FILL_SUB <> 9 AND TR_CUP[2] THEN TR_BAD[2] := TRUE; END_IF;
        IF FOIL_SUB <> 9 AND TR_CUP[3] THEN TR_BAD[3] := TRUE; END_IF;
        IF SEAL_SUB <> 9 AND TR_CUP[4] THEN TR_BAD[4] := TRUE; END_IF;
        DROP_SUB := 9; FILL_SUB := 9; FOIL_SUB := 9; SEAL_SUB := 9;
        (* weighing and reject can be repeated: run them from the start *)
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

  (* =================== 4. Index cycle =================== *)
  T_IDX(IN := (MODE = 1 OR MODE = 2) AND (CYC = 10 OR CYC = 11), PT := T#2s);
  IF T_IDX.Q THEN ALARMS := ALARMS OR WORD#16#0002; END_IF;

  IF MODE = 1 OR MODE = 2 THEN
    IF CYC = 0 THEN
      IF MODE = 2 THEN
        MODE := 0;
      ELSIF NOT TEMP_OK THEN
        HEAT_WAIT := TRUE;
      ELSIF TR_CUP[7] AND DI_OUT_FULL THEN
        (* the cup in the last pocket would be pushed onto the full belt: wait until the belt clears *)
        HEAT_WAIT := FALSE;
        OUT_WAIT := TRUE;
      ELSE
        HEAT_WAIT := FALSE;
        OUT_WAIT := FALSE;
        CYC := 10;
      END_IF;
    ELSIF CYC = 10 THEN
      (* trigger the indexer; release the trigger when the motion starts *)
      Q_CONV := TRUE;
      IF NOT DI_INDEX THEN
        Q_CONV := FALSE;
        CYC := 11;
      END_IF;
    ELSIF CYC = 11 THEN
      IF DI_INDEX THEN
        IF PURGE > 0 THEN PURGE := PURGE - 1; END_IF;
        (* cups advanced one pocket: shift the tracking register *)
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

  (* =================== 5. Stations =================== *)
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

    (* --- Pocket 0: cup feed --- *)
    CASE DROP_SUB OF
      0:
        IF MODE = 1 AND NOT DI_CUP_EMPTY THEN
          Q_CUP_DROP := TRUE;
          DROP_SUB := 1;
        ELSE
          DROP_SUB := 9;   (* magazine empty or the line is being emptied *)
        END_IF;
      1:
        IF T_DROP.Q THEN
          Q_CUP_DROP := FALSE;
          TR_CUP[0] := TRUE;
          DROP_SUB := 2;
        END_IF;
      2:
        (* the chain must not move while the cup drops: wait for the drop + communication delay *)
        IF T_DROPWAIT.Q THEN DROP_SUB := 9; END_IF;
    END_CASE;

    (* --- Pocket 2: filling with scale --- *)
    CASE FILL_SUB OF
      0:
        TR_CUP[2] := DI_CUP_AT_FILL;          (* the sensor corrects the tracking register *)
        IF NOT DI_CUP_AT_FILL THEN
          FILL_SUB := 9;
        ELSIF NOT DI_TANK_LOW THEN
          Q_NOZ_DN := TRUE;
          FILL_SUB := 1;
        END_IF;                               (* tank at low level: wait *)
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
          (* adjust the coarse flow cut-off point according to the fine flow time *)
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
          (* adjust the pre-act according to the last error *)
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

    (* --- Pocket 3: foil placement --- *)
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

    (* --- Pocket 4: heat seal --- *)
    CASE SEAL_SUB OF
      0:
        IF NOT TR_CUP[4] THEN
          SEAL_SUB := 9;
        ELSIF NOT DI_FOIL_AT_SEAL OR NOT TEMP_OK THEN
          TR_BAD[4] := TRUE;                  (* the head does not descend onto a cup without foil *)
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

    (* --- Pocket 5: checkweigher --- *)
    CASE CHK_SUB OF
      0:
        IF TR_CUP[5] THEN CHK_SUB := 1; ELSE CHK_SUB := 9; END_IF;
      1:
        IF T_CHK.Q THEN
          IF IW_CHECK < 20 THEN
            TR_CUP[5] := FALSE;               (* the cup was lost on the way *)
          ELSE
            CHK_NET := IW_CHECK - TARE;
            IF ABS(CHK_NET - FILL_TARGET) > FILL_TOL THEN TR_BAD[5] := TRUE; END_IF;
          END_IF;
          CHK_SUB := 9;
        END_IF;
    END_CASE;

    (* --- Pocket 6: reject --- *)
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

  (* =================== 6. Stop motions on alarm =================== *)
  IF MODE = 3 OR MODE = 4 THEN
    Q_CONV := FALSE; Q_CUP_DROP := FALSE; Q_NOZ_DN := FALSE;
    Q_FILL_FAST := FALSE; Q_FILL_FINE := FALSE; Q_FOIL := FALSE;
    Q_SEAL_DN := FALSE; Q_REJECT := FALSE;
  END_IF;

  (* =================== 7. Tower light =================== *)
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

  (* =================== 8. Pack the outputs =================== *)
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

  (* waiting reason for OEE: 7 no product (cup at filling, tank at low level),
     8 no cup (magazine empty and the chain has emptied) *)
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
  (* counters wrap within 0..30000 (the monitoring layer takes differences according to this rule) *)
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


(* =====================================================================
   FB_Pallet - robotic palletizing, pallet line and stretch wrapping (block 4)

   Robot interface (the robot controller runs its own program):
     PLC -> robot : JOB, SLOT, SEQ. The job starts when SEQ changes; the same SEQ does not
                    run a second time. The job number is written as a block (single FC16).
     robot -> PLC : ACK_SEQ (job accepted), RES_SEQ + RES_CODE + RES_SLOT
                    (job finished). The result record is retained.
   The pack count on the pallet increases only after the robot says "done" (1) or "released,
   then cancelled" (17). The slot of a dropped pack stays empty,
   and the next pack is placed in the same slot. On a timeout the job is not blindly
   repeated: an alarm is raised.

   Job selection (again after every job): if the position is not verified, go home; if the gripper
   holds a pack, place it in the next slot; if the pallet has just arrived, the bottom sheet;
   if the pallet is full, the top sheet; otherwise pick the pack at the pickup point. While the pallet
   is changing, no pack is picked in advance: because the gripper also carries the sheet, it cannot
   place the bottom sheet with a pack in hand (deadlock).

   Safety (door, light curtain, muting, e-stop) is in the independent safety controller
   in the simulator; this block only reads its status. Reset does not start a movement:
   after an alarm the robot stays in HOLD and continues with Start.
   This is not a certified safety design.
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
    AGV_CLEAR   : BOOL;   (* AGV forks are outside the pickup point *)
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
    PICKUP_RDY   : BOOL;  (* to the AGV: pallet at D, D conveyor stopped *)
    RUNNING      : BOOL;
  END_VAR

  VAR
    SLOTS      : INT := 18;     (* 3 layers x 6 packs *)
    MIN_TURNS  : INT := 9;      (* stretch recipe: 3 bottom + 2 climb + 2 top + 2 descent *)
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
    MODE      : INT := 0;    (* 0 stopped, 1 running, 3 alarm, 4 e-stop *)
    A_STP     : INT := 0;    (* empty pallet feed *)
    B_STP     : INT := 0;    (* stacking position *)
    C_STP     : INT := 0;    (* stretch and exit *)
    R_STP     : INT := 0;    (* robot job *)
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

  (* =================== 1. Decode inputs =================== *)
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

  (* continue from the robot's numbering on the first valid data (if the PLC restarted, do not send the same SEQ again) *)
  IF IO_READY AND NOT SEQ_SYNC THEN
    SEQ := IW_ACK_SEQ;
    SEQ_SYNC := TRUE;
  END_IF;

  (* reset window: the safety controller and the robot report the effect of the reset with a 0.5 s delay *)
  IF RT_RESET.Q THEN RST_WIN := TRUE; END_IF;
  T_RSTWIN(IN := RST_WIN, PT := T#3s);
  IF T_RSTWIN.Q THEN RST_WIN := FALSE; END_IF;

  (* =================== 2. Alarms =================== *)
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
    HOLD_LATCH := TRUE;   (* the robot stays paused until Start *)
  END_IF;

  IF RST_WIN AND ESTOP_OK AND DI_SAFETY_OK AND NOT COMM_FAULT AND NOT DI_WRAP_FAULT AND NOT R_ERROR THEN
    ALARMS := ALARMS AND WORD#16#4000;
    RST_WIN := FALSE;
    IF MODE = 3 OR MODE = 4 THEN
      MODE := 0;
      (* take back the job that was not accepted: if the robot sees the same number it does nothing *)
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
  IF MODE = 1 AND NOT STOP_OK THEN MODE := 0; END_IF;   (* end of cycle: the robot finishes the job in hand *)

  (* READY means idle; accepted work is resumed without an impossible READY/home
     prerequisite. Idle loaded/off-home robots use the existing place/home branches. *)
  T_ROBSAFE(IN := IO_READY AND R_READY
    AND (IW_ROB_DI AND WORD#4) = WORD#0 AND (NOT DI_PAL_B OR DI_PIN_UP)
    AND IW_ACK_SEQ = IW_RES_SEQ AND BOOK_OK AND NOT BOOT_PENDING, PT := T#500ms);
  IF NOT ROB_BOOT_DONE THEN ROB_BOOT_OK := (BOOK_OK AND RECOVERING AND (NOT DI_PAL_B OR DI_PIN_UP)) OR T_ROBSAFE.Q; END_IF;
  IF NOT ROB_BOOT_OK THEN HOLD_LATCH := TRUE; END_IF;
  IF MODE = 1 AND ROB_BOOT_OK AND (ALARMS AND ALARM_MASK) = WORD#0 THEN HOLD_LATCH := FALSE; END_IF;

  (* =================== 3. Robot job =================== *)
  (* result evaluation runs in every mode; a new job is issued only while running *)
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
    10: (* new job number; JOB, SLOT and SEQ go out in the same write *)
      SEQ := SEQ + 1;
      IF SEQ > 30000 THEN SEQ := 1; END_IF;
      R_STP := 11;
    11: (* wait for acceptance *)
      IF IW_RES_SEQ = SEQ OR IW_ACK_SEQ = SEQ THEN R_STP := 12; END_IF;
    12: (* wait for result *)
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
        (* 13 = cancelled: the counter does not change, the job is selected again *)
      END_IF;
  END_CASE;

  (* =================== 4. Pallet line =================== *)
  IF MODE = 1 AND NOT RECOVERING THEN
    (* A: empty pallet feed; the next pallet is prepared even while the stacking position is filling *)
    CASE A_STP OF
      0:
        IF NOT DI_PAL_A AND NOT DI_DISP_BUSY AND IW_PALLETS > 0 AND B_STP <> 2 THEN A_STP := 1; END_IF;
      1:
        IF DI_PAL_A THEN A_STP := 0; END_IF;
    END_CASE;

    (* B: stacking position *)
    CASE B_STP OF
      0:
        IF DI_PAL_B THEN
          B_STP := 3;
        ELSIF DI_PAL_A AND A_STP = 0 THEN
          B_STP := 2;
        END_IF;
      2: (* A -> B, pin up *)
        IF DI_PAL_B THEN B_STP := 3; END_IF;
      3: (* new pallet: the ledger is reset *)
        PALLET_ID := PALLET_ID + 1;
        IF PALLET_ID > 30000 THEN PALLET_ID := 1; END_IF;
        COUNT := 0;
        SHEET_BOT := FALSE;
        SHEET_TOP := FALSE;
        B_STP := 10;
      10: (* stacking *)
        IF COUNT >= SLOTS AND SHEET_TOP THEN B_STP := 20; END_IF;
      20: (* pallet full: release when the robot is outside the zone, the stretch wrapper is empty and the turntable is at its start position *)
        IF R_CLEAR AND R_STP = 0 AND C_STP = 0 AND NOT DI_PAL_C AND DI_WRAP_HOME THEN B_STP := 21; END_IF;
      21: (* pin down, B -> C *)
        IF DI_PAL_C AND NOT DI_PAL_B THEN
          DONE_CNT := DONE_CNT + 1;
          IF DONE_CNT > 30000 THEN DONE_CNT := 0; END_IF;
          C_STP := 1;
          B_STP := 0;
        END_IF;
    END_CASE;

    (* C: stretch wrapping and exit to the pickup point *)
    CASE C_STP OF
      0:
        IF DI_PAL_C AND B_STP <> 21 THEN C_STP := 1; END_IF;
      1: (* the request is held until "done" arrives *)
        IF DI_WRAP_DONE THEN
          UNDERWRAP := IW_TURNS < MIN_TURNS;
          WRAPPED := WRAPPED + 1;
          IF WRAPPED > 30000 THEN WRAPPED := 0; END_IF;
          C_STP := 2;
        END_IF;
      2:
        IF NOT DI_WRAP_DONE AND DI_WRAP_HOME THEN C_STP := 3; END_IF;
      3: (* when the pickup point is empty and the AGV forks are outside *)
        IF NOT DI_PAL_D AND AGV_CLEAR THEN C_STP := 4; END_IF;
      4: (* C -> D; the light curtain muting while the pallet passes is in the safety controller *)
        IF DI_PAL_D AND NOT DI_PAL_C THEN C_STP := 0; END_IF;
    END_CASE;
  END_IF;

  (* =================== 5. Outputs =================== *)
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


(* =====================================================================
   FB_Shrink - grouping, shrink wrapping and shrink tunnel (block 3 of the factory)

   Grouping: place pad -> when the lane is full with 3 cups, close the infeed
   gate -> row pusher -> when there are two rows, the group pusher moves them to the wrapping machine.
   Wrapping: the request is held until "done" arrives (a short pulse can
   be lost with Modbus delay). Release permission: tunnel hot, outfeed empty, belt running.

   Tunnel: +/- 3 C thermostat. If the fan is not running or the over-temperature
   trip has tripped, the heater does not run. A lower setpoint is used during standby
   to save energy. On stop no new pack is accepted and the packs inside are discharged
   (controlled draining); if the outfeed is blocked and there are packs in the tunnel, the heater
   switches off immediately. When the tunnel is empty the fan cools until the temperature drops.

   Packs are counted with the simulator's infeed/outfeed counters (photoeye
   pulses can be missed at a 0.5 s delay).
   ===================================================================== *)

FUNCTION_BLOCK FB_Shrink
  VAR_INPUT
    RESTART : BOOL;
    START, STOP_OK, ESTOP_OK, RESET : BOOL;
    IO_READY   : BOOL;
    COMM_FAULT : BOOL;
    IW_DI      : WORD;
    IW_LANE    : INT;
    IW_TEMP    : INT;    (* 0.1 C *)
    IW_IN_CNT  : INT;
    IW_OUT_CNT : INT;
    IW_FILM    : INT;    (* 0.1 % *)
    IW_PADS    : INT;
    IW_PLATE   : WORD;
    IW_REJECT_CNT : INT;
  END_VAR
  VAR_OUTPUT
    QW_DO     : WORD;
    QW_STATE  : INT;
    QW_ALARM  : WORD;
    QW_STATUS : WORD;
    QW_PACKS  : INT;
    QW_INSIDE : INT;
    QW_SP     : INT;
    QW_REJECT : INT;
    QW_GOOD : INT;
    RUNNING   : BOOL;
  END_VAR

  VAR
    (* ---- Recipe (demo scale; for POF film) ---------------------------- *)
    SP_RUN       : INT := 1600;   (* 160 C *)
    SP_STANDBY   : INT := 1200;   (* 120 C, during long standby *)
    TEMP_BAND    : INT := 150;    (* ready: setpoint +/- 15 C *)
    HYST         : INT := 30;     (* termostat +/- 3 C *)
    COOL_OFF     : INT := 600;    (* fan stops below 60 C *)
    FILM_LOW     : INT := 100;    (* %10 *)
    ALARM_MASK   : WORD := WORD#16#63FF;
  END_VAR

  VAR
    DI_LANE_FULL, DI_ROWP_EXT, DI_ROWP_RET, DI_GRPP_EXT, DI_GRPP_RET, DI_PAD, DI_PAD_LOW,
    DI_WRAP_READY, DI_WRAP_BUSY, DI_WRAP_DONE, DI_WRAP_FAULT, DI_PACK_IN_WRAP,
    DI_FAN_RUN, DI_BELT_RUN, DI_OT_TRIP, DI_EXIT_FULL : BOOL;

    WAIT_START : BOOL := TRUE;
    MODE       : INT := 0;    (* 0 stopped, 1 running, 3 alarm, 4 e-stop *)
    G_STP      : INT := 0;    (* grouping step *)
    W_STP      : INT := 0;    (* wrapping step *)
    ROWS       : INT := 0;
    PACKS      : INT := 0;
    INSIDE     : INT := 0;
    OUT_LAST   : INT := 0;
    LANE_LAST  : INT := 0;
    SP         : INT := 1600;
    ALARMS_BEFORE : WORD;
    ALARMS     : WORD;
    WARNS      : WORD;
    STATUS     : WORD;
    TEMP_READY : BOOL;
    STANDBY    : BOOL;
    DRAINING   : BOOL;
    HEAT_BLOCK : BOOL;
    REL_OK     : BOOL;
    ROW_BLOCKED : BOOL;
    QUARANTINE : BOOL := FALSE;
    GROUP_OK : BOOL;
    Q_GATE, Q_ROW, Q_GRP, Q_PAD, Q_WRAP, Q_REL, Q_CONV, Q_HEAT, Q_FAN : BOOL;

    RT_START   : R_TRIG;
    RT_RESET   : R_TRIG;
    T_PAD      : TON;
    T_GATE     : TON;
    T_MOVE     : TON;
    T_WRAP     : TON;
    T_FANFB    : TON;
    T_HEATUP   : TON;
    T_BELTFB   : TON;
    T_STUCK    : TON;
    T_EXITBLK  : TON;
    T_IDLE     : TON;
  END_VAR

  ALARMS_BEFORE := ALARMS;
  IF RESTART THEN
    MODE := 0; WAIT_START := TRUE;
    G_STP := 0; W_STP := 0; Q_HEAT := FALSE; Q_FAN := FALSE; Q_CONV := FALSE;
    T_PAD(IN := FALSE, PT := T#1s);
    T_GATE(IN := FALSE, PT := T#1s);
    T_MOVE(IN := FALSE, PT := T#1s);
    T_WRAP(IN := FALSE, PT := T#1s);
    T_FANFB(IN := FALSE, PT := T#1s);
    T_HEATUP(IN := FALSE, PT := T#1s);
    T_BELTFB(IN := FALSE, PT := T#1s);
    T_STUCK(IN := FALSE, PT := T#1s);
    T_EXITBLK(IN := FALSE, PT := T#1s);
    T_IDLE(IN := FALSE, PT := T#1s);
  END_IF;

  (* =================== 1. Decode inputs =================== *)
  DI_LANE_FULL    := (IW_DI AND WORD#16#0001) <> WORD#0;
  DI_ROWP_EXT     := (IW_DI AND WORD#16#0002) <> WORD#0;
  DI_ROWP_RET     := (IW_DI AND WORD#16#0004) <> WORD#0;
  DI_GRPP_EXT     := (IW_DI AND WORD#16#0008) <> WORD#0;
  DI_GRPP_RET     := (IW_DI AND WORD#16#0010) <> WORD#0;
  DI_PAD          := (IW_DI AND WORD#16#0020) <> WORD#0;
  DI_PAD_LOW      := (IW_DI AND WORD#16#0040) <> WORD#0;
  DI_WRAP_READY   := (IW_DI AND WORD#16#0080) <> WORD#0;
  DI_WRAP_BUSY    := (IW_DI AND WORD#16#0100) <> WORD#0;
  DI_WRAP_DONE    := (IW_DI AND WORD#16#0200) <> WORD#0;
  DI_WRAP_FAULT   := (IW_DI AND WORD#16#0400) <> WORD#0;
  DI_PACK_IN_WRAP := (IW_DI AND WORD#16#0800) <> WORD#0;
  DI_FAN_RUN      := (IW_DI AND WORD#16#1000) <> WORD#0;
  DI_BELT_RUN     := (IW_DI AND WORD#16#2000) <> WORD#0;
  DI_OT_TRIP      := (IW_DI AND WORD#16#4000) <> WORD#0;
  DI_EXIT_FULL    := (IW_DI AND WORD#16#8000) <> WORD#0;
  ROWS := 0;
  IF (IW_PLATE AND WORD#1) <> WORD#0 THEN ROWS := ROWS + 1; END_IF;
  IF (IW_PLATE AND WORD#2) <> WORD#0 THEN ROWS := ROWS + 1; END_IF;

  RT_START(CLK := START);
  RT_RESET(CLK := RESET);

  (* packs in the tunnel: infeed counter - outfeed counter (including wrap-around at 30000) *)
  INSIDE := IW_IN_CNT - IW_OUT_CNT;
  IF INSIDE < 0 THEN INSIDE := INSIDE + 30000; END_IF;

  (* Sensor-reconstructed interrupted batch; never mix a fresh group into it.
     Complete a partial plate and reject the whole group conservatively. *)
  IF RESTART THEN QUARANTINE := INSIDE > 0 OR DI_PACK_IN_WRAP OR ROWS > 0; END_IF;
  IF QUARANTINE AND NOT WAIT_START AND INSIDE = 0 AND NOT DI_PACK_IN_WRAP
     AND ROWS = 0 AND W_STP = 0 AND G_STP = 0 THEN QUARANTINE := FALSE; END_IF;
  GROUP_OK := NOT QUARANTINE OR ROWS > 0 OR G_STP >= 11;

  ROW_BLOCKED := MODE = 1 AND G_STP = 12 AND ROWS >= 2 AND IW_LANE > 0;
  IF ROW_BLOCKED THEN ALARMS := ALARMS OR WORD#16#4000; END_IF;
  (* =================== 2. Alarms =================== *)
  IF NOT ESTOP_OK THEN ALARMS := ALARMS OR WORD#16#0001; END_IF;
  IF COMM_FAULT THEN ALARMS := ALARMS OR WORD#16#2000; END_IF;
  IF DI_OT_TRIP THEN ALARMS := ALARMS OR WORD#16#0040; END_IF;
  IF DI_WRAP_FAULT THEN ALARMS := ALARMS OR WORD#16#0008; END_IF;
  T_FANFB(IN := Q_FAN AND NOT DI_FAN_RUN, PT := T#2s);
  IF T_FANFB.Q THEN ALARMS := ALARMS OR WORD#16#0010; END_IF;
  T_HEATUP(IN := Q_HEAT AND (IW_TEMP < SP - 300) AND NOT RT_RESET.Q, PT := T#90s);
  IF T_HEATUP.Q THEN ALARMS := ALARMS OR WORD#16#0020; END_IF;
  T_BELTFB(IN := Q_CONV AND NOT DI_BELT_RUN, PT := T#2s);
  IF T_BELTFB.Q THEN ALARMS := ALARMS OR WORD#16#0080; END_IF;
  (* pack jammed in the tunnel: belt is running, outfeed is empty, but no pack has left the tunnel for 15 s *)
  T_STUCK(IN := INSIDE > 0 AND DI_BELT_RUN AND NOT DI_EXIT_FULL AND IW_OUT_CNT = OUT_LAST, PT := T#15s);
  OUT_LAST := IW_OUT_CNT;
  IF T_STUCK.Q THEN ALARMS := ALARMS OR WORD#16#0100; END_IF;

  IF NOT IO_READY THEN ALARMS := ALARMS_BEFORE; END_IF;

  IF (ALARMS AND ALARM_MASK) <> WORD#0 THEN
    IF (ALARMS AND WORD#16#0001) <> WORD#0 THEN MODE := 4; ELSIF MODE <> 4 THEN MODE := 3; END_IF;
  END_IF;

  IF RT_RESET.Q AND ESTOP_OK AND NOT COMM_FAULT AND NOT DI_OT_TRIP AND NOT DI_WRAP_FAULT THEN
    ALARMS := WORD#0;
    IF MODE = 3 OR MODE = 4 THEN
      MODE := 0;
      (* restart the unfinished movements; the row count is kept *)
      IF G_STP = 1 THEN G_STP := 0; END_IF;
      IF G_STP >= 11 AND G_STP <= 13 THEN G_STP := 10; END_IF;
      IF G_STP >= 21 AND G_STP <= 22 THEN G_STP := 20; END_IF;
      IF W_STP = 1 THEN W_STP := 0; END_IF;
    END_IF;
  END_IF;

  IF MODE = 0 AND RT_START.Q AND IO_READY AND NOT RESTART AND STOP_OK THEN MODE := 1; END_IF;
  IF MODE = 1 THEN WAIT_START := FALSE; END_IF;
  IF MODE = 1 AND NOT STOP_OK THEN MODE := 0; END_IF;

  (* =================== 3. Shrink tunnel =================== *)
  (* if no new cup arrives for 2 minutes, energy saving; return to the normal setpoint when a new cup arrives *)
  T_IDLE(IN := MODE = 1 AND G_STP = 10 AND IW_LANE = LANE_LAST AND INSIDE = 0 AND W_STP = 0, PT := T#120s);
  LANE_LAST := IW_LANE;
  STANDBY := T_IDLE.Q;
  IF STANDBY THEN SP := SP_STANDBY; ELSE SP := SP_RUN; END_IF;
  TEMP_READY := (IW_TEMP >= SP_RUN - TEMP_BAND) AND (IW_TEMP <= SP_RUN + TEMP_BAND);

  (* outfeed blocked and packs in the tunnel: heater switches off immediately, packs are suspect *)
  T_EXITBLK(IN := DI_EXIT_FULL AND INSIDE > 0, PT := T#3s);
  IF T_EXITBLK.Q THEN HEAT_BLOCK := TRUE; END_IF;
  IF NOT DI_EXIT_FULL THEN HEAT_BLOCK := FALSE; END_IF;

  DRAINING := NOT WAIT_START AND MODE <> 1 AND MODE <> 4 AND INSIDE > 0 AND (ALARMS AND WORD#16#0180) = WORD#0;

  IF NOT ESTOP_OK OR NOT DI_FAN_RUN OR DI_OT_TRIP OR HEAT_BLOCK
     OR NOT (MODE = 1 OR DRAINING) OR (ALARMS AND WORD#16#00F0) <> WORD#0 THEN
    Q_HEAT := FALSE;
  ELSIF IW_TEMP < SP - HYST THEN
    Q_HEAT := TRUE;
  ELSIF IW_TEMP > SP + HYST THEN
    Q_HEAT := FALSE;
  END_IF;
  (* fan: does not stop while running, draining, or before the tunnel has cooled *)
  Q_FAN := NOT WAIT_START AND ESTOP_OK AND (MODE = 1 OR DRAINING OR IW_TEMP > COOL_OFF);
  Q_CONV := ESTOP_OK AND (MODE = 1 OR DRAINING) AND (ALARMS AND WORD#16#0080) = WORD#0;

  (* =================== 4. Grouping =================== *)
  T_PAD(IN := G_STP = 1, PT := T#3s);
  T_GATE(IN := G_STP = 11, PT := T#600ms);
  T_MOVE(IN := MODE = 1 AND NOT ROW_BLOCKED AND (G_STP = 12 OR G_STP = 13 OR G_STP = 21 OR G_STP = 22), PT := T#3s);

  IF MODE = 1 AND GROUP_OK THEN
    CASE G_STP OF
      0:  (* pad *)
        IF DI_ROWP_RET AND DI_GRPP_RET THEN
          IF ROWS >= 2 THEN G_STP := 20;
          ELSIF DI_PAD THEN G_STP := 10;
          ELSIF IW_PADS > 0 THEN G_STP := 1;
          END_IF;
        END_IF;
      1:
        IF DI_PAD THEN G_STP := 10; ELSIF T_PAD.Q THEN ALARMS := ALARMS OR WORD#16#0200; END_IF;
      10: (* let the lane fill *)
        IF ROWS >= 2 THEN G_STP := 20;
        ELSIF DI_LANE_FULL AND DI_ROWP_RET AND DI_GRPP_RET THEN G_STP := 11; END_IF;
      11: (* close the infeed gate, wait for the stroke *)
        IF T_GATE.Q THEN G_STP := 12; END_IF;
      12: (* row pusher forward *)
        IF DI_ROWP_EXT OR (ROWS >= 2 AND IW_LANE = 0) THEN G_STP := 13;
        ELSIF T_MOVE.Q THEN ALARMS := ALARMS OR WORD#16#0002; END_IF;
      13: (* back; a row is counted only when the pusher is back *)
        IF DI_ROWP_RET THEN
          IF ROWS >= 2 THEN G_STP := 20; ELSE G_STP := 10; END_IF;
        ELSIF T_MOVE.Q THEN
          ALARMS := ALARMS OR WORD#16#0002;
        END_IF;
      20: (* push the group when the wrapping machine is empty and ready *)
        IF ROWS = 0 THEN G_STP := 0;
        ELSIF ROWS >= 2 AND DI_WRAP_READY AND DI_ROWP_RET AND DI_GRPP_RET THEN G_STP := 21; END_IF;
      21:
        IF DI_GRPP_EXT THEN G_STP := 22; ELSIF T_MOVE.Q THEN ALARMS := ALARMS OR WORD#16#0004; END_IF;
      22:
        IF DI_GRPP_RET THEN G_STP := 0; ELSIF T_MOVE.Q THEN ALARMS := ALARMS OR WORD#16#0004; END_IF;
    END_CASE;
  END_IF;

  (* =================== 5. Wrapping and release =================== *)
  T_WRAP(IN := W_STP = 1, PT := T#6s);
  REL_OK := MODE = 1 AND TEMP_READY AND NOT STANDBY AND NOT DI_EXIT_FULL AND DI_BELT_RUN AND NOT HEAT_BLOCK;
  IF MODE = 1 THEN
    CASE W_STP OF
      0:
        IF DI_PACK_IN_WRAP THEN
          IF DI_WRAP_DONE THEN W_STP := 2; ELSE W_STP := 1; END_IF;
        END_IF;
      1:
        IF DI_WRAP_DONE THEN
          W_STP := 2;
        ELSIF T_WRAP.Q THEN
          ALARMS := ALARMS OR WORD#16#0008;
        END_IF;
      2:
        IF NOT DI_PACK_IN_WRAP THEN
          PACKS := PACKS + 1; IF PACKS > 30000 THEN PACKS := 0; END_IF;
          W_STP := 0;
        END_IF;
    END_CASE;
  END_IF;

  (* =================== 6. Outputs =================== *)
  Q_PAD  := MODE = 1 AND G_STP = 1;
  Q_GATE := G_STP >= 11 AND G_STP <= 13 AND MODE <> 4;
  Q_ROW  := MODE = 1 AND G_STP = 12 AND ROWS < 2;
  Q_GRP  := MODE = 1 AND G_STP = 21;
  Q_WRAP := MODE = 1 AND W_STP = 1;
  Q_REL  := W_STP = 2 AND REL_OK;

  QW_DO := WORD#0;
  IF Q_GATE THEN QW_DO := QW_DO OR WORD#16#0001; END_IF;
  IF Q_ROW  THEN QW_DO := QW_DO OR WORD#16#0002; END_IF;
  IF Q_GRP  THEN QW_DO := QW_DO OR WORD#16#0004; END_IF;
  IF Q_PAD  THEN QW_DO := QW_DO OR WORD#16#0008; END_IF;
  IF Q_WRAP THEN QW_DO := QW_DO OR WORD#16#0010; END_IF;
  IF Q_REL  THEN QW_DO := QW_DO OR WORD#16#0020; END_IF;
  IF Q_CONV THEN QW_DO := QW_DO OR WORD#16#0040; END_IF;
  IF Q_HEAT THEN QW_DO := QW_DO OR WORD#16#0080; END_IF;
  IF Q_FAN  THEN QW_DO := QW_DO OR WORD#16#0100; END_IF;
  IF Q_CONV AND NOT QUARANTINE THEN QW_DO := QW_DO OR WORD#16#0200; END_IF;
  IF Q_CONV AND QUARANTINE THEN QW_DO := QW_DO OR WORD#16#0400; END_IF;

  WARNS := WORD#0;
  IF HEAT_BLOCK THEN WARNS := WARNS OR WORD#16#0400; END_IF;
  IF IW_FILM < FILM_LOW THEN WARNS := WARNS OR WORD#16#0800; END_IF;
  IF DI_PAD_LOW THEN WARNS := WARNS OR WORD#16#1000; END_IF;
  QW_ALARM := ALARMS OR WARNS;

  (* state code and PackML-like status bits *)
  IF MODE = 4 THEN
    QW_STATE := 9;
  ELSIF MODE = 3 THEN
    IF DRAINING THEN QW_STATE := 5; ELSE QW_STATE := 8; END_IF;
  ELSIF MODE = 0 THEN
    IF DRAINING THEN
      QW_STATE := 5;
    ELSIF Q_FAN AND IW_TEMP > COOL_OFF THEN
      QW_STATE := 6;
    ELSE
      QW_STATE := 0;
    END_IF;
  ELSIF STANDBY THEN
    QW_STATE := 7;
  ELSIF NOT TEMP_READY THEN
    QW_STATE := 1;
  ELSIF W_STP = 2 AND NOT REL_OK AND DI_EXIT_FULL THEN
    QW_STATE := 4;
  ELSIF G_STP = 10 AND NOT DI_LANE_FULL THEN
    QW_STATE := 3;
  ELSE
    QW_STATE := 2;
  END_IF;

  STATUS := WORD#0;
  IF MODE = 1 AND G_STP = 10 THEN STATUS := STATUS OR WORD#16#0001; END_IF;
  IF MODE = 1 THEN STATUS := STATUS OR WORD#16#0002; END_IF;
  IF Q_HEAT AND NOT TEMP_READY THEN STATUS := STATUS OR WORD#16#0004; END_IF;
  IF DRAINING THEN STATUS := STATUS OR WORD#16#0008; END_IF;
  IF MODE = 3 OR MODE = 4 THEN STATUS := STATUS OR WORD#16#0010; END_IF;
  IF QW_STATE = 4 THEN STATUS := STATUS OR WORD#16#0020; END_IF;
  IF QW_STATE = 3 THEN STATUS := STATUS OR WORD#16#0040; END_IF;
  IF WAIT_START THEN STATUS := STATUS OR WORD#16#0080; END_IF;
  IF QUARANTINE THEN STATUS := STATUS OR WORD#16#0100; END_IF;
  QW_STATUS := STATUS;

  QW_PACKS  := PACKS;
  QW_INSIDE := INSIDE;
  QW_SP     := SP;
  QW_REJECT := IW_REJECT_CNT;
  QW_GOOD := IW_OUT_CNT - IW_REJECT_CNT;
  IF QW_GOOD < 0 THEN QW_GOOD := QW_GOOD + 30000; END_IF;
  RUNNING   := MODE = 1;
  IF WAIT_START OR NOT IO_READY THEN
    QW_DO := WORD#0;
    Q_HEAT := FALSE; Q_FAN := FALSE; Q_CONV := FALSE;
  END_IF;
END_FUNCTION_BLOCK


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


PROGRAM Lojistik
  VAR
    (* --- blok 0: Fabrika --- *)
    FAB_IW_DI        AT %IW100 : WORD;  (* Fabrika paneli girisleri (bit paketli) *)
    FAB_IW_MAPVER    AT %IW101 : INT;  (* Sinyal haritasi surumu *)
    FAB_IW_SIM_HB    AT %IW102 : INT;  (* Simulator kalp atisi (100 ms) *)
    (* --- blok 1: Dolum-kapama --- *)
    DOL_IW_DI        AT %IW116 : WORD;  (* Dijital girisler (bit paketli) *)
    DOL_IW_FILL      AT %IW117 : INT;  (* Dolum terazisi (net) *)
    DOL_IW_TANK      AT %IW118 : INT;  (* Dolum tanki seviyesi *)
    DOL_IW_TEMP      AT %IW119 : INT;  (* Kapama kafasi sicakligi *)
    DOL_IW_CHECK     AT %IW120 : INT;  (* Kontrol tartisi (brut) *)
    (* --- blok 2: Tank ve transfer --- *)
    TNK_IW_DI        AT %IW132 : WORD;  (* Dijital girisler (bit paketli) *)
    TNK_IW_T1_LVL    AT %IW133 : INT;  (* Uretim tanki T1 seviyesi *)
    TNK_IW_FLOW      AT %IW134 : INT;  (* Debimetre FT1 *)
    TNK_IW_TOTAL     AT %IW135 : INT;  (* Debimetre toplayici (30000'de sifirlanir) *)
    TNK_IW_COND      AT %IW136 : INT;  (* Hat iletkenligi QT1 (25 ?C'ye duzeltilmis) *)
    TNK_IW_RET_T     AT %IW137 : INT;  (* Hat donus sicakligi TT1 *)
    TNK_IW_CIP_T     AT %IW138 : INT;  (* Kostik tanki sicakligi TT2 *)
    TNK_IW_CIP_LVL   AT %IW139 : INT;  (* Kostik tanki seviyesi *)
    (* --- blok 3: Shrink ve firin --- *)
    SHR_IW_DI        AT %IW148 : WORD;  (* Dijital girisler (bit paketli) *)
    SHR_IW_LANE      AT %IW149 : INT;  (* Seritteki bardak sayisi (bilesik sensor) *)
    SHR_IW_TEMP      AT %IW150 : INT;  (* Firin hava sicakligi *)
    SHR_IW_IN_CNT    AT %IW151 : INT;  (* Firin girisi paket sayaci (30000'de sifirlanir) *)
    SHR_IW_OUT_CNT   AT %IW152 : INT;  (* Firin cikisi paket sayaci *)
    SHR_IW_FILM      AT %IW153 : INT;  (* Film bobini kalan *)
    SHR_IW_PADS      AT %IW154 : INT;  (* Altlik magazini adedi *)
    SHR_IW_EXIT_CNT  AT %IW155 : INT;  (* Cikistan alinan paket sayaci *)
    SHR_IW_PLATE     AT %IW156 : WORD;  (* Plaka fotoselleri (bit 0: sira 1, bit 1: sira 2) *)
    SHR_IW_DIVERT    AT %IW157 : WORD;  (* Cikis ayirici: bit 0 paket var, 1 red konumu, 2 gecis konumu *)
    SHR_IW_REJECT_CNT AT %IW158 : INT;  (* Karantina kasasina ayrilan paket sayaci (30000 modul) *)
    (* --- blok 4: Paletleme --- *)
    PAL_IW_DI        AT %IW164 : WORD;  (* Hat ve guvenlik girisleri (bit paketli) *)
    PAL_IW_ROB_DI    AT %IW165 : WORD;  (* Robot kontrolcusu durum bitleri *)
    PAL_IW_ACK_SEQ   AT %IW166 : INT;  (* Robot: kabul edilen son is numarasi *)
    PAL_IW_RES_SEQ   AT %IW167 : INT;  (* Robot: biten son is numarasi *)
    PAL_IW_RES_CODE  AT %IW168 : INT;  (* Robot: son is sonucu (1 tamam, 10+ hata) *)
    PAL_IW_RES_SLOT  AT %IW169 : INT;  (* Robot: son isin slotu *)
    PAL_IW_TURNS     AT %IW170 : INT;  (* Strec sarma: bu cevrimdeki tur *)
    PAL_IW_PALLETS   AT %IW171 : INT;  (* Bos palet magazini adedi *)
    PAL_IW_SHEETS    AT %IW172 : INT;  (* Karton levha magazini adedi *)
    PAL_IW_PICKUP_CNT AT %IW173 : INT;  (* Alim noktasindan alinan palet sayaci *)
    PAL_IW_IL        AT %IW174 : WORD;  (* Istasyon el sikisma girisleri (AGV optik I/O) *)
    PAL_IW_RES_JOB   AT %IW175 : INT;  (* Robot: biten son isin tipi *)
    (* --- blok 5: AGV transpalet --- *)
    AGV_IW_DI        AT %IW180 : WORD;  (* AGV durum bitleri *)
    AGV_IW_ACK_SEQ   AT %IW181 : INT;  (* AGV: kabul edilen son is *)
    AGV_IW_RES_SEQ   AT %IW182 : INT;  (* AGV: biten son is *)
    AGV_IW_RES_CODE  AT %IW183 : INT;  (* AGV: son is sonucu *)
    AGV_IW_BATTERY   AT %IW184 : INT;  (* Batarya *)
    AGV_IW_NODE      AT %IW185 : INT;  (* Bulundugu / gittigi dugum *)
    AGV_IW_LOAD_ID   AT %IW186 : INT;  (* Cataldaki paletin numarasi *)
    AGV_IW_DELIVERED AT %IW187 : INT;  (* Teslim edilen palet sayaci *)
    AGV_IW_IL        AT %IW188 : WORD;  (* Istasyon el sikisma girisleri (paletleme hucresinden kablo) *)
    AGV_QW_DO        AT %QW100 : WORD;  (* AGV ve istasyon izinleri (bit paketli) *)
    AGV_QW_ORDER     AT %QW101 : INT;  (* AGV isi (1 tasi D?depo, 2 yuku depoya birak, 3 sarj, 4 park) *)
    AGV_QW_SEQ       AT %QW102 : INT;  (* AGV is numarasi *)
    AGV_QW_STATE     AT %QW103 : INT;  (* AGV durumu *)
    AGV_QW_ALARM     AT %QW104 : WORD;  (* Alarm kelimesi *)
    AGV_QW_STATUS    AT %QW105 : WORD;  (* Durum bitleri *)
    AGV_QW_MOVES     AT %QW106 : INT;  (* Tamamlanan tasima sayaci *)
    AGV_QW_PLC_HB    AT %QW115 : INT;  (* Lojistik PLC kalp atisi (her tarama) *)
    (* --- blok 6: Otomatik depo --- *)
    ASRS_IW_DI       AT %IW196 : WORD;  (* Vinc, konveyor ve guvenlik bitleri *)
    ASRS_IW_ACK_SEQ  AT %IW197 : INT;  (* Vinc: kabul edilen son is *)
    ASRS_IW_RES_SEQ  AT %IW198 : INT;  (* Vinc: biten son is *)
    ASRS_IW_RES_CODE AT %IW199 : INT;  (* Vinc: son is sonucu *)
    ASRS_IW_RES_LOC  AT %IW200 : INT;  (* Vinc: son isin gozu *)
    ASRS_IW_RES_ID   AT %IW201 : INT;  (* Vinc: son iste okunan palet numarasi (0 bos) *)
    ASRS_IW_IN_ID    AT %IW202 : INT;  (* Giris okuyucusu: palet numarasi (0 okunamadi) *)
    ASRS_IW_FORK_ID  AT %IW203 : INT;  (* Vinc catalindaki palet numarasi *)
    ASRS_IW_TEMP     AT %IW204 : INT;  (* Depo sicakligi *)
    ASRS_IW_SHIP_REQ AT %IW205 : INT;  (* Sevkiyat siparisi sayaci (palet) *)
    ASRS_IW_SHIPPED  AT %IW206 : INT;  (* Kamyona yuklenen palet sayaci *)
    ASRS_QW_DO       AT %QW116 : WORD;  (* Dijital cikislar (bit paketli) *)
    ASRS_QW_JOB      AT %QW117 : INT;  (* Vinc isi (1 depola, 2 cikar, 3 eve don, 4 goz kontrolu) *)
    ASRS_QW_LOC      AT %QW118 : INT;  (* Goz numarasi (1..36) *)
    ASRS_QW_SEQ      AT %QW119 : INT;  (* Vinc is numarasi *)
    ASRS_QW_STATE    AT %QW120 : INT;  (* Depo durumu *)
    ASRS_QW_ALARM    AT %QW121 : WORD;  (* Alarm kelimesi *)
    ASRS_QW_STATUS   AT %QW122 : WORD;  (* Durum bitleri *)
    ASRS_QW_OCC_A    AT %QW123 : WORD;  (* PLC envanteri: dolu gozler 1-16 (bit) *)
    ASRS_QW_OCC_B    AT %QW124 : WORD;  (* PLC envanteri: dolu gozler 17-32 (bit) *)
    ASRS_QW_OCC_C    AT %QW125 : WORD;  (* PLC envanteri: dolu gozler 33-36 (bit) *)
    ASRS_QW_STOCK    AT %QW126 : INT;  (* Stoktaki palet *)
    ASRS_QW_UNKNOWN  AT %QW127 : INT;  (* Durumu belirsiz goz (kontrol bekliyor) *)
    ASRS_QW_STORED   AT %QW128 : INT;  (* Depolanan palet sayaci *)
    ASRS_QW_PICKED   AT %QW129 : INT;  (* Sevkiyata cikarilan palet sayaci *)
    ASRS_QW_NEXT_ID  AT %QW130 : INT;  (* Siradaki sevk paleti (FIFO, 0 yok) *)
  END_VAR

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
    AGV         : FB_Agv;
    ASRS        : FB_Asrs;
  END_VAR

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
  IF FAB_IW_SIM_HB <> 0 AND FAB_IW_MAPVER = 7 THEN IO_READY := TRUE; END_IF;

  RESTART := FIRST_SCAN AND IO_READY;
  IF RESTART THEN FIRST_SCAN := FALSE; END_IF;

  (* PLC heartbeat: the simulator watches it and switches off this PLC's outputs if the program stops *)
  PLC_HB := PLC_HB + 1;
  IF PLC_HB > 30000 THEN PLC_HB := 0; END_IF;

  (* =================== Automated cold store =================== *)
  (* the inbound conveyor runs only while the AGV forks are outside *)
  ASRS(START := PB_START, STOP_OK := PB_STOP_OK, ESTOP_OK := PB_ESTOP_OK, RESET := PB_RESET,
       RESTART := RESTART, IO_READY := IO_READY, COMM_FAULT := COMM_FAULT,
       IW_DI := ASRS_IW_DI, IW_ACK_SEQ := ASRS_IW_ACK_SEQ, IW_RES_SEQ := ASRS_IW_RES_SEQ,
       IW_RES_CODE := ASRS_IW_RES_CODE, IW_RES_LOC := ASRS_IW_RES_LOC, IW_RES_ID := ASRS_IW_RES_ID,
       IW_IN_ID := ASRS_IW_IN_ID, IW_FORK_ID := ASRS_IW_FORK_ID, IW_TEMP := ASRS_IW_TEMP,
       IW_SHIP_REQ := ASRS_IW_SHIP_REQ, AGV_CLEAR_IN := (AGV_IW_DI AND WORD#16#0080) <> WORD#0);
  ASRS_QW_DO      := ASRS.QW_DO;
  ASRS_QW_JOB     := ASRS.QW_JOB;
  ASRS_QW_LOC     := ASRS.QW_LOC;
  ASRS_QW_SEQ     := ASRS.QW_SEQ;
  ASRS_QW_STATE   := ASRS.QW_STATE;
  ASRS_QW_ALARM   := ASRS.QW_ALARM;
  ASRS_QW_STATUS  := ASRS.QW_STATUS;
  ASRS_QW_OCC_A   := ASRS.QW_OCC_A;
  ASRS_QW_OCC_B   := ASRS.QW_OCC_B;
  ASRS_QW_OCC_C   := ASRS.QW_OCC_C;
  ASRS_QW_STOCK   := ASRS.QW_STOCK;
  ASRS_QW_UNKNOWN := ASRS.QW_UNKNOWN;
  ASRS_QW_STORED  := ASRS.QW_STORED;
  ASRS_QW_PICKED  := ASRS.QW_PICKED;
  ASRS_QW_NEXT_ID := ASRS.QW_NEXT_ID;

  (* =================== AGV =================== *)
  (* moves pallets according to the palletizing cell and cold store permissions. "Pallet ready at the
     pickup point": in a single PLC, PALLET.PICKUP_RDY directly; in split mode, the wire from the
     packaging PLC's PAL_QW_DO bit 11 output (AGV_IW_IL bit 0). *)
  AGV(START := PB_START, STOP_OK := PB_STOP_OK, ESTOP_OK := PB_ESTOP_OK, RESET := PB_RESET,
      RESTART := RESTART, IO_READY := IO_READY, COMM_FAULT := COMM_FAULT,
      IW_DI := AGV_IW_DI, IW_ACK_SEQ := AGV_IW_ACK_SEQ, IW_RES_SEQ := AGV_IW_RES_SEQ,
      IW_RES_CODE := AGV_IW_RES_CODE, IW_BATTERY := AGV_IW_BATTERY,
      D_READY := (AGV_IW_IL AND WORD#16#0001) <> WORD#0, IN_READY := ASRS.IN_READY);
  AGV_QW_DO     := AGV.QW_DO;
  AGV_QW_ORDER  := AGV.QW_ORDER;
  AGV_QW_SEQ    := AGV.QW_SEQ;
  AGV_QW_STATE  := AGV.QW_STATE;
  AGV_QW_ALARM  := AGV.QW_ALARM;
  AGV_QW_STATUS := AGV.QW_STATUS;
  AGV_QW_MOVES  := AGV.QW_MOVES;

  AGV_QW_PLC_HB := PLC_HB;
END_PROGRAM


CONFIGURATION Config0
  RESOURCE Res0 ON PLC
    TASK task0(INTERVAL := T#20ms, PRIORITY := 0);
    PROGRAM instance0 WITH task0 : Lojistik;
  END_RESOURCE
END_CONFIGURATION
