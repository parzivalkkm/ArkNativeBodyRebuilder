import { MethodSubSignature } from "@ArkAnalyzer/src/core/model/ArkSignature";

export interface ModuleIR {
    hap_name: string;
    so_name: string;
    module_name: string;
    functions: FunctionIR[];
}

export interface FunctionIR {
    name: string;
    params: { [key: string]: string };
    instructions: Inst[];
}

export interface Inst {
    type: string;
}

export interface CallInst extends Inst {
    callsite: string;
    target: string;
    operands: string[]; 
    argsoperands ?: string[];
    rets: { [key: string]: string };
}

export interface RetInst extends Inst {
    operand: string;
}

export interface PhiInst extends Inst {
    operands: string[];
    ret: string;
}

export interface MethodSubSignatureMap{
    name: string;
    methodSubSignature: MethodSubSignature;
}