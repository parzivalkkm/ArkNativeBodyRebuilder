import { SceneConfig } from '@ArkAnalyzer/src/Config';
import { Scene } from '@ArkAnalyzer/src/Scene';
import { DummyMainCreater } from "@ArkAnalyzer/src/core/common/DummyMainCreater";
import { TaintAnalysisChecker} from "taintanalysis/TaintAnalysis";
import * as fs from 'fs';
import { TaintAnalysisSolver } from "taintanalysis/TaintAnalysisSolver";
import Logger, { LOG_MODULE_TYPE, LOG_LEVEL } from '@ArkAnalyzer/src/utils/logger';
import { PointerAnalysisConfig } from "@ArkAnalyzer/src/callgraph/pointerAnalysis/PointerAnalysisConfig";
import { PointerAnalysis } from "@ArkAnalyzer/src/callgraph/pointerAnalysis/PointerAnalysis";
import { NativeBodyRebuilder } from 'src/NativeBodyRebuilder';

Logger.configure('out/HapFlow.log', LOG_LEVEL.ERROR)
const logger = Logger.getLogger(LOG_MODULE_TYPE.ARKANALYZER, 'HapFlow');

const config_path = "tests/resources/ifdsTestConfig.json";
let config: SceneConfig = new SceneConfig();
config.buildFromJson(config_path);

const scene = new Scene();
scene.buildBasicInfo(config);
scene.buildScene4HarmonyProject();

scene.inferTypes()

// 重建native body
const projectDir = 'D:\\WorkSpace\\ArkTS_Native\\Benchmarks\\OpenHarmony\\native_leak'; // 要分析的项目目录
const irFilePath = "tests/resources/test_resources/native_leak/libentry.so.ir.json"; // 生成的IR文件路径

// 创建NativeBodyRebuilder实例
const nativeBodyRebuilder = new NativeBodyRebuilder(irFilePath, scene);

nativeBodyRebuilder.rebuildNativeBody();
// 结束后再次进行类型推断
scene.inferTypes()

const creater = new DummyMainCreater(scene);
const ms = scene.getMethods()

creater.setEntryMethods(ms)
creater.createDummyMain();

const dummyMain = creater.getDummyMain();

let ptaConfig = PointerAnalysisConfig.create(1, "./out");
let pta : PointerAnalysis | undefined = PointerAnalysis.pointerAnalysisForWholeProject(scene, ptaConfig);


const problem = new TaintAnalysisChecker([...dummyMain.getCfg()!.getBlocks()][0].getStmts()[dummyMain.getParameters().length], dummyMain, pta);
problem.addSinksFromJson("tests/resources/sink.json");
problem.addSourcesFromJson("tests/resources/source.json");
problem.addSantizationsFromJson("tests/resources/santizationPath.json")
const solver = new TaintAnalysisSolver(problem, scene, pta);
solver.solve();
const o = problem.getOutcome()
logger.info('====== Taint Analysis Done');
debugger

