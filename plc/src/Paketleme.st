(* =====================================================================
   Paketleme PLC'si: gruplama, sarma, firin (blok 3) ve robotlu paletleme (blok 4).
   ===================================================================== *)
VAR
  SHRINK      : FB_Shrink;
  PALLET      : FB_Pallet;
END_VAR
(*@BODY@*)
  (* =================== Gruplama, sarma, firin =================== *)
  (* sozlesme: cikis bandi dolunca dolum zaten bekler, bu istasyon da kendi cikisi dolunca
     firina paket birakmaz *)
  SHRINK(START := PB_START, STOP_OK := PB_STOP_OK, ESTOP_OK := PB_ESTOP_OK, RESET := PB_RESET,
         RESTART := RESTART, IO_READY := IO_READY, COMM_FAULT := COMM_FAULT,
         IW_DI := SHR_IW_DI, IW_LANE := SHR_IW_LANE, IW_TEMP := SHR_IW_TEMP,
         IW_IN_CNT := SHR_IW_IN_CNT, IW_OUT_CNT := SHR_IW_OUT_CNT, IW_FILM := SHR_IW_FILM, IW_PADS := SHR_IW_PADS,
         IW_PLATE := SHR_IW_PLATE, IW_REJECT_CNT := SHR_IW_REJECT_CNT);
  SHR_QW_DO     := SHRINK.QW_DO;
  SHR_QW_STATE  := SHRINK.QW_STATE;
  SHR_QW_ALARM  := SHRINK.QW_ALARM;
  SHR_QW_STATUS := SHRINK.QW_STATUS;
  SHR_QW_PACKS  := SHRINK.QW_PACKS;
  SHR_QW_INSIDE := SHRINK.QW_INSIDE;
  SHR_QW_SP     := SHRINK.QW_SP;
  SHR_QW_REJECT := SHRINK.QW_REJECT;
  SHR_QW_GOOD := SHRINK.QW_GOOD;

  (* =================== Robotlu paletleme =================== *)
  (* sozlesme: robot alma noktasindaki paketi almazsa firin cikisi dolar ve shrink firina yeni
     paket birakmaz. AGV'nin "catallar alim noktasinin disinda" sinyali aracin istasyona verdigi
     optik sinyaldir: istasyonun kendi girisi (PAL_IW_IL bit 0), lojistik PLC'sinden gecmez. *)
  PALLET(START := PB_START, STOP_OK := PB_STOP_OK, ESTOP_OK := PB_ESTOP_OK, RESET := PB_RESET,
         RESTART := RESTART, IO_READY := IO_READY, COMM_FAULT := COMM_FAULT,
         IW_DI := PAL_IW_DI, IW_ROB_DI := PAL_IW_ROB_DI, IW_ACK_SEQ := PAL_IW_ACK_SEQ, IW_RES_SEQ := PAL_IW_RES_SEQ,
         IW_RES_JOB := PAL_IW_RES_JOB, IW_RES_CODE := PAL_IW_RES_CODE, IW_RES_SLOT := PAL_IW_RES_SLOT, IW_TURNS := PAL_IW_TURNS,
         IW_PALLETS := PAL_IW_PALLETS, IW_SHEETS := PAL_IW_SHEETS,
         AGV_CLEAR := (PAL_IW_IL AND WORD#16#0001) <> WORD#0,
         RET_MAGIC := RET_MAGIC, RET_MAPVER := RET_MAPVER, PAL_COUNT := PAL_COUNT, PAL_ID := PAL_ID,
         PAL_DONE := PAL_DONE, PAL_WRAPPED := PAL_WRAPPED, PAL_SHEETS := PAL_SHEETS,
         PAL_LAST_SEQ := PAL_LAST_SEQ, PAL_ACTIVE := PAL_ACTIVE, PAL_C_PHASE := PAL_C_PHASE,
         PAL_UNDERWRAP := PAL_UNDERWRAP, RET_CHECK := RET_CHECK);
  PAL_QW_DO        := PALLET.QW_DO;
  PAL_QW_JOB       := PALLET.QW_JOB;
  PAL_QW_SLOT      := PALLET.QW_SLOT;
  PAL_QW_SEQ       := PALLET.QW_SEQ;
  PAL_QW_STATE     := PALLET.QW_STATE;
  PAL_QW_ALARM     := PALLET.QW_ALARM;
  PAL_QW_STATUS    := PALLET.QW_STATUS;
  PAL_QW_COUNT     := PALLET.QW_COUNT;
  PAL_QW_DONE      := PALLET.QW_DONE;
  PAL_QW_PALLET_ID := PALLET.QW_PALLET_ID;
  PAL_QW_WRAPPED   := PALLET.QW_WRAPPED;
(*@END@*)
  SHR_QW_PLC_HB := PLC_HB;
