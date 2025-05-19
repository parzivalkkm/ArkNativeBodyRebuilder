
import { IRFunction } from '../ir/IRFunction';
import { IRCallInstruction, IRPhiInstruction, IRReturnInstruction } from '../ir/IRInstruction';
import { ValueType } from '../ir/ValueType';
// import { IRValue } from '../ir/IRValue';
import { CallInstTypeRules } from './TypeInferRules';
import { Logger } from 'log4js';

/**
 * 负责IR函数中变量类型推断的类
 */
export class TypeInference {
    private logger: Logger;
    private irFunction: IRFunction;
    
    constructor(irFunction: IRFunction, logger: Logger) {
        this.irFunction = irFunction;
        this.logger = logger;
    }
    
    /**
     * 执行类型推断
     */
    public inferTypes(): void {
        this.logger.debug(`Performing type inference for function: ${this.irFunction.getName()}`);
        
        // 对每条指令进行类型推断
        this.irFunction.getInstructions().forEach(instruction => {
            if (instruction instanceof IRCallInstruction) {
                this.inferCallInstructionTypes(instruction);
            } else if (instruction instanceof IRPhiInstruction) {
                this.inferPhiInstructionTypes(instruction);
            } else if (instruction instanceof IRReturnInstruction) {
                this.inferReturnInstructionTypes(instruction);
            }
        });
        
        // 检查未推断的类型
        this.checkUnresolvedTypes();
    }
    
    /**
     * 为调用指令推断类型
     */
    private inferCallInstructionTypes(callInst: IRCallInstruction): void {
        const target = callInst.getTarget();
        
        // 特殊处理napi_get_cb_info
        // if (target === 'napi_get_cb_info') {
        //     this.inferGetCallbackInfoTypes(callInst);
        //     return;
        // }
        
        // 跳过特定类型的调用
        if (target === 'OH_LOG_Print') {
            this.logger.debug(`Skipping type inference for target ${target}`);
            return;
        }
        
        // 获取目标函数的类型规则
        const rules = CallInstTypeRules[target];
        if (!rules) {
            this.logger.warn(`No type inference rules found for target ${target}`);
            return;
        }
        
        // 处理返回值类型
        if (rules.rets) {
            const returnValues = callInst.getReturnValues();
            for (const [name, variable] of returnValues.entries()) {
                const retIndex = this.findReturnIndex(callInst, name);
                if (retIndex && rules.rets[retIndex]) {
                    const inferredType = rules.rets[retIndex];
                    variable.setValueType(inferredType);
                    this.logger.debug(`Inferred return value ${name} type: ${inferredType}`);
                }
            }
        }
        
        // 处理操作数类型
        const operands = callInst.getOperands();
        operands.forEach((operand, index) => {
            if (operand.isConstant()) {
                return; // 跳过常量
            }
            
            const expectedType = rules.operands?.[index.toString()];
            if (expectedType) {
                const actualType = operand.getValueType();
                if (actualType !== ValueType.UnInferred && actualType !== expectedType) {
                    this.logger.warn(
                        `Type mismatch for operand ${operand.getName()} in ${target}: ` +
                        `expected ${expectedType}, got ${actualType}`
                    );
                } else if (actualType === ValueType.UnInferred) {
                    operand.setValueType(expectedType);
                    this.logger.debug(`Inferred operand ${operand.getName()} type: ${expectedType}`);
                }
            }
        });
    }
    
    /**
     * 为napi_get_cb_info调用推断类型
     * 处理索引为3的多个返回值（函数实际参数）
     */
    // private inferGetCallbackInfoTypes(callInst: IRCallInstruction): void {
    //     // 获取索引为"-1"的返回值（通常是状态码）
    //     const statusVars = callInst.getAllReturnValuesByIndex("-1");
    //     for (const statusVar of statusVars) {
    //         statusVar.setValueType(ValueType.Status);
    //         this.logger.debug(`Set napi_get_cb_info status return value ${statusVar.getName()} to Status type`);
    //     }

    //     // 获取索引为"3"的返回值（通常是回调函数的参数）
    //     const argVars = callInst.getAllReturnValuesByIndex("3");
        
    //     // 尝试从上下文推断类型
    //     // 这里我们假设第一个参数通常是字符串类型，就像示例中的情况
    //     // 实际应用中可能需要更复杂的类型推断逻辑
    //     for (const [index, argVar] of argVars.entries()) {
    //         let inferredType: ValueType;
            
            
    //         inferredType = ValueType.Any; // 其他参数默认为Any类型
            
            
    //         argVar.setValueType(inferredType);
    //         this.logger.debug(`Inferred napi_get_cb_info argument ${argVar.getName()} type: ${inferredType}`);
    //     }
    // }
    
    /**
     * 查找返回值对应的索引
     */
    private findReturnIndex(callInst: IRCallInstruction, varName: string): string | null {
        // 使用IRCallInstruction中添加的方法获取索引
        const index = callInst.getReturnValueIndex(varName);
        if (index) {
            return index;
        }
        
        // 如果找不到索引，则使用原来的方法作为备选
        return varName.substring(1); // 去掉前面的%
    }
    
    /**
     * 为PHI指令推断类型
     */
    private inferPhiInstructionTypes(phiInst: IRPhiInstruction): void {
        const operands = phiInst.getOperands();
        const result = phiInst.getResult();
        
        // 收集所有非常量操作数的类型
        const operandTypes = operands
            .filter(operand => !operand.isConstant())
            .map(operand => operand.getValueType())
            .filter(type => type !== ValueType.UnInferred);
        
        if (operandTypes.length === 0) {
            this.logger.debug(`No valid operand types for Phi instruction ${result.getName()}`);
            return;
        }
        
        // 检查类型一致性
        const uniqueTypes = Array.from(new Set(operandTypes));
        
        if (uniqueTypes.length === 1) {
            result.setValueType(uniqueTypes[0]);
            this.logger.debug(`Inferred Phi result ${result.getName()} type: ${uniqueTypes[0]}`);
        } else if (uniqueTypes.includes(ValueType.Any)) {
            result.setValueType(ValueType.Any);
            this.logger.warn(`Phi instruction ${result.getName()} has operand with type Any`);
        } else {
            result.setValueType(ValueType.UnInferred);
            this.logger.warn(`Inconsistent types for Phi instruction ${result.getName()}: ${uniqueTypes}`);
        }
    }
    
    /**
     * 为Return指令推断类型
     */
    private inferReturnInstructionTypes(retInst: IRReturnInstruction): void {
        const operand = retInst.getOperand();
        
        // 如果是常量，不需要特殊处理
        if (operand.isConstant()) {
            return;
        }
        
        // 检查操作数类型
        const operandType = operand.getValueType();
        if (operandType === ValueType.UnInferred) {
            this.logger.warn(`Return instruction operand ${operand.getName()} has uninferred type`);
        }
    }
    
    /**
     * 检查未解析的类型
     */
    private checkUnresolvedTypes(): void {
        const valueMap = this.irFunction.getAllValues();
        
        for (const [name, value] of valueMap.entries()) {
            if (value.getValueType() === ValueType.UnInferred) {
                this.logger.warn(`Variable ${name} has uninferred type after analysis`);
            }
        }
    }
} 