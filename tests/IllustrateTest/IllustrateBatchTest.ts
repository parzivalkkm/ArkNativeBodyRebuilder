/**
 * Illustrate Batch Test Script
 * 
 * 功能：
 * 1. 批量导出SumIR文本格式
 * 2. 重建Native函数体并生成ArkIR
 * 3. 执行污点分析
 * 4. 输出详细统计数据和报告
 * 
 * 路径配置：
 * - IR目录：D:/WorkSpace/ArkTS_Native/Illustration/TaintAnalysisApp/CollectedNativeLibs
 * - 项目目录：D:/WorkSpace/ArkTS_Native/Illustration/TaintAnalysisApp/ProjectDirs
 * - 输出目录：out/illustrate_batch
 */

import { SceneConfig } from '@ArkAnalyzer/src/Config';
import { Scene } from '@ArkAnalyzer/src/Scene';
import Logger, { LOG_MODULE_TYPE, LOG_LEVEL } from '@ArkAnalyzer/src/utils/logger';
import { DummyMainCreater } from "@ArkAnalyzer/src/core/common/DummyMainCreater";
import { PointerAnalysisConfig } from "@ArkAnalyzer/src/callgraph/pointerAnalysis/PointerAnalysisConfig";
import { PointerAnalysis } from "@ArkAnalyzer/src/callgraph/pointerAnalysis/PointerAnalysis";
import { TaintAnalysisChecker } from "taintanalysis/TaintAnalysis";
import { TaintAnalysisSolver } from "taintanalysis/TaintAnalysisSolver";
import { NativeBodyRebuilder, RebuildStatistics } from 'src/NativeBodyRebuilder';
import { SumIRDumper } from 'src/ir/SumIRDumper';
import { ModuleIR } from 'src/ir/JsonObjectInterface';
import { ArkIRMethodPrinter } from '@ArkAnalyzer/src/save/arkir/ArkIRMethodPrinter';
import * as fs from 'fs';
import * as path from 'path';

// ================================
// 配置常量
// ================================

// 测试用例
const ILLUSTRATE_CASES = [
    'native_source',
    'native_leak', 
    'native_proxy',
    'native_delegation',
    'native_call_function_sink',
    'native_call_function_source',
    'native_call_function_proxy',
    'native_call_function_delegation',
    'native_proxy_copy',
    'native_call_function_object',
    'native_complex_data',
    'native_set_field',
    'native_array_set',
    'native_array_get',
    'native_error',
    'native_multiple_interaction',
    'native_multiple_libraries',
    'native_phi_branch',
    'native_phi_concat',
    'native_encode'
];

// 路径配置
const PATHS = {
    IR_BASE_DIR: 'D:/WorkSpace/ArkTS_Native/Illustration/TaintAnalysisApp/CollectedNativeLibs',
    PROJECT_BASE_DIR: 'D:/WorkSpace/ArkTS_Native/Illustration/TaintAnalysisApp/ProjectDirs',
    OUTPUT_DIR: 'out/illustrate_batch',
    CONFIG_BASE: 'tests/Batch/configs/IFDSConfig.json',
    SINK_CONFIG: 'tests/resources/sink.json',
    SOURCE_CONFIG: 'tests/resources/source.json',
    SANITIZATION_CONFIG: 'tests/resources/santizationPath.json'
};

// ================================
// 类型定义
// ================================

interface IllustrateTestResult {
    success: boolean;
    methodCount: number;
    taintFlows: number;
    duration: number;
    statistics?: RebuildStatistics;
    sumIROutput: string;
    arkIROutput: string;
    callsiteOutput: string;
    errorMessage?: string;
}

interface BatchSummary {
    totalCases: number;
    successCount: number;
    failedCount: number;
    totalMethods: number;
    totalTaintFlows: number;
    totalSumIRFunctions: number;
    totalRebuiltMethods: number;
    totalCallsites: number;
    totalRebuildDuration: number;
    averageRebuildTime: number;
    overallSuccessRate: number;
    rebuildSuccessRate: number;
}

// ================================
// 工具函数
// ================================

/**
 * 确保输出目录存在
 */
function ensureOutputDirectories(): void {
    const dirs = [
        PATHS.OUTPUT_DIR,
        path.join(PATHS.OUTPUT_DIR, 'configs'),
        path.join(PATHS.OUTPUT_DIR, 'logs'),
        path.join(PATHS.OUTPUT_DIR, 'ir_outputs'),
        path.join(PATHS.OUTPUT_DIR, 'arkir_outputs'),
        path.join(PATHS.OUTPUT_DIR, 'callsite_outputs')
    ];
    
    dirs.forEach(dir => {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    });
}

/**
 * 创建测试用例的配置文件
 */
function createTestConfig(testCase: string): string {
    const baseConfigPath = PATHS.CONFIG_BASE;
    
    if (!fs.existsSync(baseConfigPath)) {
        throw new Error(`Base config file not found: ${baseConfigPath}`);
    }
    
    const baseConfig = JSON.parse(fs.readFileSync(baseConfigPath, 'utf-8'));
    
    // 修改配置
    const testConfig = {
        ...baseConfig,
        targetProjectName: testCase,
        targetProjectDirectory: path.join(PATHS.PROJECT_BASE_DIR, testCase),
        logPath: path.join(PATHS.OUTPUT_DIR, 'logs', `illustrate_${testCase}.log`)
    };
    
    // 保存临时配置文件
    const tempConfigPath = path.join(PATHS.OUTPUT_DIR, 'configs', `IFDSConfig_${testCase}.json`);
    fs.writeFileSync(tempConfigPath, JSON.stringify(testConfig, null, 2));
    
    return tempConfigPath;
}

/**
 * 检查必要文件是否存在
 */
function validateTestEnvironment(testCase: string): { valid: boolean; message?: string } {
    const irFilePath = path.join(PATHS.IR_BASE_DIR, testCase, 'libentry.so.ir.json');
    const projectDir = path.join(PATHS.PROJECT_BASE_DIR, testCase);
    
    if (!fs.existsSync(irFilePath)) {
        return { valid: false, message: `IR file not found: ${irFilePath}` };
    }
    
    if (!fs.existsSync(projectDir)) {
        return { valid: false, message: `Project directory not found: ${projectDir}` };
    }
    
    // 检查资源配置文件
    const resourceFiles = [PATHS.SINK_CONFIG, PATHS.SOURCE_CONFIG, PATHS.SANITIZATION_CONFIG];
    for (const file of resourceFiles) {
        if (!fs.existsSync(file)) {
            return { valid: false, message: `Resource file not found: ${file}` };
        }
    }
    
    return { valid: true };
}

// ================================
// 核心处理函数
// ================================

/**
 * 处理单个测试用例
 */
function processIllustrateTestCase(testCase: string): IllustrateTestResult {
    const startTime = Date.now();
    
    try {
        console.log(`\n📋 [${testCase}] Starting illustrate test...`);
        
        // 1. 环境验证
        const validation = validateTestEnvironment(testCase);
        if (!validation.valid) {
            console.warn(`⚠️  [${testCase}] Validation failed: ${validation.message}`);
            return {
                success: false,
                methodCount: 0,
                taintFlows: 0,
                duration: Date.now() - startTime,
                sumIROutput: '',
                arkIROutput: '',
                callsiteOutput: '',
                errorMessage: validation.message
            };
        }
        
        // 2. 路径设置
        const irFilePath = path.join(PATHS.IR_BASE_DIR, testCase, 'libentry.so.ir.json');
        const configPath = createTestConfig(testCase);
        
        // 3. 配置日志
        const logPath = path.join(PATHS.OUTPUT_DIR, 'logs', `illustrate_${testCase}.log`);
        Logger.configure(logPath, LOG_LEVEL.INFO);
        const logger = Logger.getLogger(LOG_MODULE_TYPE.ARKANALYZER, `Illustrate_${testCase}`);
        
        // 4. 读取并导出SumIR
        console.log(`📄 [${testCase}] Reading and dumping SumIR...`);
        const irContent = fs.readFileSync(irFilePath, 'utf-8');
        const moduleIR: ModuleIR = JSON.parse(irContent);
        
        const sumIRDumper = new SumIRDumper(logger);
        const sumIROutput = sumIRDumper.dumpModule(moduleIR);
        
        // 5. 初始化Scene
        console.log(`🏗️  [${testCase}] Building scene...`);
        let arkconfig = new SceneConfig();
        arkconfig.buildFromJson(configPath);
        let scene = new Scene();
        scene.buildBasicInfo(arkconfig);
        scene.buildScene4HarmonyProject();
        scene.inferTypes();
        
        // 6. 重建Native Body
        console.log(`🔄 [${testCase}] Rebuilding native bodies...`);
        const nativeBodyRebuilder = new NativeBodyRebuilder(irFilePath, scene);
        nativeBodyRebuilder.rebuildNativeBody();
        scene.inferTypes(); // 再次类型推断
        
        // 7. 导出ArkIR
        console.log(`📝 [${testCase}] Generating ArkIR outputs...`);
        const rebuiltMethods = nativeBodyRebuilder.getRebuiltBodies();
        
        let arkIROutput = `// Rebuilt ArkIR for ${testCase}\n`;
        arkIROutput += `// Generated on: ${new Date().toISOString()}\n`;
        arkIROutput += `// Total rebuilt methods: ${rebuiltMethods.length}\n\n`;
        
        rebuiltMethods.forEach((method, index) => {
            arkIROutput += `// Method ${index + 1}: ${method.getName()}\n`;
            arkIROutput += '// ' + '='.repeat(60) + '\n';
            const printer = new ArkIRMethodPrinter(method);
            arkIROutput += printer.dump();
            arkIROutput += '\n\n';
        });
        
        // 8. 查找调用点方法并生成ArkIR
        console.log(`🔍 [${testCase}] Analyzing callsite methods...`);
        let callsiteOutput = `// Callsite Methods ArkIR for ${testCase}\n`;
        callsiteOutput += `// Generated on: ${new Date().toISOString()}\n\n`;
        
        const callsiteMethods: any[] = [];
        for (const arkClass of scene.getClasses()) {
            for (const method of arkClass.getMethods()) {
                const body = method.getBody();
                if (body && body.getCfg()) {
                    const blocks = Array.from(body.getCfg().getBlocks());
                    let hasNativeCall = false;
                    
                    for (const block of blocks) {
                        for (const stmt of block.getStmts()) {
                            const stmtStr = stmt.toString();
                            if (stmtStr.includes('@nodeapi') || stmtStr.includes('native')) {
                                hasNativeCall = true;
                                break;
                            }
                        }
                        if (hasNativeCall) break;
                    }
                    
                    if (hasNativeCall) {
                        callsiteMethods.push(method);
                    }
                }
            }
        }
        
        callsiteOutput += `// Total callsite methods found: ${callsiteMethods.length}\n\n`;
        callsiteMethods.forEach((method, index) => {
            callsiteOutput += `// Callsite Method ${index + 1}: ${method.getName()}\n`;
            callsiteOutput += '// ' + '='.repeat(60) + '\n';
            const printer = new ArkIRMethodPrinter(method);
            callsiteOutput += printer.dump();
            callsiteOutput += '\n\n';
        });
        
        // 9. 创建DummyMain并设置指针分析
        console.log(`🎯 [${testCase}] Setting up pointer analysis...`);
        const creater = new DummyMainCreater(scene);
        const ms = scene.getMethods();
        creater.setEntryMethods(ms);
        creater.createDummyMain();
        const dummyMain = creater.getDummyMain();
        
        // 指针分析
        const ptaConfig = PointerAnalysisConfig.create(1, path.join(PATHS.OUTPUT_DIR, 'pta'));
        const pta = PointerAnalysis.pointerAnalysisForWholeProject(scene, ptaConfig);
        
        // 10. 污点分析
        console.log(`🔍 [${testCase}] Running taint analysis...`);
        const blocks = Array.from(dummyMain.getCfg()!.getBlocks());
        const entryStmt = blocks[0].getStmts()[dummyMain.getParameters().length];
        
        const problem = new TaintAnalysisChecker(entryStmt, dummyMain, pta);
        problem.addSinksFromJson(PATHS.SINK_CONFIG);
        problem.addSourcesFromJson(PATHS.SOURCE_CONFIG);
        problem.addSantizationsFromJson(PATHS.SANITIZATION_CONFIG);
        
        const solver = new TaintAnalysisSolver(problem, scene, pta);
        solver.solve();
        
        const outcome = problem.getOutcome();
        const taintFlows = outcome ? outcome.length : 0;
        
        // 11. 获取统计信息
        const statistics = nativeBodyRebuilder.getStatistics();
        
        const duration = Date.now() - startTime;
        console.log(`✅ [${testCase}] Completed successfully. Methods: ${rebuiltMethods.length}, Flows: ${taintFlows}, Time: ${duration}ms`);
        
        return {
            success: true,
            methodCount: rebuiltMethods.length,
            taintFlows,
            duration,
            statistics,
            sumIROutput: sumIROutput,
            arkIROutput: arkIROutput,
            callsiteOutput
        };
        
    } catch (error) {
        const duration = Date.now() - startTime;
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`❌ [${testCase}] Failed: ${errorMessage}`);
        
        return {
            success: false,
            methodCount: 0,
            taintFlows: 0,
            duration,
            sumIROutput: '',
            arkIROutput: '',
            callsiteOutput: '',
            errorMessage
        };
    }
}

/**
 * 保存测试结果文件
 */
function saveTestResults(testCase: string, result: IllustrateTestResult): void {
    const outputPaths = {
        sumir: path.join(PATHS.OUTPUT_DIR, 'ir_outputs', `${testCase}_sumir.txt`),
        arkir: path.join(PATHS.OUTPUT_DIR, 'arkir_outputs', `${testCase}_arkir.txt`),
        callsite: path.join(PATHS.OUTPUT_DIR, 'callsite_outputs', `${testCase}_callsite.txt`)
    };
    
    try {
        fs.writeFileSync(outputPaths.sumir, result.sumIROutput);
        fs.writeFileSync(outputPaths.arkir, result.arkIROutput);
        fs.writeFileSync(outputPaths.callsite, result.callsiteOutput);
    } catch (error) {
        console.warn(`⚠️  Failed to save output files for ${testCase}: ${error}`);
    }
}

/**
 * 生成批量测试总结
 */
function generateBatchSummary(results: { [key: string]: IllustrateTestResult }): BatchSummary {
    const summary: BatchSummary = {
        totalCases: ILLUSTRATE_CASES.length,
        successCount: 0,
        failedCount: 0,
        totalMethods: 0,
        totalTaintFlows: 0,
        totalSumIRFunctions: 0,
        totalRebuiltMethods: 0,
        totalCallsites: 0,
        totalRebuildDuration: 0,
        averageRebuildTime: 0,
        overallSuccessRate: 0,
        rebuildSuccessRate: 0
    };
    
    for (const result of Object.values(results)) {
        if (result.success) {
            summary.successCount++;
            summary.totalMethods += result.methodCount;
            summary.totalTaintFlows += result.taintFlows;
            
            if (result.statistics) {
                summary.totalSumIRFunctions += result.statistics.totalSumIRFunctions;
                summary.totalRebuiltMethods += result.statistics.totalRebuiltMethods;
                summary.totalCallsites += result.statistics.totalCallsites;
                summary.totalRebuildDuration += result.statistics.totalRebuildDuration;
            }
        } else {
            summary.failedCount++;
        }
    }
    
    summary.averageRebuildTime = summary.successCount > 0 ? summary.totalRebuildDuration / summary.successCount : 0;
    summary.overallSuccessRate = (summary.successCount / summary.totalCases) * 100;
    summary.rebuildSuccessRate = summary.totalSumIRFunctions > 0 ? (summary.totalRebuiltMethods / summary.totalSumIRFunctions) * 100 : 0;
    
    return summary;
}

/**
 * 生成详细报告
 */
function generateDetailedReport(results: { [key: string]: IllustrateTestResult }, summary: BatchSummary): string {
    let report = `# Illustrate Batch Test Report\n\n`;
    report += `**Generated:** ${new Date().toISOString()}\n\n`;
    
    // 总体统计
    report += `## Overall Statistics\n\n`;
    report += `| Metric | Value |\n`;
    report += `|--------|-------|\n`;
    report += `| Total Test Cases | ${summary.totalCases} |\n`;
    report += `| Successful Cases | ${summary.successCount} |\n`;
    report += `| Failed Cases | ${summary.failedCount} |\n`;
    report += `| Overall Success Rate | ${summary.overallSuccessRate.toFixed(2)}% |\n`;
    report += `| Total SumIR Functions | ${summary.totalSumIRFunctions} |\n`;
    report += `| Total Rebuilt Methods | ${summary.totalRebuiltMethods} |\n`;
    report += `| Rebuild Success Rate | ${summary.rebuildSuccessRate.toFixed(2)}% |\n`;
    report += `| Total Callsites | ${summary.totalCallsites} |\n`;
    report += `| Total Taint Flows | ${summary.totalTaintFlows} |\n`;
    report += `| Total Rebuild Duration | ${summary.totalRebuildDuration}ms |\n`;
    report += `| Average Rebuild Time | ${summary.averageRebuildTime.toFixed(2)}ms |\n\n`;
    
    // 详细结果表格
    report += `## Detailed Results\n\n`;
    report += `| Test Case | Status | Methods | Flows | SumIR | Rebuilt | Callsites | Duration |\n`;
    report += `|-----------|--------|---------|-------|-------|---------|-----------|----------|\n`;
    
    for (const testCase of ILLUSTRATE_CASES) {
        const result = results[testCase];
        const status = result.success ? '✅' : '❌';
        const stats = result.statistics;
        
        report += `| ${testCase} | ${status} | ${result.methodCount} | ${result.taintFlows} | ${stats?.totalSumIRFunctions || 0} | ${stats?.totalRebuiltMethods || 0} | ${stats?.totalCallsites || 0} | ${result.duration}ms |\n`;
    }
    
    // 失败案例详情
    const failedCases = Object.entries(results).filter(([_, result]) => !result.success);
    if (failedCases.length > 0) {
        report += `\n## Failed Cases\n\n`;
        failedCases.forEach(([testCase, result]) => {
            report += `### ${testCase}\n`;
            report += `- **Error:** ${result.errorMessage || 'Unknown error'}\n`;
            report += `- **Duration:** ${result.duration}ms\n\n`;
        });
    }
    
    // 输出文件链接
    report += `## Generated Files\n\n`;
    report += `### SumIR Outputs\n`;
    ILLUSTRATE_CASES.forEach(testCase => {
        report += `- [${testCase}_sumir.txt](ir_outputs/${testCase}_sumir.txt)\n`;
    });
    
    report += `\n### ArkIR Outputs\n`;
    ILLUSTRATE_CASES.forEach(testCase => {
        report += `- [${testCase}_arkir.txt](arkir_outputs/${testCase}_arkir.txt)\n`;
    });
    
    report += `\n### Callsite Outputs\n`;
    ILLUSTRATE_CASES.forEach(testCase => {
        report += `- [${testCase}_callsite.txt](callsite_outputs/${testCase}_callsite.txt)\n`;
    });
    
    return report;
}

// ================================
// 主执行函数
// ================================

/**
 * 执行批量测试
 */
async function illustrateBatchTest(): Promise<void> {
    console.log("🚀 Starting Illustrate Batch Test...");
    console.log("=".repeat(80));
    
    // 准备环境
    ensureOutputDirectories();
    
    const results: { [key: string]: IllustrateTestResult } = {};
    
    // 处理每个测试用例
    for (const testCase of ILLUSTRATE_CASES) {
        const result = processIllustrateTestCase(testCase);
        results[testCase] = result;
        
        // 保存结果文件
        if (result.success) {
            saveTestResults(testCase, result);
        }
    }
    
    // 生成总结和报告
    console.log("\n" + "=".repeat(80));
    console.log("📊 Generating summary and reports...");
    
    const summary = generateBatchSummary(results);
    const detailedReport = generateDetailedReport(results, summary);
    
    // 保存报告
    const reportPath = path.join(PATHS.OUTPUT_DIR, 'DETAILED_REPORT.md');
    fs.writeFileSync(reportPath, detailedReport);
    
    // 生成CSV报告
    const csvLines = ['TestCase,Success,Methods,TaintFlows,SumIRFunctions,RebuiltMethods,Callsites,Duration,RebuildSuccessRate'];
    for (const testCase of ILLUSTRATE_CASES) {
        const result = results[testCase];
        const stats = result.statistics;
        const rebuildRate = stats && stats.totalSumIRFunctions > 0 ? (stats.totalRebuiltMethods / stats.totalSumIRFunctions * 100).toFixed(2) : '0';
        
        csvLines.push([
            testCase,
            result.success ? 'SUCCESS' : 'FAILED',
            result.methodCount,
            result.taintFlows,
            stats?.totalSumIRFunctions || 0,
            stats?.totalRebuiltMethods || 0,
            stats?.totalCallsites || 0,
            result.duration,
            rebuildRate
        ].join(','));
    }
    
    const csvPath = path.join(PATHS.OUTPUT_DIR, 'results.csv');
    fs.writeFileSync(csvPath, csvLines.join('\n'));
    
    // 打印最终结果
    console.log("📋 ILLUSTRATE BATCH TEST SUMMARY");
    console.log("=".repeat(80));
    console.log(`Total test cases: ${summary.totalCases}`);
    console.log(`Successful: ${summary.successCount}`);
    console.log(`Failed: ${summary.failedCount}`);
    console.log(`Overall success rate: ${summary.overallSuccessRate.toFixed(2)}%`);
    console.log(`Total rebuilt methods: ${summary.totalRebuiltMethods}`);
    console.log(`Rebuild success rate: ${summary.rebuildSuccessRate.toFixed(2)}%`);
    console.log(`Total taint flows: ${summary.totalTaintFlows}`);
    console.log(`Output directory: ${PATHS.OUTPUT_DIR}`);
    console.log(`Detailed report: ${reportPath}`);
    console.log(`CSV report: ${csvPath}`);
    console.log("=".repeat(80));
}

// ================================
// 模块导出和执行
// ================================

// 主执行入口
if (require.main === module) {
    illustrateBatchTest().catch(error => {
        console.error("💥 Fatal error:", error);
        process.exit(1);
    });
}

export { illustrateBatchTest, ILLUSTRATE_CASES, PATHS };