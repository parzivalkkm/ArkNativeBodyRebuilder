import { IRFunction } from '../ir/IRFunction';
import { IRCallInstruction, IRPhiInstruction, IRReturnInstruction } from '../ir/IRInstruction';
import { IRValue } from '../ir/IRValue';
import { Logger } from 'log4js';
import { Type, NumberType, StringType, BooleanType, ArrayType, AnyType, UnknownType, ClassType, VoidType } from '@ArkAnalyzer/src/core/base/Type';
import { ClassSignature, FileSignature } from '@ArkAnalyzer/src/core/model/ArkSignature';

/**
 * 类型推导系统
 * 直接使用 ArkAnalyzer 的 Type 体系
 */
export class IRValueTypeInference {
    private logger: Logger;
    private irFunction: IRFunction;
    
    // 类型映射表，存储每个值对应的类型
    private typeMap: Map<IRValue, Type> = new Map();

    constructor(irFunction: IRFunction, logger: Logger) {
        this.irFunction = irFunction;
        this.logger = logger;
    }

    /**
     * 创建标准的 Object 类型
     */
    private static createObjectType(): Type {
        const fileSignature = new FileSignature("ES2015", "BuiltinClass");
        const classSignature = new ClassSignature("Object", fileSignature, null);
        return new ClassType(classSignature, undefined);
    }

    /**
     * 执行类型推断，使用 worklist 算法
     */
    public inferTypes(): void {
        this.logger.debug(`Performing safe type inference for function: ${this.irFunction.getName()}`);
        
        // 初始化参数类型
        this.initializeParameterTypes();
        
        // 使用 worklist 算法进行类型传播
        this.propagateTypes();
        
        // 检查未解析的类型
        this.checkUnresolvedTypes();
    }

    /**
     * 初始化函数参数的类型
     */
    private initializeParameterTypes(): void {
        const params = this.irFunction.getParameters();
        
        // 前两个参数通常是 JNIEnv* 和 jobject (或 jclass)
        for (const [name, param] of params.entries()) {
            const index = parseInt(name);
            
            if (index === 0) {
                // JNIEnv* 参数，通常不需要特殊类型
                this.setValueType(param, UnknownType.getInstance());
            } else if (index === 1) {
                // this 对象参数
                this.setValueType(param, IRValueTypeInference.createObjectType());
            } else {
                // 其他参数保持默认类型或从函数签名推断
                this.setValueType(param, AnyType.getInstance());
            }
        }
    }

    /**
     * 使用 worklist 算法传播类型信息
     */
    private propagateTypes(): void {
        const worklist: Set<IRValue> = new Set();
        const processed: Set<IRValue> = new Set();
        
        // 将所有有类型的值添加到 worklist
        for (const [value, type] of this.typeMap.entries()) {
            worklist.add(value);
        }
        
        let changed = true;
        let iterations = 0;
        const maxIterations = 100; // 防止无限循环
        
        while (changed && worklist.size > 0 && iterations < maxIterations) {
            changed = false;
            const currentWorklist = Array.from(worklist);
            worklist.clear();
            
            for (const value of currentWorklist) {
                if (processed.has(value)) continue;
                
                const updated = this.processValue(value);
                if (updated) {
                    changed = true;
                    // 将受影响的值添加回 worklist
                    this.addUsersToWorklist(value, worklist);
                }
                processed.add(value);
            }
            iterations++;
        }
        
        if (iterations >= maxIterations) {
            this.logger.warn(`Type inference reached maximum iterations (${maxIterations})`);
        }
    }

    /**
     * 处理单个值的类型推断
     */
    private processValue(value: IRValue): boolean {
        let updated = false;
        
        // 遍历所有指令，找到使用该值的地方
        for (const instruction of this.irFunction.getInstructions()) {
            if (instruction instanceof IRCallInstruction) {
                const result = this.processCallInstruction(instruction, value);
                updated = updated || result;
            } else if (instruction instanceof IRPhiInstruction) {
                const result = this.processPhiInstruction(instruction, value);
                updated = updated || result;
            } else if (instruction instanceof IRReturnInstruction) {
                const result = this.processReturnInstruction(instruction, value);
                updated = updated || result;
            }
        }
        
        return updated;
    }

    /**
     * 处理调用指令的类型推断
     */
    private processCallInstruction(callInst: IRCallInstruction, targetValue?: IRValue): boolean {
        const target = callInst.getTarget();
        let updated = false;

        // 处理不同的 NAPI 调用
        if (target.startsWith('napi_create_') && target.includes('string')) {
            // 字符串创建相关
            const returnValues = callInst.getReturnValues();
            for (const [_, returnValue] of returnValues.entries()) {
                const result = this.setValueType(returnValue, StringType.getInstance());
                updated = updated || result;
            }
        } else if (target.startsWith('napi_create_') && (target.includes('int') || target.includes('double'))) {
            // 数值创建相关
            const returnValues = callInst.getReturnValues();
            for (const [_, returnValue] of returnValues.entries()) {
                const result = this.setValueType(returnValue, NumberType.getInstance());
                updated = updated || result;
            }
        } else if (target.startsWith('napi_get_value_bool') || target === 'napi_get_boolean') {
            // 布尔值相关
            const returnValues = callInst.getReturnValues();
            for (const [_, returnValue] of returnValues.entries()) {
                const result = this.setValueType(returnValue, BooleanType.getInstance());
                updated = updated || result;
            }
        } else if (target.includes('array')) {
            // 数组相关
            const returnValues = callInst.getReturnValues();
            for (const [_, returnValue] of returnValues.entries()) {
                const result = this.setValueType(returnValue, new ArrayType(AnyType.getInstance(), 1));
                updated = updated || result;
            }
        } else if (target.includes('object') || target === 'napi_create_object') {
            // 对象相关
            const returnValues = callInst.getReturnValues();
            for (const [_, returnValue] of returnValues.entries()) {
                const result = this.setValueType(returnValue, IRValueTypeInference.createObjectType());
                updated = updated || result;
            }
        }
        
        return updated;
    }

    /**
     * 处理 Phi 指令的类型推断
     */
    private processPhiInstruction(phiInst: IRPhiInstruction, targetValue?: IRValue): boolean {
        const result = phiInst.getResult();
        const operands = phiInst.getOperands();
        
        // 收集所有操作数的类型
        const operandTypes: Type[] = [];
        for (const operand of operands) {
            if (!operand.isConstant()) {
                const type = this.getValueType(operand);
                if (type) {
                    operandTypes.push(type);
                }
            }
        }
        
        if (operandTypes.length === 0) {
            return false;
        }
        
        // 合并类型
        const mergedType = this.mergeTypes(operandTypes);
        let updated = false;
        
        // 将合并后的类型传播给结果和所有操作数
        const resultUpdated = this.setValueType(result, mergedType);
        updated = updated || resultUpdated;
        
        for (const operand of operands) {
            if (!operand.isConstant()) {
                const operandUpdated = this.setValueType(operand, mergedType);
                updated = updated || operandUpdated;
            }
        }
        
        return updated;
    }

    /**
     * 处理返回指令的类型推断
     */
    private processReturnInstruction(retInst: IRReturnInstruction, targetValue?: IRValue): boolean {
        const operand = retInst.getOperand();
        
        if (operand.isConstant()) {
            return false;
        }
        
        // 可以根据函数签名的返回类型进一步优化
        const currentType = this.getValueType(operand);
        if (!currentType) {
            return this.setValueType(operand, AnyType.getInstance());
        }
        
        return false;
    }

    /**
     * 合并多个类型，参考 TypeAnalysis.java 的实现
     */
    private mergeTypes(types: Type[]): Type {
        if (types.length === 0) {
            return UnknownType.getInstance();
        }
        
        if (types.length === 1) {
            return types[0];
        }
        
        let result = types[0];
        for (let i = 1; i < types.length; i++) {
            result = this.mergeType(result, types[i]);
        }
        
        return result;
    }

    /**
     * 合并两个类型
     */
    private mergeType(type1: Type, type2: Type): Type {
        if (!type1) return type2;
        if (!type2) return type1;
        
        // 使用 toString() 比较类型
        if (type1.toString() === type2.toString()) {
            return type1;
        }
        
        // 如果其中一个是 AnyType，返回 AnyType
        if (type1 instanceof AnyType || type2 instanceof AnyType) {
            return AnyType.getInstance();
        }
        
        // 如果其中一个是 UnknownType，返回另一个
        if (type1 instanceof UnknownType) {
            return type2;
        }
        if (type2 instanceof UnknownType) {
            return type1;
        }
        
        // 对于不兼容的类型，返回 AnyType
        this.logger.warn(`Cannot merge incompatible types: ${type1.toString()} and ${type2.toString()}, using AnyType`);
        return AnyType.getInstance();
    }

    /**
     * 设置值的类型，如果类型发生变化返回 true
     */
    private setValueType(value: IRValue, type: Type): boolean {
        const currentType = this.typeMap.get(value);
        
        if (!currentType) {
            this.typeMap.set(value, type);
            value.setType(type);
            return true;
        }
        
        // 使用 toString() 比较类型
        if (currentType.toString() === type.toString()) {
            return false;
        }
        
        // 合并类型
        const mergedType = this.mergeType(currentType, type);
        if (mergedType.toString() !== currentType.toString()) {
            this.typeMap.set(value, mergedType);
            value.setType(mergedType);
            return true;
        }
        
        return false;
    }

    /**
     * 获取值的类型
     */
    private getValueType(value: IRValue): Type | null {
        return this.typeMap.get(value) || null;
    }

    /**
     * 将使用了指定值的其他值添加到 worklist
     */
    private addUsersToWorklist(value: IRValue, worklist: Set<IRValue>): void {
        // 遍历所有指令，找到使用该值的其他值
        for (const instruction of this.irFunction.getInstructions()) {
            if (instruction instanceof IRCallInstruction) {
                const operands = instruction.getOperands();
                if (operands.includes(value)) {
                    // 将返回值添加到 worklist
                    const returnValues = instruction.getReturnValues();
                    for (const [_, returnValue] of returnValues.entries()) {
                        worklist.add(returnValue);
                    }
                }
            } else if (instruction instanceof IRPhiInstruction) {
                const operands = instruction.getOperands();
                if (operands.includes(value)) {
                    worklist.add(instruction.getResult());
                }
                
                if (instruction.getResult() === value) {
                    // 将所有操作数添加到 worklist
                    for (const operand of operands) {
                        if (!operand.isConstant()) {
                            worklist.add(operand);
                        }
                    }
                }
            }
        }
    }

    /**
     * 检查未解析的类型
     */
    private checkUnresolvedTypes(): void {
        const valueMap = this.irFunction.getAllValues();
        
        for (const [name, value] of valueMap.entries()) {
            const type = this.getValueType(value);
            if (!type || type instanceof UnknownType) {
                this.logger.warn(`Variable ${name} has unresolved type after analysis`);
                // 为未解析的类型设置默认值
                this.setValueType(value, AnyType.getInstance());
            }
        }
    }

    /**
     * 获取类型映射表（用于调试和测试）
     */
    public getTypeMap(): Map<IRValue, Type> {
        return new Map(this.typeMap);
    }
}
