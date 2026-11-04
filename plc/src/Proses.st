(* =====================================================================
   Proses PLC'si: dolum-kapama (blok 1) ve tank, transfer, CIP (blok 2).
   Blok 0'in (fabrika ozeti) sahibi de bu PLC'dir.
   ===================================================================== *)
VAR
  DOLUM       : FB_Dolum;
  TANK        : FB_Tank;
END_VAR
(*@BODY@*)
  (* =================== Dolum-kapama =================== *)
  DOLUM(START := PB_START, STOP_OK := PB_STOP_OK, ESTOP_OK := PB_ESTOP_OK, RESET := PB_RESET,
        RESTART := RESTART, IO_READY := IO_READY, COMM_FAULT := COMM_FAULT,
        IW_DI := DOL_IW_DI, IW_FILL := DOL_IW_FILL, IW_TANK := DOL_IW_TANK,
        IW_TEMP := DOL_IW_TEMP, IW_CHECK := DOL_IW_CHECK);
  DOL_QW_DO     := DOLUM.QW_DO;
  DOL_QW_STATE  := DOLUM.QW_STATE;
  DOL_QW_ALARM  := DOLUM.QW_ALARM;
  DOL_QW_GOOD   := DOLUM.QW_GOOD;
  DOL_QW_REJECT := DOLUM.QW_REJECT;
  DOL_QW_STATUS := DOLUM.QW_STATUS;

  (* el sikisma: dolum makinesi urun ister, tank istasyonu aktarir (ayni PLC) *)
  TANK(START := PB_START, TNK_COMMISSION := TNK_COMMISSION, ESTOP_OK := PB_ESTOP_OK, RESET := PB_RESET, RESTART := RESTART, IO_READY := IO_READY, COMM_FAULT := COMM_FAULT,
       REQ := DOLUM.PRODUCT_REQ,
       IW_DI := TNK_IW_DI, IW_T1_LVL := TNK_IW_T1_LVL, IW_FLOW := TNK_IW_FLOW, IW_TOTAL := TNK_IW_TOTAL,
       IW_COND := TNK_IW_COND, IW_RET_T := TNK_IW_RET_T, IW_CIP_T := TNK_IW_CIP_T, IW_CIP_LVL := TNK_IW_CIP_LVL);
  TNK_QW_DO       := TANK.QW_DO;
  TNK_QW_STATE    := TANK.QW_STATE;
  TNK_QW_ALARM    := TANK.QW_ALARM;
  TNK_QW_STEP_T   := TANK.QW_STEP_T;
  TNK_QW_SINCE    := TANK.QW_SINCE;
  TNK_QW_BATCH    := TANK.QW_BATCH;
  TNK_QW_CIP_RES  := TANK.QW_CIP_RES;
  TNK_QW_CIP_MINT := TANK.QW_CIP_MINT;
  TNK_QW_CIP_MINF := TANK.QW_CIP_MINF;
  TNK_QW_CIP_COND := TANK.QW_CIP_COND;
  TNK_QW_CIP_DUR  := TANK.QW_CIP_DUR;
  TNK_QW_STATUS := TANK.QW_STATUS;
(*@END@*)
  (* =================== Fabrika ozeti (blok 0) =================== *)
  FAB_QW_PLC_HB := PLC_HB;
  IF DOLUM.RUNNING THEN FAB_QW_DO := WORD#16#0001; ELSE FAB_QW_DO := WORD#0; END_IF;
  FAB_QW_STATE := DOLUM.QW_STATE;
  FAB_QW_ALARM := (*@FAB_ALARM@*);
