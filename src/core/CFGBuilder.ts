import { IRFunction } from '../ir/IRFunction';
import { IRCallInstruction, IRPhiInstruction, IRReturnInstruction } from '../ir/IRInstruction';
import { IRValue, IRVariable, IRStringConstant, IRNumberConstant, IRNullConstant, IRTopConstant } from '../ir/IRValue';
import { Logger } from 'log4js';
import { ArkMethod } from '@ArkAnalyzer/src/core/model/ArkMethod';
import { Local } from '@ArkAnalyzer/src/core/base/Local';
import { Cfg } from '@ArkAnalyzer/src/core/graph/Cfg';
import { BasicBlock } from '@ArkAnalyzer/src/core/graph/BasicBlock';
import { ArkAssignStmt, ArkInvokeStmt, ArkReturnStmt, ArkReturnVoidStmt, ArkThrowStmt } from '@ArkAnalyzer/src/core/base/Stmt';
import { ArkArrayRef, ArkInstanceFieldRef, ArkParameterRef, ArkThisRef } from '@ArkAnalyzer/src/core/base/Ref';
import { ArkDeleteExpr, ArkInstanceInvokeExpr, ArkInstanceOfExpr, ArkNewArrayExpr, ArkNewExpr, ArkPhiExpr, ArkStaticInvokeExpr, ArkPtrInvokeExpr } from '@ArkAnalyzer/src/core/base/Expr';
import { Constant, NullConstant, NumberConstant, StringConstant } from '@ArkAnalyzer/src/core/base/Constant';
import { ValueUtil } from '@ArkAnalyzer/src/core/common/ValueUtil';
import { Type, NumberType, StringType, BooleanType, VoidType, ArrayType, AnyType, UnknownType, ClassType, FunctionType } from '@ArkAnalyzer/src/core/base/Type';
import { Value } from '@ArkAnalyzer/src/core/base/Value';
import { ClassSignature, FieldSignature, FileSignature, MethodSignature, MethodSubSignature, NamespaceSignature } from '@ArkAnalyzer/src/core/model/ArkSignature';
import { MethodParameter } from '@ArkAnalyzer/src/core/model/builder/ArkMethodBuilder';
import { GLOBAL_THIS_NAME } from '@ArkAnalyzer/src/core/common/TSConst';

/**
 * 负责构建CFG的类
 */
export class CFGBuilder {
    private logger: Logger;
    private irFunction: IRFunction;
    private arkMethod: ArkMethod;
        private callsiteInvokeExpr: ArkInstanceInvokeExpr | ArkStaticInvokeExpr | ArkPtrInvokeExpr;
    
    // 存储变量到Local的映射
    private varLocalMap: Map<string, Local> = new Map();
    // 存储Local到参数索引的映射
    private paramIndexMap: Map<Local, number> = new Map();
    private constIdCounter: number = 0;
    
    constructor(irFunction: IRFunction, arkMethod: ArkMethod, logger: Logger, invokeExpr: ArkInstanceInvokeExpr | ArkStaticInvokeExpr | ArkPtrInvokeExpr) {
        this.irFunction = irFunction;
        this.arkMethod = arkMethod;
        this.logger = logger;
        this.callsiteInvokeExpr = invokeExpr;
    }
    
    /**
     * 构建CFG
     */
    public buildCFG(): Cfg {
        const cfg = new Cfg();
        cfg.setDeclaringMethod(this.arkMethod);
        
        // 构建第一个基本块并处理参数
        const firstBlock = new BasicBlock();
        this.processParameters(firstBlock);
        this.createThisLocal(firstBlock);
        // 处理指令
        let currentBlock = firstBlock;
        
        for (const instruction of this.irFunction.getInstructions()) {
            if (instruction instanceof IRCallInstruction) {
                currentBlock = this.processCallInstruction(instruction, cfg, currentBlock);
            } else if (instruction instanceof IRPhiInstruction) {
                currentBlock = this.processPhiInstruction(instruction, cfg, currentBlock);
            } else if (instruction instanceof IRReturnInstruction) {
                currentBlock = this.processReturnInstruction(instruction, cfg, currentBlock);
            }
        }
        
        // 确保最后一个基本块被添加到CFG中
        cfg.addBlock(currentBlock);
        
        return cfg;
    }
    
    /**
     * 处理函数参数
     */
    private processParameters(firstBlock: BasicBlock): void {
        // 获取方法参数
        const methodParams = this.arkMethod.getParameters();
        const realArgs = this.irFunction.getRealArgs();
        // TODO: 存在问题
        // 如果方法参数已经定义，则使用这些参数，但是如果和真正参数不一致怎么办？


        if (methodParams.length > 0) {
            if (this.irFunction.getRealArgs().length !== methodParams.length) {
                this.logger.error(`Mismatch between method parameters and real arguments.`);
                this.logger.error(`Method parameters: ${methodParams.map(p => p.getName()).join(', ')}`);
                this.logger.error(`Real arguments: ${realArgs.map(arg => arg.getName()).join(', ')}`);
            }
            // 如果方法已有参数定义，为每个参数创建Local并添加赋值语句
            methodParams.forEach((param, index) => {
                const correspondingArg = realArgs[index];
                const paramName = correspondingArg.getName();
                
                const paramRef = new ArkParameterRef(index, param.getType());
                const paramLocal = new Local(paramName, paramRef.getType());
                this.varLocalMap.set(paramName, paramLocal);
                // 记录参数索引
                this.paramIndexMap.set(paramLocal, index);
                
                const paramAssignStmt = new ArkAssignStmt(paramLocal, paramRef);
                paramLocal.setDeclaringStmt(paramAssignStmt);

                firstBlock.addStmt(paramAssignStmt);
            });
        } else {
            // 否则使用提取的真正参数
            realArgs.forEach((arg, index) => {
                // 为每个真正参数创建对应的Local
                const argType = arg.getType();
                const paramLocal = new Local(arg.getName(), argType);
                this.varLocalMap.set(arg.getName(), paramLocal);
                // 记录参数索引
                this.paramIndexMap.set(paramLocal, index);
                
                // 创建参数引用并添加赋值语句
                const paramRef = new ArkParameterRef(index, argType);
                const paramAssignStmt = new ArkAssignStmt(paramLocal, paramRef);
                paramLocal.setDeclaringStmt(paramAssignStmt);

                firstBlock.addStmt(paramAssignStmt);
            });
        }
    }

    private createThisLocal(firstBlock: BasicBlock): void {
        // 创建this引用
        const thisType = new ClassType(this.arkMethod.getDeclaringArkClass().getSignature(), undefined);
        const thisLocal = new Local("this", thisType);
        const thisRef = new ArkThisRef(thisType);
        this.varLocalMap.set("this", thisLocal);
        
        // 创建赋值语句
        const thisAssignStmt = new ArkAssignStmt(thisLocal, thisRef);
        thisLocal.setDeclaringStmt(thisAssignStmt);

        firstBlock.addStmt(thisAssignStmt);
    }
    
    /**
     * 处理调用指令
     */
    private processCallInstruction(callInst: IRCallInstruction, cfg: Cfg, currentBlock: BasicBlock): BasicBlock {
        const target = callInst.getTarget();
        
        switch (target) {
            // case 'napi_get_cb_info':
            //     return this.processGetCallbackInfoCall(callInst, currentBlock);
                
            case 'napi_create_double':
            case 'napi_create_int64':
            case 'napi_create_int32':
            case 'napi_create_uint32':
                return this.processNumberCreationCall(callInst, currentBlock);
                
            case 'napi_get_value_double':
            case 'napi_get_value_int64':
            case 'napi_get_value_int32':
            case 'napi_get_value_uint32':
                return this.processNumberExtractionCall(callInst, currentBlock);
                
            case 'napi_create_string_utf8':
            case 'napi_create_string_utf16':
            case 'napi_create_string_latin1':
                return this.processStringCreationCall(callInst, currentBlock);
                
            case 'napi_get_value_string_utf8':
            case 'napi_get_value_string_utf16':
            case 'napi_get_value_string_latin1':
                return this.processStringExtractionCall(callInst, currentBlock);
                
            case 'napi_get_boolean':
            case 'napi_get_value_bool':
                return this.processBooleanCall(callInst, currentBlock);
                
            case 'napi_get_undefined':
            case 'napi_get_null':
                return this.processSpecialConstantCall(callInst, currentBlock);

            case 'napi_coerce_to_bool':
            case 'napi_coerce_to_number':
            case 'napi_coerce_to_object':
            case 'napi_coerce_to_string':
                return this.processCoerceCall(callInst, currentBlock);

            case 'napi_get_prototype':
                // 在DevEco Studio 4.1及以后的版本中，由于ArkTS没有原型的概念，
                // 因此尝试进行原型赋值或相关操作时，将会触发错误提示
                // 'Prototype assignment is not supported (arkts-no-prototype-assignment)'
                // 好像没有必要进行处理
            case 'napi_create_object':
            case 'napi_get_property_names':
            case 'napi_set_property':
            case 'napi_get_property':
            case 'napi_has_property':
            case 'napi_delete_property':
            case 'napi_has_own_property':
            case 'napi_set_named_property':
            case 'napi_get_named_property':
            case 'napi_has_named_property':
            case 'napi_get_all_property_names':
                return this.processObjectInst(callInst, currentBlock);

            case "napi_get_global":
            case "napi_call_function":
                return this.processFunctionCall(callInst, currentBlock);

            case "napi_create_array":
            case "napi_create_array_with_length":
            case "napi_is_array":
            case "napi_get_array_length" : 
                return this.processArrayFunctionCall(callInst, currentBlock);

            case "napi_set_element" : 
            case "napi_get_element" : 
            case "napi_has_element" : 
            case "napi_delete_element" : 
                return this.processArrayElementCall(callInst, currentBlock);
                
            case 'operator.new[]':
            case 'malloc':
            case 'operator.new':
            case 'xmalloc':
                return this.processAllocationCall(callInst, currentBlock);

            case "napi_create_error":
            case "napi_create_type_error":
            case "napi_create_range_error":
            case "napi_throw":
            case "napi_throw_error":
            case "napi_throw_type_error":
            case "napi_throw_range_error":
                return this.processErrorThrowCall(callInst, currentBlock);
                
            case 'OH_LOG_Print':
                return this.processLogPrintCall(callInst, currentBlock);
                
            default:
                this.logger.warn(`Unhandled call target: ${target}`);
                return currentBlock;
        }
    }
    
    /**
     * 找到特定索引对应的所有返回值变量
     */
    // private findAllReturnValuesByIndex(callInst: IRCallInstruction, index: string): IRVariable[] {
    //     return callInst.getAllReturnValuesByIndex(index);
    // }
    
    /**
     * 找到特定索引对应的返回值变量
     */
    private findReturnValueByIndex(callInst: IRCallInstruction, index: string): IRVariable | undefined {
        return callInst.getReturnValueByIndex(index);
    }
    
    /**
     * 处理创建数值的调用
     * cpp vlaue -> arkts value
     */
    private processNumberCreationCall(callInst: IRCallInstruction, currentBlock: BasicBlock): BasicBlock {
        // 获取第二个操作数（要创建的值）
        const operands = callInst.getOperands();
        if (operands.length < 2) {
            this.logger.warn(`Invalid number of operands for ${callInst.getTarget()}`);
            return currentBlock;
        }
        
        const cppNumberIrValue = operands[1];
        
        // 获取或创建操作数对应的Value
        const cppNumberValue = this.getOrCreateValueForIrValue(cppNumberIrValue, currentBlock);
        if (!cppNumberValue) {
            this.logger.warn(`Failed to get value for operand ${cppNumberIrValue.getName()}`);
            return currentBlock;
        }
        
        // 查找索引为"2"的返回值（通常是返回的数值对象）
        const arktsNumberIrValue = this.findReturnValueByIndex(callInst, "2");
        if (arktsNumberIrValue) {
            // 如果值是常量，创建一个新的Local
            if (cppNumberValue instanceof NumberConstant) {
                const local = new Local(`%number_${this.constIdCounter++}`, cppNumberValue.getType());
                const assignStmt = new ArkAssignStmt(local, cppNumberValue);
                local.setDeclaringStmt(assignStmt);

                currentBlock.addStmt(assignStmt);
                
                // 设置结果变量的Value
                arktsNumberIrValue.setArktsValue(local);
                
                // 添加到varLocalMap
                this.varLocalMap.set(arktsNumberIrValue.getName(), local);
            }
            
            
            // 如果值是Local，也添加到varLocalMap
            if (cppNumberValue instanceof Local) {
                // 设置结果变量的Value
                arktsNumberIrValue.setArktsValue(cppNumberValue);
                this.varLocalMap.set(arktsNumberIrValue.getName(), cppNumberValue);
            }
        }
        
        return currentBlock;
    }
    
    /**
     * 处理提取数值的调用
     * arkts value -> cpp value
     */
    private processNumberExtractionCall(callInst: IRCallInstruction, currentBlock: BasicBlock): BasicBlock {
        const operands = callInst.getOperands();
        if (operands.length < 3) {
            this.logger.warn(`Invalid number of operands for ${callInst.getTarget()}`);
            return currentBlock;
        }
        
        // 获取数值操作数和目标操作数
        const arktsNumberIrValue = operands[1];
        const cppNumberIrValue = operands[2];
        
        // 获取值操作数对应的Value，这里应该是Local
        const arktsNumberValue = this.getOrCreateValueForIrValue(arktsNumberIrValue, currentBlock);
        if (!arktsNumberValue) {
            this.logger.warn(`Failed to create Local for operand ${arktsNumberIrValue.getName()}`);
            return currentBlock;
        }
        
        // 获取目标操作数对应的Value
        const targetLocal = this.getOrCreateValueForIrValue(cppNumberIrValue, currentBlock);
        if (targetLocal) {
            // 创建赋值语句将值赋给目标
            const assignStmt = new ArkAssignStmt(targetLocal, arktsNumberValue);
            currentBlock.addStmt(assignStmt);
        }
        
        // 查找索引为"2"的返回值（通常是存储提取的数值） 
        // TODO: 这里操作其实不必要
        const resultVar = this.findReturnValueByIndex(callInst, "2");
        if (resultVar) {
            resultVar.setArktsValue(arktsNumberValue);
            
            // 如果值是Local，也添加到varLocalMap
            if (arktsNumberValue instanceof Local) {
                this.varLocalMap.set(resultVar.getName(), arktsNumberValue);
            }
        }
        
        return currentBlock;
    }
    
    /**
     * 处理创建字符串的调用
     * cpp value -> arkts value
     */
    private processStringCreationCall(callInst: IRCallInstruction, currentBlock: BasicBlock): BasicBlock {
        const operands = callInst.getOperands();
        if (operands.length < 2) {
            this.logger.warn(`Invalid number of operands for ${callInst.getTarget()}`);
            return currentBlock;
        }
        
        // 获取字符串操作数
        const stringOperand = operands[1];
        
        // 获取或创建字符串操作数对应的Value
        const stringValue = this.getOrCreateValueForIrValue(stringOperand, currentBlock);
        if (!stringValue) {
            this.logger.warn(`Failed to create value for operand ${stringOperand.getName()}`);
            return currentBlock;
        }
        
        // 查找索引为"3"的返回值（通常是字符串对象）
        const resultVar = this.findReturnValueByIndex(callInst, "3");
        if (resultVar) {
            if (stringValue instanceof StringConstant) {
                // 如果是字符串常量，创建一个新的Local
                const local = new Local(`%string_${this.constIdCounter++}`, StringType.getInstance());
                const assignStmt = new ArkAssignStmt(local, stringValue);
                local.setDeclaringStmt(assignStmt);
                currentBlock.addStmt(assignStmt);
                
                // 设置结果变量的Value
                resultVar.setArktsValue(local);
                
                // 添加到varLocalMap
                this.varLocalMap.set(resultVar.getName(), local);
            }
            
            // 如果值是Local，也添加到varLocalMap
            if (stringValue instanceof Local) {
                resultVar.setArktsValue(stringValue);
                this.varLocalMap.set(resultVar.getName(), stringValue);
            }
        }
        
        return currentBlock;
    }
    
    /**
     * 处理提取字符串的调用
     * arkts value -> cpp value
     */
    private processStringExtractionCall(callInst: IRCallInstruction, currentBlock: BasicBlock): BasicBlock {
        const operands = callInst.getOperands();
        if (operands.length < 3) {
            this.logger.warn(`Invalid number of operands for ${callInst.getTarget()}`);
            return currentBlock;
        }
        
        // 获取字符串操作数和目标操作数
        const arktsStringOperand = operands[1];
        const cppStringOperand = operands[2];
        
        // 获取字符串操作数对应的Value
        const stringValue = this.getOrCreateValueForIrValue(arktsStringOperand, currentBlock);
        if (!stringValue) {
            this.logger.warn(`Failed to create value for operand ${arktsStringOperand.getName()}`);
            return currentBlock;
        }
        
        // 获取目标操作数对应的Value
        const targetValue = this.getOrCreateValueForIrValue(cppStringOperand, currentBlock);
        if (targetValue && !(targetValue instanceof NullConstant)) {
            // 如果目标不是NullType，创建赋值语句将字符串赋给目标
            // 创建赋值语句将字符串赋给目标
            const assignStmt = new ArkAssignStmt(targetValue, stringValue);
            currentBlock.addStmt(assignStmt);
            
            // 查找索引为"2"的返回值（通常是提取的字符串）
            // TODO: 这里操作其实不必要
            const stringResultVar = this.findReturnValueByIndex(callInst, "2");
            if (stringResultVar) {
                stringResultVar.setArktsValue(stringValue);
                
                // 如果值是Local，也添加到varLocalMap
                if (stringValue instanceof Local) {
                    this.varLocalMap.set(stringResultVar.getName(), stringValue);
                }
            }
        }
        

        
        // 查找索引为"4"的返回值（通常是字符串长度）
        const lengthResultVar = this.findReturnValueByIndex(callInst, "4");
        if (lengthResultVar) {
            // 为长度创建一个数字类型的Local
            const lengthLocal = new Local(`%length_${this.constIdCounter++}`, NumberType.getInstance());
              // 暂时使用一个固定值作为长度（实际应该计算）
            const stringClassSignature = new ClassSignature("String", new FileSignature("ES2015", "BuiltinClass"), null);
            const fieldSignature = new FieldSignature("length", stringClassSignature, NumberType.getInstance(), false);
            const refExpr = new ArkInstanceFieldRef(stringValue as Local, fieldSignature);
            const lengthAssignStmt = new ArkAssignStmt(lengthLocal, refExpr);
            lengthLocal.setDeclaringStmt(lengthAssignStmt);
            currentBlock.addStmt(lengthAssignStmt);

            
            lengthResultVar.setArktsValue(lengthLocal);
            this.varLocalMap.set(lengthResultVar.getName(), lengthLocal);
        }
        
        return currentBlock;
    }
    
    /**
     * 处理布尔值相关的调用
     */
    private processBooleanCall(callInst: IRCallInstruction, currentBlock: BasicBlock): BasicBlock {
        const target = callInst.getTarget();
        const operands = callInst.getOperands();
        
        if (target === 'napi_get_boolean') {
            // cpp value -> arkts value
            if (operands.length < 2) {
                this.logger.warn(`Invalid number of operands for ${target}`);
                return currentBlock;
            }
            
            // 获取布尔值操作数
            const boolOperand = operands[1];
            
            // 创建布尔值对应的Value
            const boolValue = this.getOrCreateValueForIrValue(boolOperand, currentBlock);
            if (!boolValue) {
                this.logger.warn(`Failed to create value for operand ${boolOperand.getName()}`);
                return currentBlock;
            }
            
            // 查找索引为"2"的返回值（通常是布尔值对象）
            const resultVar = this.findReturnValueByIndex(callInst, "2");
            if (resultVar) {
                if (boolValue instanceof NumberConstant) {
                    // 如果是布尔值常量，创建一个新的Local
                    const local = new Local(`%bool_${this.constIdCounter++}`, BooleanType.getInstance());
                    const assignStmt = new ArkAssignStmt(local, boolValue);
                    currentBlock.addStmt(assignStmt);
                    local.setDeclaringStmt(assignStmt);
                    
                    // 设置结果变量的Value
                    resultVar.setArktsValue(local);
                    
                    // 添加到varLocalMap
                    this.varLocalMap.set(resultVar.getName(), local);
                }
                
                // 如果值是Local，也添加到varLocalMap
                if (boolValue instanceof Local) {
                    resultVar.setArktsValue(boolValue);
                    this.varLocalMap.set(resultVar.getName(), boolValue);
                }
            }
        } else if (target === 'napi_get_value_bool') {
            // arkts value -> cpp value
            if (operands.length < 3) {
                this.logger.warn(`Invalid number of operands for ${target}`);
                return currentBlock;
            }
            
            // 获取布尔值操作数
            const boolOperand = operands[1];
            
            // 获取布尔值操作数对应的Value
            const boolValue = this.getOrCreateValueForIrValue(boolOperand, currentBlock);
            if (!boolValue) {
                this.logger.warn(`Failed to create value for operand ${boolOperand.getName()}`);
                return currentBlock;
            }
            
            // 查找索引为"2"的返回值（通常是提取的布尔值）
            const resultVar = this.findReturnValueByIndex(callInst, "2");
            if (resultVar) {
                resultVar.setArktsValue(boolValue);
                
                // 如果值是Local，也添加到varLocalMap
                if (boolValue instanceof Local) {
                    this.varLocalMap.set(resultVar.getName(), boolValue);
                }
            }
        }
        
        return currentBlock;
    }
    
    /**
     * 处理特殊常量（undefined/null）调用
     */
    private processSpecialConstantCall(callInst: IRCallInstruction, currentBlock: BasicBlock): BasicBlock {
        const target = callInst.getTarget();
        
        // 创建对应的常量
        let constant: Constant | null = null;
        if (target === 'napi_get_undefined') {
            constant = ValueUtil.getUndefinedConst();
        } else if (target === 'napi_get_null') {
            constant = ValueUtil.getNullConstant();
        }
        
        if (!constant) {
            this.logger.warn(`Failed to create constant for ${target}`);
            return currentBlock;
        }
        
        // 查找索引为"1"的返回值（通常是undefined/null常量）
        const resultVar = this.findReturnValueByIndex(callInst, "1");
        if (resultVar) {
            const local = new Local(`%const_${this.constIdCounter++}`, constant.getType());
            const assignStmt = new ArkAssignStmt(local, constant);
            currentBlock.addStmt(assignStmt);
            local.setDeclaringStmt(assignStmt);
            
            resultVar.setArktsValue(local);
            this.varLocalMap.set(resultVar.getName(), local);
        }
        
        return currentBlock;
    }

    /**
     * 处理数组相关的调用
     */
    private processArrayFunctionCall(callInst: IRCallInstruction, currentBlock: BasicBlock): BasicBlock {
        const target = callInst.getTarget();
        if(target === "napi_create_array"){
            const resultVar = this.findReturnValueByIndex(callInst, "1");
            if(resultVar){
                let arrayType = new ArrayType(AnyType.getInstance(), 1);
                const local = new Local(`%array_${this.constIdCounter++}`, arrayType);
                // 创建对应赋值语句
                const newArray = new ArkNewArrayExpr(arrayType, ValueUtil.getOrCreateNumberConst(0), true); // TODO: 不确定fromliteral是什么意思
                const assignStmt = new ArkAssignStmt(local, newArray);
                local.setDeclaringStmt(assignStmt);
                currentBlock.addStmt(assignStmt);

                resultVar.setArktsValue(local);
                this.varLocalMap.set(resultVar.getName(), local);
            }
        }
        else if(target === "napi_create_array_with_length"){
            // TODO 实现的不正确
            const operands = callInst.getOperands();
            
            if(operands.length < 2){
                this.logger.warn(`Invalid number of operands for ${target}`);
                return currentBlock;
            }
            const lengthOperand = operands[1];
            const lengthValue = this.getOrCreateValueForIrValue(lengthOperand, currentBlock);
            if(!lengthValue){
                this.logger.warn(`Failed to create value for operand ${lengthOperand.getName()}`);
                return currentBlock;
            }
            const resultVar = this.findReturnValueByIndex(callInst, "1");
            if(resultVar){
                let arrayType = new ArrayType(AnyType.getInstance(), 1);
                const local = new Local(`%array_${this.constIdCounter++}`, arrayType);

                // 创建对应赋值语句
                const newArray = new ArkNewArrayExpr(arrayType, lengthValue, true); // TODO: 不确定fromliteral是什么意思
                const assignStmt = new ArkAssignStmt(local, newArray);
                local.setDeclaringStmt(assignStmt);
                currentBlock.addStmt(assignStmt);

                resultVar.setArktsValue(local);
                this.varLocalMap.set(resultVar.getName(), local);
            }
        }
        else if(target === "napi_get_array_length"){
            // length -> cpp value
            // 用field reference来获取length
            const operands = callInst.getOperands();
            if(operands.length < 2){
                this.logger.warn(`Invalid number of operands for ${target}`);
                return currentBlock;
            }
            const arrayOperand = operands[1];
            const arrayValue = this.getOrCreateValueForIrValue(arrayOperand, currentBlock) as Local;
            if(!arrayValue){
                this.logger.warn(`Failed to create value for operand ${arrayOperand.getName()}`);
                return currentBlock;
            }

            const resultVar = this.findReturnValueByIndex(callInst, "2");
            if(resultVar){
                const local = new Local(`%array_length_${this.constIdCounter++}`, NumberType.getInstance());                const arrayClassSignature = new ClassSignature("Array", new FileSignature("ES2015", "BuiltinClass"), null);
                const fieldSignature = new FieldSignature("length", arrayClassSignature, NumberType.getInstance(), false);
                const refExpr = new ArkInstanceFieldRef(arrayValue, fieldSignature);
                const assignStmt = new ArkAssignStmt(local, refExpr);
                currentBlock.addStmt(assignStmt);
                local.setDeclaringStmt(assignStmt);
                
                resultVar.setArktsValue(local);
                this.varLocalMap.set(resultVar.getName(), local);
            }
        }
        else if(target === "napi_is_array"){
            // 运用instanceof判断是否是数组
            const operands = callInst.getOperands();
            if (operands.length < 2) {
                this.logger.warn(`Invalid number of operands for ${target}`);
                return currentBlock;
            }

            const arrayOperand = operands[1];
            const arrayValue = this.getOrCreateValueForIrValue(arrayOperand, currentBlock) as Local;
            if(!arrayValue){
                this.logger.warn(`Failed to create value for operand ${arrayOperand.getName()}`);
                return currentBlock;
            }

            const isArrayReturnVar = this.findReturnValueByIndex(callInst, "1");
            if(isArrayReturnVar){
                const local = new Local(`%is_array_${this.constIdCounter++}`, BooleanType.getInstance());
                const instanceofExpr = new ArkInstanceOfExpr(arrayValue, new ArrayType(AnyType.getInstance(), 1));  // TODO: 这里的类型是否需要宽泛
                const assignStmt = new ArkAssignStmt(local, instanceofExpr);
                local.setDeclaringStmt(assignStmt);
                currentBlock.addStmt(assignStmt);
                
                this.varLocalMap.set(isArrayReturnVar.getName(), local);
                isArrayReturnVar.setArktsValue(local);
            }
        }
        return currentBlock;
    }

    /**
     * 处理数组元素相关的调用
     */
    private processArrayElementCall(callInst: IRCallInstruction, currentBlock: BasicBlock): BasicBlock {
        const target = callInst.getTarget();
        const operands = callInst.getOperands();
        if(operands.length < 3){
            this.logger.warn(`Invalid number of operands for ${target}`);
            return currentBlock;
        }

        if(target === "napi_set_element"){
            const objectOperand = operands[1];
            const indexOperand = operands[2];
            const valueOperand = operands[3];
            const objectValue = this.getOrCreateValueForIrValue(objectOperand, currentBlock);
            if(!objectValue){
                this.logger.warn(`Failed to create Local for operand ${objectOperand.getName()}`);
                return currentBlock;
            }
            const indexValue = this.getOrCreateValueForIrValue(indexOperand, currentBlock);
            if(!indexValue){
                this.logger.warn(`Failed to create Local for operand ${indexOperand.getName()}`);
                return currentBlock;
            }
            const valueValue = this.getOrCreateValueForIrValue(valueOperand, currentBlock);
            if(!valueValue){
                this.logger.warn(`Failed to create Local for operand ${valueOperand.getName()}`);
                return currentBlock;
            }
            
            const arrayRef = new ArkArrayRef(objectValue as Local, indexValue);
            const assignStmt = new ArkAssignStmt(arrayRef, valueValue);
            currentBlock.addStmt(assignStmt);
            
        }
        else if(target === "napi_get_element"){
            const objectOperand = operands[1];
            const indexOperand = operands[2];
            const objectValue = this.getOrCreateValueForIrValue(objectOperand, currentBlock);
            if(!objectValue){
                this.logger.warn(`Failed to create Local for operand ${objectOperand.getName()}`);
                return currentBlock;
            }
            const indexValue = this.getOrCreateValueForIrValue(indexOperand, currentBlock);
            if(!indexValue){
                this.logger.warn(`Failed to create Local for operand ${indexOperand.getName()}`);
                return currentBlock;
            }
            const resultVar = this.findReturnValueByIndex(callInst, "3");
            // 怎么处理indexlocal
            if(resultVar){
                const local = new Local(`%get_element_${this.constIdCounter++}`, AnyType.getInstance()); // TODO: 暂时设为AnyType，可能需要改进
                const arrayRef = new ArkArrayRef(objectValue as Local, indexValue);
                const assignStmt = new ArkAssignStmt(local, arrayRef);
                local.setDeclaringStmt(assignStmt);
                currentBlock.addStmt(assignStmt);
                this.varLocalMap.set(resultVar.getName(), local);
                resultVar.setArktsValue(local);
            }
        }
        else if(target === "napi_has_element"){
            // TODO: 实现检查元素是否存在
        }
        else if(target === "napi_delete_element"){
            // TODO: 实现删除元素
            // 好像可以用ArkDeleteExpr来实现
        }
        
        return currentBlock;
    }
    
    
    /**
     * 处理内存分配调用
     */
    private processAllocationCall(callInst: IRCallInstruction, currentBlock: BasicBlock): BasicBlock {
        // 内存分配通常创建字符串缓冲区
        // 查找索引为"-1"的返回值（通常是分配的内存指针）
        const resultVar = this.findReturnValueByIndex(callInst, "-1");
        if (resultVar) {
            // 创建一个新的字符串类型的Local
            const local = new Local(`%alloc_${this.constIdCounter++}`, StringType.getInstance());
            
            
            // 创建一个空字符串常量
            const emptyString = ValueUtil.createStringConst("");
            const assignStmt = new ArkAssignStmt(local, emptyString);
            local.setDeclaringStmt(assignStmt);
            currentBlock.addStmt(assignStmt);
            
            resultVar.setArktsValue(local);
            this.varLocalMap.set(resultVar.getName(), local);
        }
        
        return currentBlock;
    }

    /**
     * 处理强制转换调用
     */
    private processCoerceCall(callInst: IRCallInstruction, currentBlock: BasicBlock): BasicBlock {

        
        return currentBlock;
    }

    /**
     * 处理对象相关调用
     */
    private processObjectInst(callInst: IRCallInstruction, currentBlock: BasicBlock): BasicBlock {
        const target = callInst.getTarget();
        const operands = callInst.getOperands();
        if (target === 'napi_get_prototype') {
            const objectOperand = operands[1];
            const objectValue = this.getOrCreateValueForIrValue(objectOperand, currentBlock);
            if(!objectValue){
                this.logger.warn(`Failed to create Local for operand ${objectOperand.getName()}`);
                return currentBlock;
            }
            // 找到objectValue在参数的index
            const paramIndex = this.paramIndexMap.get(objectValue as Local);
            
            if(paramIndex === undefined){
                this.logger.warn(`Failed to find param index for operand ${objectOperand.getName()}`);
                return currentBlock;
            }
            const resultVar = this.findReturnValueByIndex(callInst, "1");
            if(resultVar){
                const tmplocal = new Local(`%tmp_${this.constIdCounter++}`, UnknownType.getInstance());
                // 创建一个ArkInstanceFieldRef，base为objectValue，field在函数参数中获取
                const filedtype = this.arkMethod.getSignature().getMethodSubSignature().getParameters()[paramIndex].getType();
                const fileddeclaringSignature = (filedtype as ClassType).getClassSignature();
                const fieldSignature = new FieldSignature("constructor", fileddeclaringSignature, filedtype, false);
                const fieldRef = new ArkInstanceFieldRef(objectValue as Local, fieldSignature);
                const assignStmt = new ArkAssignStmt(tmplocal, fieldRef);
                currentBlock.addStmt(assignStmt);
                tmplocal.setDeclaringStmt(assignStmt);
                
                // 创建一个ArkAssignStmt，将tmplocal赋值给resultVar
                const resultLocal = new Local(`%result_${this.constIdCounter++}`, UnknownType.getInstance());
                const defaultClassSignature = ClassSignature.DEFAULT;
                const prototypefieldSignature = new FieldSignature("prototype", defaultClassSignature, UnknownType.getInstance(), false);
                const fieldRef2 = new ArkInstanceFieldRef(tmplocal, prototypefieldSignature);
                const assignStmt2 = new ArkAssignStmt(resultLocal, fieldRef2);
                currentBlock.addStmt(assignStmt2);
                resultLocal.setDeclaringStmt(assignStmt2);
                
                resultVar.setArktsValue(resultLocal);
                this.varLocalMap.set(resultVar.getName(), resultLocal);
                
            }

        }
        else if (target === 'napi_create_object') {
            // arkts不允许创建默认对象
            // Object literal must correspond to some explicitly declared class or interface (arkts-no-untyped-obj-literals)
            // 但是还是弄一下吧
            const resultVar = this.findReturnValueByIndex(callInst, "1");
            if (resultVar) {
                // 创建 ES2015 Object 类型的签名
                const fileSignature = new FileSignature("ES2015", "BuiltinClass");
                const classSignature = new ClassSignature("Object", fileSignature, null);
                const objectType = new ClassType(classSignature, undefined);
                
                const tmplocal = new Local(`%tmp_${this.constIdCounter++}`, objectType);
                
                // 创建新对象实例表达式
                const newExpr = new ArkNewExpr(objectType);
                
                const assignStmt = new ArkAssignStmt(tmplocal, newExpr);
                tmplocal.setDeclaringStmt(assignStmt);
                currentBlock.addStmt(assignStmt);
                
                resultVar.setArktsValue(tmplocal);
                this.varLocalMap.set(resultVar.getName(), tmplocal);

                // 创建invokeExpr
                // 创建方法签名
                const methodSubSignature = new MethodSubSignature(
                    "constructor",  
                    [],  
                    objectType,  
                    false  
                );
                const methodSignature = new MethodSignature(classSignature, methodSubSignature);
                
                // 创建实例调用表达式
                const constructorInvokeExpr = new ArkInstanceInvokeExpr(
                    tmplocal,  
                    methodSignature,  
                    [] 
                );
                
                // 创建调用语句
                const invokeStmt = new ArkInvokeStmt(constructorInvokeExpr);
                currentBlock.addStmt(invokeStmt);

                // 给resultVar创建对应local
                const resultLocal = new Local(`%result_${this.constIdCounter++}`, objectType);
                // 赋值tmplocal给resultLocal
                const assignStmt2 = new ArkAssignStmt(resultLocal, tmplocal);
                currentBlock.addStmt(assignStmt2);
                resultLocal.setDeclaringStmt(assignStmt2);

                resultVar.setArktsValue(resultLocal);
                this.varLocalMap.set(resultVar.getName(), resultLocal);
            }
        }
        else if (target === 'napi_get_property_names') {
            const objectOperand = operands[1];
            const resultOperand = this.findReturnValueByIndex(callInst, "2");
            const objectValue = this.getOrCreateValueForIrValue(objectOperand, currentBlock);
            if (!objectValue) {
                this.logger.warn(`Failed to create Local for operand ${objectOperand.getName()}`);
                return currentBlock;
            }
            if (resultOperand) {
                const resultLocal = new Local(`%result_${this.constIdCounter++}`, UnknownType.getInstance());
                // 创建方法签名
                const fileSignature = new FileSignature("ES2015", "BuiltinClass");
                const classSignature = new ClassSignature("Object", fileSignature, null);
                const methodSubSignature = new MethodSubSignature(
                    "keys",
                    [],  // 无参数
                    UnknownType.getInstance(),  // 返回类型
                    false  // 非静态方法
                );
                const methodSignature = new MethodSignature(classSignature, methodSubSignature);

                // 创建静态调用表达式
                const staticInvokeExpr = new ArkStaticInvokeExpr(
                    methodSignature,
                    [objectValue]  
                );

                // 创建赋值语句
                const assignStmt = new ArkAssignStmt(resultLocal, staticInvokeExpr);
                resultLocal.setDeclaringStmt(assignStmt);
                currentBlock.addStmt(assignStmt);
                
                resultOperand.setArktsValue(resultLocal);
                this.varLocalMap.set(resultOperand.getName(), resultLocal);
            }

        }
        else if (target === 'napi_set_property') {
            const objectOperand = operands[1];
            const propertyOperand = operands[2];
            const valueOperand = operands[3];
            const objectValue = this.getOrCreateValueForIrValue(objectOperand, currentBlock);
            if (!objectValue) {
                this.logger.warn(`Failed to create Local for operand ${objectOperand.getName()}`);
                return currentBlock;
            }
            const propertyValue = this.getOrCreateValueForIrValue(propertyOperand, currentBlock);
            if (!propertyValue) {
                this.logger.warn(`Failed to create Local for operand ${propertyOperand.getName()}`);
                return currentBlock;
            }
            const valueValue = this.getOrCreateValueForIrValue(valueOperand, currentBlock);
            if (!valueValue) {
                this.logger.warn(`Failed to create Local for operand ${valueOperand.getName()}`);
                return currentBlock;
            }
            // 尝试获取字段名称
            let fieldName: string | null = null;
            if (propertyValue instanceof StringConstant) {
                // 如果propertyValue是字符串常量，直接使用它的值
                fieldName = propertyValue.getValue();
            }
            else{
                fieldName = this.traceStringLiteralValueInBlock(propertyValue, currentBlock);
            }
            if (!fieldName) {
                this.logger.warn(`Failed to trace string literal value for operand ${propertyOperand.getName()}`);
                return currentBlock;
            }
            // 创建一个fieldSignature
            const filedtype = valueValue.getType();
            const fileddeclaringSignature = (objectValue.getType() as ClassType).getClassSignature();
            const fieldSignature = new FieldSignature(fieldName, fileddeclaringSignature, filedtype, false);
            // InstanceFieldRef
            const instanceFieldRef = new ArkInstanceFieldRef(objectValue as Local, fieldSignature);
            // AssignStmt
            const assignStmt = new ArkAssignStmt(instanceFieldRef, valueValue);
            currentBlock.addStmt(assignStmt);

        }
        else if (target === 'napi_get_property') {
            const objectOperand = operands[1];
            const keyOperand = operands[2];
            const resultOperand = this.findReturnValueByIndex(callInst, "3");
            const objectValue = this.getOrCreateValueForIrValue(objectOperand, currentBlock);
            const keyValue = this.getOrCreateValueForIrValue(keyOperand, currentBlock);
            if (!objectValue) {
                this.logger.warn(`Failed to create Local for operand ${objectOperand.getName()}`);
                return currentBlock;
            }
            if (!keyValue) {
                this.logger.warn(`Failed to create Local for operand ${keyOperand.getName()}`);
                return currentBlock;
            }
            if (resultOperand) {
                const resultLocal = new Local(`%result_${this.constIdCounter++}`, AnyType.getInstance());
                 // 尝试获取字段名称
                let fieldName: string | null = null;
                if (keyValue instanceof StringConstant) {
                    // 如果keyValue是字符串常量，直接使用它的值
                    fieldName = keyValue.getValue();
                }
                else{
                    fieldName = this.traceStringLiteralValueInBlock(keyValue, currentBlock);
                }
                if (!fieldName) {
                    this.logger.warn(`Failed to trace string literal value for operand ${keyOperand.getName()}`);
                    return currentBlock;
                }
                // 创建字段签名
                // 创建一个fieldSignature
                const filedtype = UnknownType.getInstance(); // 暂时设为UnknownType，可能需要改进
                const fileddeclaringSignature = (objectValue.getType() as ClassType).getClassSignature();
                const fieldSignature = new FieldSignature(fieldName, fileddeclaringSignature, filedtype, false);
                
                // 创建字段引用
                const fieldRef = new ArkInstanceFieldRef(objectValue as Local, fieldSignature);
                
                // 创建赋值语句
                const assignStmt = new ArkAssignStmt(resultLocal, fieldRef);
                resultLocal.setDeclaringStmt(assignStmt);
                currentBlock.addStmt(assignStmt);
                
                // 更新变量映射
                resultOperand.setArktsValue(resultLocal);
                this.varLocalMap.set(resultOperand.getName(), resultLocal);
            }
        }
        else if (target === 'napi_has_property') {
            const objectOperand = operands[1];
            const keyOperand = operands[2];
            const resultOperand = this.findReturnValueByIndex(callInst, "3");
            const objectValue = this.getOrCreateValueForIrValue(objectOperand, currentBlock);
            const keyValue = this.getOrCreateValueForIrValue(keyOperand, currentBlock);
            if (!objectValue) {
                this.logger.warn(`Failed to create Local for operand ${objectOperand.getName()}`);
                return currentBlock;
            }
            if (!keyValue) {
                this.logger.warn(`Failed to create Local for operand ${keyOperand.getName()}`);
                return currentBlock;
            }
            if (resultOperand) {
                const tmplocal = new Local(`%tmp_${this.constIdCounter++}`, UnknownType.getInstance());
                
                // 创建方法签名
                const fileSignature = new FileSignature("ES2015", "BuiltinClass");
                const classSignature = new ClassSignature("Object", fileSignature, null);
                const methodSubSignature = new MethodSubSignature(
                    "keys",
                    [],  // 无参数
                    UnknownType.getInstance(),  // 返回类型
                    false  // 非静态方法
                );
                const methodSignature = new MethodSignature(classSignature, methodSubSignature);

                // 创建静态调用表达式
                const staticInvokeExpr = new ArkStaticInvokeExpr(
                    methodSignature,
                    [objectValue]  
                );

                // 创建赋值语句
                const assignStmt = new ArkAssignStmt(tmplocal, staticInvokeExpr);
                tmplocal.setDeclaringStmt(assignStmt);
                currentBlock.addStmt(assignStmt);

                // 创建结果变量
                const resultLocal = new Local(`%result_${this.constIdCounter++}`, BooleanType.getInstance());
                const includesMethodSubSignature = new MethodSubSignature(
                    "includes",
                    [],  // 参数列表为空
                    BooleanType.getInstance(),  // 返回布尔类型
                    false  // 非静态方法
                );
                const includesMethodSignature = new MethodSignature(ClassSignature.DEFAULT, includesMethodSubSignature);

                // 创建实例调用表达式
                const includesInvokeExpr = new ArkInstanceInvokeExpr(
                    tmplocal,  // base是刚创建的tmplocal
                    includesMethodSignature,  // 方法签名
                    [keyValue]  // 参数是keyValue
                );

                // 创建赋值语句
                const assignStmt2 = new ArkAssignStmt(resultLocal, includesInvokeExpr);
                resultLocal.setDeclaringStmt(assignStmt2);
                currentBlock.addStmt(assignStmt2);

                // 更新变量映射
                resultOperand.setArktsValue(resultLocal);
                this.varLocalMap.set(resultOperand.getName(), resultLocal);
            }
        }
        else if (target === 'napi_delete_property') {
            
            const objectOperand = operands[1];  // 获取对象操作数
            const keyOperand = operands[2];     // 获取键操作数
            
            // 获取对象和键的值
            const objectValue = this.getOrCreateValueForIrValue(objectOperand, currentBlock);
            const keyValue = this.getOrCreateValueForIrValue(keyOperand, currentBlock);
            
            if (!objectValue || !keyValue) {
                this.logger.warn(`Failed to create Local for operands in napi_delete_property`);
                return currentBlock;
            }
             // 尝试获取字段名称
            let fieldName: string | null = null;
            if (keyValue instanceof StringConstant) {
                // 如果keyValue是字符串常量，直接使用它的值
                fieldName = keyValue.getValue();
            }
            else{
                fieldName = this.traceStringLiteralValueInBlock(keyValue, currentBlock);
            }
            if (!fieldName) {
                this.logger.warn(`Failed to trace string literal value for operand ${keyOperand.getName()}`);
                return currentBlock;
            }
            // 创建字段签名
            const fieldSignature = new FieldSignature(
                fieldName,  // 使用键值作为字段名
                ClassSignature.DEFAULT,         // 使用默认类签名
                UnknownType.getInstance(),      // 字段类型未知
                false                          // 非静态字段
            );
            
            // 创建字段引用
            const fieldRef = new ArkInstanceFieldRef(objectValue as Local, fieldSignature);
            
            // 创建删除表达式
            const deleteExpr = new ArkDeleteExpr(fieldRef);
            
            // 创建一个临时变量来存储删除操作的结果（布尔值）
            const resultVar = this.findReturnValueByIndex(callInst, "3");
            if (resultVar) {
                const resultLocal = new Local(`%delete_result_${this.constIdCounter++}`, BooleanType.getInstance());
                const assignStmt = new ArkAssignStmt(resultLocal, deleteExpr);
                resultLocal.setDeclaringStmt(assignStmt);
                currentBlock.addStmt(assignStmt);
                
                // 更新变量映射
                resultVar.setArktsValue(resultLocal);
                this.varLocalMap.set(resultVar.getName(), resultLocal);
            }
        }
        else if (target === 'napi_has_own_property') {
            // 用于检查传入的Object是否具有自己的命名属性，不包括从原型链上继承的属性。
            // 没有必要建模

        }
        else if (target === 'napi_set_named_property') {
            // 和napi_set_property类似，只不过key是一个cpp字符串
            const objectOperand = operands[1];  // 获取对象操作数
            const propertyNameOperand = operands[2];  // 获取属性名操作数(IRStringConstant)
            const valueOperand = operands[3];    // 获取值操作数

            // 获取对应的 Value
            const objectValue = this.getOrCreateValueForIrValue(objectOperand, currentBlock);
            if (!objectValue) {
                this.logger.warn(`Failed to create Local for operand ${objectOperand.getName()}`);
                return currentBlock;
            }

            const propertyNameValue = this.getOrCreateValueForIrValue(propertyNameOperand, currentBlock);
            if (!propertyNameValue) {
                this.logger.warn(`Failed to create Local for operand ${propertyNameOperand.getName()}`);
                return currentBlock;
            }

            const valueValue = this.getOrCreateValueForIrValue(valueOperand, currentBlock);
            if (!valueValue) {
                this.logger.warn(`Failed to create Local for operand ${valueOperand.getName()}`);
                return currentBlock;
            }

             // 尝试获取字段名称
            let fieldName: string | null = null;
            if (propertyNameValue instanceof StringConstant) {
                // 如果keyValue是字符串常量，直接使用它的值
                fieldName = propertyNameValue.getValue();
            }
            else{
                fieldName = this.traceStringLiteralValueInBlock(propertyNameValue, currentBlock);
            }
            if (!fieldName) {
                this.logger.warn(`Failed to trace string literal value for operand ${propertyNameOperand.getName()}`);
                return currentBlock;
            }

            // 创建一个 fieldSignature，直接使用字符串常量的值作为字段名
            // 创建一个fieldSignature
            const filedtype = valueValue.getType();
            const fileddeclaringSignature = (objectValue.getType() as ClassType).getClassSignature();
            const fieldSignature = new FieldSignature(fieldName, fileddeclaringSignature, filedtype, false);
            // 创建实例字段引用
            const instanceFieldRef = new ArkInstanceFieldRef(objectValue as Local, fieldSignature);
            // 创建赋值语句
            const assignStmt = new ArkAssignStmt(instanceFieldRef, valueValue);
            currentBlock.addStmt(assignStmt);
        }
        else if (target === 'napi_get_named_property') {
            const objectOperand = operands[1];
            const propertyNameOperand = operands[2];  // IRStringConstant类型
            const resultOperand = this.findReturnValueByIndex(callInst, "3");
            
            const objectValue = this.getOrCreateValueForIrValue(objectOperand, currentBlock);
            if (!objectValue) {
                this.logger.warn(`Failed to create Local for operand ${objectOperand.getName()}`);
                return currentBlock;
            }

            const propertyNameValue = this.getOrCreateValueForIrValue(propertyNameOperand, currentBlock);
            if (!propertyNameValue) {
                this.logger.warn(`Failed to create Local for operand ${propertyNameOperand.getName()}`);
                return currentBlock;
            }

                         // 尝试获取字段名称
            let fieldName: string | null = null;
            if (propertyNameValue instanceof StringConstant) {
                // 如果keyValue是字符串常量，直接使用它的值
                fieldName = propertyNameValue.getValue();
            }
            else{
                fieldName = this.traceStringLiteralValueInBlock(propertyNameValue, currentBlock);
            }
            if (!fieldName) {
                this.logger.warn(`Failed to trace string literal value for operand ${propertyNameOperand.getName()}`);
                return currentBlock;
            }

            if (resultOperand) {
                const resultLocal = new Local(`%result_${this.constIdCounter++}`, AnyType.getInstance());
                
                // 创建字段签名
                // 创建一个fieldSignature
            const filedtype = UnknownType.getInstance(); // 暂时设为UnknownType，可能需要改进
            const fileddeclaringSignature = (objectValue.getType() as ClassType).getClassSignature();
            const fieldSignature = new FieldSignature(fieldName, fileddeclaringSignature, filedtype, false);
                
                // 创建字段引用
                const fieldRef = new ArkInstanceFieldRef(objectValue as Local, fieldSignature);
                
                // 创建赋值语句
                const assignStmt = new ArkAssignStmt(resultLocal, fieldRef);
                resultLocal.setDeclaringStmt(assignStmt);
                currentBlock.addStmt(assignStmt);
                
                // 更新变量映射
                resultOperand.setArktsValue(resultLocal);
                this.varLocalMap.set(resultOperand.getName(), resultLocal);
            }
        }
        else if (target === 'napi_has_named_property') {
            const objectOperand = operands[1];
            const keyOperand = operands[2];
            const resultOperand = this.findReturnValueByIndex(callInst, "3");
            const objectValue = this.getOrCreateValueForIrValue(objectOperand, currentBlock);
            if (!objectValue) {
                this.logger.warn(`Failed to create Local for operand ${objectOperand.getName()}`);
                return currentBlock;
            }
            
            const keyValue = this.getOrCreateValueForIrValue(keyOperand, currentBlock);
            if (!keyValue) {
                this.logger.warn(`Failed to create Local for operand ${keyOperand.getName()}`);
                return currentBlock;
            }

            // 尝试获取字段名称
            let fieldName: string | null = null;
            if (keyValue instanceof StringConstant) {
                // 如果keyValue是字符串常量，直接使用它的值
                fieldName = keyValue.getValue();
            }
            else{
                fieldName = this.traceStringLiteralValueInBlock(keyValue, currentBlock);
            }
            if (!fieldName) {
                this.logger.warn(`Failed to trace string literal value for operand ${keyOperand.getName()}`);
                return currentBlock;
            }

            if (resultOperand) {
                const tmplocal = new Local(`%tmp_${this.constIdCounter++}`, UnknownType.getInstance());
                
                // 创建方法签名
                const fileSignature = new FileSignature("ES2015", "BuiltinClass");
                const classSignature = new ClassSignature("Object", fileSignature, null);
                const methodSubSignature = new MethodSubSignature(
                    "keys",
                    [],  // 无参数
                    UnknownType.getInstance(),  // 返回类型
                    false  // 非静态方法
                );
                const methodSignature = new MethodSignature(classSignature, methodSubSignature);

                // 创建静态调用表达式
                const staticInvokeExpr = new ArkStaticInvokeExpr(
                    methodSignature,
                    [objectValue]  
                );

                // 创建赋值语句
                const assignStmt = new ArkAssignStmt(tmplocal, staticInvokeExpr);
                tmplocal.setDeclaringStmt(assignStmt);
                currentBlock.addStmt(assignStmt);

                // 创建结果变量
                const resultLocal = new Local(`%result_${this.constIdCounter++}`, BooleanType.getInstance());
                const includesMethodSubSignature = new MethodSubSignature(
                    "includes",
                    [],  // 参数列表为空
                    BooleanType.getInstance(),  // 返回布尔类型
                    false  // 非静态方法
                );
                const includesMethodSignature = new MethodSignature(ClassSignature.DEFAULT, includesMethodSubSignature);
                // 创建字符串常量
                const keyStringConstant = ValueUtil.createStringConst(fieldName);
                // 创建实例调用表达式
                const includesInvokeExpr = new ArkInstanceInvokeExpr(
                    tmplocal,  // base是刚创建的tmplocal
                    includesMethodSignature,  // 方法签名
                    [keyStringConstant]  // 参数是keyValue
                );

                // 创建赋值语句
                const assignStmt2 = new ArkAssignStmt(resultLocal, includesInvokeExpr);
                resultLocal.setDeclaringStmt(assignStmt2);
                currentBlock.addStmt(assignStmt2);

                // 更新变量映射
                resultOperand.setArktsValue(resultLocal);
                this.varLocalMap.set(resultOperand.getName(), resultLocal);
            }
        }
        else if (target === 'napi_get_all_property_names') {

        }
        else {
            
        }
        return currentBlock;
    }


    /**
     * 处理函数调用
     */
    private processFunctionCall(callInst: IRCallInstruction, currentBlock: BasicBlock): BasicBlock {
        // 处理函数调用
        const target = callInst.getTarget();
        const operands = callInst.getOperands();
        if(target === "napi_get_global"){
            // 获取global对象，返回值1
            // TODO 获取callsite处的上下文
            const globalVar = this.findReturnValueByIndex(callInst, "1");
            if (globalVar) {
                // 创建一个新的Local变量
                const local = new Local(GLOBAL_THIS_NAME, UnknownType.getInstance());
                const globalLocal = new Local(`%global_${this.constIdCounter++}`, UnknownType.getInstance());
                // 创建赋值语句
                const assignStmt = new ArkAssignStmt(globalLocal, local);
                local.setDeclaringStmt(assignStmt);
                currentBlock.addStmt(assignStmt);
                
                // 更新变量映射
                globalVar.setArktsValue(globalLocal);
                this.varLocalMap.set(globalVar.getName(), globalLocal);
            }
        }
        else if(target === "napi_call_function"){
            // 调用函数
            const thisOperand = operands[1];
            const thisLocal = this.getOrCreateValueForIrValue(thisOperand, currentBlock);
            const funcOperand = operands[2];
            const funcLocal = this.getOrCreateValueForIrValue(funcOperand, currentBlock);
            const argslenOperand = operands[3];
            const argsOperands = callInst.getArgsOperands();
            const resultOperand = this.findReturnValueByIndex(callInst, "5");

            if (!thisLocal || !funcLocal) {
                this.logger.warn(`Failed to create Local for operands`);
                return currentBlock;
            }

            const tmpLocal = new Local(`%tmp_${this.constIdCounter++}`, UnknownType.getInstance());            // 创建bind函数的方法签名
            const fileSignature = new FileSignature("ES2015", "BuiltinClass");
            const classSignature = new ClassSignature("Function", fileSignature, null);
            const methodSubSignature = new MethodSubSignature("bind", [], UnknownType.getInstance(), false);
            const methodSignature = new MethodSignature(classSignature, methodSubSignature);

            // 处理参数列表
            const bindArgs = [thisLocal];
            for (const argOperand of argsOperands) {
                const argLocal = this.getOrCreateValueForIrValue(argOperand, currentBlock);
                if (!argLocal) {
                    this.logger.warn(`Failed to create Local for argument ${argOperand.getName()}`);
                    continue;
                }
                bindArgs.push(argLocal);
            }

            // 有没有bind其实是一样的

            // // 创建bind函数调用表达式
            // const bindExpr = new ArkInstanceInvokeExpr(funcLocal as Local, methodSignature, bindArgs);
            
            // // 创建赋值语句
            // const bindStmt = new ArkAssignStmt(tmpLocal, bindExpr);
            // tmpLocal.setDeclaringStmt(bindStmt);
            // currentBlock.addStmt(bindStmt);


            if(funcLocal.getType() instanceof FunctionType && resultOperand){
                const funcType = funcLocal.getType() as FunctionType;
                const returnType = funcType.getMethodSignature().getMethodSubSignature().getReturnType();
                const resultLocal = new Local(`%result_${this.constIdCounter++}`, returnType);

                // 创建函数调用，staticInvokeExpr
                const callMethodSignature = funcType.getMethodSignature();
                const this_Local = thisLocal as Local;
                let callExpr: ArkInstanceInvokeExpr | ArkStaticInvokeExpr | ArkPtrInvokeExpr;
                if(this_Local.getName() === GLOBAL_THIS_NAME || this_Local.getName().startsWith("%global_")){
                    // 创建静态调用表达式
                    callExpr = new ArkStaticInvokeExpr(callMethodSignature, bindArgs.slice(1));
                }
                else{
                    // 创建实例调用表达式
                    callExpr = new ArkInstanceInvokeExpr(thisLocal as Local,callMethodSignature, bindArgs.slice(1));
                }
                
                // 创建赋值语句
                const callStmt = new ArkAssignStmt(resultLocal, callExpr);
                resultLocal.setDeclaringStmt(callStmt);
                currentBlock.addStmt(callStmt);

                // 更新resultLocal的值
                resultOperand.setArktsValue(resultLocal);
                this.varLocalMap.set(resultOperand.getName(), resultLocal);
            }
            else{
                // 创建函数调用，staticInvokeExpr
                const callMethodSubSignature = new MethodSubSignature(tmpLocal.getName(), [], UnknownType.getInstance(), false);
                const callMethodSignature = new MethodSignature(classSignature, callMethodSubSignature);

                // 创建静态调用表达式
                const callExpr = new ArkInstanceInvokeExpr(thisLocal as Local,callMethodSignature, bindArgs.slice(1));
                const callStmt = new ArkInvokeStmt(callExpr);
                currentBlock.addStmt(callStmt);
            }
        }
        return currentBlock;
    }

    /**
     * 处理日志打印调用
     */
    private processLogPrintCall(callInst: IRCallInstruction, currentBlock: BasicBlock): BasicBlock {
        // 处理日志打印调用
        // int OH_LOG_Print(LogType type, LogLevel level, unsigned int domain, const char *tag, const char *fmt, ...)
        //  type: 对于app为LOG_APP=0
        //  level: LOG_DEBUG = 3,LOG_INFO = 4,LOG_WARN = 5,LOG_ERROR = 6,LOG_FATAL = 7,
        //  domain: service domain of logs from 0x0 to 0xFFFF.
        //  tag: string
        //  fmt: string
        //  ...: 可变参数，可能是各种类型

        const operands = callInst.getOperands();
        // 首先获取日志level
        const levelOperand = operands[1] as IRNumberConstant;
        if (!levelOperand) {
            this.logger.warn(`Invalid level operand for ${callInst.getTarget()}`);
            return currentBlock;
        }

        let LogLevel = 0;
        if (levelOperand instanceof IRNumberConstant) {
            // 获取level对应的值
            LogLevel = levelOperand.getValue();
        }


        const domainOperand = operands[2];
        const domainLocal = this.getOrCreateValueForIrValue(domainOperand, currentBlock);

        if (!domainLocal) {
            this.logger.warn(`Failed to create Local for domain operand ${domainOperand.getName()}`);
            return currentBlock;
        }
        const tagOperand = operands[3];
        const tagLocal = this.getOrCreateValueForIrValue(tagOperand, currentBlock);

        if (!tagLocal) {
            this.logger.warn(`Failed to create Local for tag operand ${tagOperand.getName()}`);
            return currentBlock;
        }

        const fmtOperand = operands[4];
        const fmtLocal = this.getOrCreateValueForIrValue(fmtOperand, currentBlock);

        if (!fmtLocal) {
            this.logger.warn(`Failed to create Local for fmt operand ${fmtOperand.getName()}`);
            return currentBlock;
        }
        // 获取可变参数列表
        const varArgs = operands.slice(5).map((arg) => {
            return this.getOrCreateValueForIrValue(arg, currentBlock);
        });

        if (!varArgs || varArgs.length === 0) {
            this.logger.warn(`No variable arguments for ${callInst.getTarget()}`);
            return currentBlock;
            
        }

        let args = [domainLocal, tagLocal, fmtLocal];
        // 如果有可变参数，则将其添加到参数列表中
        for (const arg of varArgs) {
            if (arg) {
                args.push(arg);
            } else {
                this.logger.warn(`Failed to create Local for variable argument`);
            }
        }

        // 创建日志函数调用表达式
        const logFunctionCall = this.getLogFunctionInvokeExpr(LogLevel, args);
        // 创建日志函数调用语句
        const logStmt = new ArkInvokeStmt(logFunctionCall);
        currentBlock.addStmt(logStmt);

        return currentBlock;
    }

    private getLogFunctionInvokeExpr(level: number, args: Value[]): ArkStaticInvokeExpr {
        // 获取函数调用的目标方法
        
        const targetMethodSig = this.getLogFunctionSignature(level);

        const ret = new ArkStaticInvokeExpr(targetMethodSig, args);

        return ret;
    }

    private getLogFunctionSignature(level: number): MethodSignature {
        let functionName: string;
        switch (level) {
            case 3:
                functionName = "debug";
                break;
            case 4:
                functionName = "info";
                break;
            case 5:
                functionName = "warn";
                break;
            case 6:
                functionName = "error";
                break;
            case 7:
                functionName = "fatal";
                break;
            default:
                functionName = "info";
                break;
        }
        const sdkProject = 'etsSdk'
        const apiFile = 'api/@ohos.hilog.d.ts';
        const apiNS = 'hilog';
        const apiCls = '%dflt';
        const apiName = functionName;
        const fileSignature = new FileSignature(sdkProject,apiFile);
        const namespaceSignature = new NamespaceSignature(apiNS, fileSignature);
        const classSignature = new ClassSignature(apiCls, fileSignature, namespaceSignature);
        const param1 = new MethodParameter();
        param1.setName('domain');
        param1.setType(NumberType.getInstance());
        const param2 = new MethodParameter();
        param2.setName('tag');
        param2.setType(StringType.getInstance());
        const param3 = new MethodParameter();
        param3.setName('format');
        param3.setType(StringType.getInstance());
        const param4 = new MethodParameter();
        param4.setName('args');
        param4.setType(new ArrayType(AnyType.getInstance(),1));
        param4.setRestFlag(true);
        const params = [param1, param2, param3, param4];
        const methodSubSignature = new MethodSubSignature(apiName,params,VoidType.getInstance(),false);
        const targetMethodSig = new MethodSignature(classSignature, methodSubSignature);
        return targetMethodSig;
    }

    private processErrorThrowCall(callInst: IRCallInstruction, currentBlock: BasicBlock): BasicBlock {        // 处理错误抛出调用
        // 处理函数调用
        const errorFileSignature = new FileSignature("ES2015", "BuiltinClass");
        const errorClassSignature = new ClassSignature("Error", errorFileSignature, null);
        const errorType = new ClassType(errorClassSignature);
        // TODO parameter数量是0？是否不正确？
        const constructorSignature = new MethodSignature(errorClassSignature, new MethodSubSignature("constructor", [], errorType, false));

        const target = callInst.getTarget();
        const operands = callInst.getOperands();
        switch (target) {
            case "napi_create_error":
            case "napi_create_type_error":
            case "napi_create_range_error":
                // 创建错误对象
                // 分两个语句，一个是assign new，一个是instance invoke
            case "napi_throw_error":
            case "napi_throw_type_error":
            case "napi_throw_range_error":
                // 抛出错误
                // TODO
                // 分三个语句，一个是assign new，一个是instance invoke，然后是ThrowStmt

                const errCodeOperand = operands[1];
                const errCodeValue = this.getOrCreateValueForIrValue(errCodeOperand, currentBlock);
                if (!errCodeValue) {
                    this.logger.warn(`Invalid error code operand for ${target}`);
                    return currentBlock;
                }
                const messageOperand = operands[2];
                const messageValue = this.getOrCreateValueForIrValue(messageOperand, currentBlock);
                if (!messageValue) {
                    this.logger.warn(`Invalid message operand for ${target}`);
                    return currentBlock;
                }
                const errResOperand = this.findReturnValueByIndex(callInst, "3");
                if (errResOperand) {
                    // 创建错误对象的Local
                    const errLocal = new Local(`%error_${this.constIdCounter++}`, UnknownType.getInstance());
                    
                    // 创建错误对象的实例化表达式
                    const errorExpr = new ArkNewExpr(errorType);
                    
                    // 创建赋值语句
                    const assignStmt = new ArkAssignStmt(errLocal, errorExpr);
                    errLocal.setDeclaringStmt(assignStmt);
                    currentBlock.addStmt(assignStmt);
                    
                    // 更新返回值
                    errResOperand.setArktsValue(errLocal);
                    this.varLocalMap.set(errResOperand.getName(), errLocal);

                    // 然后创建实例方法调用
                    const instanceInvokeExpr = new ArkInstanceInvokeExpr(errLocal, constructorSignature, [messageValue]);
                    const invokeStmt = new ArkInvokeStmt(instanceInvokeExpr);
                    currentBlock.addStmt(invokeStmt);

                    if (target.startsWith("napi_throw")) {
                        // 如果是抛出错误的调用，创建ThrowStmt
                        const throwStmt = new ArkThrowStmt(errLocal);
                        currentBlock.addStmt(throwStmt);
                    }
                }
                break;
            case "napi_throw":
                // throw错误
                const errOperand = operands[1];
                if (!errOperand) {
                    this.logger.warn(`Invalid error operand for ${target}`);
                    return currentBlock;
                }
                const errValue = this.getOrCreateValueForIrValue(errOperand, currentBlock);
                if (!errValue) {
                    this.logger.warn(`Failed to create Local for error operand ${errOperand.getName()}`);
                    return currentBlock;
                }
                const throwStmt = new ArkThrowStmt(errValue);
                currentBlock.addStmt(throwStmt);
                break;
        }
        return currentBlock;
    }
        
    
    /**
     * 处理Phi指令
     */
    private processPhiInstruction(phiInst: IRPhiInstruction, cfg: Cfg, currentBlock: BasicBlock): BasicBlock {
        const result = phiInst.getResult();
        const operands = phiInst.getOperands();
        
        // 创建ArkPhiExpr
        const phiExpr = new ArkPhiExpr();
        
        // 为每个操作数添加到Phi表达式
        for (const operand of operands) {
            const operandLocal = this.getOrCreateValueForIrValue(operand, currentBlock);
            if (operandLocal && operandLocal instanceof Local) {
                phiExpr.getArgs().push(operandLocal);
            } else {
                this.logger.warn(`Failed to create Local for Phi operand ${operand.getName()}`);
            }
        }
        
        // 创建结果Local
        const resultType = result.getType();
        const resultLocal = new Local(result.getName(), resultType);
        
        // 创建赋值语句
        const phiStmt = new ArkAssignStmt(resultLocal, phiExpr);
        resultLocal.setDeclaringStmt(phiStmt);

        currentBlock.addStmt(phiStmt);
        
        // 更新映射
        result.setArktsValue(resultLocal);
        this.varLocalMap.set(result.getName(), resultLocal);
        
        return currentBlock;
    }
    
    /**
     * 处理Return指令
     */
    private processReturnInstruction(retInst: IRReturnInstruction, cfg: Cfg, currentBlock: BasicBlock): BasicBlock {
        const operand = retInst.getOperand();
        
        // 处理void返回
        if (operand instanceof IRTopConstant) {
            const voidReturnStmt = new ArkReturnVoidStmt();
            currentBlock.addStmt(voidReturnStmt);
            return currentBlock;
        }
        
        // 处理有值返回
        const returnLocal = this.getOrCreateValueForIrValue(operand, currentBlock);
        if (returnLocal) {
            const returnStmt = new ArkReturnStmt(returnLocal);
            currentBlock.addStmt(returnStmt);
        } else {
            // 如果无法获取值，使用void返回
            this.logger.warn(`Failed to create Local for return value ${operand.getName()}, using void return`);
            const voidReturnStmt = new ArkReturnVoidStmt();
            currentBlock.addStmt(voidReturnStmt);
        }
        
        return currentBlock;
    }
    
    /**
     * 获取或创建IRValue对应的Value，
     * 注意：仅对ArkIR的CallInst的Operand进行处理
     */
    private getOrCreateValueForIrValue(value: IRValue, currentBlock: BasicBlock): Value | null {
        // 检查IRValue是否已经关联了arktsValue
        const existingValue = value.getArktsValue();
        if (existingValue) {
            return existingValue;
        }

        // 检查变量映射
        if (this.varLocalMap.has(value.getName())) {
            const local = this.varLocalMap.get(value.getName())!;
            value.setArktsValue(local);
            return local;
        }

        // 根据不同类型创建新的Value
        let newValue: Value| null = null;

        if (value.isConstant()) {
            // 处理常量
            if (value instanceof IRNumberConstant) {
                newValue = ValueUtil.getOrCreateNumberConst(value.getValue());
            } else if (value instanceof IRStringConstant) {
                newValue = ValueUtil.createStringConst(value.getValue());
            } else if (value instanceof IRNullConstant) {
                newValue = ValueUtil.getNullConstant();
            } else if (value instanceof IRTopConstant) {
                // top通常表示无关值，返回null
            } else if (value instanceof IRNullConstant) {
                newValue = ValueUtil.getNullConstant();
            }else{
                // 默认返回null
                this.logger.warn(`Unknown constant type for ${value.toString()}, using null constant`);

            }
        } else {
            // 处理变量，创建新的Local
            const varType = value.getType();
            const local = new Local(value.getName(), varType);
            
            newValue = local;
            this.varLocalMap.set(value.getName(), local);
            
        }

        // 设置IRValue的arktsValue
        if (newValue) {
            value.setArktsValue(newValue);
        }
        
        return newValue;
    }
    /**
     * 推断Object类型的正确ClassType
     * 根据调用上下文和参数信息推断对象的实际类型
     */
    private inferObjectClassType(): Type {
        console.log("【inferObjectClassType调试】开始推断对象类型");
        
        // 尝试从调用上下文推断对象类型
        // 如果有调用表达式上下文，尝试从参数类型推断
        if (this.callsiteInvokeExpr) {
            const args = this.callsiteInvokeExpr.getArgs();
            console.log(`【inferObjectClassType调试】调用上下文参数数量: ${args.length}`);
            
            // 检查参数是否有具体的ClassType
            for (let i = 0; i < args.length; i++) {
                const arg = args[i];
                const argType = arg.getType();
                console.log(`【inferObjectClassType调试】参数${i}类型: ${argType.constructor.name}`);
                if (argType instanceof ClassType) {
                    console.log(`【inferObjectClassType调试】从调用上下文推断类型: ${argType.getClassSignature()}`);
                    this.logger.debug(`Inferred object type from call context: ${argType.getClassSignature()}`);
                    return argType;
                }
            }
        } else {
            console.log("【inferObjectClassType调试】无调用上下文");
        }
        
        // 尝试从当前方法的参数推断
        const methodParams = this.arkMethod.getSignature().getMethodSubSignature().getParameters();
        console.log(`【inferObjectClassType调试】方法参数数量: ${methodParams.length}`);
        for (let i = 0; i < methodParams.length; i++) {
            const param = methodParams[i];
            const paramType = param.getType();
            console.log(`【inferObjectClassType调试】方法参数${i}类型: ${paramType.constructor.name}`);
            if (paramType instanceof ClassType) {
                console.log(`【inferObjectClassType调试】从方法参数推断类型: ${paramType.getClassSignature()}`);
                this.logger.debug(`Inferred object type from method parameter: ${paramType.getClassSignature()}`);
                return paramType;
            }
        }
        
        // 如果无法推断出具体类型，创建一个通用的Object类型
        // 但使用正确的类签名而不是@%unk/%unk
        const fileSignature = new FileSignature("ES2015", "BuiltinClass");
        const classSignature = new ClassSignature("Object", fileSignature, null);
        const objectType = new ClassType(classSignature, undefined);
        
        console.log(`【inferObjectClassType调试】使用通用Object类型: ${classSignature}`);
        this.logger.debug(`Using generic Object type for Object: ${classSignature}`);
        return objectType;
    }

    private traceStringLiteralValueInBlock(value: Value, currentBlock: BasicBlock, visited: Set<Local> = new Set()): string | null {
        if (!(value instanceof Local)) {
            if (value instanceof StringConstant) {
                return value.getValue();
            }
            return null;
        }
        const local = value as Local;
        // 防止循环引用
        if (visited.has(local)) {
            return null;
        }
        visited.add(local);
        
        // 检查Local的类型是否为字符串
        if (!(local.getType() instanceof StringType)) {
            return null;
        }
        
        // 遍历当前基本块中的所有语句，找到对该Local的最新赋值
        const statements = currentBlock.getStmts();
        let latestAssignStmt: ArkAssignStmt | null = null;
        
        // 从后往前遍历，找到最新的赋值语句
        for (let i = statements.length - 1; i >= 0; i--) {
            const stmt = statements[i];
            if (stmt instanceof ArkAssignStmt && stmt.getLeftOp() === local) {
                latestAssignStmt = stmt;
                break;
            }
        }
        
        // 如果在当前block中没找到赋值，检查declaringStmt（用于处理参数初始化等情况）
        if (!latestAssignStmt) {
            const declaringStmt = local.getDeclaringStmt();
            if (declaringStmt && declaringStmt instanceof ArkAssignStmt) {
                latestAssignStmt = declaringStmt;
            }
        }
        
        if (!latestAssignStmt) {
            return null;
        }
        
        const rightOp = latestAssignStmt.getRightOp();
        
        // 情况1: 直接赋值字符串常量
        if (rightOp instanceof StringConstant) {
            return rightOp.getValue();
        }
        
        // 情况2: 从另一个Local赋值（递归追踪）
        if (rightOp instanceof Local) {
            return this.traceStringLiteralValueInBlock(rightOp, currentBlock, visited);
        }
        
        // 情况3: 从参数引用赋值
        if (rightOp instanceof ArkParameterRef) {
            const paramIndex = rightOp.getIndex();
            
            // 从调用点表达式中获取对应参数的值
            const args = this.callsiteInvokeExpr.getArgs();
            if (paramIndex >= 0 && paramIndex < args.length) {
                const argValue = args[paramIndex];
                
                // 如果参数是字符串常量，返回其值
                if (argValue instanceof StringConstant) {
                    return argValue.getValue();
                }
                
                // 如果参数是Local，递归追踪（需要在调用点的上下文中追踪）
                // 注意：这里可能需要访问调用点所在的BasicBlock，但目前我们只有当前BasicBlock
                // 所以暂时只处理常量情况
                this.logger.debug(`Parameter at index ${paramIndex} is not a string constant, trace failed`);
            } else {
                this.logger.warn(`Parameter index ${paramIndex} out of bounds for callsite arguments`);
            }
            
            return null;
        }
    
        // 其他情况无法追溯
        return null;
    }

    /**
     * 处理napi_get_cb_info调用
     * 这个函数比较特殊，它的索引"3"可能对应多个实际参数
     */
    // private processGetCallbackInfoCall(callInst: IRCallInstruction, currentBlock: BasicBlock): BasicBlock {
    //     // 获取env参数（通常是第一个操作数）
    //     // const envOperand = callInst.getOperands()[0];
        
    //     // 获取索引为"-1"的返回值（通常是状态码）
    //     const statusVar = this.findReturnValueByIndex(callInst, "-1");
    //     if (statusVar) {
    //         // 创建状态码Local
    //         const statusLocal = this.getOrCreateValueForIrValue(statusVar, currentBlock);
    //         if (statusLocal) {
    //             statusVar.setArktsLocal(statusLocal);
    //             this.varLocalMap.set(statusVar.getName(), statusLocal);
    //         }
    //     }
        
    //     // 获取索引为"3"的所有返回值（实际参数）
    //     const argVars = this.findAllReturnValuesByIndex(callInst, "3");
        
    //     // 为每个参数创建一个默认值Local（具体类型可能需要后续类型推断确定）
    //     argVars.forEach((argVar, index) => {
    //         const argType = this.mapValueTypeToArkType(argVar.getValueType());
    //         const argLocal = new Local(`%arg_${index}`, argType);
            
    //         // 创建一个默认值（具体值可能需要后续分析）
    //         let defaultValue: Constant;
    //         if (argType === StringType.getInstance()) {
    //             defaultValue = ValueUtil.createStringConst("");
    //         } else if (argType === NumberType.getInstance()) {
    //             defaultValue = ValueUtil.getOrCreateNumberConst(0);
    //         } else if (argType === BooleanType.getInstance()) {
    //             defaultValue = ValueUtil.getBooleanConstant(false);
    //         } else {
    //             // 其他类型默认使用null值
    //             defaultValue = ValueUtil.getNullConstant();
    //         }
            
    //         // 创建赋值语句
    //         const assignStmt = new ArkAssignStmt(argLocal, defaultValue);
    //         currentBlock.addStmt(assignStmt);
            
    //         // 设置参数变量的ArktsLocal
    //         argVar.setArktsLocal(argLocal);
    //         this.varLocalMap.set(argVar.getName(), argLocal);
            
    //         // 将参数标记为真实参数（可能需要在IRFunction中添加对应的方法）
    //         if (argVar instanceof IRVariable) {
    //             this.irFunction.addRealArg(argVar);
    //         }
    //     });
        
    //     return currentBlock;
    // }
}