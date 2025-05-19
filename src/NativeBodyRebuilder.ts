import { readFileSync } from 'fs';
import { LOG_LEVEL, LOG_MODULE_TYPE } from '@ArkAnalyzer/src/utils/logger';
import ConsoleLogger from '@ArkAnalyzer/src/utils/logger';
import { Scene } from '@ArkAnalyzer/src/Scene';
import { ArkFile } from '@ArkAnalyzer/src/core/model/ArkFile';
import { ArkClass } from '@ArkAnalyzer/src/core/model/ArkClass';
import { ClassSignature, FileSignature } from '@ArkAnalyzer/src/core/model/ArkSignature';

import { IRModule } from './ir/IRFunction';
import { FunctionBodyRebuilder } from './core/FunctionBodyRebuilder';
import { ArkBody } from '@ArkAnalyzer/src/core/model/ArkBody';
import { ArkAssignStmt } from '@ArkAnalyzer/src/core/base/Stmt';
import { ArkInstanceInvokeExpr } from '@ArkAnalyzer/src/core/base/Expr';
import { MethodSignatureIR } from './ir/JsonObjectInterface';
import { UnknownType } from '@ArkAnalyzer/src/core/base/Type';

// 设置日志
const logPath = 'out/ArkAnalyzer.log';
const logger = ConsoleLogger.getLogger(LOG_MODULE_TYPE.TOOL, 'NativeBodyRebuilder');
ConsoleLogger.configure(logPath, LOG_LEVEL.DEBUG, LOG_LEVEL.DEBUG);

/**
 * 本机函数体重建器类
 * 
 * 负责从IR文件读取数据，创建IR对象，然后为每个函数重建函数体
 */
export class NativeBodyRebuilder {
    private irFilePath: string;
    private scene: Scene;
    private irModule: IRModule | null = null;

    private napiCalls: MethodSignatureIR[] = [];

    constructor(irFilePath: string, scene: Scene) {
        this.irFilePath = irFilePath;
        this.scene = scene;
    }
    
    /**
     * 重建Native函数体
     */
    public rebuildNativeBody(): void {
        // 1. 读取IR文件
        const content = this.readIRFile();
        if (!content) {
            return;
        }
        
        // 2. 解析IR文件，创建IRModule对象
        const jsonIR = this.parseIRContent(content);
        if (!jsonIR) {
            return;
        }
        
        // 3. 创建IRModule
        this.irModule = IRModule.fromJson(jsonIR);
        logger.info(`Created IRModule: ${this.irModule.getModuleName()}`);
        
        // 4. 创建ArkFile和ArkClass
        const moduleFile = this.createArkFile();
        const moduleClass = this.createArkClass(moduleFile);

        // 5. 遍历Ark Project，找到napi调用并记录
        this.findNapiCalls();
        // 5. 遍历函数，重建函数体
        this.rebuildFunctionBodies(moduleClass);
    }
    
    /**
     * 读取IR文件内容
     */
    private readIRFile(): string | null {
        try {
            const content = readFileSync(this.irFilePath, 'utf-8');
            logger.debug(`Read IR file: ${this.irFilePath}`);
            return content;
        } catch (error) {
            logger.error(`Failed to read IR file: ${this.irFilePath}`, error);
            return null;
        }
    }
    
    /**
     * 解析IR文件内容
     */
    private parseIRContent(content: string): any {
        try {
            const jsonIR = JSON.parse(content);
            logger.debug(`Parsed IR file successfully`);
            return jsonIR;
        } catch (error) {
            logger.error(`Failed to parse IR content`, error);
            return null;
        }
    }
    
    /**
     * 创建ArkFile
     */
    private createArkFile(): ArkFile {
        if (!this.irModule) {
            throw new Error('IRModule is not initialized');
        }
        
        const moduleFile = new ArkFile();
        moduleFile.setScene(this.scene);
        
        const moduleFileSignature = new FileSignature(
            this.scene.getProjectName(),
            `@nodeapiFile${this.irModule.getModuleName()}`
        );
        
        moduleFile.setFileSignature(moduleFileSignature);
        this.scene.setFile(moduleFile);
        
        return moduleFile;
    }
    
    /**
     * 创建ArkClass
     */
    private createArkClass(moduleFile: ArkFile): ArkClass {
        if (!this.irModule) {
            throw new Error('IRModule is not initialized');
        }
        
        const moduleClass = new ArkClass();
        moduleClass.setDeclaringArkFile(moduleFile);
        
        const moduleClassSignature = new ClassSignature(
            `@nodeapiClass${this.irModule.getModuleName()}`,
            moduleClass.getDeclaringArkFile().getFileSignature(),
            moduleClass.getDeclaringArkNamespace()?.getSignature() || null
        );
        
        moduleClass.setSignature(moduleClassSignature);
        moduleFile.addArkClass(moduleClass);
        
        return moduleClass;
    }

        /**
     * 查找项目中的NAPI调用
     */
    public findNapiCalls(): void {
        const sofuncs: string[] = [];
        for (const arkFile of this.scene.getFiles()) {
            logger.info('Processing file:', arkFile.getFilePath());
            // 找到importInfos
            const importInfos = arkFile.getImportInfos();
            for (const importInfo of importInfos) {
                logger.info(`Import Info: 
                    Clause Name: ${importInfo.getImportClauseName()}
                    Type: ${importInfo.getImportType()}
                    From: ${importInfo.getFrom() || 'undefined'}
                    Name Before As: ${importInfo.getNameBeforeAs() || 'undefined'}
                    Position: ${importInfo.getOriginTsPosition()?.toString() || 'undefined'}
                    Declaring File: ${importInfo.getDeclaringArkFile()?.getFilePath() || 'undefined'}
                `);
                // 将importInfo.getFrom()赋值为变量
                const from = importInfo.getFrom();
                // 如果来自.so库，判断结尾是否endwiths".so"
                if(from && from.endsWith(".so")){
                    sofuncs.push(importInfo.getImportClauseName());
                }
            }
            if(sofuncs.length > 0){
                // 找到这个file的所有函数调用
                for(const arkClass of arkFile.getClasses()){
                    for(const arkMethod of arkClass.getMethods()){
                        const body = arkMethod.getBody();
                        if(body){
                            const methodSignatureIR = this.processNapiCalls(body, sofuncs);
                            if(methodSignatureIR){
                                this.napiCalls.push(...methodSignatureIR);
                            }
                        }
                    }
                }
            }
        }
    }

    private processNapiCalls(body: ArkBody, sofuncs: string[]): MethodSignatureIR[] {
        const cfg = body.getCfg();
        const napiCalls: MethodSignatureIR[] = [];
        
        for(const stmt of cfg.getStmts()){
            if(stmt.containsInvokeExpr()){
                // 打印stmt
                logger.info(`Stmt: ${stmt.toString()}`);
                if(stmt instanceof ArkAssignStmt){
                    const leftOp = stmt.getLeftOp();
                    logger.info(`leftOp: ${leftOp.getType()}`);
                }
                const invokeExpr = stmt.getInvokeExpr();
                // 打印invokeExpr
                logger.info(`Invoke Expr: ${invokeExpr?.toString()}`);
                if(invokeExpr){
                    const methodSignature = invokeExpr.getMethodSignature();
                    const methodName = methodSignature.getMethodSubSignature().getMethodName();
                    if(invokeExpr instanceof ArkInstanceInvokeExpr){
                        const base = invokeExpr.getBase();
                        logger.info(`base: ${base.toString()}`);
                        if(sofuncs.includes(base.toString())){
                            logger.info(`include napi call: ${methodName}`);
                            napiCalls.push({
                                name: methodName,
                                params: invokeExpr.getArgs().map(arg => arg.getType()),
                                returnType: UnknownType.getInstance()
                            });
                        }
                    }
                    // 打印methodsignature
                    logger.info(`Method Signature: ${methodSignature.toString()}`);
                    // 打印methodname
                    logger.info(`Method Name: ${methodName}`);
                    // getargs
                    const args = invokeExpr.getArgs();
                    logger.info(`args: ${args.toString()}`);
                    for(const arg of args){
                        logger.info(`arg: ${arg.getType()}`);
                    }
                }
            }
        }
        return napiCalls;
    }
    /**
     * 重建所有函数体
     */
    private rebuildFunctionBodies(moduleClass: ArkClass): void {
        if (!this.irModule) {
            throw new Error('IRModule is not initialized');
        }
        
        // 遍历所有函数
        // TODO这里需要在每一次的调用上下文完成
        this.irModule.getFunctions().forEach(irFunction => {
            logger.info(`Processing function: ${irFunction.getName()}`);
            
            // 为每个函数创建FunctionBodyRebuilder
            const rebuilder = new FunctionBodyRebuilder(this.scene, moduleClass, irFunction, this.napiCalls);
            
            // 重建函数体
            rebuilder.rebuildFunctionBody();
        });
    }

    public printModuleDetails(): void {
        if (!this.irModule) {
            logger.warn('IRModule is not initialized');
            return;
        }
        
        logger.info(`Module Details:`);
        logger.info(`HAP Name: ${this.irModule.getHapName()}`);
        logger.info(`SO Name: ${this.irModule.getSoName()}`);
        logger.info(`Module Name: ${this.irModule.getModuleName()}`);
        logger.info(`Functions: ${this.irModule.getFunctions().length}`);
        
        this.irModule.getFunctions().forEach((func, index) => {
            logger.info(`  ${index + 1}. Function: ${func.getName()}`);
            logger.info(`     Parameters: ${func.getParameters().size}`);
            logger.info(`     Instructions: ${func.getInstructions().length}`);
        });
    }
}



