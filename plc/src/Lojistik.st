(* =====================================================================
   Logistics PLC: AGV main control (block 5) and automated cold store (block 6).
   ===================================================================== *)
VAR
  AGV         : FB_Agv;
  ASRS        : FB_Asrs;
END_VAR
(*@BODY@*)
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
      D_READY := (*@D_READY@*), IN_READY := ASRS.IN_READY);
  AGV_QW_DO     := AGV.QW_DO;
  AGV_QW_ORDER  := AGV.QW_ORDER;
  AGV_QW_SEQ    := AGV.QW_SEQ;
  AGV_QW_STATE  := AGV.QW_STATE;
  AGV_QW_ALARM  := AGV.QW_ALARM;
  AGV_QW_STATUS := AGV.QW_STATUS;
  AGV_QW_MOVES  := AGV.QW_MOVES;
(*@END@*)
  AGV_QW_PLC_HB := PLC_HB;
