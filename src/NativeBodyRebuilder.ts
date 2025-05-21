import { readFileSync } from 'fs';
import { LOG_LEVEL, LOG_MODULE_TYPE } from '@ArkAnalyzer/src/utils/logger';
import ConsoleLogger from '@ArkAnalyzer/src/utils/logger';
import { Scene } from '@ArkAnalyzer/src/Scene';
import { ArkFile, Language } from '@ArkAnalyzer/src/core/model/ArkFile';
import { ArkClass } from '@ArkAnalyzer/src/core/model/ArkClass';
import { ClassSignature, FileSignature } from '@ArkAnalyzer/src/core/model/ArkSignature';

import { IRModule } from './ir/IRFunction';
import { FunctionBodyRebuilder } from './core/FunctionBodyRebuilder';
import { SceneConfig } from '@ArkAnalyzer/src/Config';
import { IndexdtsUtils } from './IndexdtsUtils';
import { MethodSubSignatureMap } from './ir/JsonObjectInterface';
import path from 'path';
import { ArkBody, ArkInstanceInvokeExpr, ArkMethod, ModelUtils } from '@ArkAnalyzer/src';

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
    
    private methodSubSignatureMap: Map<string, MethodSubSignatureMap[]> = new Map();
    private NapiCallExprMap: Map<string, ArkInstanceInvokeExpr[]> = new Map();
    constructor(irFilePath: string, scene: Scene) {
        this.irFilePath = irFilePath;
        this.scene = scene;
    }

    private rebuiltBodys: Array<ArkMethod> = [];
    
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
        this.recordNapiCalls();
        // 6. 导出exportMap
        this.buildNapiExportMap();
        // 7. 遍历函数，重建函数体
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
        
        const moduleFile = new ArkFile(Language.TYPESCRIPT);
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

    private buildNapiExportMap(): void {
        // 遍历所有file，找到index.d.ts文件
        for(const arkFile of this.scene.getFiles()){
            logger.info(`arkFile name is: ${arkFile.getName()}`);
            if(arkFile.getName().endsWith('.d.ts') && arkFile.getName().includes('cpp')){
                const methodSubSignatureMapArray = IndexdtsUtils.buildNapiExportMap(arkFile);
                const parentDir = path.basename(path.dirname(arkFile.getName()));
                logger.info(`parentDir is: ${parentDir}`);
                this.methodSubSignatureMap.set(parentDir, methodSubSignatureMapArray);
            }
        }
    }

    private recordNapiCalls(): void {
        // 遍历所有arkfile
        for (const arkFile of this.scene.getFiles()) {
            // 解析import信息
            const importInfos = arkFile.getImportInfos();
            const importMap = new Map<string, string>();
            for (const importInfo of importInfos) {
                if(importInfo.getFrom()?.endsWith('.so')){
                    logger.info(`importInfo: ${importInfo.toString()}`);
                    const strImportFrom = importInfo.getFrom()?.split('.so')[0] || '';
                    importMap.set(importInfo.getImportClauseName(), strImportFrom);
                }
            }
            // 找到所有napi调用并记录
            if(importMap.size > 0){
                for(const arkClass of ModelUtils.getAllClassesInFile(arkFile)){
                    for(const arkMethod of arkClass.getMethods()){
                        const body = arkMethod.getBody();
                        if(body){
                            this.PraseNapiCall(body, importMap);
                        }
                    }
                }
            }
        }
    }

    private PraseNapiCall(body: ArkBody, importMap: Map<string, string>): void {
        // 遍历body中的所有stmt
        const cfg = body.getCfg();
        for(const threeAddressStmt of cfg.getStmts()){
            if(threeAddressStmt.containsInvokeExpr()){
                const invokeExpr = threeAddressStmt.getInvokeExpr();
                if(invokeExpr instanceof ArkInstanceInvokeExpr){
                    logger.info(`invokeExpr: ${invokeExpr.toString()}`);
                    // getbase
                    const base = invokeExpr.getBase();
                    const basename = base.getName();
                    if(importMap.has(basename)){
                        const importFrom = importMap.get(basename);
                        logger.info(`importFrom: ${importFrom}`);
                        // 获取invokeExpr的签名
                        const methodSignature = invokeExpr.getMethodSignature();
                        logger.info(`methodSignature: ${methodSignature.toString()}`);
                        if (importFrom) {
                            const existingExprs = this.NapiCallExprMap.get(importFrom) || [];
                            existingExprs.push(invokeExpr);
                            this.NapiCallExprMap.set(importFrom, existingExprs);
                        }
                    }
                }
            }
        }
    }

    /**
     * 重建所有函数体
     */
    private rebuildFunctionBodies(moduleClass: ArkClass): void {
        if (!this.irModule) {
            throw new Error('IRModule is not initialized');
        }

        // 遍历所有napicallexpr，为每一个调用创建对应的函数
        for(const [importFrom, invokeExprs] of this.NapiCallExprMap.entries()){
            logger.info(`importFrom: ${importFrom}`);
            const libname = importFrom ? importFrom.replace(/^lib/, '') : '';
            if(this.irModule.getModuleName() === libname){
                for(const invokeExpr of invokeExprs){
                    logger.info(`invokeExpr: ${invokeExpr.toString()}`);
                    // get invoke Expr name
                    const invokeExprName = invokeExpr.getMethodSignature().getMethodSubSignature().getMethodName();
                    const irFunction = this.irModule.getFunctionByName(invokeExprName);
                    if(irFunction){
                        logger.info(`irFunction: ${irFunction.getName()}`);
                    }
                    else{
                        logger.info(`irFunction not found`);
                    }
                    // 为每个函数创建FunctionBodyRebuilder
                    if (irFunction) {
                        const rebuilder = new FunctionBodyRebuilder(this.scene, moduleClass, irFunction, this.methodSubSignatureMap, invokeExpr);
                        // 重建函数体
                        this.rebuiltBodys.push(rebuilder.rebuildFunctionBody());

                        logger.info(`rebuilder done`);
                    }
                }
            }
        }
        

        // 遍历所有函数
        // this.irModule.getFunctions().forEach(irFunction => {
        //     logger.info(`Processing function: ${irFunction.getName()}`);
            
        //     // 为每个函数创建FunctionBodyRebuilder
        //     const rebuilder = new FunctionBodyRebuilder(this.scene, moduleClass, irFunction, this.methodSubSignatureMap);
            
        //     // 重建函数体
        //     rebuilder.rebuildFunctionBody();
        // });
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

// 运行示例
// const irFilePath = "./NativeBodyRebuilder/test_resources/native_complex/libentry.so.ir.json";
// const projectDir = 'tests/resources/HarmonyNativeFlowBench/native_complex';
// const sceneConfig = new SceneConfig({ enableTrailingComments: true, enableLeadingComments: true });
// sceneConfig.buildFromProjectDir(projectDir);

// const scene = new Scene();
// scene.buildSceneFromProjectDir(sceneConfig);
// scene.inferTypes();
// const nativeBodyRebuilder = new NativeBodyRebuilder(irFilePath, scene);
// nativeBodyRebuilder.rebuildNativeBody();

