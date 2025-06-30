import { readdirSync, statSync } from 'fs';
import { LOG_LEVEL, LOG_MODULE_TYPE } from '@ArkAnalyzer/src/utils/logger';
import ConsoleLogger from '@ArkAnalyzer/src/utils/logger';
import { Scene } from '@ArkAnalyzer/src/Scene';
import { SceneConfig } from '@ArkAnalyzer/src/Config';
import { IndexdtsUtils } from './IndexdtsUtils';
import { MethodSubSignatureMap } from './ir/JsonObjectInterface';
import path from 'path';
import { ArkMethod } from '@ArkAnalyzer/src';

// 导入新的模块化组件
import { NativeModuleManager } from './core/NativeModuleManager';
import { CrossLanguageCallAnalyzer } from './core/CrossLanguageCallAnalyzer';
import { NativeModule } from './core/NativeModule';

// 设置日志
const logPath = 'out/ArkAnalyzer.log';
const logger = ConsoleLogger.getLogger(LOG_MODULE_TYPE.TOOL, 'NativeBodyRebuilder');
ConsoleLogger.configure(logPath, LOG_LEVEL.DEBUG, LOG_LEVEL.DEBUG);

/**
 * 本机函数体重建器类
 * 
 * 负责从IR文件读取数据，创建IR对象，然后为每个函数重建函数体
 * 重构后的版本，使用模块化组件进行管理
 */
export class NativeBodyRebuilder {
    private irFilePaths: string[];
    private scene: Scene;
    private moduleManager: NativeModuleManager;
    private callAnalyzer: CrossLanguageCallAnalyzer;
    private methodSubSignatureMap: Map<string, MethodSubSignatureMap[]> = new Map();
    
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
        
        // 初始化管理器组件
        this.moduleManager = new NativeModuleManager(this.irFilePaths, this.scene);
        this.callAnalyzer = new CrossLanguageCallAnalyzer(this.scene);
        
        logger.info(`Initialized with ${this.irFilePaths.length} IR file(s):`);
        this.irFilePaths.forEach(path => logger.info(`  - ${path}`));
    }
    
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
        // 1. 加载所有IR文件并创建模块
        if (!this.moduleManager.loadAllModules()) {
            logger.warn('No IR modules loaded successfully');
            return;
        }
        
        // 2. 分析跨语言调用
        const napiCallDetailsMap = this.callAnalyzer.analyzeCrossLanguageCalls();
        
        // 3. 构建NAPI导出映射
        this.buildNapiExportMap();
        
        // 4. 重建所有模块的函数体（使用CallDetailInfo）
        const rebuiltMethods = this.moduleManager.rebuildAllModuleFunctionsWithCallDetails(napiCallDetailsMap, this.methodSubSignatureMap);
        
        logger.info(`Successfully rebuilt ${rebuiltMethods.length} native function bodies`);
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

    /**
     * 重建Native函数体（改进版，支持更精确的signature传递）
     */
    public rebuildNativeBodyImproved(): void {
        // 1. 加载所有IR文件并创建模块
        if (!this.moduleManager.loadAllModules()) {
            logger.warn('No IR modules loaded successfully');
            return;
        }
        
        // 2. 分析跨语言调用
        const napiCallDetailsMap = this.callAnalyzer.analyzeCrossLanguageCalls();
        
        // 3. 构建NAPI导出映射
        this.buildNapiExportMap();
        
        // 4. 转换methodSubSignatureMap为模块-函数的两级映射
        const moduleSignatureMap = this.convertToModuleFunctionSignatureMap();
        
        // 5. 使用基于CallDetail的重建方法
        const rebuiltMethods = this.moduleManager.rebuildAllModuleFunctionsWithCallDetails(napiCallDetailsMap, this.methodSubSignatureMap);
        
        logger.info(`Successfully rebuilt ${rebuiltMethods.length} native function bodies using improved method with call details`);
    }
    
    /**
     * 转换methodSubSignatureMap为模块-函数的两级映射
     */
    private convertToModuleFunctionSignatureMap(): Map<string, Map<string, MethodSubSignatureMap>> {
        const moduleSignatureMap = new Map<string, Map<string, MethodSubSignatureMap>>();
        
        for (const [moduleName, methodSubSignatureArray] of this.methodSubSignatureMap) {
            const functionSignatureMap = new Map<string, MethodSubSignatureMap>();
            
            // 将数组中的每个signature按函数名分组
            for (const methodSubSignature of methodSubSignatureArray) {
                // 假设MethodSubSignatureMap有一个方法可以获取函数名
                // 这里需要根据实际的MethodSubSignatureMap结构进行调整
                const functionName = this.extractFunctionNameFromSignature(methodSubSignature);
                if (functionName) {
                    functionSignatureMap.set(functionName, methodSubSignature);
                }
            }
            
            moduleSignatureMap.set(moduleName, functionSignatureMap);
            logger.info(`Converted signatures for module: ${moduleName}, functions: ${functionSignatureMap.size}`);
        }
        
        return moduleSignatureMap;
    }
    
    /**
     * 从MethodSubSignatureMap中提取函数名
     * 这个方法需要根据实际的MethodSubSignatureMap结构进行实现
     */
    private extractFunctionNameFromSignature(methodSubSignature: MethodSubSignatureMap): string | null {
        // TODO: 这里需要根据实际的MethodSubSignatureMap结构来实现
        // 可能需要访问methodSubSignature的某个属性来获取函数名
        try {
            // 假设有一个getFunctionName方法或者类似的属性
            if (typeof methodSubSignature === 'object' && methodSubSignature !== null) {
                // 尝试常见的属性名
                const possibleNames = ['functionName', 'name', 'methodName', 'identifier'];
                for (const propName of possibleNames) {
                    if (propName in methodSubSignature) {
                        const value = (methodSubSignature as any)[propName];
                        if (typeof value === 'string') {
                            return value;
                        }
                    }
                }
            }
            
            // 如果找不到合适的属性，记录警告并返回null
            logger.warn('Unable to extract function name from methodSubSignature:', methodSubSignature);
            return null;
        } catch (error) {
            logger.error('Error extracting function name from signature:', error);
            return null;
        }
    }

    /**
     * 获取所有已加载的模块
     */
    public getModules(): Map<string, NativeModule> {
        return this.moduleManager.getAllModules();
    }
    
    /**
     * 获取指定名称的模块
     */
    public getModule(moduleName: string): NativeModule | undefined {
        return this.moduleManager.getModule(moduleName);
    }
    
    /**
     * 获取所有重建的方法体
     */
    public getRebuiltBodies(): Array<ArkMethod> {
        return this.moduleManager.getAllRebuiltMethods();
    }

    /**
     * 打印模块详细信息
     */
    public printModuleDetails(): void {
        this.moduleManager.printAllModuleDetails();
    }

    /**
     * 获取模块统计信息
     */
    public getModuleStatistics() {
        return this.moduleManager.getModuleStatistics();
    }

    /**
     * 获取跨语言调用分析器
     */
    public getCallAnalyzer(): CrossLanguageCallAnalyzer {
        return this.callAnalyzer;
    }

    /**
     * 获取模块管理器
     */
    public getModuleManager(): NativeModuleManager {
        return this.moduleManager;
    }
}

// 运行示例 (保留注释供参考)
// const irFilePath = "./NativeBodyRebuilder/test_resources/native_complex/libentry.so.ir.json";
// const projectDir = 'tests/resources/HarmonyNativeFlowBench/native_complex';
// const sceneConfig = new SceneConfig({ enableTrailingComments: true, enableLeadingComments: true });
// sceneConfig.buildFromProjectDir(projectDir);

// const scene = new Scene();
// scene.buildSceneFromProjectDir(sceneConfig);
// scene.inferTypes();
// const nativeBodyRebuilder = new NativeBodyRebuilder(irFilePath, scene);
// nativeBodyRebuilder.rebuildNativeBody();

