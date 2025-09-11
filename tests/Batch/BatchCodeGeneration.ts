import { SceneConfig } from '@ArkAnalyzer/src/Config';
import { Scene } from '@ArkAnalyzer/src/Scene';
import Logger, { LOG_MODULE_TYPE, LOG_LEVEL } from '@ArkAnalyzer/src/utils/logger';
import { NativeBodyRebuilder } from 'src/NativeBodyRebuilder';
import { SumIRDumper } from 'src/ir/SumIRDumper';
import { ModuleIR } from 'src/ir/JsonObjectInterface';
import { ArkIRMethodPrinter } from '@ArkAnalyzer/src/save/arkir/ArkIRMethodPrinter';
import * as fs from 'fs';
import * as path from 'path';

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
               'native_proxy',
               'native_proxy_copy',
               'native_set_field',
               'native_source',
               'native_source_clean',
               'native_encode',
            ];

function processTestCaseCodeGeneration(testCase: string): { success: boolean, methodCount: number, sumirOutput: string, arkirOutput: string, callsiteOutput: string } {
    try {
        console.log(`\n🔄 Processing ${testCase}...`);
        
        // 读取原始配置文件
        const configPath = 'tests/Batch/configs/IFDSConfig.json';
        const configContent = fs.readFileSync(configPath, 'utf-8');
        const config = JSON.parse(configContent);

        // 修改配置字段
        config.targetProjectName = testCase;
        config.targetProjectDirectory = `D:/WorkSpace/ArkTS_Native/Benchmarks/HarmonyXFlowBench/${testCase}`;
        config.logPath = `out/CodeGen_${testCase}.log`;

        // 保存修改后的配置到临时文件
        const tempConfigPath = `tests/Batch/configs/IFDSConfig_${testCase}.json`;
        fs.writeFileSync(tempConfigPath, JSON.stringify(config, null, 2));

        // 配置日志
        Logger.configure(config.logPath, LOG_LEVEL.INFO);
        const logger = Logger.getLogger(LOG_MODULE_TYPE.ARKANALYZER, `CodeGen_${testCase}`);

        // 设置路径
        const irFilePath = `D:/WorkSpace/ArkTS_Native/Benchmarks/HarmonyXFlowBench/SummaryIR/Binary/${testCase}/libentry.so.ir.json`;
        
        // 检查IR文件是否存在
        if (!fs.existsSync(irFilePath)) {
            console.warn(`⚠️  IR file not found: ${irFilePath}`);
            return { success: false, methodCount: 0, sumirOutput: '', arkirOutput: '', callsiteOutput: '' };
        }

        // 1. 读取并生成SumIR
        const irContent = fs.readFileSync(irFilePath, 'utf-8');
        const moduleIR: ModuleIR = JSON.parse(irContent);
        
        const sumIRDumper = new SumIRDumper(logger);
        const sumIROutput = sumIRDumper.dumpModule(moduleIR);

        // 2. 初始化Scene
        let arkconfig = new SceneConfig();
        arkconfig.buildFromJson(tempConfigPath);
        let scene = new Scene();
        scene.buildBasicInfo(arkconfig);
        scene.buildScene4HarmonyProject();
        scene.inferTypes();

        // 3. 重建Native Body
        const nativeBodyRebuilder = new NativeBodyRebuilder(irFilePath, scene);
        nativeBodyRebuilder.rebuildNativeBody();
        scene.inferTypes(); // 再次推断类型

        // 4. 获取重建的方法并生成ArkIR
        const rebuiltMethods = nativeBodyRebuilder.getRebuiltBodies();
        
        let arkIROutput = '';
        if (rebuiltMethods.length > 0) {
            arkIROutput += `// Rebuilt ArkIR for ${testCase}\n`;
            arkIROutput += `// Total rebuilt methods: ${rebuiltMethods.length}\n\n`;
            
            rebuiltMethods.forEach((method, index) => {
                arkIROutput += `// Method ${index + 1}: ${method.getName()}\n`;
                arkIROutput += '// ' + '='.repeat(60) + '\n';
                
                const printer = new ArkIRMethodPrinter(method);
                arkIROutput += printer.dump();
                arkIROutput += '\n\n';
            });
        } else {
            arkIROutput = `// No rebuilt methods found for ${testCase}\n`;
        }

        // 5. 获取调用位置处的方法ArkIR
        let callsiteOutput = '';
        callsiteOutput += `// Callsite Methods ArkIR for ${testCase}\n`;
        callsiteOutput += `// Methods that contain native function calls\n\n`;
        
        // 搜索所有方法中包含native调用的方法
        const allCallsiteMethods: any[] = [];
        for (const arkClass of scene.getClasses()) {
            for (const method of arkClass.getMethods()) {
                const body = method.getBody();
                if (body && body.getCfg()) {
                    const blocks = Array.from(body.getCfg().getBlocks());
                    let hasNativeCall = false;
                    
                    for (const block of blocks) {
                        for (const stmt of block.getStmts()) {
                            const stmtStr = stmt.toString();
                            // 检查是否包含native调用特征
                            if (stmtStr.includes('@nodeapi')){
                                hasNativeCall = true;
                                break;
                            }
                        }
                        if (hasNativeCall) break;
                    }
                    
                    if (hasNativeCall) {
                        allCallsiteMethods.push(method);
                    }
                }
            }
        }
        
        if (allCallsiteMethods.length > 0) {
            callsiteOutput += `// Total callsite methods found: ${allCallsiteMethods.length}\n\n`;
            
            allCallsiteMethods.forEach((method, index) => {
                callsiteOutput += `// Callsite Method ${index + 1}: ${method.getName()}\n`;
                callsiteOutput += '// ' + '='.repeat(60) + '\n';
                
                const printer = new ArkIRMethodPrinter(method);
                callsiteOutput += printer.dump();
                callsiteOutput += '\n\n';
            });
        } else {
            callsiteOutput += `// No callsite methods found for ${testCase}\n`;
        }

        return { 
            success: true, 
            methodCount: rebuiltMethods.length, 
            sumirOutput: sumIROutput,
            arkirOutput: arkIROutput,
            callsiteOutput: callsiteOutput
        };
        
    } catch (error) {
        console.error(`❌ Error processing ${testCase}:`, error);
        return { success: false, methodCount: 0, sumirOutput: '', arkirOutput: '', callsiteOutput: '' };
    }
}

// 确保输出目录存在
function ensureOutputDirectory() {
    const outputDir = 'out/generated_code';
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }
    return outputDir;
}

// 批量处理所有测试用例
async function batchCodeGeneration() {
    console.log("🚀 Starting Batch Code Generation...");
    console.log("=".repeat(80));
    
    const outputDir = ensureOutputDirectory();
    let successCount = 0;
    let failedCount = 0;
    let totalMethodCount = 0;
    const results: { [key: string]: { success: boolean, methods: number, duration: number } } = {};

    // 创建汇总文件
    let summaryContent = `# Batch Code Generation Summary\n`;
    summaryContent += `Generated on: ${new Date().toISOString()}\n\n`;

    for (const testCase of cases) {
        console.log(`\n📋 Processing ${testCase}...`);
        const startTime = Date.now();
        
        const result = processTestCaseCodeGeneration(testCase);
        
        const endTime = Date.now();
        const duration = endTime - startTime;

        if (result.success) {
            successCount++;
            totalMethodCount += result.methodCount;
            results[testCase] = { success: true, methods: result.methodCount, duration };
            
            // 保存SumIR
            const sumirFilePath = path.join(outputDir, `${testCase}_sumir.txt`);
            fs.writeFileSync(sumirFilePath, result.sumirOutput);
            
            // 保存ArkIR
            const arkirFilePath = path.join(outputDir, `${testCase}_arkir.txt`);
            fs.writeFileSync(arkirFilePath, result.arkirOutput);
            
            // 保存Callsite ArkIR
            const callsiteFilePath = path.join(outputDir, `${testCase}_callsite.txt`);
            fs.writeFileSync(callsiteFilePath, result.callsiteOutput);
            
            console.log(`✅ ${testCase} completed. Methods: ${result.methodCount}, Time: ${duration}ms`);
            
            // 添加到汇总
            summaryContent += `## ${testCase}\n`;
            summaryContent += `- Status: ✅ SUCCESS\n`;
            summaryContent += `- Methods rebuilt: ${result.methodCount}\n`;
            summaryContent += `- Duration: ${duration}ms\n`;
            summaryContent += `- SumIR: [${testCase}_sumir.txt](${testCase}_sumir.txt)\n`;
            summaryContent += `- ArkIR: [${testCase}_arkir.txt](${testCase}_arkir.txt)\n`;
            summaryContent += `- Callsite ArkIR: [${testCase}_callsite.txt](${testCase}_callsite.txt)\n\n`;
            
        } else {
            failedCount++;
            results[testCase] = { success: false, methods: 0, duration };
            console.log(`❌ ${testCase} failed. Time: ${duration}ms`);
            
            // 添加到汇总
            summaryContent += `## ${testCase}\n`;
            summaryContent += `- Status: ❌ FAILED\n`;
            summaryContent += `- Duration: ${duration}ms\n\n`;
        }
    }

    // 保存汇总报告
    summaryContent += `\n# Overall Statistics\n`;
    summaryContent += `- Total test cases: ${cases.length}\n`;
    summaryContent += `- Successful: ${successCount}\n`;
    summaryContent += `- Failed: ${failedCount}\n`;
    summaryContent += `- Success rate: ${((successCount / cases.length) * 100).toFixed(2)}%\n`;
    summaryContent += `- Total methods rebuilt: ${totalMethodCount}\n`;
    
    const summaryFilePath = path.join(outputDir, 'SUMMARY.md');
    fs.writeFileSync(summaryFilePath, summaryContent);

    // 打印最终结果
    console.log("\n" + "=".repeat(80));
    console.log("📊 BATCH CODE GENERATION SUMMARY");
    console.log("=".repeat(80));
    console.log(`Total test cases: ${cases.length}`);
    console.log(`Successful: ${successCount}`);
    console.log(`Failed: ${failedCount}`);
    console.log(`Success rate: ${((successCount / cases.length) * 100).toFixed(2)}%`);
    console.log(`Total methods rebuilt: ${totalMethodCount}`);
    console.log(`Output directory: ${outputDir}`);

    console.log(`\n📋 Detailed Results:`);
    for (const [testCase, result] of Object.entries(results)) {
        const status = result.success ? '✅' : '❌';
        const methodInfo = result.success ? `, Methods: ${result.methods}` : '';
        console.log(`  ${status} ${testCase}: (${result.duration}ms${methodInfo})`);
    }
    
    console.log(`\n📁 Generated Files:`);
    console.log(`  - Summary: ${summaryFilePath}`);
    console.log(`  - SumIR files: ${outputDir}/*_sumir.txt`);
    console.log(`  - ArkIR files: ${outputDir}/*_arkir.txt`);
    console.log(`  - Callsite ArkIR files: ${outputDir}/*_callsite.txt`);
}

// 主执行部分
if (require.main === module) {
    batchCodeGeneration().catch(error => {
        console.error("💥 Fatal error:", error);
        process.exit(1);
    });
}

export { batchCodeGeneration };
