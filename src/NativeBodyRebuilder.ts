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
 * 重建统计信息接口
 */
export interface RebuildStatistics {
    // SumIR相关统计
    totalSumIRFunctions: number;
    totalSumIRInstructions: number;
    
    // 重建相关统计
    totalRebuiltMethods: number;
    rebuildSuccessRate: number;
    
    // 时间统计 (毫秒)
    totalRebuildDuration: number;
    analyzeCrossLanguageCallsDuration: number;
    rebuildAllModuleFunctionsDuration: number;
    
    // 调用点统计
    totalCallsites: number;
    callsitesByType: Map<string, number>;
    
    // 详细的模块统计
    moduleStatistics: Array<{
        moduleName: string;
        sumIRFunctions: number;
        rebuiltMethods: number;
        callsites: number;
        rebuildDuration: number;
    }>;
}

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
    
    // 新增：统计信息
    private statistics: RebuildStatistics;
    private rebuildStartTime: number = 0;
    
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
        
        // 初始化统计信息
        this.initializeStatistics();
        
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
     * 初始化统计信息
     */
    private initializeStatistics(): void {
        this.statistics = {
            totalSumIRFunctions: 0,
            totalSumIRInstructions: 0,
            totalRebuiltMethods: 0,
            rebuildSuccessRate: 0,
            totalRebuildDuration: 0,
            analyzeCrossLanguageCallsDuration: 0,
            rebuildAllModuleFunctionsDuration: 0,
            totalCallsites: 0,
            callsitesByType: new Map(),
            moduleStatistics: []
        };
    }
    
    /**
     * 收集SumIR统计信息
     */
    private collectSumIRStatistics(): void {
        try {
            const modules = this.moduleManager.getAllModules();
            
            for (const [moduleName, module] of modules) {
                const moduleIR = module.getIRModule();
                const functions = moduleIR.getFunctions();
                
                if (functions && functions.length > 0) {
                    const functionCount = functions.length;
                    let instructionCount = 0;
                    
                    functions.forEach((func: any) => {
                        const instructions = func.getInstructions();
                        instructionCount += instructions ? instructions.length : 0;
                    });
                    
                    this.statistics.totalSumIRFunctions += functionCount;
                    this.statistics.totalSumIRInstructions += instructionCount;
                    
                    // 初始化模块统计
                    this.statistics.moduleStatistics.push({
                        moduleName,
                        sumIRFunctions: functionCount,
                        rebuiltMethods: 0, // 后续更新
                        callsites: 0, // 后续更新
                        rebuildDuration: 0 // 后续更新
                    });
                }
            }
            
            logger.info(`SumIR Statistics: ${this.statistics.totalSumIRFunctions} functions, ${this.statistics.totalSumIRInstructions} instructions`);
        } catch (error) {
            logger.error('Failed to collect SumIR statistics', error);
        }
    }
    
    /**
     * 收集调用点统计信息 - 从跨语言调用分析结果获取
     */
    private collectCallsiteStatistics(napiCallDetailsMap: Map<string, any[]>): void {
        try {
            let callsitesByType = new Map<string, number>();
            let totalCallsites = 0;
            
            // 优先从跨语言调用分析器获取统计信息
            if (this.callAnalyzer) {
                callsitesByType = this.callAnalyzer.getCallsiteStatistics();
                for (const count of callsitesByType.values()) {
                    totalCallsites += count;
                }
                logger.info('Using callsite statistics from CrossLanguageCallAnalyzer');
            } else {
                // 备用方案：从napiCallDetailsMap中计算
                logger.info('Fallback: calculating callsite statistics from napiCallDetailsMap');
                for (const [moduleName, callDetails] of napiCallDetailsMap.entries()) {
                    if (callDetails && Array.isArray(callDetails)) {
                        totalCallsites += callDetails.length;
                        // 简单统计为通用调用
                        callsitesByType.set('native_calls', totalCallsites);
                    }
                }
            }
            
            // 更新模块级调用点统计
            for (const [moduleName, callDetails] of napiCallDetailsMap.entries()) {
                const moduleStat = this.statistics.moduleStatistics.find(stat => stat.moduleName === moduleName);
                if (moduleStat && callDetails && Array.isArray(callDetails)) {
                    moduleStat.callsites = callDetails.length;
                }
            }
            
            this.statistics.totalCallsites = totalCallsites;
            this.statistics.callsitesByType = callsitesByType;
            
            logger.info(`Callsite Statistics: ${totalCallsites} total callsites found from analysis results`);
            
            // 打印调用点类型分布
            if (callsitesByType.size > 0) {
                logger.info('Callsite distribution:');
                for (const [type, count] of callsitesByType.entries()) {
                    logger.info(`  - ${type}: ${count}`);
                }
            }
        } catch (error) {
            logger.error('Failed to collect callsite statistics', error);
        }
    }
    
    /**
     * 更新重建统计信息
     */
    private updateRebuildStatistics(): void {
        try {
            const rebuiltMethods = this.moduleManager.getAllRebuiltMethods();
            this.statistics.totalRebuiltMethods = rebuiltMethods.length;
            
            if (this.statistics.totalSumIRFunctions > 0) {
                this.statistics.rebuildSuccessRate = 
                    (this.statistics.totalRebuiltMethods / this.statistics.totalSumIRFunctions) * 100;
            }
            
            this.statistics.totalRebuildDuration = Date.now() - this.rebuildStartTime;
            
            // 更新模块级统计
            const modules = this.moduleManager.getAllModules();
            this.statistics.moduleStatistics.forEach(moduleStat => {
                const module = modules.get(moduleStat.moduleName);
                if (module) {
                    const moduleRebuiltMethods = module.getRebuiltMethods();
                    moduleStat.rebuiltMethods = moduleRebuiltMethods.length;
                    moduleStat.rebuildDuration = this.statistics.totalRebuildDuration; // 简化处理
                }
            });
            
            logger.info(`Rebuild Statistics: ${this.statistics.totalRebuiltMethods}/${this.statistics.totalSumIRFunctions} methods rebuilt (${this.statistics.rebuildSuccessRate.toFixed(2)}%)`);
        } catch (error) {
            logger.error('Failed to update rebuild statistics', error);
        }
    }
    
    /**
     * 重建Native函数体
     */
    public rebuildNativeBody(): void {
        // 开始计时和统计收集
        this.rebuildStartTime = Date.now();
        
        // 1. 加载所有IR文件并创建模块
        if (!this.moduleManager.loadAllModules()) {
            logger.warn('No IR modules loaded successfully');
            return;
        }
        
        // 2. 收集SumIR统计信息
        this.collectSumIRStatistics();
        
        // 3. 构建NAPI导出映射（从.d.ts文件）
        this.buildNapiExportMap();
        
        // 4. 创建跨语言调用分析器（传入方法签名映射）
        this.callAnalyzer = new CrossLanguageCallAnalyzer(this.scene, this.methodSubSignatureMap);
        
        // 5. 分析跨语言调用（已包含方法签名匹配）- 开始计时
        const analyzeCrossLanguageCallsStart = Date.now();
        const napiCallDetailsMap = this.callAnalyzer.analyzeCrossLanguageCalls();
        this.statistics.analyzeCrossLanguageCallsDuration = Date.now() - analyzeCrossLanguageCallsStart;
        
        // 6. 重建所有模块的函数体（使用包含签名的CallDetailInfo）- 开始计时
        const rebuildAllModuleFunctionsStart = Date.now();
        const rebuiltMethods = this.moduleManager.rebuildAllModuleFunctionsWithCallDetails(napiCallDetailsMap);
        this.statistics.rebuildAllModuleFunctionsDuration = Date.now() - rebuildAllModuleFunctionsStart;
        
        // 7. 收集调用点统计信息
        this.collectCallsiteStatistics(napiCallDetailsMap);
        
        // 8. 更新重建统计信息
        this.updateRebuildStatistics();
        
        logger.info(`Successfully rebuilt ${rebuiltMethods.length} native function bodies`);
        logger.info(`Timing breakdown: analyzeCrossLanguageCalls=${this.statistics.analyzeCrossLanguageCallsDuration}ms, rebuildAllModuleFunctions=${this.statistics.rebuildAllModuleFunctionsDuration}ms`);
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
    
    /**
     * 获取重建统计信息
     */
    public getStatistics(): RebuildStatistics {
        return { ...this.statistics }; // 返回副本以防止外部修改
    }
    
    /**
     * 打印统计信息摘要
     */
    public printStatisticsSummary(): void {
        console.log('\n📊 NativeBodyRebuilder Statistics Summary:');
        console.log(`🔍 SumIR Analysis:`);
        console.log(`   - Total functions: ${this.statistics.totalSumIRFunctions}`);
        console.log(`   - Total instructions: ${this.statistics.totalSumIRInstructions}`);
        
        console.log(`🔄 Rebuild Performance:`);
        console.log(`   - Rebuilt methods: ${this.statistics.totalRebuiltMethods}`);
        console.log(`   - Success rate: ${this.statistics.rebuildSuccessRate.toFixed(2)}%`);
        console.log(`   - Total duration: ${this.statistics.totalRebuildDuration}ms`);
        console.log(`   - Cross-language analysis: ${this.statistics.analyzeCrossLanguageCallsDuration}ms`);
        console.log(`   - Function rebuilding: ${this.statistics.rebuildAllModuleFunctionsDuration}ms`);
        
        console.log(`📞 Callsite Analysis:`);
        console.log(`   - Total callsites: ${this.statistics.totalCallsites}`);
        
        if (this.statistics.callsitesByType.size > 0) {
            console.log(`   - Callsites by type:`);
            for (const [type, count] of this.statistics.callsitesByType) {
                console.log(`     * ${type}: ${count}`);
            }
        }
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

