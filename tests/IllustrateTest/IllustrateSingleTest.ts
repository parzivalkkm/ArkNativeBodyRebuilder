import { SceneConfig } from '@ArkAnalyzer/src/Config';
import { Scene } from '@ArkAnalyzer/src/Scene';
import Logger, { LOG_MODULE_TYPE, LOG_LEVEL } from '@ArkAnalyzer/src/utils/logger';
import { NativeBodyRebuilder, RebuildStatistics } from 'src/NativeBodyRebuilder';
import { SumIRDumper } from 'src/ir/SumIRDumper';
import { ModuleIR } from 'src/ir/JsonObjectInterface';
import { ArkIRMethodPrinter } from '@ArkAnalyzer/src/save/arkir/ArkIRMethodPrinter';
import { DummyMainCreater } from "@ArkAnalyzer/src/core/common/DummyMainCreater";
import { TaintAnalysisChecker } from "taintanalysis/TaintAnalysis";
import { TaintAnalysisSolver } from "taintanalysis/TaintAnalysisSolver";
import { PointerAnalysisConfig } from "@ArkAnalyzer/src/callgraph/pointerAnalysis/PointerAnalysisConfig";
import { PointerAnalysis } from "@ArkAnalyzer/src/callgraph/pointerAnalysis/PointerAnalysis";
import * as fs from 'fs';
import * as path from 'path';

/**
 * 单个用例测试：native_multiple_interaction
 * 
 * 功能：
 * 1. 导出SumIR文本格式
 * 2. 重建Native函数体 
 * 3. 导出ArkIR文本格式
 * 4. 执行指针分析
 * 5. 执行污点分析
 * 6. 输出详细统计信息
 */

// 测试用例配置
const TEST_CASE = 'native_multiple_interaction';
const IR_DIR = 'D:/WorkSpace/ArkTS_Native/Illustration/TaintAnalysisApp/CollectedNativeLibs';
const PROJECT_DIR = 'D:/WorkSpace/ArkTS_Native/Illustration/TaintAnalysisApp/ProjectDirs';
const OUTPUT_DIR = 'out/illustrate_single';

// 确保输出目录存在
function ensureOutputDirectory(): void {
    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
        console.log(`✅ Created output directory: ${OUTPUT_DIR}`);
    }
}

// 主测试函数
async function testNativeMultipleInteraction(): Promise<void> {
    console.log(`🚀 Starting single test for: ${TEST_CASE}`);
    console.log('='.repeat(80));
    
    const startTime = Date.now();
    
    try {
        // 确保输出目录存在
        ensureOutputDirectory();
        
        // ========== 第1步：路径配置和文件检查 ==========
        console.log('\n📁 Step 1: Path configuration and file validation');
        const irFilePath = path.join(IR_DIR, TEST_CASE, 'libentry.so.ir.json');
        const projectDirPath = path.join(PROJECT_DIR, TEST_CASE);
        
        console.log(`   IR file path: ${irFilePath}`);
        console.log(`   Project directory: ${projectDirPath}`);
        
        // 检查IR文件是否存在
        if (!fs.existsSync(irFilePath)) {
            throw new Error(`IR file not found: ${irFilePath}`);
        }
        console.log(`   ✅ IR file exists`);
        
        // 检查项目目录是否存在
        if (!fs.existsSync(projectDirPath)) {
            throw new Error(`Project directory not found: ${projectDirPath}`);
        }
        console.log(`   ✅ Project directory exists`);
        
        // ========== 第2步：导出SumIR文本格式 ==========
        console.log('\n📄 Step 2: Export SumIR text format');
        const irContent = fs.readFileSync(irFilePath, 'utf-8');
        const moduleIR: ModuleIR = JSON.parse(irContent);
        
        // 配置日志
        const logPath = path.join(OUTPUT_DIR, `${TEST_CASE}.log`);
        Logger.configure(logPath, LOG_LEVEL.INFO);
        const logger = Logger.getLogger(LOG_MODULE_TYPE.ARKANALYZER, TEST_CASE);
        
        const sumIRDumper = new SumIRDumper(logger);
        const sumIROutput = sumIRDumper.dumpModule(moduleIR);
        
        // 保存SumIR输出
        const sumIRFilePath = path.join(OUTPUT_DIR, `${TEST_CASE}_sumir.txt`);
        fs.writeFileSync(sumIRFilePath, sumIROutput);
        console.log(`   ✅ SumIR exported to: ${sumIRFilePath}`);
        console.log(`   📊 SumIR functions: ${moduleIR.functions?.length || 0}`);
        
        // ========== 第3步：构建Scene和配置 ==========
        console.log('\n🏗️  Step 3: Build Scene and configuration');
        
        // 创建临时配置文件
        const config = {
            targetProjectName: TEST_CASE,
            targetProjectDirectory: projectDirPath,
            logPath: logPath
        };
        
        const tempConfigPath = path.join(OUTPUT_DIR, `IFDSConfig_${TEST_CASE}.json`);
        fs.writeFileSync(tempConfigPath, JSON.stringify(config, null, 2));
        console.log(`   ✅ Temporary config created: ${tempConfigPath}`);
        
        // 初始化Scene
        let arkConfig = new SceneConfig();
        arkConfig.buildFromJson(tempConfigPath);
        let scene = new Scene();
        scene.buildBasicInfo(arkConfig);
        scene.buildScene4HarmonyProject();
        scene.inferTypes();
        console.log(`   ✅ Scene built and types inferred`);
        console.log(`   📊 Total classes: ${scene.getClasses().length}`);
        console.log(`   📊 Total methods: ${scene.getMethods().length}`);
        
        // ========== 第4步：重建Native函数体 ==========
        console.log('\n🔧 Step 4: Rebuild native function bodies');
        const nativeBodyRebuilder = new NativeBodyRebuilder(irFilePath, scene);
        nativeBodyRebuilder.rebuildNativeBody();
        
        // 再次推断类型
        scene.inferTypes();
        console.log(`   ✅ Native body rebuild completed`);
        
        // 获取重建统计信息
        const statistics: RebuildStatistics = nativeBodyRebuilder.getStatistics();
        console.log(`   📊 SumIR functions: ${statistics.totalSumIRFunctions}`);
        console.log(`   📊 Rebuilt methods: ${statistics.totalRebuiltMethods}`);
        console.log(`   📊 Rebuild success rate: ${statistics.rebuildSuccessRate.toFixed(2)}%`);
        console.log(`   📊 Total callsites: ${statistics.totalCallsites}`);
        console.log(`   ⏱️  Rebuild duration: ${statistics.totalRebuildDuration}ms`);
        
        // ========== 第5步：导出ArkIR文本格式 ==========
        console.log('\n📄 Step 5: Export ArkIR text format');
        const rebuiltMethods = nativeBodyRebuilder.getRebuiltBodies();
        
        let arkIROutput = `// ArkIR for ${TEST_CASE}\n`;
        arkIROutput += `// Generated on: ${new Date().toISOString()}\n`;
        arkIROutput += `// Total rebuilt methods: ${rebuiltMethods.length}\n\n`;
        
        rebuiltMethods.forEach((method, index) => {
            arkIROutput += `// Method ${index + 1}: ${method.getName()}\n`;
            arkIROutput += '// ' + '='.repeat(60) + '\n';
            
            try {
                const printer = new ArkIRMethodPrinter(method);
                arkIROutput += printer.dump();
            } catch (error) {
                arkIROutput += `// Error printing method: ${error}\n`;
            }
            arkIROutput += '\n\n';
        });
        
        // 保存ArkIR输出
        const arkIRFilePath = path.join(OUTPUT_DIR, `${TEST_CASE}_arkir.txt`);
        fs.writeFileSync(arkIRFilePath, arkIROutput);
        console.log(`   ✅ ArkIR exported to: ${arkIRFilePath}`);
        console.log(`   📊 Rebuilt methods: ${rebuiltMethods.length}`);
        
        // ========== 第6步：创建DummyMain和指针分析 ==========
        console.log('\n🎯 Step 6: Create DummyMain and pointer analysis');
        const creater = new DummyMainCreater(scene);
        const allMethods = scene.getMethods();
        creater.setEntryMethods(allMethods);
        creater.createDummyMain();
        const dummyMain = creater.getDummyMain();
        console.log(`   ✅ DummyMain created with ${allMethods.length} entry methods`);
        
        // 指针分析
        const ptaConfig = PointerAnalysisConfig.create(1, OUTPUT_DIR);
        const pta = PointerAnalysis.pointerAnalysisForWholeProject(scene, ptaConfig);
        const myPag = pta.getPag();
        
        // 保存PAG文件
        const pagFilePath = path.join(OUTPUT_DIR, `pag_${TEST_CASE}`);
        myPag.dump(pagFilePath);
        console.log(`   ✅ Pointer analysis completed, PAG saved to: ${pagFilePath}`);
        
        // ========== 第7步：污点分析 ==========
        console.log('\n🔍 Step 7: Taint analysis');
        const blocks = Array.from(dummyMain.getCfg()!.getBlocks());
        const entryStmt = blocks[0].getStmts()[dummyMain.getParameters().length];
        
        // 创建污点分析问题
        const problem = new TaintAnalysisChecker(entryStmt, dummyMain, pta);
        
        // 加载配置文件
        const sinkPath = "tests/resources/sink.json";
        const sourcePath = "tests/resources/source.json";
        const sanitizationPath = "tests/resources/santizationPath.json";
        
        if (fs.existsSync(sinkPath)) {
            problem.addSinksFromJson(sinkPath);
            console.log(`   ✅ Sinks loaded from: ${sinkPath}`);
        } else {
            console.log(`   ⚠️  Sink file not found: ${sinkPath}`);
        }
        
        if (fs.existsSync(sourcePath)) {
            problem.addSourcesFromJson(sourcePath);
            console.log(`   ✅ Sources loaded from: ${sourcePath}`);
        } else {
            console.log(`   ⚠️  Source file not found: ${sourcePath}`);
        }
        
        if (fs.existsSync(sanitizationPath)) {
            problem.addSantizationsFromJson(sanitizationPath);
            console.log(`   ✅ Sanitizations loaded from: ${sanitizationPath}`);
        } else {
            console.log(`   ⚠️  Sanitization file not found: ${sanitizationPath}`);
        }
        
        // 执行污点分析
        const solver = new TaintAnalysisSolver(problem, scene, pta);
        solver.solve();
        console.log(`   ✅ Taint analysis solver completed`);
        
        // 获取分析结果
        const outcome = problem.getOutcome();
        const taintFlowCount = outcome ? outcome.length : 0;
        console.log(`   📊 Taint flows detected: ${taintFlowCount}`);
        
        // ========== 第8步：生成详细报告 ==========
        console.log('\n📊 Step 8: Generate detailed report');
        const endTime = Date.now();
        const totalDuration = endTime - startTime;
        
        let reportContent = `# Single Test Report: ${TEST_CASE}\n\n`;
        reportContent += `**Generated on:** ${new Date().toISOString()}\n\n`;
        reportContent += `## Test Configuration\n`;
        reportContent += `- Test Case: ${TEST_CASE}\n`;
        reportContent += `- IR File: ${irFilePath}\n`;
        reportContent += `- Project Directory: ${projectDirPath}\n`;
        reportContent += `- Output Directory: ${OUTPUT_DIR}\n\n`;
        
        reportContent += `## SumIR Analysis\n`;
        reportContent += `- SumIR Functions: ${statistics.totalSumIRFunctions}\n`;
        reportContent += `- SumIR Instructions: ${statistics.totalSumIRInstructions}\n\n`;
        
        reportContent += `## Native Body Rebuilding\n`;
        reportContent += `- Rebuilt Methods: ${statistics.totalRebuiltMethods}\n`;
        reportContent += `- Rebuild Success Rate: ${statistics.rebuildSuccessRate.toFixed(2)}%\n`;
        reportContent += `- Total Callsites: ${statistics.totalCallsites}\n`;
        reportContent += `- Rebuild Duration: ${statistics.totalRebuildDuration}ms\n`;
        reportContent += `- Cross-language Analysis Duration: ${statistics.analyzeCrossLanguageCallsDuration}ms\n`;
        reportContent += `- Function Rebuilding Duration: ${statistics.rebuildAllModuleFunctionsDuration}ms\n\n`;
        
        reportContent += `## Scene Analysis\n`;
        reportContent += `- Total Classes: ${scene.getClasses().length}\n`;
        reportContent += `- Total Methods: ${scene.getMethods().length}\n\n`;
        
        reportContent += `## Taint Analysis\n`;
        reportContent += `- Taint Flows Detected: ${taintFlowCount}\n\n`;
        
        reportContent += `## Performance\n`;
        reportContent += `- Total Test Duration: ${totalDuration}ms\n\n`;
        
        reportContent += `## Generated Files\n`;
        reportContent += `- SumIR Text: [${TEST_CASE}_sumir.txt](${TEST_CASE}_sumir.txt)\n`;
        reportContent += `- ArkIR Text: [${TEST_CASE}_arkir.txt](${TEST_CASE}_arkir.txt)\n`;
        reportContent += `- PAG File: [pag_${TEST_CASE}](pag_${TEST_CASE})\n`;
        reportContent += `- Log File: [${TEST_CASE}.log](${TEST_CASE}.log)\n`;
        
        const reportFilePath = path.join(OUTPUT_DIR, `${TEST_CASE}_report.md`);
        fs.writeFileSync(reportFilePath, reportContent);
        console.log(`   ✅ Detailed report saved to: ${reportFilePath}`);
        
        // ========== 第9步：打印最终统计 ==========
        console.log('\n' + '='.repeat(80));
        console.log('🎉 SINGLE TEST COMPLETED SUCCESSFULLY');
        console.log('='.repeat(80));
        console.log(`📋 Test Case: ${TEST_CASE}`);
        console.log(`⏱️  Total Duration: ${totalDuration}ms`);
        console.log(`📊 SumIR Functions: ${statistics.totalSumIRFunctions}`);
        console.log(`📊 Rebuilt Methods: ${statistics.totalRebuiltMethods}`);
        console.log(`📊 Rebuild Success Rate: ${statistics.rebuildSuccessRate.toFixed(2)}%`);
        console.log(`📊 Taint Flows: ${taintFlowCount}`);
        console.log(`📂 Output Directory: ${OUTPUT_DIR}`);
        console.log('='.repeat(80));
        
    } catch (error) {
        console.error('\n❌ Test failed with error:');
        console.error(error);
        
        // 生成错误报告
        const errorReport = `# Single Test Error Report: ${TEST_CASE}\n\n`;
        const errorReportContent = errorReport + 
            `**Generated on:** ${new Date().toISOString()}\n\n` +
            `**Error:** ${error}\n\n` +
            `**Stack Trace:**\n\`\`\`\n${(error as Error).stack}\n\`\`\`\n`;
        
        const errorReportPath = path.join(OUTPUT_DIR, `${TEST_CASE}_error_report.md`);
        fs.writeFileSync(errorReportPath, errorReportContent);
        console.log(`📄 Error report saved to: ${errorReportPath}`);
        
        const endTime = Date.now();
        const totalDuration = endTime - startTime;
        console.log(`⏱️  Failed after: ${totalDuration}ms`);
        
        process.exit(1);
    }
}

// 主执行入口
if (require.main === module) {
    testNativeMultipleInteraction().catch(error => {
        console.error('💥 Fatal error:', error);
        process.exit(1);
    });
}

export { testNativeMultipleInteraction };
