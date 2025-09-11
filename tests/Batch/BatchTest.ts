import { SceneConfig } from '@ArkAnalyzer/src/Config';
import { Scene } from '@ArkAnalyzer/src/Scene';
import { DummyMainCreater } from "@ArkAnalyzer/src/core/common/DummyMainCreater";
import { TaintAnalysisChecker} from "taintanalysis/TaintAnalysis";
import { TaintAnalysisSolver } from "taintanalysis/TaintAnalysisSolver";
import Logger, { LOG_MODULE_TYPE, LOG_LEVEL } from '@ArkAnalyzer/src/utils/logger';
import { PointerAnalysisConfig } from "@ArkAnalyzer/src/callgraph/pointerAnalysis/PointerAnalysisConfig";
import { PointerAnalysis } from "@ArkAnalyzer/src/callgraph/pointerAnalysis/PointerAnalysis";
import { NativeBodyRebuilder, RebuildStatistics } from 'src/NativeBodyRebuilder';
import * as fs from 'fs';
import * as pathModule from 'path';

const NATIVE_X_FLOW_ON = true

const cases = [
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
    'native_array_clean',
    'native_error',
    'native_multiple_interaction',
    'native_multiple_libraries',
    'native_phi_branch',
    'native_phi_concat',
    'native_encode'
];

function processTestCase(testCase: string): { 
    success: boolean, 
    flowCount: number,
    statistics?: RebuildStatistics 
} {
    try {
        // 读取原始配置文件
        const configPath = 'tests/Batch/configs/IFDSConfig.json';
        const configContent = fs.readFileSync(configPath, 'utf-8');
        const config = JSON.parse(configContent);

        // 修改配置字段
        config.targetProjectName = testCase;
        config.targetProjectDirectory = `D:/WorkSpace/ArkTS_Native/Benchmarks/CrossFlowBench-main/CrossFlowBench-main/${testCase}`;
        config.logPath = `out/ArkAnalyzer_${testCase}.log`;

        // 保存修改后的配置到临时文件
        const tempConfigPath = `tests/Batch/configs/IFDSConfig_${testCase}.json`;
        fs.writeFileSync(tempConfigPath, JSON.stringify(config, null, 2));

        // 配置日志
        Logger.configure(config.logPath, LOG_LEVEL.DEBUG);
        const logger = Logger.getLogger(LOG_MODULE_TYPE.ARKANALYZER, `HapFlow_${testCase}`);

        // 设置路径
        const irFilePath = `D:/WorkSpace/ArkTS_Native/Benchmarks/HarmonyXFlowBench/SummaryIR/Binary/${testCase}`;

        let arkconfig = new SceneConfig();
        arkconfig.buildFromJson(tempConfigPath);
        let scene = new Scene();
        scene.buildBasicInfo(arkconfig);
        scene.buildScene4HarmonyProject();

        scene.inferTypes();

        let rebuildStatistics: RebuildStatistics | undefined;

        if(NATIVE_X_FLOW_ON){
            // 重建本地方法体
            const nativeBodyRebuilder = new NativeBodyRebuilder(irFilePath, scene);
            nativeBodyRebuilder.rebuildNativeBody();
            
            // 获取统计信息
            rebuildStatistics = nativeBodyRebuilder.getStatistics();
            
            scene.inferTypes();
        }

        // 创建DummyMain
        const creater = new DummyMainCreater(scene);
        const ms = scene.getMethods();

        creater.setEntryMethods(ms);
        creater.createDummyMain();
        const dummyMain = creater.getDummyMain();

        // 指针分析
        const ptaConfig = PointerAnalysisConfig.create(1, "./out");
        const pta = PointerAnalysis.pointerAnalysisForWholeProject(scene, ptaConfig);
        const myPag = pta.getPag();
        myPag.dump(`out/pag_${testCase}`);

        // 污点分析
        const blocks = Array.from(dummyMain.getCfg()!.getBlocks());
        const entryStmt = blocks[0].getStmts()[dummyMain.getParameters().length];
        
        const problem = new TaintAnalysisChecker(entryStmt, dummyMain, pta);
        problem.addSinksFromJson("tests/resources/sink.json");
        problem.addSourcesFromJson("tests/resources/source.json");
        problem.addSantizationsFromJson("tests/resources/santizationPath.json")

        const solver = new TaintAnalysisSolver(problem, scene, pta);
        solver.solve();
        console.log(`[${testCase}] Taint analysis solver completed`);
        
        const outcome = problem.getOutcome();
        
        return { 
            success: true, 
            flowCount: outcome ? outcome.length : 0,
            statistics: rebuildStatistics
        };
    } catch (error) {
        console.error(`Error processing ${testCase}:`, error);
        return { success: false, flowCount: 0 };
    }
}

// 批量处理所有测试用例
let successCount = 0;
let failedCount = 0;
let totalTaintFlows = 0;

// 统计数据汇总
    let totalSumIRFunctions = 0;
    let totalRebuiltMethods = 0;
    let totalRebuildDuration = 0;
    let totalAnalyzeCrossLanguageCallsDuration = 0;
    let totalRebuildAllModuleFunctionsDuration = 0;
    let totalCallsites = 0;const results: { [key: string]: { 
    success: boolean, 
    flows: number, 
    duration: number,
    statistics?: RebuildStatistics
} } = {};

cases.forEach(testCase => {
    console.info(`====== TestCase ${testCase} started! ======`)
    const startTime = Date.now();
    const result = processTestCase(testCase);
    const endTime = Date.now();
    const duration = endTime - startTime;

    if (result.success) {
        successCount++;
        totalTaintFlows += result.flowCount;
        
        // 汇总统计数据
        if (result.statistics) {
            totalSumIRFunctions += result.statistics.totalSumIRFunctions;
            totalRebuiltMethods += result.statistics.totalRebuiltMethods;
            totalRebuildDuration += result.statistics.totalRebuildDuration;
            totalAnalyzeCrossLanguageCallsDuration += result.statistics.analyzeCrossLanguageCallsDuration;
            totalRebuildAllModuleFunctionsDuration += result.statistics.rebuildAllModuleFunctionsDuration;
            totalCallsites += result.statistics.totalCallsites;
        }
        
        results[testCase] = { 
            success: true, 
            flows: result.flowCount, 
            duration,
            statistics: result.statistics
        };
        console.info(`====== TestCase ${testCase} completed successfully. Time taken: ${duration}ms, Flows: ${result.flowCount} ======`);
    } else {
        failedCount++;
        results[testCase] = { success: false, flows: 0, duration };
        console.error(`TestCase ${testCase} failed. Time taken: ${duration}ms`);
    }
});

// 生成详细的统计报告
console.info(`\n${'='.repeat(80)}`);
console.info(`📊 COMPREHENSIVE NATIVE BODY REBUILDER ANALYSIS REPORT`);
console.info(`${'='.repeat(80)}`);

console.info(`\n📋 BASIC STATISTICS:`);
console.info(`Total test cases: ${cases.length}`);
console.info(`Successful: ${successCount}`);
console.info(`Failed: ${failedCount}`);
console.info(`Success rate: ${((successCount / cases.length) * 100).toFixed(2)}%`);

console.info(`\n🔍 SUMIR ANALYSIS:`);
console.info(`Total SumIR functions: ${totalSumIRFunctions}`);
console.info(`Average functions per project: ${successCount > 0 ? (totalSumIRFunctions / successCount).toFixed(2) : '0'}`);

console.info(`\n🔄 REBUILD PERFORMANCE:`);
console.info(`Total rebuild duration: ${totalRebuildDuration}ms`);
console.info(`Average rebuild time per project: ${successCount > 0 ? (totalRebuildDuration / successCount).toFixed(2) : '0'}ms`);
console.info(`Total rebuilt methods: ${totalRebuiltMethods}`);
console.info(`Rebuild success rate: ${totalSumIRFunctions > 0 ? ((totalRebuiltMethods / totalSumIRFunctions) * 100).toFixed(2) : '0'}%`);

console.info(`\n⏱️ DETAILED TIMING BREAKDOWN:`);
console.info(`Cross-language analysis duration: ${totalAnalyzeCrossLanguageCallsDuration}ms`);
console.info(`Function rebuilding duration: ${totalRebuildAllModuleFunctionsDuration}ms`);
console.info(`Analysis percentage: ${totalRebuildDuration > 0 ? ((totalAnalyzeCrossLanguageCallsDuration / totalRebuildDuration) * 100).toFixed(2) : '0'}%`);
console.info(`Rebuilding percentage: ${totalRebuildDuration > 0 ? ((totalRebuildAllModuleFunctionsDuration / totalRebuildDuration) * 100).toFixed(2) : '0'}%`);

console.info(`\n📞 CALLSITE ANALYSIS:`);
console.info(`Total callsites identified: ${totalCallsites}`);
console.info(`Average callsites per project: ${successCount > 0 ? (totalCallsites / successCount).toFixed(2) : '0'}`);

console.info(`\n🌊 TAINT FLOW RESULTS:`);
console.info(`Total taint flows detected: ${totalTaintFlows}`);
console.info(`Average flows per project: ${successCount > 0 ? (totalTaintFlows / successCount).toFixed(2) : '0'}`);

// 详细项目表格
console.info(`\n${'='.repeat(100)}`);
console.info(`📊 DETAILED PROJECT RESULTS:`);
console.info(`${'='.repeat(100)}`);

const csvHeader = 'Project,Success,SumIR_Functions,Rebuilt_Methods,Rebuild_Duration_ms,AnalyzeCalls_Duration_ms,RebuildFunctions_Duration_ms,Callsites,Taint_Flows,Total_Duration_ms,Rebuild_Success_Rate';
const csvLines = [csvHeader];

console.info(`${'Project'.padEnd(28)} ${'Success'.padEnd(8)} ${'SumIR'.padEnd(6)} ${'Rebuilt'.padEnd(8)} ${'Rebuild'.padEnd(9)} ${'Analyze'.padEnd(9)} ${'RebuildF'.padEnd(10)} ${'Calls'.padEnd(6)} ${'Flows'.padEnd(6)} ${'Total'.padEnd(8)} ${'Success%'.padEnd(8)}`);
console.info(`${''.padEnd(28)} ${''.padEnd(8)} ${'Funcs'.padEnd(6)} ${'Methods'.padEnd(8)} ${'Time(ms)'.padEnd(9)} ${'Time(ms)'.padEnd(9)} ${'Time(ms)'.padEnd(10)} ${'Sites'.padEnd(6)} ${''.padEnd(6)} ${'Time(ms)'.padEnd(8)} ${'Rate'.padEnd(8)}`);
console.info(`${'-'.repeat(120)}`);

for (const [testCase, result] of Object.entries(results)) {
    const status = result.success ? '✅' : '❌';
    const stats = result.statistics;
    
    const projectName = testCase.padEnd(26);
    const successStr = status.padEnd(8);
    const sumirStr = (stats?.totalSumIRFunctions || 0).toString().padEnd(6);
    const rebuiltStr = (stats?.totalRebuiltMethods || 0).toString().padEnd(8);
    const rebuildTimeStr = (stats?.totalRebuildDuration || 0).toString().padEnd(9);
    const analyzeTimeStr = (stats?.analyzeCrossLanguageCallsDuration || 0).toString().padEnd(9);
    const rebuildFTimeStr = (stats?.rebuildAllModuleFunctionsDuration || 0).toString().padEnd(10);
    const callsitesStr = (stats?.totalCallsites || 0).toString().padEnd(6);
    const flowsStr = result.flows.toString().padEnd(6);
    const totalTimeStr = result.duration.toString().padEnd(8);
    const successRateStr = (stats?.rebuildSuccessRate || 0).toFixed(1).padEnd(8);
    
    console.info(`${projectName} ${successStr} ${sumirStr} ${rebuiltStr} ${rebuildTimeStr} ${analyzeTimeStr} ${rebuildFTimeStr} ${callsitesStr} ${flowsStr} ${totalTimeStr} ${successRateStr}`);
    
    // CSV行
    csvLines.push(`${testCase},${result.success ? 'SUCCESS' : 'FAILED'},${stats?.totalSumIRFunctions || 0},${stats?.totalRebuiltMethods || 0},${stats?.totalRebuildDuration || 0},${stats?.analyzeCrossLanguageCallsDuration || 0},${stats?.rebuildAllModuleFunctionsDuration || 0},${stats?.totalCallsites || 0},${result.flows},${result.duration},${(stats?.rebuildSuccessRate || 0).toFixed(2)}`);
}

// 保存CSV报告
const csvContent = csvLines.join('\n');

// 确保输出目录存在
const outputDir = pathModule.dirname('out/native_body_rebuilder_analysis.csv');
if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
}

try {
    fs.writeFileSync('out/native_body_rebuilder_analysis.csv', csvContent);
    console.info(`💾 Detailed CSV report saved to: out/native_body_rebuilder_analysis.csv`);
} catch (error) {
    console.error(`❌ Failed to save CSV report:`, error);
    // 备用保存到当前目录
    try {
        fs.writeFileSync('native_body_rebuilder_analysis.csv', csvContent);
        console.info(`💾 Detailed CSV report saved to: native_body_rebuilder_analysis.csv (current directory)`);
    } catch (backupError) {
        console.error(`❌ Failed to save CSV report to current directory:`, backupError);
    }
}

console.info(`${'-'.repeat(120)}`);
console.info(`${'TOTAL/AVERAGE'.padEnd(26)} ${''.padEnd(8)} ${totalSumIRFunctions.toString().padEnd(6)} ${totalRebuiltMethods.toString().padEnd(8)} ${totalRebuildDuration.toString().padEnd(9)} ${totalAnalyzeCrossLanguageCallsDuration.toString().padEnd(9)} ${totalRebuildAllModuleFunctionsDuration.toString().padEnd(10)} ${totalCallsites.toString().padEnd(6)} ${totalTaintFlows.toString().padEnd(6)} ${''.padEnd(8)} ${totalSumIRFunctions > 0 ? ((totalRebuiltMethods / totalSumIRFunctions) * 100).toFixed(1).padEnd(8) : '0.0'.padEnd(8)}`);

console.info(`\n${'='.repeat(80)}`);
console.info(`✅ BATCH ANALYSIS COMPLETED`);
console.info(`${'='.repeat(80)}`);