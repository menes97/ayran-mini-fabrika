PROGRAM MODBUS_IO
VAR
    Client : ModbusFB.ClientTCP;
    SimIp : ARRAY [0..3] OF BYTE := [127, 0, 0, 1];   (* simulator; array literal is not allowed inside the call *)
    ReadIR : ModbusFB.ClientRequestReadInputRegisters;
    WriteHR : ModbusFB.ClientRequestWriteMultipleRegisters;
    aRead : ARRAY [0..111] OF UINT;
    aWrite : ARRAY [0..111] OF UINT;
    (* 0 connect, 10 read, 11 reset read, 20 snapshot, 21 write, 22 reset write, 90 backoff *)
    Stage : INT;
    Retry : TON;
    i : INT;
END_VAR
(*@BODY@*)
(* All Modbus FBs are called exactly once per MainTask scan, in the same task.
   ModbusFB 4.5.0.0: timeouts are microseconds; addresses are zero-based.
   Buffers remain valid and unchanged for the entire asynchronous operation. *)
Client(xConnect := Stage <> 90, aIPaddr := SimIp, uiPort := 5020,
       tConnnectTimeOut := T#1s);
ReadIR(rClient := Client, xExecute := Stage = 10, uiUnitId := 1,
       udiTimeOut := 1500000, udiReplyTimeout := 500000, uiMaxRetries := 0,
       uiStartItem := 0, uiQuantity := 112, pData := ADR(aRead));
WriteHR(rClient := Client, xExecute := Stage = 21, uiUnitId := 1,
        udiTimeOut := 1500000, udiReplyTimeout := 500000, uiMaxRetries := 0,
        uiStartItem := 0, uiQuantity := 112, pData := ADR(aWrite));

IF Client.xError OR ReadIR.xError OR WriteHR.xError OR
   ((Stage <> 0) AND (Stage <> 90) AND NOT Client.xConnected) THEN
    Stage := 90;
END_IF;
Retry(IN := Stage = 90, PT := T#500ms);
CASE Stage OF
    0:
        IF Client.xConnected THEN Stage := 10; END_IF;
    10:
        IF ReadIR.xDone THEN
(*@INPUT_MAP@*)
            Stage := 11;
        END_IF;
    11:
        (* xExecute=FALSE was delivered to ReadIR in this scan. *)
        Stage := 20;
    22:
        (* xExecute=FALSE was delivered to WriteHR in this scan. *)
        Stage := 10;
    21:
        IF WriteHR.xDone THEN Stage := 22; END_IF;
    90:
        (* Force a falling/rising xConnect edge, including on request timeouts. *)
        IF Retry.Q THEN Stage := 0; END_IF;
END_CASE;
(*@OUTPUT@*)
(* MAIN calls this action AFTER Fabrika. Only snapshot when the previous
   request is reset and no write owns the buffer. Read failures never queue
   further writes, so the simulator stops seeing changes of the PLC HB. *)
IF Stage = 20 THEN
    FOR i := 0 TO 111 DO aWrite[i] := 0; END_FOR;
(*@OUTPUT_MAP@*)
    Stage := 21;
END_IF;
