import { IRFunction } from '../ir/IRFunction';
// import { IRValue } from '../ir/IRValue';
// import { ValueType } from '../ValueType';
import { Logger } from 'log4js';

import { ArkMethod } from '@ArkAnalyzer/src/core/model/ArkMethod';
import { ArkBody } from '@ArkAnalyzer/src/core/model/ArkBody';
import { Local } from '@ArkAnalyzer/src/core/base/Local';
import { ArkClass } from '@ArkAnalyzer/src/core/model/ArkClass';
import { Scene } from '@ArkAnalyzer/src/Scene';
import { MethodSignature, MethodSubSignature } from '@ArkAnalyzer/src/core/model/ArkSignature';
import { ArkSignatureBuilder } from '@ArkAnalyzer/src/core/model/builder/ArkSignatureBuilder';
import { checkAndUpdateMethod } from '@ArkAnalyzer/src/core/model/builder/ArkMethodBuilder';
import { SafeTypeInference } from './SafeTypeInference';
import { CFGBuilder } from './CFGBuilder';

import { LOG_MODULE_TYPE } from '@ArkAnalyzer/src/utils/logger';
import ConsoleLogger from '@ArkAnalyzer/src/utils/logger';
import { IRInstruction } from '../ir/IRInstruction';
import { MethodSubSignatureMap } from '../ir/JsonObjectInterface';
import { ArkInstanceInvokeExpr, ArkStaticInvokeExpr, ArkPtrInvokeExpr } from '@ArkAnalyzer/src/core/base/Expr';
import { StringType, UnknownType, FunctionType, ClassType } from '@ArkAnalyzer/src/core/base/Type';
import { MethodParameter } from '@ArkAnalyzer/src/core/model/builder/ArkMethodBuilder';
import { ArkAssignStmt, ArkInvokeStmt } from '@ArkAnalyzer/src/core/base/Stmt';
import { BasicBlock } from '@ArkAnalyzer/src/core/graph/BasicBlock';



/**
 * 负责重建函数体的类
 */
export class FunctionBodyRebuilder {
    private scene: Scene;
    private declaringClass: ArkClass;
    private irFunction: IRFunction;
    private logger: Logger;
    private functionMethod: ArkMethod;    private methodSubSignatureMap: Map<string, MethodSubSignatureMap[]>;
    private defUseMap: { [variable: string]: { definedIn: IRInstruction[]; usedIn: IRInstruction[] } }
    = {};
    private callsiteInvokeExpr: ArkInstanceInvokeExpr | ArkStaticInvokeExpr | ArkPtrInvokeExpr;
    private callsiteBlock: BasicBlock | null = null; // 调用点所在的BasicBlock
    private callsiteLocalMap: Map<string, Local> = new Map(); // 调用点相关的Local变量映射
    private convertToStaticInvoke: boolean = false; // 是否将原invokeExpr转换为static invoke
    private callsiteStmtIndex: number = -1; // 记录调用语句在BasicBlock中的位置
    private static functionNumber: number = 0; // 用于生成唯一的函数编号

    private getFunctionNumber(): number {
        return FunctionBodyRebuilder.functionNumber++;
    }

    // TODO 在functionBodyRebuilder之前
    // 需要获取调用上下文，对于传入参数为object以及Function的情况
    // 需要其ClassSignature，MethodSignature
    // 涉及到类操作以及field操作时，构建对应的FieldSignature，只有指明常量字符串才可能做到

    // 此外对于call function时，获取对应的域也很重要，staticcall时直接获取this，instancecall时需要获取对应的class
      constructor(
        scene: Scene,
        declaringClass: ArkClass,
        irFunction: IRFunction,
        methodSubSignatureMap: Map<string, MethodSubSignatureMap[]>,
        invokeExpr: ArkInstanceInvokeExpr | ArkStaticInvokeExpr | ArkPtrInvokeExpr,
        callsiteBlock?: BasicBlock,
        convertToStaticInvoke: boolean = false, // 可选功能：是否将原invokeExpr转换为static invoke
        callsiteStmtIndex: number = -1 // 记录调用语句在BasicBlock中的位置
    ) {
        this.scene = scene;
        this.declaringClass = declaringClass;
        this.irFunction = irFunction;
        this.logger = ConsoleLogger.getLogger(LOG_MODULE_TYPE.TOOL, 'FunctionBodyRebuilder');
        this.functionMethod = new ArkMethod();
        this.methodSubSignatureMap = methodSubSignatureMap;
        this.callsiteInvokeExpr = invokeExpr;
        this.callsiteBlock = callsiteBlock || null;
        this.convertToStaticInvoke = convertToStaticInvoke;
        this.callsiteStmtIndex = callsiteStmtIndex;
    }
    
    /**
     * 重建函数体
     */
    public rebuildFunctionBody(): ArkMethod {
        this.logger.info(`Rebuilding function body for: ${this.irFunction.getName()}`);
        
        // 1. 分析def-use关系
        this.defUseMap = this.irFunction.analyzeDefUse();
        this.logger.debug(`Def-Use analysis completed`, this.defUseMap);
        
        // 2. 提取真正的函数参数
        this.irFunction.extractRealArgs();
        const realArgs = this.irFunction.getRealArgs();
        this.logger.debug(`Extracted ${realArgs.length} real arguments`);
        
        // 3. 进行类型推断
        const typeInference = new SafeTypeInference(this.irFunction, this.logger);
        typeInference.inferTypes();
        this.logger.debug(`Type inference completed`);
        
        // 4. 处理调用点的base、funcptr等Local变量（在函数体构建之前）
        this.processCallsiteVariables();
        
        // 5. 创建ArkMethod和函数签名
        this.createArkMethod();
        
        // 6. 构建CFG和函数体
        this.buildFunctionCFG();
        
        // 7. 可选功能：将原invokeExpr转换为static invoke
        if (this.convertToStaticInvoke) {
            this.convertInvokeExprToStaticInvoke();
        }
        
        // 8. 将方法添加到场景中
        this.scene.addToMethodsMap(this.functionMethod);
        this.logger.info(`invokeExpr: ${this.callsiteInvokeExpr.toString()}`);

        return this.functionMethod
    }
    
    /**
     * 获取函数的方法子签名
     */
    private getMethodSubSignature(): MethodSubSignature | undefined {
        // 遍历所有文件的方法签名映射
        for (const [_, methodSubSignatureMapArray] of this.methodSubSignatureMap) {
            const found = methodSubSignatureMapArray.find(map => map.name === `@nodeapiFunction${this.irFunction.getName()}`);
            if (found) {
                this.logger.info(`Found method sub-signature for function: ${this.irFunction.getName()} ${found.methodSubSignature}`);
                return found.methodSubSignature;
            }
        }
        
        this.logger.warn(`No method sub-signature found for function: ${this.irFunction.getName()}`);
        return undefined;
    }
    
    /**
     * 创建ArkMethod及其签名
     */
    private createArkMethod(): void {
        // 设置声明类
        this.functionMethod.setDeclaringArkClass(this.declaringClass);
        
        let methodSubSignature: MethodSubSignature | undefined = this.getMethodSubSignature();
        
        if (!methodSubSignature) {
            this.logger.warn(`No method sub-signature found for function: ${this.irFunction.getName()}, creating default signature`);
            
            // 创建默认的参数列表
            const parameters: MethodParameter[] = [];
            const args = this.callsiteInvokeExpr.getArgs();
            
            // 基于调用表达式的参数创建方法参数
            for (let i = 0; i < args.length; i++) {
                const arg = args[i];
                const paramName = `p${i + 1}`;  // 使用p1, p2, p3...的命名方式
                const paramType = arg.getType() || StringType.getInstance();
                
                // 创建正确的MethodParameter参数
                const param = new MethodParameter();
                param.setName(paramName);
                param.setType(paramType);
                parameters.push(param);
                
                this.logger.info(`Created default parameter: ${paramName} with type: ${paramType}`);
            }
            
            // 如果没有参数，至少创建一个默认参数以避免空数组
            if (parameters.length === 0) {
                const defaultParam = new MethodParameter();
                defaultParam.setName('defaultParam');
                defaultParam.setType(StringType.getInstance());
                parameters.push(defaultParam);
                this.logger.warn('Created default parameter since no arguments found');
            }
            
            // 使用创建的参数列表创建MethodSubSignature
            methodSubSignature = new MethodSubSignature(
                `@nodeapiFunction${this.irFunction.getName()}`, 
                parameters,  // 使用实际创建的参数列表
                UnknownType.getInstance(), 
                true
            );
            
        }
        
        // 验证并确保参数列表不为空
        const parameters = methodSubSignature.getParameters();
        if (!parameters || parameters.length === 0) {
            this.logger.warn(`Method signature has no parameters`);
        }
        
        // 遍历methodSubSignature的参数并设置type
        for(const param of methodSubSignature.getParameters()){
            const paramName = param.getName();
            this.logger.info(`Processing parameter: ${paramName}`);
            
            // 替换成invokeExpr的type
            const args = this.callsiteInvokeExpr.getArgs();
            const paramIndex = methodSubSignature.getParameters().indexOf(param);
            if (paramIndex >= 0 && paramIndex < args.length) {
                const arg = args[paramIndex];
                const argType = arg.getType();
                if (argType instanceof UnknownType) {
                    this.logger.warn(`Argument type for ${paramName} is unknown, setting to StringType`);
                    param.setType(StringType.getInstance());
                    this.logger.warn(`Set param ${paramName} type to StringType`);
                }
                else{
                    param.setType(argType);
                    this.logger.info(`Set param ${paramName} type to ${argType}`);
                }
            } else {
                // 如果没有对应的参数，设置默认类型
                param.setType(StringType.getInstance());
                this.logger.warn(`No corresponding argument for parameter ${paramName}, using StringType`);
            }
        }

        const newMethodName = `@nodeapiFunction${this.irFunction.getName()}_${this.getFunctionNumber()}`;
        methodSubSignature = new MethodSubSignature(
            newMethodName,
            methodSubSignature.getParameters(),
            methodSubSignature.getReturnType() // 克隆返回类型
        );
        
        const methodSignature = new MethodSignature(
            this.functionMethod.getDeclaringArkClass().getSignature(),
            methodSubSignature
        );
        
        // 根据调用类型设置方法签名
        if (this.callsiteInvokeExpr instanceof ArkInstanceInvokeExpr) {
            this.callsiteInvokeExpr.setMethodSignature(methodSignature);
            let base = this.callsiteInvokeExpr.getBase();
            // TODO: 更新base的类型
            // base type改为 declaringClass
            if (base instanceof Local) {
                // 确保base的类型与declaringClass匹配
                let declaringClassType = new ClassType(this.declaringClass.getSignature(), this.declaringClass.getRealTypes());

                base.setType(declaringClassType);
                this.logger.debug(`Updated base type for ArkInstanceInvokeExpr: ${base.getName()} to ${this.declaringClass.getSignature()}`);
            }
        } else if (this.callsiteInvokeExpr instanceof ArkStaticInvokeExpr) {
            // 对于静态调用，需要更新方法签名
            this.callsiteInvokeExpr.setMethodSignature(methodSignature);
        } else if (this.callsiteInvokeExpr instanceof ArkPtrInvokeExpr) {
            // TODO: 对于指针调用，需要更新方法签名
            this.callsiteInvokeExpr.setMethodSignature(methodSignature);
        }
        
        this.functionMethod.setImplementationSignature(methodSignature);
        
        // 验证方法参数设置
        this.validateMethodParameters();
        
        // 更新方法并添加到声明类
        checkAndUpdateMethod(this.functionMethod, this.declaringClass);
        this.declaringClass.addMethod(this.functionMethod);
    }
    
    /**
     * 创建方法参数
     */
    private createMethodParameter(name: string, type: any): any {
        // 创建一个基本的参数对象，避免复杂的API调用
        // TODO 这里的实现有问题
        return {
            getName: () => name,
            getType: () => type,
            setType: (newType: any) => { 
                type = newType; 
                this.logger.debug(`Updated parameter ${name} type to ${newType}`);
            },
            toString: () => `${name}: ${type}`
        };
    }
    
    /**
     * 验证方法参数设置
     */
    private validateMethodParameters(): void {
        try {
            const signature = this.functionMethod.getImplementationSignature();
            if (signature) {
                const subSignature = signature.getMethodSubSignature();
                if (subSignature) {
                    const parameters = subSignature.getParameters();
                    this.logger.info(`Method ${this.irFunction.getName()} has ${parameters ? parameters.length : 0} parameters`);
                    
                    if (!parameters || parameters.length === 0) {
                        this.logger.error(`Method ${this.irFunction.getName()} has no parameters - this may cause runtime errors`);
                    } else {
                        parameters.forEach((param, index) => {
                            if (param) {
                                this.logger.info(`Parameter ${index}: ${param.getName()} (${param.getType()})`);
                            } else {
                                this.logger.error(`Parameter ${index} is undefined`);
                            }
                        });
                    }
                } else {
                    this.logger.error(`Method ${this.irFunction.getName()} has no method sub-signature`);
                }
            } else {
                this.logger.error(`Method ${this.irFunction.getName()} has no implementation signature`);
            }
        } catch (error) {
            this.logger.error(`Error validating method parameters for ${this.irFunction.getName()}:`, error);
        }
    }
    
    /**
     * 构建函数CFG和函数体
     */
    private buildFunctionCFG(): void {
        // 创建CFG构建器，传递调用点的Local映射
        const cfgBuilder = new CFGBuilder(this.irFunction, this.functionMethod, this.logger, this.callsiteInvokeExpr);
        
        // 如果有调用点Local映射，将其传递给CFGBuilder
        if (this.callsiteLocalMap.size > 0) {
            this.logger.debug(`Passing ${this.callsiteLocalMap.size} callsite locals to CFGBuilder`);
            // 这里可能需要在CFGBuilder中添加一个方法来接受这些映射
            // cfgBuilder.setCallsiteLocalMap(this.callsiteLocalMap);
        }
        
        // 构建CFG
        const cfg = cfgBuilder.buildCFG();
        
        // 创建函数体
        const localSet = new Set<Local>();
        
        // 将调用点的Local变量添加到函数体的Local集合中
        for (const local of this.callsiteLocalMap.values()) {
            localSet.add(local);
        }
        
        const functionBody = new ArkBody(localSet, cfg);
        this.functionMethod.setBody(functionBody);
        
        // 为所有语句设置CFG
        this.addCfgToStmts(cfg);
    }
    
    /**
     * 为所有语句设置CFG
     */
    private addCfgToStmts(cfg: any): void {
        if (!cfg) {
            return;
        }
        
        for (const block of cfg.getBlocks()) {
            for (const stmt of block.getStmts()) {
                stmt.setCfg(cfg);
            }
        }
    }
    
    /**
     * 打印函数详情（用于调试）
     */
    public printFunctionDetails(): void {
        this.logger.info(`Function: ${this.irFunction.getName()}`);
        
        // 打印参数
        this.logger.info(`Parameters:`);
        for (const [name, param] of this.irFunction.getParameters()) {
            this.logger.info(`  ${name}: ${param.getParameterType()}`);
        }
        
        // 打印真正参数
        this.logger.info(`Real Arguments:`);
        this.irFunction.getRealArgs().forEach((arg, index) => {
            this.logger.info(`  ${index + 1}: ${arg.getName()} (${arg.getType().toString()})`);
        });
        
        // 打印指令
        this.logger.info(`Instructions:`);
        this.irFunction.getInstructions().forEach((inst, index) => {
            this.logger.info(`  ${index + 1}: ${inst.getType()}`);
        });
        
        // 打印值类型
        this.logger.info(`Value Types:`);
        for (const [name, value] of this.irFunction.getAllValues()) {
            this.logger.info(`  ${name}: ${value.getType().toString()}`);
        }
    }
    
    /**
     * 处理调用点的base、funcptr等Local变量
     * 这些变量应该在调用点所在的BasicBlock中创建，而不是在被调用函数内部
     */
    private processCallsiteVariables(): void {
        if (!this.callsiteBlock) {
            this.logger.warn(`No callsite block provided, cannot process callsite variables`);
            return;
        }

        this.logger.debug(`Processing callsite variables for ${this.callsiteInvokeExpr.constructor.name}`);
        
        if (this.callsiteInvokeExpr instanceof ArkInstanceInvokeExpr) {
            // 处理实例调用的base
            const base = this.callsiteInvokeExpr.getBase();
            if (base instanceof Local) {
                this.logger.debug(`Processing ArkInstanceInvokeExpr base: ${base.getName()}`);
                this.ensureCallsiteLocalInMap(base, "instance_base");
            }
        } else if (this.callsiteInvokeExpr instanceof ArkPtrInvokeExpr) {
            // 处理指针调用的funcptr
            // 对于ArkPtrInvokeExpr，我们需要在调用点创建funcptr Local变量
            const methodSignature = this.callsiteInvokeExpr.getMethodSignature();
            const functionName = methodSignature.getMethodSubSignature().getMethodName();
            
            this.logger.info(`Processing ArkPtrInvokeExpr for function: ${functionName} in callsite block`);
            
            // 创建函数类型的Local来建模函数指针
            const funcType = new FunctionType(methodSignature);
            const funcPtrLocal = new Local(`%funcptr_${functionName}`, funcType);
            
            // 添加到调用点的Local映射中
            this.callsiteLocalMap.set(funcPtrLocal.getName(), funcPtrLocal);
            
            // 在调用点的BasicBlock中创建函数指针的赋值语句
            // 使用ArkTS的字符串常量，而不是直接创建赋值语句
            // 这样可以避免在CFG中产生不正确的语句
            this.logger.debug(`Would create funcPtr assignment for: ${functionName}, but skipping for now to avoid errors`);
            
            // 暂时只记录funcPtr Local，不在调用点BasicBlock中创建赋值语句
            // 这个功能可以在后续的CFG构建过程中实现
            
            this.logger.debug(`Added funcPtr Local to callsite block: ${funcPtrLocal.getName()}, type: ${funcPtrLocal.getType()}`);
        }
        
        // 处理所有参数，确保它们在调用点的Local映射中
        const args = this.callsiteInvokeExpr.getArgs();
        for (let i = 0; i < args.length; i++) {
            const arg = args[i];
            if (arg instanceof Local) {
                this.logger.debug(`Processing callsite argument ${i}: ${arg.getName()}`);
                this.ensureCallsiteLocalInMap(arg, `callsite_arg_${i}`);
            }
        }
    }
    
    /**
     * 确保Local变量在调用点Local映射中正确建立
     */
    private ensureCallsiteLocalInMap(local: Local, context: string): void {
        if (!this.callsiteLocalMap.has(local.getName())) {
            this.callsiteLocalMap.set(local.getName(), local);
            this.logger.debug(`Added ${context} Local to callsite map: ${local.getName()}, type: ${local.getType()}`);
        } else {
            this.logger.debug(`${context} Local already in callsite map: ${local.getName()}`);
        }
    }
    
    /**
     * 创建字符串常量（临时实现）
     */
    private createStringConstant(value: string): any {
        // 这里应该使用正确的ValueUtil.createStringConst方法
        // 临时实现一个简单的常量对象
        return {
            getValue: () => value,
            getType: () => StringType.getInstance(),
            toString: () => `"${value}"`
        };
    }
    
    /**
     * 获取调用点Local变量映射（供CFGBuilder使用）
     */
    public getCallsiteLocalMap(): Map<string, Local> {
        return this.callsiteLocalMap;
    }

    /**
     * 将原invokeExpr转换为static invoke
     * 这是一个可选功能，将任何类型的调用（instance invoke、ptr invoke等）转换为static invoke
     */
    private convertInvokeExprToStaticInvoke(): void {
        if (!this.callsiteBlock) {
            this.logger.warn(`No callsite block available, cannot convert invokeExpr to static invoke`);
            return;
        }

        this.logger.info(`Converting ${this.callsiteInvokeExpr.constructor.name} to static invoke`);

        try {
            // 获取新创建的方法签名
            const newMethodSignature = this.functionMethod.getImplementationSignature();
            if (!newMethodSignature) {
                this.logger.error(`No implementation signature found for the rebuilt method`);
                return;
            }

            // 收集原有的参数
            let originalArgs = this.callsiteInvokeExpr.getArgs();
            let staticInvokeArgs = [...originalArgs]; // 复制参数数组

            // // 如果原来是instance invoke，需要将base作为第一个参数
            // if (this.callsiteInvokeExpr instanceof ArkInstanceInvokeExpr) {
            //     const base = this.callsiteInvokeExpr.getBase();
            //     staticInvokeArgs = [base, ...originalArgs];
            //     this.logger.debug(`Added base as first argument for static invoke: ${base.toString()}`);
            // }

            // 创建新的ArkStaticInvokeExpr
            const staticInvokeExpr = new ArkStaticInvokeExpr(
                newMethodSignature,
                staticInvokeArgs
            );

            // 在callsiteBlock中找到包含原invokeExpr的语句并替换
            this.replaceInvokeExprInCallsiteBlock(staticInvokeExpr);

            // 重要：同时更新原始的invokeExpr对象，确保引用也指向新的static invoke
            this.updateOriginalInvokeExpr(staticInvokeExpr);

            this.logger.info(`Successfully converted to static invoke: ${staticInvokeExpr.toString()}`);

        } catch (error) {
            this.logger.error(`Failed to convert invokeExpr to static invoke:`, error);
        }
    }

    /**
     * 在调用点BasicBlock中找到并替换invokeExpr
     */
    private replaceInvokeExprInCallsiteBlock(newStaticInvokeExpr: ArkStaticInvokeExpr): void {
        if (!this.callsiteBlock) {
            this.logger.error(`No callsite block available for replacement`);
            return;
        }

        if (this.callsiteStmtIndex < 0) {
            this.logger.warn(`No valid callsite statement index, cannot replace invokeExpr`);
            return;
        }

        const statements = this.callsiteBlock.getStmts();
        
        this.logger.debug(`=== REPLACEMENT DEBUG INFO ===`);
        this.logger.debug(`CallsiteBlock has ${statements.length} statements`);
        this.logger.debug(`Trying to replace at index: ${this.callsiteStmtIndex}`);
        this.logger.debug(`Original invokeExpr: ${this.callsiteInvokeExpr.toString()}`);
        this.logger.debug(`New static invokeExpr: ${newStaticInvokeExpr.toString()}`);
        
        if (this.callsiteStmtIndex >= statements.length) {
            this.logger.error(`Invalid callsite statement index ${this.callsiteStmtIndex}, block has ${statements.length} statements`);
            return;
        }

        const stmt = statements[this.callsiteStmtIndex];
        this.logger.debug(`Target statement at index ${this.callsiteStmtIndex}: ${stmt.toString()}`);
        this.logger.debug(`Statement type: ${stmt.constructor.name}`);

        try {
            // 检查语句是否包含invokeExpr
            if (!stmt.containsInvokeExpr || !stmt.containsInvokeExpr()) {
                this.logger.error(`Statement at index ${this.callsiteStmtIndex} does not contain invokeExpr`);
                this.logger.debug(`Statement details: ${stmt.toString()}`);
                this.logger.debug(`Expected invokeExpr: ${this.callsiteInvokeExpr.toString()}`);
                return;
            }

            // 先验证当前语句中的invokeExpr是否匹配我们要替换的invokeExpr
            const currentInvokeExpr = stmt.getInvokeExpr();
            if (currentInvokeExpr !== this.callsiteInvokeExpr) {
                this.logger.warn(`InvokeExpr mismatch! Expected: ${this.callsiteInvokeExpr.toString()}, Found: ${currentInvokeExpr?.toString() || 'null'}`);
                // 即使不匹配，也尝试继续替换，因为可能是同一个对象的不同引用
            }

            // 根据语句类型进行替换
            if (stmt instanceof ArkAssignStmt) {
                // 对于赋值语句，创建新的赋值语句并尽可能保留原有元信息
                const newAssignStmt = new ArkAssignStmt(stmt.getLeftOp(), newStaticInvokeExpr);
                
                // 保留CFG和其他可能的元信息
                if (stmt.getCfg()) {
                    newAssignStmt.setCfg(stmt.getCfg());
                }
                
                // 尝试保留其他元信息（如行号、文件信息等）
                try {
                    if ((stmt as any).getLineNumber && typeof (stmt as any).getLineNumber === 'function') {
                        const lineNumber = (stmt as any).getLineNumber();
                        if (lineNumber && typeof (newAssignStmt as any).setLineNumber === 'function') {
                            (newAssignStmt as any).setLineNumber(lineNumber);
                        }
                    }
                    
                    // 保留其他可能的元数据属性
                    if ((stmt as any).metadata) {
                        (newAssignStmt as any).metadata = (stmt as any).metadata;
                    }
                } catch (metaError) {
                    this.logger.debug(`Could not preserve all metadata for ArkAssignStmt: ${metaError}`);
                }
                
                // 直接替换语句
                statements[this.callsiteStmtIndex] = newAssignStmt;
                this.logger.info(`Successfully replaced assign statement with static invoke at index ${this.callsiteStmtIndex}`);
                this.logger.debug(`New statement: ${newAssignStmt.toString()}`);
            } else if (stmt instanceof ArkInvokeStmt) {
                // 对于调用语句，直接替换其中的invokeExpr
                this.logger.debug(`Before replacement - ArkInvokeStmt: ${stmt.toString()}`);
                stmt.replaceInvokeExpr(newStaticInvokeExpr);
                this.logger.info(`Successfully replaced invokeExpr in ArkInvokeStmt with static invoke at index ${this.callsiteStmtIndex}`);
                this.logger.debug(`After replacement - ArkInvokeStmt: ${stmt.toString()}`);
            } else {
                // 对于其他类型的语句，尝试直接设置invokeExpr
                // 大多数包含invokeExpr的语句都应该有setInvokeExpr方法或类似的方式来更新
                try {
                    // 尝试通过反射或直接方法调用来设置新的invokeExpr
                    if (typeof (stmt as any).setInvokeExpr === 'function') {
                        (stmt as any).setInvokeExpr(newStaticInvokeExpr);
                        this.logger.info(`Successfully updated invokeExpr in statement at index ${this.callsiteStmtIndex}`);
                    } else {
                        this.logger.warn(`Cannot directly replace invokeExpr in statement type: ${stmt.constructor.name} at index ${this.callsiteStmtIndex}`);
                        this.logger.warn(`Statement may need manual handling for this type`);
                        
                        // 作为最后的手段，尝试使用反射方式替换
                        this.logger.info(`Attempting to use reflection-based replacement for statement type: ${stmt.constructor.name}`);
                        this.tryReflectionBasedReplacement(stmt, newStaticInvokeExpr);
                    }
                } catch (setError) {
                    this.logger.warn(`Failed to set invokeExpr directly, statement type: ${stmt.constructor.name}`, setError);
                }
            }
        } catch (error) {
            this.logger.error(`Error replacing statement at index ${this.callsiteStmtIndex}:`, error);
        }
    }

    /**
     * 尝试使用反射方式替换invokeExpr（兜底方案）
     */
    private tryReflectionBasedReplacement(stmt: any, newStaticInvokeExpr: ArkStaticInvokeExpr): void {
        try {
            // 检查是否有rightOp属性（通常是ArkAssignStmt的右操作数）
            if (stmt.rightOp && this.isInvokeExpr(stmt.rightOp)) {
                stmt.rightOp = newStaticInvokeExpr;
                this.logger.info(`Successfully replaced rightOp invokeExpr using reflection`);
                return;
            }
            
            // 检查是否有invokeExpr属性（某些语句可能直接有这个属性）
            if (stmt.invokeExpr && this.isInvokeExpr(stmt.invokeExpr)) {
                stmt.invokeExpr = newStaticInvokeExpr;
                this.logger.info(`Successfully replaced invokeExpr property using reflection`);
                return;
            }
            
            // 检查其他可能的属性名
            const possibleProps = ['expr', 'expression', 'call', 'invoke'];
            for (const prop of possibleProps) {
                if (stmt[prop] && this.isInvokeExpr(stmt[prop])) {
                    stmt[prop] = newStaticInvokeExpr;
                    this.logger.info(`Successfully replaced ${prop} property using reflection`);
                    return;
                }
            }
            
            this.logger.warn(`Could not find invokeExpr property to replace in statement type: ${stmt.constructor.name}`);
        } catch (error) {
            this.logger.error(`Error in reflection-based replacement:`, error);
        }
    }

    /**
     * 判断对象是否是invokeExpr
     */
    private isInvokeExpr(obj: any): boolean {
        return obj instanceof ArkInstanceInvokeExpr ||
               obj instanceof ArkStaticInvokeExpr ||
               obj instanceof ArkPtrInvokeExpr;
    }

    /**
     * 更新原始invokeExpr对象，确保引用指向新的static invoke
     * 这解决了替换callsite block中的语句后，原始invokeExpr引用没有更新的问题
     */
    private updateOriginalInvokeExpr(newStaticInvokeExpr: ArkStaticInvokeExpr): void {
        try {
            // 获取原始invokeExpr的方法签名和参数，然后将它们复制到新的static invoke中
            const originalInvokeExpr = this.callsiteInvokeExpr;
            
            // 由于JavaScript对象是引用传递，我们需要"就地"更新原始对象的属性
            // 但这对于TypeScript类来说比较复杂，因为类的属性可能是只读的
            
            // 一个更安全的方法是更新所有可以更新的属性
            if (originalInvokeExpr instanceof ArkInstanceInvokeExpr) {
                // 对于ArkInstanceInvokeExpr，我们需要将其转换为ArkStaticInvokeExpr
                // 但由于类型不匹配，我们采用"属性复制"的方式
                this.copyInvokeExprProperties(newStaticInvokeExpr, originalInvokeExpr);
                this.logger.info(`Updated original ArkInstanceInvokeExpr properties to match static invoke`);
            } else if (originalInvokeExpr instanceof ArkStaticInvokeExpr) {
                // 对于已经是static invoke的情况，直接更新属性
                this.copyInvokeExprProperties(newStaticInvokeExpr, originalInvokeExpr);
                this.logger.info(`Updated original ArkStaticInvokeExpr properties`);
            } else if (originalInvokeExpr instanceof ArkPtrInvokeExpr) {
                // 对于指针调用，也使用属性复制
                this.copyInvokeExprProperties(newStaticInvokeExpr, originalInvokeExpr);
                this.logger.info(`Updated original ArkPtrInvokeExpr properties to match static invoke`);
            }
            
        } catch (error) {
            this.logger.error(`Error updating original invokeExpr:`, error);
        }
    }

    /**
     * 将新invokeExpr的属性复制到原始invokeExpr对象中
     * 这是一个"就地更新"的尝试，但受限于TypeScript的类型系统
     */
    private copyInvokeExprProperties(source: ArkStaticInvokeExpr, target: any): void {
        try {
            // 复制方法签名
            if (typeof target.setMethodSignature === 'function') {
                target.setMethodSignature(source.getMethodSignature());
                this.logger.debug(`Copied method signature to original invokeExpr`);
            }
            
            // 复制参数
            if (typeof target.setArgs === 'function') {
                target.setArgs(source.getArgs());
                this.logger.debug(`Copied arguments to original invokeExpr`);
            }
            
            // 尝试更新类型信息
            if (typeof target.setType === 'function' && typeof source.getType === 'function') {
                target.setType(source.getType());
                this.logger.debug(`Copied type to original invokeExpr`);
            }
            
            // 直接设置属性（不推荐，但在某些情况下可能有效）
            if (target.methodSignature !== undefined) {
                target.methodSignature = source.getMethodSignature();
            }
            if (target.args !== undefined) {
                target.args = source.getArgs();
            }
            
            this.logger.debug(`Attempted to copy properties from static invoke to original invokeExpr`);
            
        } catch (error) {
            this.logger.warn(`Some properties could not be copied to original invokeExpr:`, error);
        }
    }

}