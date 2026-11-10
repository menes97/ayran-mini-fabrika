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
