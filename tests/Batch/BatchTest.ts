import { SceneConfig } from '@ArkAnalyzer/src/Config';
import { Scene } from '@ArkAnalyzer/src/Scene';
import { DummyMainCreater } from "@ArkAnalyzer/src/core/common/DummyMainCreater";
import { TaintAnalysisChecker} from "taintanalysis/TaintAnalysis";
import { TaintAnalysisSolver } from "taintanalysis/TaintAnalysisSolver";
import Logger, { LOG_MODULE_TYPE, LOG_LEVEL } from '@ArkAnalyzer/src/utils/logger';
import { PointerAnalysisConfig } from "@ArkAnalyzer/src/callgraph/pointerAnalysis/PointerAnalysisConfig";
import { PointerAnalysis } from "@ArkAnalyzer/src/callgraph/pointerAnalysis/PointerAnalysis";
import { NativeBodyRebuilder } from 'src/NativeBodyRebuilder';
import * as fs from 'fs';

const NATIVE_X_FLOW_ON = true

const cases = ['native_array_get',
               'native_array_set',
               'native_call_function_object',
               'native_call_function_proxy',
               'native_call_function_sink',
               'native_call_function_source',
               'native_complex_data',
               'native_delegation',
               'native_error',
               'native_leak',
               'native_multiple_interaction',
               'native_multiple_libraries',
               'native_phi_branch',
               'native_phi_concat',
               'native_delegation',
               'native_proxy',
               'native_proxy_copy',
               'native_set_field',
               'native_source',
               'native_source_clean',
               'native_encode',
            ];

function processTestCase(testCase: string): { success: boolean, flowCount: number } {
    try {
        // 读取原始配置文件
        const configPath = 'tests/Batch/configs/IFDSConfig.json';
        const configContent = fs.readFileSync(configPath, 'utf-8');
        const config = JSON.parse(configContent);

        // 修改配置字段
        config.targetProjectName = testCase;
        config.targetProjectDirectory = `D:/WorkSpace/ArkTS_Native/Benchmarks/HarmonyXFlowBench/${testCase}`;
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

        if(NATIVE_X_FLOW_ON){
            // 重建本地方法体
            const nativeBodyRebuilder = new NativeBodyRebuilder(irFilePath, scene);
            nativeBodyRebuilder.rebuildNativeBody();
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
        
        return { success: true, flowCount: outcome ? outcome.length : 0 };
    } catch (error) {
        console.error(`Error processing ${testCase}:`, error);
        return { success: false, flowCount: 0 };
    }
}

// 批量处理所有测试用例
let successCount = 0;
let failedCount = 0;
let totalTaintFlows = 0;
const results: { [key: string]: { success: boolean, flows: number, duration: number } } = {};

cases.forEach(testCase => {
    console.info(`====== TestCase ${testCase} started! ======`)
    const startTime = Date.now();
    const result = processTestCase(testCase);
    const endTime = Date.now();
    const duration = endTime - startTime;

    if (result.success) {
        successCount++;
        totalTaintFlows += result.flowCount;
        results[testCase] = { success: true, flows: result.flowCount, duration };
        console.info(`====== TestCase ${testCase} completed successfully. Time taken: ${duration}ms, Flows: ${result.flowCount} ======`);
    } else {
        failedCount++;
        results[testCase] = { success: false, flows: 0, duration };
        console.error(`TestCase ${testCase} failed. Time taken: ${duration}ms`);
    }
});

console.info(`\n====== Batch Test Summary ======`);
console.info(`Total test cases: ${cases.length}`);
console.info(`Successful: ${successCount}`);
console.info(`Failed: ${failedCount}`);
console.info(`Success rate: ${((successCount / cases.length) * 100).toFixed(2)}%`);
console.info(`Total taint flows detected: ${totalTaintFlows}`);

console.info(`\n====== Detailed Results ======`);
for (const [testCase, result] of Object.entries(results)) {
    const status = result.success ? 'PASS' : 'FAIL';
    const flowInfo = result.success ? `, Flows: ${result.flows}` : '';
    console.info(`${testCase}: ${status} (${result.duration}ms${flowInfo})`);
}