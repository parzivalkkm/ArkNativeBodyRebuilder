

import { IRFunction } from '../ir/IRFunction';
// import { IRValue } from '../ir/IRValue';
// import { ValueType } from '../ValueType';
import { Logger } from 'log4js';

import { ArkMethod } from '@ArkAnalyzer/src/core/model/ArkMethod';
import { ArkBody } from '@ArkAnalyzer/src/core/model/ArkBody';
import { Local } from '@ArkAnalyzer/src/core/base/Local';
import { ArkClass } from '@ArkAnalyzer/src/core/model/ArkClass';
import { Scene } from '@ArkAnalyzer/src/Scene';
import { MethodSignature } from '@ArkAnalyzer/src/core/model/ArkSignature';
import { ArkSignatureBuilder } from '@ArkAnalyzer/src/core/model/builder/ArkSignatureBuilder';
import { checkAndUpdateMethod } from '@ArkAnalyzer/src/core/model/builder/ArkMethodBuilder';
import { TypeInference } from './TypeInference';
import { CFGBuilder } from './CFGBuilder';

import { LOG_MODULE_TYPE } from '@ArkAnalyzer/src/utils/logger';
import ConsoleLogger from '@ArkAnalyzer/src/utils/logger';
import { IRInstruction } from '../ir/IRInstruction';
import { MethodSignatureIR } from '../ir/JsonObjectInterface';
/**
 * 负责重建函数体的类
 */
export class FunctionBodyRebuilder {
    private scene: Scene;
    private declaringClass: ArkClass;
    private irFunction: IRFunction;
    private logger: Logger;
    private napiCalls: MethodSignatureIR[];
    private functionMethod: ArkMethod;

    private defUseMap: { [variable: string]: { definedIn: IRInstruction[]; usedIn: IRInstruction[] } }
    = {};

    // TODO 在functionBodyRebuilder之前
    // 需要获取调用上下文，对于传入参数为object以及Function的情况
    // 需要其ClassSignature，MethodSignature
    // 涉及到类操作以及field操作时，构建对应的FieldSignature，只有指明常量字符串才可能做到

    // 此外对于call function时，获取对应的域也很重要，staticcall时直接获取this，instancecall时需要获取对应的class
    
    constructor(scene: Scene, declaringClass: ArkClass, irFunction: IRFunction, napiCalls: MethodSignatureIR[]) {
        this.scene = scene;
        this.declaringClass = declaringClass;
        this.irFunction = irFunction;
        this.logger = ConsoleLogger.getLogger(LOG_MODULE_TYPE.TOOL, 'FunctionBodyRebuilder');
        
        this.functionMethod = new ArkMethod();
        this.napiCalls = napiCalls;
    }
    
    /**
     * 重建函数体
     */
    public rebuildFunctionBody(): void {
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
    }
    
    /**
     * 创建ArkMethod及其签名
     */
    private createArkMethod(): void {
        // 设置声明类
        this.functionMethod.setDeclaringArkClass(this.declaringClass);
        
        // 创建方法签名
        const methodSubSignature = ArkSignatureBuilder.buildMethodSubSignatureFromMethodName(
            `@nodeapiFunction${this.irFunction.getName()}`
        );
        
        const methodSignature = new MethodSignature(
            this.functionMethod.getDeclaringArkClass().getSignature(),
            methodSubSignature
        );
        
        this.functionMethod.setImplementationSignature(methodSignature);
        this.functionMethod.setLineCol(0);
        
        // 更新方法并添加到声明类
        checkAndUpdateMethod(this.functionMethod, this.declaringClass);
        this.declaringClass.addMethod(this.functionMethod);
        
        // TODO: 根据realArgs创建参数
        // 遍历arkts文件找到node api调用点，找到参数类型，可以结合index.d.ts文件
        // 遍历napiCalls，找到对应的参数类型
        for(const napiCall of this.napiCalls){
            const methodName = napiCall.name;
            this.logger.info(`methodName: ${methodName}`);
        }
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