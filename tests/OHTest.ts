import Logger, { LOG_LEVEL, LOG_MODULE_TYPE } from '@ArkAnalyzer/src/utils/logger';
import { SceneConfig } from '@ArkAnalyzer/src/Config';
import { Scene } from '@ArkAnalyzer/src/Scene';
import { ArkBody } from '@ArkAnalyzer/src/core/model/ArkBody';
import { ArkAssignStmt, Stmt } from '@ArkAnalyzer/src';
import { ModelUtils } from '@ArkAnalyzer/src/core/common/ModelUtils';
import { ArkMetadataKind, CommentsMetadata } from '@ArkAnalyzer/src/core/model/ArkMetadata';
import { NativeBodyRebuilder } from 'src/NativeBodyRebuilder';

const logPath = 'out/projectParser.log';
const logger = Logger.getLogger(LOG_MODULE_TYPE.TOOL, 'OHTest');
Logger.configure(logPath, LOG_LEVEL.DEBUG, LOG_LEVEL.DEBUG);

class OHTest {
    public test() {
        const projectDir = 'tests/resources/HarmonyNativeFlowBench/native_leak';
        const sceneConfig: SceneConfig = new SceneConfig({ enableTrailingComments: true, enableLeadingComments: true });
        const irFilePath = "tests/resources/test_resources/native_leak/libentry.so.ir.json";
        sceneConfig.buildFromProjectDir(projectDir);

        const scene = new Scene();
        scene.buildSceneFromProjectDir(sceneConfig);
        scene.inferTypes();
        const nativeBodyRebuilder = new NativeBodyRebuilder(irFilePath, scene);
        nativeBodyRebuilder.rebuildNativeBody();
        this.printScene(scene);
    }

    private printScene(scene: Scene): void {
        for (const arkFile of scene.getFiles()) {
            logger.error('+++++++++++++ arkFile:', arkFile.getFilePath(), ' +++++++++++++');
            // 解析import信息
            const importInfos = arkFile.getImportInfos();
            for (const importInfo of importInfos) {
                logger.error(`importInfo: ${importInfo.toString()}`);
            }
            for (const arkClass of ModelUtils.getAllClassesInFile(arkFile)) {
                logger.error('========= arkClass:', arkClass.getSignature().toString(), ' =======');
                for (const arkMethod of arkClass.getMethods(true)) {
                    logger.error('***** arkMethod: ', arkMethod.getName());
                    const body = arkMethod.getBody();
                    if (body) {
                        this.printStmts(body);
                        logger.error('-- locals:');
                        body.getLocals().forEach(local => {
                            logger.error(`name: ${local.getName()}, type: ${local.getType()}`);
                        });
                        logger.error('-- usedGlobals:');
                        body.getUsedGlobals()?.forEach(usedGlobalName => {
                            logger.error(`name: ${usedGlobalName}`);
                        });
                    }
                }
            }
        }
    }

    private printStmts(body: ArkBody): void {
        logger.error('--- threeAddressStmts ---');
        const cfg = body.getCfg();
        for (const threeAddressStmt of cfg.getStmts()) {
            logger.error(`text: '${threeAddressStmt.toString()}'`);
            this.printMetadata(threeAddressStmt);
            if (threeAddressStmt.containsInvokeExpr()) {
                if (threeAddressStmt instanceof ArkAssignStmt) {
                    // 打印左值的类型
                    logger.error(`leftValue: ${threeAddressStmt.getLeftOp().getType()}`);
                }
                logger.error(`contains invokeExpr: ${threeAddressStmt.toString()}`);
                // 提取出invokeExpr
                const invokeExpr = threeAddressStmt.getInvokeExpr();
                if (invokeExpr) {
                    logger.error(`invokeExpr: ${invokeExpr.toString()}`);
                    // 打印方法名称
                    logger.error(`methodName: ${invokeExpr.getMethodSignature().getMethodSubSignature().getMethodName()}`);

                    if (invokeExpr.getMethodSignature().getMethodSubSignature().getMethodName() === 'testlog') {
                        logger.error(`invokeExpr: ${invokeExpr.toString()}`);
                    }
                    // 提取出invokeExpr的参数
                    const args = invokeExpr.getArgs();
                    logger.error(`args: ${args.toString()}`);
                    // 遍历所有参数，获取参数的类型
                    for (const arg of args) {
                        logger.error(`argType: ${arg.getType()}`);
                    }
                    // 打印返回值类型
                    logger.error(`returnType: ${invokeExpr.getMethodSignature().getMethodSubSignature().getReturnType()}`);
                }
            }
        }
    }

    public printMetadata(stmt: Stmt): void {
        const leadingCommentsMetadata = stmt.getMetadata(ArkMetadataKind.LEADING_COMMENTS);
        if (leadingCommentsMetadata instanceof CommentsMetadata) {
            const comments = leadingCommentsMetadata.getComments();
            for (const comment of comments) {
                logger.error(`leading comment content: ${comment.content}`);
                logger.error(`leading comment position: ${comment.position.getFirstLine()}:${comment.position.getFirstCol()}-${comment.position.getLastLine()}:${comment.position.getLastCol()}`);
            }
        }
        const trailingCommentsMetadata = stmt.getMetadata(ArkMetadataKind.TRAILING_COMMENTS);
        if (trailingCommentsMetadata instanceof CommentsMetadata) {
            const comments = trailingCommentsMetadata.getComments();
            for (const comment of comments) {
                logger.error(`trailing comment content: ${comment.content}`);
                logger.error(`trailing comment position: ${comment.position.getFirstLine()}:${comment.position.getFirstCol()}-${comment.position.getLastLine()}:${comment.position.getLastCol()}`);
            }
        }
    }
}

const ohTest = new OHTest();
ohTest.test();
