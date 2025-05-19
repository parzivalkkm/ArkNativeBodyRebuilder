
import { SceneConfig } from "@ArkAnalyzer/src/Config";
import { Scene } from "@ArkAnalyzer/src/Scene";
import { DummyMainCreater } from "@ArkAnalyzer/src/core/common/DummyMainCreater";
// import { DummyMainCreater } from "../src/DummyMainCreater";
import { TaintAnalysisChecker} from "taintanalysis/TaintAnalysis";
import * as fs from 'fs';
import { TaintAnalysisSolver } from "taintanalysis/TaintAnalysisSolver";
import Logger, { LOG_MODULE_TYPE, LOG_LEVEL } from '@ArkAnalyzer/src/utils/logger';
import { PointerAnalysisConfig } from "@ArkAnalyzer/src/callgraph/pointerAnalysis/PointerAnalysisConfig";
import { PointerAnalysis } from "@ArkAnalyzer/src/callgraph/pointerAnalysis/PointerAnalysis";
Logger.configure('out/HapFlow.log', LOG_LEVEL.ERROR)
const logger = Logger.getLogger(LOG_MODULE_TYPE.ARKANALYZER, 'HapFlow');

// 根据指针图pag两种选择：1、指针完全一样视为等价，同时被污染；2、指针有交集就视为等价
// tests/resources/typeInference/multi_module/main_module
// out/ets2ts/applications_photos/common/src/main/ets/default/model/browser/photo
// const config_path = "tests/resources/typeInference/ProjectTypeInferenceTestConfig.json";
const config_path = "tests/resources/ifdsTestConfig.json";
// const config_path = "tests/resources/typeInference/ohapps.json";
let config: SceneConfig = new SceneConfig();
config.buildFromJson(config_path);
// config.buildFromProjectDir("tests/resources")
const scene = new Scene();
scene.buildBasicInfo(config);
scene.buildScene4HarmonyProject();
// scene.buildSceneFromProjectDir(config);
scene.inferTypes()

// TODO: 添加在这一步创建native body

const creater = new DummyMainCreater(scene);
const ms = scene.getMethods()
// .filter(m =>
//     m.getSignature().toString() == "@TaintTest/entry/src/main/ets/entryability/EntryAbility.ts: EntryAbility.onCreate(unknown, unknown)"
// )

creater.setEntryMethods(ms)
creater.createDummyMain();
const dummyMain = creater.getDummyMain();

let ptaConfig = PointerAnalysisConfig.create(1, "./out");
let pta : PointerAnalysis | undefined = PointerAnalysis.pointerAnalysisForWholeProject(scene, ptaConfig);
// let pta = undefined

const problem = new TaintAnalysisChecker([...dummyMain.getCfg()!.getBlocks()][0].getStmts()[dummyMain.getParameters().length], dummyMain, pta);
problem.addSinksFromJson("tests/resources/sink.json");
problem.addSourcesFromJson("tests/resources/source.json");
problem.addSantizationsFromJson("tests/resources/santizationPath.json")
const solver = new TaintAnalysisSolver(problem, scene, pta);
solver.solve();
const o = problem.getOutcome()
logger.info('====== Taint Analysis Done');
debugger

