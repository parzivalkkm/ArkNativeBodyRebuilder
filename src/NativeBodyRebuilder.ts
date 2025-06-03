import { readFileSync, readdirSync, statSync } from 'fs';
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
    private irFilePaths: string[];
    private scene: Scene;
    private irModules: Map<string, IRModule> = new Map(); // 存储多个IRModule
    
    private methodSubSignatureMap: Map<string, MethodSubSignatureMap[]> = new Map();
    private NapiCallExprMap: Map<string, ArkInstanceInvokeExpr[]> = new Map();
    
    // 修改构造函数，支持单个文件路径或文件路径数组
    constructor(irFilePathOrPaths: string | string[], scene: Scene) {
        if (Array.isArray(irFilePathOrPaths)) {
            this.irFilePaths = irFilePathOrPaths;
        } else if (this.isDirectory(irFilePathOrPaths)) {
            // 如果是目录，扫描所有.ir.json文件
            this.irFilePaths = this.scanIRFiles(irFilePathOrPaths);
        } else {
            // 单个文件
            this.irFilePaths = [irFilePathOrPaths];
        }
        this.scene = scene;
        
        logger.info(`Initialized with ${this.irFilePaths.length} IR file(s):`);
        this.irFilePaths.forEach(path => logger.info(`  - ${path}`));
    }

    private rebuiltBodys: Array<ArkMethod> = [];
    
    /**
     * 检查路径是否为目录
     */
    private isDirectory(path: string): boolean {
        try {
            return statSync(path).isDirectory();
        } catch {
            return false;
        }
    }
    
    /**
     * 扫描目录中的所有IR文件
     */
    private scanIRFiles(dirPath: string): string[] {
        try {
            const files = readdirSync(dirPath);
            const irFiles: string[] = [];
            
            for (const file of files) {
                const fullPath = path.join(dirPath, file);
                const stat = statSync(fullPath);
                
                if (stat.isFile() && file.endsWith('.ir.json')) {
                    irFiles.push(fullPath);
                } else if (stat.isDirectory()) {
                    // 递归扫描子目录
                    irFiles.push(...this.scanIRFiles(fullPath));
                }
            }
            
            return irFiles;
        } catch (error) {
            logger.error(`Failed to scan directory: ${dirPath}`, error);
            return [];
        }
    }
    
    /**
     * 重建Native函数体
     */
    public rebuildNativeBody(): void {
        // 1. 读取并解析所有IR文件
        this.loadAllIRFiles();
        
        if (this.irModules.size === 0) {
            logger.warn('No IR modules loaded successfully');
            return;
        }
        
        // 2. 为每个IRModule创建对应的ArkFile和ArkClass
        const moduleClassMap = new Map<string, ArkClass>();
        for (const [moduleName, irModule] of this.irModules) {
            const moduleFile = this.createArkFile(irModule);
            const moduleClass = this.createArkClass(moduleFile, irModule);
            moduleClassMap.set(moduleName, moduleClass);
        }

        // 3. 遍历Ark Project，找到napi调用并记录
        this.recordNapiCalls();
        
        // 4. 导出exportMap
        this.buildNapiExportMap();
        
        // 5. 重建所有模块的函数体
        this.rebuildAllFunctionBodies(moduleClassMap);
    }
    
    /**
     * 加载所有IR文件
     */
    private loadAllIRFiles(): void {
        for (const irFilePath of this.irFilePaths) {
            try {
                // 读取IR文件
                const content = this.readIRFile(irFilePath);
                if (!content) {
                    continue;
                }
                
                // 解析IR文件内容
                const jsonIR = this.parseIRContent(content, irFilePath);
                if (!jsonIR) {
                    continue;
                }
                
                // 创建IRModule
                const irModule = IRModule.fromJson(jsonIR);
                const moduleName = irModule.getModuleName();
                
                if (this.irModules.has(moduleName)) {
                    logger.warn(`Duplicate module name found: ${moduleName}. Overwriting previous module.`);
                }
                
                this.irModules.set(moduleName, irModule);
                logger.info(`Loaded IRModule: ${moduleName} from ${irFilePath}`);
                
            } catch (error) {
                logger.error(`Failed to process IR file: ${irFilePath}`, error);
            }
        }
        
        logger.info(`Successfully loaded ${this.irModules.size} IR module(s)`);
    }
    
    /**
     * 读取IR文件内容
     */
    private readIRFile(irFilePath: string): string | null {
        try {
            const content = readFileSync(irFilePath, 'utf-8');
            logger.debug(`Read IR file: ${irFilePath}`);
            return content;
        } catch (error) {
            logger.error(`Failed to read IR file: ${irFilePath}`, error);
            return null;
        }
    }
    
    /**
     * 解析IR文件内容
     */
    private parseIRContent(content: string, filePath: string): any {
        try {
            const jsonIR = JSON.parse(content);
            logger.debug(`Parsed IR file successfully: ${filePath}`);
            return jsonIR;
        } catch (error) {
            logger.error(`Failed to parse IR content from: ${filePath}`, error);
            return null;
        }
    }
    
    /**
     * 创建ArkFile
     */
    private createArkFile(irModule: IRModule): ArkFile {
        const moduleFile = new ArkFile(Language.TYPESCRIPT);
        moduleFile.setScene(this.scene);
        
        const moduleFileSignature = new FileSignature(
            this.scene.getProjectName(),
            `@nodeapiFile${irModule.getModuleName()}`
        );
        
        moduleFile.setFileSignature(moduleFileSignature);
        this.scene.setFile(moduleFile);
        
        return moduleFile;
    }
    
    /**
     * 创建ArkClass
     */
    private createArkClass(moduleFile: ArkFile, irModule: IRModule): ArkClass {
        const moduleClass = new ArkClass();
        moduleClass.setDeclaringArkFile(moduleFile);
        
        const moduleClassSignature = new ClassSignature(
            `@nodeapiClass${irModule.getModuleName()}`,
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
     * 重建所有模块的函数体
     */
    private rebuildAllFunctionBodies(moduleClassMap: Map<string, ArkClass>): void {
        let totalRebuiltFunctions = 0;
        
        // 遍历所有napicallexpr，为每一个调用创建对应的函数
        for(const [importFrom, invokeExprs] of this.NapiCallExprMap.entries()){
            logger.info(`Processing importFrom: ${importFrom}`);
            const libname = importFrom ? importFrom.replace(/^lib/, '') : '';
            
            // 查找对应的IRModule
            const irModule = this.irModules.get(libname);
            if (!irModule) {
                logger.warn(`No IRModule found for libname: ${libname}`);
                continue;
            }
            
            const moduleClass = moduleClassMap.get(libname);
            if (!moduleClass) {
                logger.warn(`No ModuleClass found for libname: ${libname}`);
                continue;
            }
            
            let moduleRebuiltCount = 0;
            for(const invokeExpr of invokeExprs){
                logger.info(`Processing invokeExpr: ${invokeExpr.toString()}`);
                // get invoke Expr name
                const invokeExprName = invokeExpr.getMethodSignature().getMethodSubSignature().getMethodName();
                const irFunction = irModule.getFunctionByName(invokeExprName);
                
                if(irFunction){
                    logger.info(`Found irFunction: ${irFunction.getName()}`);
                    
                    // 为每个函数创建FunctionBodyRebuilder
                    const rebuilder = new FunctionBodyRebuilder(this.scene, moduleClass, irFunction, this.methodSubSignatureMap, invokeExpr);
                    
                    // 重建函数体
                    this.rebuiltBodys.push(rebuilder.rebuildFunctionBody());
                    moduleRebuiltCount++;
                    
                    logger.info(`Rebuilder done for function: ${irFunction.getName()}`);
                } else {
                    logger.warn(`IRFunction not found for: ${invokeExprName}`);
                }
            }
            
            totalRebuiltFunctions += moduleRebuiltCount;
            logger.info(`Rebuilt ${moduleRebuiltCount} functions for module: ${libname}`);
        }
        
        logger.info(`Total rebuilt functions: ${totalRebuiltFunctions} across ${this.irModules.size} modules`);
    }

    /**
     * 获取所有已加载的IRModule
     */
    public getIRModules(): Map<string, IRModule> {
        return this.irModules;
    }
    
    /**
     * 获取指定名称的IRModule
     */
    public getIRModule(moduleName: string): IRModule | undefined {
        return this.irModules.get(moduleName);
    }
    
    /**
     * 获取所有重建的方法体
     */
    public getRebuiltBodies(): Array<ArkMethod> {
        return this.rebuiltBodys;
    }

    public printModuleDetails(): void {
        if (this.irModules.size === 0) {
            logger.warn('No IRModules are loaded');
            return;
        }
        
        logger.info(`=== Module Details (Total: ${this.irModules.size}) ===`);
        
        for (const [moduleName, irModule] of this.irModules) {
            logger.info(`Module: ${moduleName}`);
            logger.info(`  HAP Name: ${irModule.getHapName()}`);
            logger.info(`  SO Name: ${irModule.getSoName()}`);
            logger.info(`  Functions: ${irModule.getFunctions().length}`);
            
            irModule.getFunctions().forEach((func, index) => {
                logger.info(`    ${index + 1}. Function: ${func.getName()}`);
                logger.info(`       Parameters: ${func.getParameters().size}`);
                logger.info(`       Instructions: ${func.getInstructions().length}`);
            });
            logger.info(''); // 空行分隔
        }
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

