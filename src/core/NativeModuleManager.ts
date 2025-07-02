import { readFileSync } from 'fs';
import { Scene } from '@ArkAnalyzer/src/Scene';
import { IRModule } from '../ir/IRFunction';
import { NativeModule } from './NativeModule';
import { MethodSubSignatureMap } from '../ir/JsonObjectInterface';
import { ArkMethod, ArkInstanceInvokeExpr, ArkStaticInvokeExpr, ArkPtrInvokeExpr } from '@ArkAnalyzer/src';
import { CallDetailInfo } from './CrossLanguageCallAnalyzer';
import ConsoleLogger from '@ArkAnalyzer/src/utils/logger';
import { LOG_MODULE_TYPE } from '@ArkAnalyzer/src/utils/logger';

const logger = ConsoleLogger.getLogger(LOG_MODULE_TYPE.TOOL, 'NativeModuleManager');

/**
 * 原生模块管理器
 * 负责管理多个IR文件对应的NativeModule实例
 */
export class NativeModuleManager {
    private scene: Scene;
    private modules: Map<string, NativeModule> = new Map();
    private irFilePaths: string[];

    constructor(irFilePaths: string[], scene: Scene) {
        this.irFilePaths = irFilePaths;
        this.scene = scene;
    }

    /**
     * 加载所有IR文件并创建对应的模块
     */
    public loadAllModules(): boolean {
        logger.info(`Loading ${this.irFilePaths.length} IR files...`);
        
        let successCount = 0;
        for (const irFilePath of this.irFilePaths) {
            if (this.loadSingleModule(irFilePath)) {
                successCount++;
            }
        }

        logger.info(`Successfully loaded ${successCount}/${this.irFilePaths.length} modules`);
        return successCount > 0;
    }

    /**
     * 加载单个IR文件并创建模块
     */
    private loadSingleModule(irFilePath: string): boolean {
        try {
            // 读取IR文件
            const content = this.readIRFile(irFilePath);
            if (!content) {
                return false;
            }
            
            // 解析IR文件内容
            const jsonIR = this.parseIRContent(content, irFilePath);
            if (!jsonIR) {
                return false;
            }
            
            // 创建IRModule
            const irModule = IRModule.fromJson(jsonIR);
            const moduleName = irModule.getModuleName();
            
            if (this.modules.has(moduleName)) {
                logger.warn(`Duplicate module name found: ${moduleName}. Overwriting previous module.`);
            }
            
            // 创建NativeModule
            const nativeModule = new NativeModule(irModule, this.scene);
            this.modules.set(moduleName, nativeModule);
            
            logger.info(`Loaded module: ${moduleName} from ${irFilePath}`);
            return true;
            
        } catch (error) {
            logger.error(`Failed to process IR file: ${irFilePath}`, error);
            return false;
        }
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
     * 重建指定模块的函数体
     */
    public rebuildModuleFunctions(
        moduleName: string,
        invokeExprs: (ArkInstanceInvokeExpr | ArkStaticInvokeExpr | ArkPtrInvokeExpr)[],
        methodSubSignatureMap: Map<string, MethodSubSignatureMap[]>
    ): ArkMethod[] {
        const module = this.modules.get(moduleName);
        if (!module) {
            logger.warn(`Module not found: ${moduleName}`);
            return [];
        }

        return module.rebuildMultipleFunctions(invokeExprs, methodSubSignatureMap);
    }

    /**
     * 重建所有模块的函数体
     */
    public rebuildAllModuleFunctions(
        callMap: Map<string, (ArkInstanceInvokeExpr | ArkStaticInvokeExpr | ArkPtrInvokeExpr)[]>,
        methodSubSignatureMap: Map<string, MethodSubSignatureMap[]>
    ): ArkMethod[] {
        const allRebuiltMethods: ArkMethod[] = [];
        let totalRebuiltFunctions = 0;
        
        // 遍历所有调用映射，为每一个调用创建对应的函数
        for (const [importFrom, invokeExprs] of callMap.entries()) {
            logger.info(`Processing importFrom: ${importFrom}`);
            const libname = importFrom ? importFrom.replace(/^lib/, '') : '';
            
            // 查找对应的模块
            const module = this.modules.get(libname);
            if (!module) {
                logger.warn(`No module found for libname: ${libname}`);
                continue;
            }
            
            // 重建模块的函数
            const rebuiltMethods = module.rebuildMultipleFunctions(invokeExprs, methodSubSignatureMap);
            allRebuiltMethods.push(...rebuiltMethods);
            totalRebuiltFunctions += rebuiltMethods.length;
            
            logger.info(`Rebuilt ${rebuiltMethods.length} functions for module: ${libname}`);
        }
        
        logger.info(`Total rebuilt functions: ${totalRebuiltFunctions} across ${this.modules.size} modules`);
        return allRebuiltMethods;
    }

    /**
     * 重建指定模块的函数体（使用函数名到signature的映射）
     */
    public rebuildModuleFunctionsWithSignatureMap(
        moduleName: string,
        invokeExprs: (ArkInstanceInvokeExpr | ArkStaticInvokeExpr | ArkPtrInvokeExpr)[],
        functionSignatureMap: Map<string, MethodSubSignatureMap> = new Map()
    ): ArkMethod[] {
        const module = this.modules.get(moduleName);
        if (!module) {
            logger.warn(`Module not found: ${moduleName}`);
            return [];
        }

        return module.rebuildMultipleFunctionsWithSignatureMap(invokeExprs, functionSignatureMap);
    }

    /**
     * 重建所有模块的函数体（改进版，支持更精确的signature传递）
     */
    public rebuildAllModuleFunctionsImproved(
        callMap: Map<string, (ArkInstanceInvokeExpr | ArkStaticInvokeExpr | ArkPtrInvokeExpr)[]>,
        moduleSignatureMap: Map<string, Map<string, MethodSubSignatureMap>> = new Map()
    ): ArkMethod[] {
        const allRebuiltMethods: ArkMethod[] = [];
        let totalRebuiltFunctions = 0;
        
        // 遍历所有调用映射，为每一个调用创建对应的函数
        for (const [importFrom, invokeExprs] of callMap.entries()) {
            logger.info(`Processing importFrom: ${importFrom}`);
            const libname = importFrom ? importFrom.replace(/^lib/, '') : '';
            
            // 查找对应的模块
            const module = this.modules.get(libname);
            if (!module) {
                logger.warn(`No module found for libname: ${libname}`);
                continue;
            }
            
            // 获取该模块的函数signature映射
            const functionSignatureMap = moduleSignatureMap.get(libname) || new Map();
            
            // 重建模块的函数
            const rebuiltMethods = module.rebuildMultipleFunctionsWithSignatureMap(invokeExprs, functionSignatureMap);
            allRebuiltMethods.push(...rebuiltMethods);
            totalRebuiltFunctions += rebuiltMethods.length;
            
            logger.info(`Rebuilt ${rebuiltMethods.length} functions for module: ${libname}`);
        }
        
        logger.info(`Total rebuilt functions: ${totalRebuiltFunctions} across ${this.modules.size} modules`);
        return allRebuiltMethods;
    }

    /**
     * 重建所有模块的函数体（使用包含签名的CallDetailInfo）
     */
    public rebuildAllModuleFunctionsWithCallDetails(
        callDetailsMap: Map<string, CallDetailInfo[]>
    ): ArkMethod[] {
        const allRebuiltMethods: ArkMethod[] = [];
        let totalRebuiltFunctions = 0;
        
        // 遍历所有调用详情映射，为每一个调用创建对应的函数
        for (const [importFrom, callDetails] of callDetailsMap.entries()) {
            logger.info(`Processing importFrom: ${importFrom} with ${callDetails.length} call details`);
            const libname = importFrom ? importFrom.replace(/^lib/, '') : '';
            
            // 查找对应的模块
            const module = this.modules.get(libname);
            if (!module) {
                logger.warn(`No module found for libname: ${libname}`);
                continue;
            }
            
            // 重建模块的函数（使用包含签名的CallDetailInfo）
            const rebuiltMethods = module.rebuildMultipleFunctionsWithCallDetails(callDetails);
            allRebuiltMethods.push(...rebuiltMethods);
            totalRebuiltFunctions += rebuiltMethods.length;
            
            logger.info(`Rebuilt ${rebuiltMethods.length} functions for module: ${libname}`);
        }
        
        logger.info(`Total rebuilt functions: ${totalRebuiltFunctions} across ${this.modules.size} modules`);
        return allRebuiltMethods;
    }

    /**
     * 获取指定模块
     */
    public getModule(moduleName: string): NativeModule | undefined {
        return this.modules.get(moduleName);
    }

    /**
     * 获取所有模块
     */
    public getAllModules(): Map<string, NativeModule> {
        return new Map(this.modules);
    }

    /**
     * 获取模块数量
     */
    public getModuleCount(): number {
        return this.modules.size;
    }

    /**
     * 获取所有模块的重建方法
     */
    public getAllRebuiltMethods(): ArkMethod[] {
        const allMethods: ArkMethod[] = [];
        for (const module of this.modules.values()) {
            allMethods.push(...module.getRebuiltMethods());
        }
        return allMethods;
    }

    /**
     * 打印所有模块的详细信息
     */
    public printAllModuleDetails(): void {
        if (this.modules.size === 0) {
            logger.warn('No modules are loaded');
            return;
        }
        
        logger.info(`=== Module Details (Total: ${this.modules.size}) ===`);
        
        for (const [moduleName, module] of this.modules) {
            module.printDetails();
            logger.info(''); // 空行分隔
        }
    }

    /**
     * 获取模块统计信息
     */
    public getModuleStatistics(): {
        totalModules: number;
        totalFunctions: number;
        totalRebuiltMethods: number;
        moduleDetails: Array<{
            moduleName: string;
            functionCount: number;
            rebuiltMethodCount: number;
        }>;
    } {
        const moduleDetails: Array<{
            moduleName: string;
            functionCount: number;
            rebuiltMethodCount: number;
        }> = [];

        let totalFunctions = 0;
        let totalRebuiltMethods = 0;

        for (const module of this.modules.values()) {
            const details = module.getModuleDetails();
            moduleDetails.push({
                moduleName: details.moduleName,
                functionCount: details.functionCount,
                rebuiltMethodCount: details.rebuiltMethodCount
            });
            totalFunctions += details.functionCount;
            totalRebuiltMethods += details.rebuiltMethodCount;
        }

        return {
            totalModules: this.modules.size,
            totalFunctions,
            totalRebuiltMethods,
            moduleDetails
        };
    }

    /**
     * 检查模块是否存在
     */
    public hasModule(moduleName: string): boolean {
        return this.modules.has(moduleName);
    }

    /**
     * 清空所有模块
     */
    public clear(): void {
        this.modules.clear();
        logger.info('All modules cleared');
    }
}
