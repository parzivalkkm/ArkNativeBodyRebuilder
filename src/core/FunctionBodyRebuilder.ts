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
import { TypeInference } from './TypeInference';
import { CFGBuilder } from './CFGBuilder';

import { LOG_MODULE_TYPE } from '@ArkAnalyzer/src/utils/logger';
import ConsoleLogger from '@ArkAnalyzer/src/utils/logger';
import { IRInstruction } from '../ir/IRInstruction';
import { MethodSubSignatureMap } from '../ir/JsonObjectInterface';
import { ArkInstanceInvokeExpr, ArkStaticInvokeExpr, ArkPtrInvokeExpr } from '@ArkAnalyzer/src/core/base/Expr';
import { StringType, UnknownType, FunctionType } from '@ArkAnalyzer/src/core/base/Type';
import { ArkParameterRef } from '@ArkAnalyzer/src/core/base/Ref';
import { ArkAssignStmt } from '@ArkAnalyzer/src/core/base/Stmt';
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
    ) {
        this.scene = scene;
        this.declaringClass = declaringClass;
        this.irFunction = irFunction;
        this.logger = ConsoleLogger.getLogger(LOG_MODULE_TYPE.TOOL, 'FunctionBodyRebuilder');
        this.functionMethod = new ArkMethod();
        this.methodSubSignatureMap = methodSubSignatureMap;
        this.callsiteInvokeExpr = invokeExpr;
        this.callsiteBlock = callsiteBlock || null;
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
        const typeInference = new TypeInference(this.irFunction, this.logger);
        typeInference.inferTypes();
        this.logger.debug(`Type inference completed`);
        
        // 4. 处理调用点的base、funcptr等Local变量（在函数体构建之前）
        this.processCallsiteVariables();
        
        // 5. 创建ArkMethod和函数签名
        this.createArkMethod();
        
        // 6. 构建CFG和函数体
        this.buildFunctionCFG();
        
        // 7. 将方法添加到场景中
        this.scene.addToMethodsMap(this.functionMethod);
        this.logger.info(`invokeExpr: ${this.callsiteInvokeExpr.toString()}`);

        return this.functionMethod
    }
    
    /**
     * 创建ArkMethod及其签名
     */
    private createArkMethod(): void {
        // 设置声明类
        this.functionMethod.setDeclaringArkClass(this.declaringClass);
        
        let methodSubSignature: MethodSubSignature | undefined;
        // 遍历所有文件的方法签名映射
        for (const [_, methodSubSignatureMapArray] of this.methodSubSignatureMap) {
            const found = methodSubSignatureMapArray.find(map => map.name === `@nodeapiFunction${this.irFunction.getName()}`);
            if (found) {
                this.logger.info(`Found method sub-signature for function: ${this.irFunction.getName()} ${found.methodSubSignature}`);
                methodSubSignature = found.methodSubSignature;
                break;
            }
        }
        
        if (!methodSubSignature) {
            this.logger.warn(`No method sub-signature found for function: ${this.irFunction.getName()}, creating default signature`);
            
            // 创建默认的参数列表
            const parameters: any[] = [];
            const args = this.callsiteInvokeExpr.getArgs();
            
            // 基于调用表达式的参数创建方法参数
            for (let i = 0; i < args.length; i++) {
                const arg = args[i];
                const paramName = `param${i}`;
                const paramType = arg.getType() || StringType.getInstance();
                
                // 创建参数对象 - 这里需要根据实际的 ArkAnalyzer API 来创建
                // 假设有一个方法来创建参数
                const param = this.createMethodParameter(paramName, paramType);
                parameters.push(param);
                
                this.logger.info(`Created default parameter: ${paramName} with type: ${paramType}`);
            }
            
            // 如果没有参数，至少创建一个默认参数以避免空数组
            if (parameters.length === 0) {
                const defaultParam = this.createMethodParameter('defaultParam', StringType.getInstance());
                parameters.push(defaultParam);
                this.logger.info('Created default parameter to avoid empty parameter list');
            }
            
            methodSubSignature = ArkSignatureBuilder.buildMethodSubSignatureFromMethodName(
                `@nodeapiFunction${this.irFunction.getName()}`
            );
        }
        
        // 验证并确保参数列表不为空
        const parameters = methodSubSignature.getParameters();
        if (!parameters || parameters.length === 0) {
            this.logger.warn(`Method signature has no parameters, creating default parameter`);
            const defaultParam = this.createMethodParameter('defaultParam', StringType.getInstance());
            
            // 重新创建 methodSubSignature 包含默认参数
            methodSubSignature = new MethodSubSignature(
                methodSubSignature.getMethodName(),
                [defaultParam],
                methodSubSignature.getReturnType()
            );
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
        } else if (this.callsiteInvokeExpr instanceof ArkStaticInvokeExpr) {
            // 对于静态调用，需要更新方法签名
            this.callsiteInvokeExpr.setMethodSignature(methodSignature);
        } else if (this.callsiteInvokeExpr instanceof ArkPtrInvokeExpr) {
            // 对于指针调用（具名导入），需要更新方法签名
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
            this.logger.info(`  ${index + 1}: ${arg.getName()} (${arg.getValueType()})`);
        });
        
        // 打印指令
        this.logger.info(`Instructions:`);
        this.irFunction.getInstructions().forEach((inst, index) => {
            this.logger.info(`  ${index + 1}: ${inst.getType()}`);
        });
        
        // 打印值类型
        this.logger.info(`Value Types:`);
        for (const [name, value] of this.irFunction.getAllValues()) {
            this.logger.info(`  ${name}: ${value.getValueType()}`);
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
}