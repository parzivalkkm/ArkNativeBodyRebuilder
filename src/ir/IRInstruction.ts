import { IRValue, IRVariable, IRValueFactory } from './IRValue';
import { CallInst as JsonCallInst, RetInst as JsonRetInst, PhiInst as JsonPhiInst } from './JsonObjectInterface';

/**
 * 指令的基类
 */
export abstract class IRInstruction {
    protected type: string;
    
    constructor(type: string) {
        this.type = type;
    }
    
    public getType(): string {
        return this.type;
    }
    
    /**
     * 获取指令定义的变量
     */
    public abstract getDefinedVariables(): IRVariable[];
    
    /**
     * 获取指令使用的变量
     */
    public abstract getUsedVariables(): IRValue[];
}

/**
 * 调用指令
 */
export class IRCallInstruction extends IRInstruction {
    private callsite: string;
    private target: string;
    private operands: IRValue[] = [];
    private argsOperands : IRValue[] = [];
    private returnValues: Map<string, IRVariable> = new Map();
    private returnIndices: Map<string, string> = new Map();
    private indexToVariables: Map<string, string[]> = new Map();
    
    constructor(callsite: string, target: string) {
        super('Call');
        this.callsite = callsite;
        this.target = target;
    }
    
    public getCallsite(): string {
        return this.callsite;
    }
    
    public getTarget(): string {
        return this.target;
    }
    
    public addOperand(operand: IRValue): void {
        this.operands.push(operand);
    }
    
    public getOperands(): IRValue[] {
        return this.operands;
    }

    public addArgsOperand(operand: IRValue): void {

        this.argsOperands.push(operand);
        
    }

    public getArgsOperands(): IRValue[] {
        return this.argsOperands;

    }
    
    public setReturnValue(name: string, index: string, variable: IRVariable): void {
        this.returnValues.set(name, variable);
        this.returnIndices.set(name, index);
        
        if (!this.indexToVariables.has(index)) {
            this.indexToVariables.set(index, []);
        }
        const variables = this.indexToVariables.get(index);
        if (variables && !variables.includes(name)) {
            variables.push(name);
        }
    }
    
    public getReturnValues(): Map<string, IRVariable> {
        return this.returnValues;
    }
    
    public getReturnValueIndex(name: string): string | undefined {
        return this.returnIndices.get(name);
    }
    
    public getAllReturnValuesByIndex(index: string): IRVariable[] {
        const result: IRVariable[] = [];
        const varNames = this.indexToVariables.get(index);
        if (varNames) {
            varNames.forEach(name => {
                const variable = this.returnValues.get(name);
                if (variable) {
                    result.push(variable);
                }
            });
        }
        return result;
    }
    
    public getReturnValueByIndex(index: string): IRVariable | undefined {
        const varNames = this.indexToVariables.get(index);
        if (varNames && varNames.length > 0) {
            return this.returnValues.get(varNames[0]);
        }
        return undefined;
    }
    
    public getDefinedVariables(): IRVariable[] {
        return Array.from(this.returnValues.values());
    }
    
    public getUsedVariables(): IRValue[] {
        return this.operands.filter(operand => !operand.isConstant());
    }
    
    /**
     * 从JSON对象创建IRCallInstruction
     */
    public static fromJson(jsonCallInst: JsonCallInst): IRCallInstruction {
        const callInst = new IRCallInstruction(jsonCallInst.callsite, jsonCallInst.target);

        // 添加操作数
        jsonCallInst.operands.forEach(operandStr => {
            const operand = IRValueFactory.createFromString(operandStr); // 使用缓存机制
            callInst.addOperand(operand);
        });

        if (jsonCallInst.argsoperands) {
            jsonCallInst.argsoperands.forEach(argStr => {
                const arg = IRValueFactory.createFromString(argStr); // 使用缓存机制
                callInst.addArgsOperand(arg);
            });
        }

        // 添加返回值
        Object.entries(jsonCallInst.rets).forEach(([name, index]) => {
            const returnValue = IRValueFactory.createFromString(name) as IRVariable; // 使用缓存机制
            callInst.setReturnValue(name, index, returnValue);
        });

        return callInst;
    }
}

/**
 * 返回指令
 */
export class IRReturnInstruction extends IRInstruction {
    private operand: IRValue;
    
    constructor(operand: IRValue) {
        super('Ret');
        this.operand = operand;
    }
    
    public getOperand(): IRValue {
        return this.operand;
    }
    
    public getDefinedVariables(): IRVariable[] {
        return [];
    }
    
    public getUsedVariables(): IRValue[] {
        return this.operand.isConstant() ? [] : [this.operand];
    }
    
    /**
     * 从JSON对象创建IRReturnInstruction
     */
    public static fromJson(jsonRetInst: JsonRetInst): IRReturnInstruction {
        const operand = IRValueFactory.createFromString(jsonRetInst.operand);
        return new IRReturnInstruction(operand);
    }
}

/**
 * PHI指令
 */
export class IRPhiInstruction extends IRInstruction {
    private operands: IRValue[] = [];
    private result: IRVariable;
    
    constructor(result: IRVariable) {
        super('Phi');
        this.result = result;
    }
    
    public addOperand(operand: IRValue): void {
        this.operands.push(operand);
    }
    
    public getOperands(): IRValue[] {
        return this.operands;
    }
    
    public getResult(): IRVariable {
        return this.result;
    }
    
    public getDefinedVariables(): IRVariable[] {
        return [this.result];
    }
    
    public getUsedVariables(): IRValue[] {
        return this.operands.filter(operand => !operand.isConstant());
    }
    
    /**
     * 从JSON对象创建IRPhiInstruction
     */
    public static fromJson(jsonPhiInst: JsonPhiInst): IRPhiInstruction {
        const result = new IRVariable(jsonPhiInst.ret);
        const phiInst = new IRPhiInstruction(result);
        
        jsonPhiInst.operands.forEach(operandStr => {
            const operand = IRValueFactory.createFromString(operandStr);
            phiInst.addOperand(operand);
        });
        
        return phiInst;
    }
}

/**
 * 指令工厂
 */
export class IRInstructionFactory {
    /**
     * 根据JSON指令创建对应的IRInstruction对象
     */
    public static createFromJson(jsonInst: any): IRInstruction | null {
        if (jsonInst.type === 'Call') {
            return IRCallInstruction.fromJson(jsonInst as JsonCallInst);
        } else if (jsonInst.type === 'Ret') {
            return IRReturnInstruction.fromJson(jsonInst as JsonRetInst);
        } else if (jsonInst.type === 'Phi') {
            return IRPhiInstruction.fromJson(jsonInst as JsonPhiInst);
        }
        return null;
    }
}