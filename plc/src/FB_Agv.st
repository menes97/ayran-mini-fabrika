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
