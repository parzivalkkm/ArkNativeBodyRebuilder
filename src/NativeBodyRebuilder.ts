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
 * 函数体重建器类
 * 
 * 负责从IR文件读取数据，创建IR对象，然后为每个函数重建函数体
 * 重构后的版本，使用模块化组件进行管理
 */
export class NativeBodyRebuilder {
    private irFilePaths: string[];
    private scene: Scene;
    private moduleManager: NativeModuleManager;
    private callAnalyzer?: CrossLanguageCallAnalyzer; // 现在是可选的，在rebuildNativeBody中创建
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
        // 注意：callAnalyzer 将在 rebuildNativeBody 中创建，因为需要先构建方法签名映射
        
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
        
        // 2. 构建NAPI导出映射（从.d.ts文件）
        this.buildNapiExportMap();
        
        // 3. 创建跨语言调用分析器（传入方法签名映射）
        this.callAnalyzer = new CrossLanguageCallAnalyzer(this.scene, this.methodSubSignatureMap);
        
        // 4. 分析跨语言调用（已包含方法签名匹配）
        const napiCallDetailsMap = this.callAnalyzer.analyzeCrossLanguageCalls();
        
        // 5. 重建所有模块的函数体（使用包含签名的CallDetailInfo）
        const rebuiltMethods = this.moduleManager.rebuildAllModuleFunctionsWithCallDetails(napiCallDetailsMap);
        
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
    public getCallAnalyzer(): CrossLanguageCallAnalyzer | undefined {
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

