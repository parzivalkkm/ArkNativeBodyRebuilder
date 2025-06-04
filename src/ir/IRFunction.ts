import { IRInstruction, IRInstructionFactory, IRCallInstruction, IRReturnInstruction, IRPhiInstruction } from './IRInstruction';
import { IRValue, IRVariable, IRParameter, IRValueFactory } from './IRValue';
import { FunctionIR, ModuleIR } from './JsonObjectInterface';
import { ValueType } from './ValueType';

/**
 * 表示一个IR函数
 */
export class IRFunction {
    private name: string;
    private parameters: Map<string, IRParameter> = new Map();
    private instructions: IRInstruction[] = [];
    private valueMap: Map<string, IRValue> = new Map();
    private realArgs: IRVariable[] = [];
    
    constructor(name: string) {
        this.name = name;
    }
    
    public getName(): string {
        return this.name;
    }
    
    public addParameter(name: string, type: string): void {
        const param = IRValueFactory.createParameter(name, type) as IRParameter;
        this.parameters.set(name, param);
        this.valueMap.set(name, param);
    }
    
    public getParameters(): Map<string, IRParameter> {
        return this.parameters;
    }
    
    public addInstruction(instruction: IRInstruction): void {
        this.instructions.push(instruction);
        
        // 将指令定义的变量添加到valueMap
        instruction.getDefinedVariables().forEach(variable => {
            this.valueMap.set(variable.getName(), variable);
        });
    }
    
    public getInstructions(): IRInstruction[] {
        return this.instructions;
    }
    
    public getValue(name: string): IRValue | undefined {
        return this.valueMap.get(name);
    }
    
    public getAllValues(): Map<string, IRValue> {
        return this.valueMap;
    }
    
    public setValueType(name: string, type: ValueType): void {
        const value = this.valueMap.get(name);
        if (value) {
            value.setValueType(type);
        }
    }
    
    public addRealArg(arg: IRVariable): void {
        this.realArgs.push(arg);
    }
    
    public getRealArgs(): IRVariable[] {
        return this.realArgs;
    }
    
    /**
     * 分析函数中的def-use关系
     */
    public analyzeDefUse(): { [variable: string]: { definedIn: IRInstruction[]; usedIn: IRInstruction[] } } {
        const defUseMap: { [variable: string]: { definedIn: IRInstruction[]; usedIn: IRInstruction[] } } = {};
        
        // 初始化参数的def关系
        this.parameters.forEach((param, name) => {
            defUseMap[name] = { definedIn: [], usedIn: [] };
        });
        
        // 分析指令
        this.instructions.forEach(instruction => {
            // 处理定义的变量
            instruction.getDefinedVariables().forEach(variable => {
                const name = variable.getName();
                if (!defUseMap[name]) {
                    defUseMap[name] = { definedIn: [], usedIn: [] };
                }
                defUseMap[name].definedIn.push(instruction);
            });
            
            // 处理使用的变量
            instruction.getUsedVariables().forEach(value => {
                if (value.isConstant()) return;
                
                const name = value.getName();
                if (!defUseMap[name]) {
                    defUseMap[name] = { definedIn: [], usedIn: [] };
                }
                defUseMap[name].usedIn.push(instruction);
            });
        });
        
        return defUseMap;
    }
    
    /**
     * 提取函数的真正参数（通过分析napi_get_cb_info调用）
     */
    public extractRealArgs(): void {
        this.instructions.forEach(instruction => {
            if (instruction instanceof IRCallInstruction && instruction.getTarget() === 'napi_get_cb_info') {
                // 查找返回值中的第3个参数（索引为3）
                const realArgs = instruction.getAllReturnValuesByIndex('3');
                
                for (const [, variable] of Object.entries(realArgs)) {

                    this.realArgs.push(variable);
                    this.valueMap.set(variable.getName(), variable);

                }
                return; // 假设只需要处理第一个napi_get_cb_info调用
            }
        });
    }
    
    /**
     * 创建当前IRFunction的深拷贝
     */
    public copy(): IRFunction {
        const copiedFunction = new IRFunction(this.name);
        
        // 拷贝参数
        this.parameters.forEach((param, name) => {
            copiedFunction.addParameter(name, param.getParameterType());
        });
        
        // 拷贝指令
        this.instructions.forEach(instruction => {
            const copiedInstruction = this.copyInstruction(instruction);
            if (copiedInstruction) {
                copiedFunction.addInstruction(copiedInstruction);
            }
        });
        
        // 拷贝真正参数
        this.realArgs.forEach(arg => {
            const copiedArg = new IRVariable(arg.getName(), arg.getValueType());
            copiedFunction.addRealArg(copiedArg);
        });
        
        return copiedFunction;
    }
      /**
     * 拷贝指令的辅助方法
     */
    private copyInstruction(instruction: IRInstruction): IRInstruction | null {
        if (instruction instanceof IRCallInstruction) {
            const callInst = instruction as IRCallInstruction;
            const copiedCall = new IRCallInstruction(callInst.getCallsite(), callInst.getTarget());
            
            // 拷贝操作数
            callInst.getOperands().forEach(operand => {
                const copiedOperand = this.copyIRValue(operand);
                copiedCall.addOperand(copiedOperand);
            });
            
            // 拷贝参数操作数
            callInst.getArgsOperands().forEach(arg => {
                const copiedArg = this.copyIRValue(arg);
                copiedCall.addArgsOperand(copiedArg);
            });
            
            // 拷贝返回值
            callInst.getReturnValues().forEach((variable, name) => {
                const index = callInst.getReturnValueIndex(name);
                if (index !== undefined) {
                    const copiedVariable = this.copyIRValue(variable) as IRVariable;
                    copiedCall.setReturnValue(name, index, copiedVariable);
                }
            });
            
            return copiedCall;
        } else if (instruction instanceof IRReturnInstruction) {
            const retInst = instruction as IRReturnInstruction;
            const copiedOperand = this.copyIRValue(retInst.getOperand());
            return new IRReturnInstruction(copiedOperand);
        } else if (instruction instanceof IRPhiInstruction) {
            const phiInst = instruction as IRPhiInstruction;
            const copiedResult = this.copyIRValue(phiInst.getResult()) as IRVariable;
            const copiedPhi = new IRPhiInstruction(copiedResult);
            
            phiInst.getOperands().forEach((operand: IRValue) => {
                const copiedOperand = this.copyIRValue(operand);
                copiedPhi.addOperand(copiedOperand);
            });
            
            return copiedPhi;
        }
        
        return null;
    }
    
    /**
     * 拷贝IRValue的辅助方法
     */
    private copyIRValue(value: IRValue): IRValue {
        if (value instanceof IRParameter) {
            const copied = new IRParameter(value.getName(), value.getParameterType(), value.getValueType());
            if (value.getArktsValue()) {
                copied.setArktsValue(value.getArktsValue()!);
            }
            return copied;
        } else if (value instanceof IRVariable) {
            const copied = new IRVariable(value.getName(), value.getValueType());
            if (value.getArktsValue()) {
                copied.setArktsValue(value.getArktsValue()!);
            }
            return copied;
        } else {
            // 对于常量，可以直接返回，因为它们是不可变的
            return value;
        }
    }

    /**
     * 从JSON对象创建IRFunction
     */
    public static fromJson(jsonFunction: FunctionIR): IRFunction {
        const irFunction = new IRFunction(jsonFunction.name);
        
        // 添加参数
        Object.entries(jsonFunction.params).forEach(([name, type]) => {
            irFunction.addParameter(name, type);
        });
        
        // 添加指令
        jsonFunction.instructions.forEach(jsonInst => {
            const instruction = IRInstructionFactory.createFromJson(jsonInst);
            if (instruction) {
                irFunction.addInstruction(instruction);
            }
        });
        
        return irFunction;
    }
}

/**
 * 表示一个IR模块
 */
export class IRModule {
    private hapName: string;
    private soName: string;
    private moduleName: string;
    private functions: IRFunction[] = [];
    
    constructor(hapName: string, soName: string, moduleName: string) {
        this.hapName = hapName;
        this.soName = soName;
        this.moduleName = moduleName;
    }
    
    public getHapName(): string {
        return this.hapName;
    }
    
    public getSoName(): string {
        return this.soName;
    }
    
    public getModuleName(): string {
        return this.moduleName;
    }
    
    public addFunction(func: IRFunction): void {
        this.functions.push(func);
    }
    
    public getFunctions(): IRFunction[] {
        return this.functions;
    }
    
    public getFunctionByName(name: string): IRFunction | undefined {
        return this.functions.find(func => func.getName() === name);
    }
    
    /**
     * 从JSON对象创建IRModule
     */
    public static fromJson(jsonModule: ModuleIR): IRModule {
        const irModule = new IRModule(
            jsonModule.hap_name,
            jsonModule.so_name,
            jsonModule.module_name
        );
        
        jsonModule.functions.forEach(jsonFunction => {
            const irFunction = IRFunction.fromJson(jsonFunction);
            irModule.addFunction(irFunction);
            IRValueFactory.clearCache();
        });
        
        return irModule;
    }
}