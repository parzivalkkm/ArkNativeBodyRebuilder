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
import { ArkInstanceInvokeExpr } from '@ArkAnalyzer/src/core/base/Expr';
import { StringType, UnknownType } from '@ArkAnalyzer/src/core/base/Type';
/**
 * 负责重建函数体的类
 */
export class FunctionBodyRebuilder {
    private scene: Scene;
    private declaringClass: ArkClass;
    private irFunction: IRFunction;
    private logger: Logger;
    private functionMethod: ArkMethod;
    private methodSubSignatureMap: Map<string, MethodSubSignatureMap[]>;
    private defUseMap: { [variable: string]: { definedIn: IRInstruction[]; usedIn: IRInstruction[] } }
    = {};
    private callsiteInvokeExpr: ArkInstanceInvokeExpr;

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
        invokeExpr: ArkInstanceInvokeExpr,
    ) {
        this.scene = scene;
        this.declaringClass = declaringClass;
        this.irFunction = irFunction;
        this.logger = ConsoleLogger.getLogger(LOG_MODULE_TYPE.TOOL, 'FunctionBodyRebuilder');
        this.functionMethod = new ArkMethod();
        this.methodSubSignatureMap = methodSubSignatureMap;
        this.callsiteInvokeExpr = invokeExpr;
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
        
        // 4. 创建ArkMethod和函数签名
        this.createArkMethod();
        
        // 5. 构建CFG和函数体
        this.buildFunctionCFG();
        
        // 6. 将方法添加到场景中
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
            methodSubSignature = ArkSignatureBuilder.buildMethodSubSignatureFromMethodName(
                `@nodeapiFunction${this.irFunction.getName()}`
            );
        }
        // 遍历methodSubSignature的参数并设置type
        for(const param of methodSubSignature.getParameters()){
            const paramName = param.getName();
            this.logger.info(`paramName: ${paramName}`);
            
            // 替换成invokeExpr的type
            const args = this.callsiteInvokeExpr.getArgs();
            const paramIndex = methodSubSignature.getParameters().indexOf(param);
            if (paramIndex >= 0 && paramIndex < args.length) {
                const arg = args[paramIndex];
                const argType = arg.getType();
                if (argType instanceof UnknownType) {
                    this.logger.warn(`Argument type for ${paramName} is unknown, setting to ObjectType`);
                    // TODO 此处存在问题，
                    param.setType(argType);
                    this.logger.warn(`Set param ${paramName} type to ${argType}`);
                }
                else{
                    param.setType(argType);
                    this.logger.info(`Set param ${paramName} type to ${argType}`);
                }
                
                
            }
        }
        

        const methodSignature = new MethodSignature(
            this.functionMethod.getDeclaringArkClass().getSignature(),
            methodSubSignature
        );
        this.callsiteInvokeExpr.setMethodSignature(methodSignature);
        
        this.functionMethod.setImplementationSignature(methodSignature);
        this.functionMethod.setLineCol(0);
        
        // 更新方法并添加到声明类
        checkAndUpdateMethod(this.functionMethod, this.declaringClass);
        this.declaringClass.addMethod(this.functionMethod);
    }
    
    /**
     * 构建函数CFG和函数体
     */
    private buildFunctionCFG(): void {
        // 创建CFG构建器
        const cfgBuilder = new CFGBuilder(this.irFunction, this.functionMethod, this.logger);
        
        // 构建CFG
        const cfg = cfgBuilder.buildCFG();
        
        // 创建函数体
        const localSet = new Set<Local>();
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
} 