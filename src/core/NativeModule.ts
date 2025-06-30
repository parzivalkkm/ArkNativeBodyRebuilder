import { ArkFile, Language } from '@ArkAnalyzer/src/core/model/ArkFile';
import { ArkClass } from '@ArkAnalyzer/src/core/model/ArkClass';
import { ArkMethod } from '@ArkAnalyzer/src/core/model/ArkMethod';
import { ClassSignature, FileSignature } from '@ArkAnalyzer/src/core/model/ArkSignature';
import { Scene } from '@ArkAnalyzer/src/Scene';
import { IRModule } from '../ir/IRFunction';
import { FunctionBodyRebuilder } from './FunctionBodyRebuilder';
import { MethodSubSignatureMap } from '../ir/JsonObjectInterface';
import { ArkInstanceInvokeExpr, ArkStaticInvokeExpr, ArkPtrInvokeExpr } from '@ArkAnalyzer/src';
import { BasicBlock } from '@ArkAnalyzer/src/core/graph/BasicBlock';
import { CallDetailInfo } from './CrossLanguageCallAnalyzer';
import { StringType } from '@ArkAnalyzer/src/core/base/Type';
import ConsoleLogger from '@ArkAnalyzer/src/utils/logger';
import { LOG_MODULE_TYPE } from '@ArkAnalyzer/src/utils/logger';

const logger = ConsoleLogger.getLogger(LOG_MODULE_TYPE.TOOL, 'NativeModule');

/**
 * 原生模块类
 * 代表一个IR文件对应的模块，包含其ArkFile、ArkClass和相关操作
 */
export class NativeModule {
    private irModule: IRModule;
    private arkFile: ArkFile;
    private arkClass: ArkClass;
    private scene: Scene;
    private rebuiltMethods: ArkMethod[] = [];

    constructor(irModule: IRModule, scene: Scene) {
        this.irModule = irModule;
        this.scene = scene;
        this.arkFile = this.createArkFile();
        this.arkClass = this.createArkClass();
    }

    /**
     * 创建ArkFile
     */
    private createArkFile(): ArkFile {
        const moduleFile = new ArkFile(Language.TYPESCRIPT);
        moduleFile.setScene(this.scene);
        
        const moduleFileSignature = new FileSignature(
            this.scene.getProjectName(),
            `@nodeapiFile${this.irModule.getModuleName()}`
        );
        
        moduleFile.setFileSignature(moduleFileSignature);
        this.scene.setFile(moduleFile);
        
        logger.info(`Created ArkFile for module: ${this.irModule.getModuleName()}`);
        return moduleFile;
    }
    
    /**
     * 创建ArkClass
     */
    private createArkClass(): ArkClass {
        const moduleClass = new ArkClass();
        moduleClass.setDeclaringArkFile(this.arkFile);
        
        const moduleClassSignature = new ClassSignature(
            `@nodeapiClass${this.irModule.getModuleName()}`,
            moduleClass.getDeclaringArkFile().getFileSignature(),
            moduleClass.getDeclaringArkNamespace()?.getSignature() || null
        );
        
        moduleClass.setSignature(moduleClassSignature);
        this.arkFile.addArkClass(moduleClass);
        
        logger.info(`Created ArkClass for module: ${this.irModule.getModuleName()}`);
        return moduleClass;
    }

    /**
     * 重建指定函数的方法体
     */
    public rebuildFunctionBody(
        functionName: string, 
        invokeExpr: ArkInstanceInvokeExpr | ArkStaticInvokeExpr | ArkPtrInvokeExpr,
        methodSubSignature?: MethodSubSignatureMap[]
    ): ArkMethod | null {
        // 查找对应的IR函数
        const irFunction = this.irModule.getFunctionByName(functionName);
        
        if (!irFunction) {
            logger.warn(`IRFunction not found for: ${functionName} in module: ${this.irModule.getModuleName()}`);
            return null;
        }

        const copyIrFunction = irFunction.copy();
        logger.info(`Found irFunction: ${copyIrFunction.getName()} in module: ${this.irModule.getModuleName()}`);
        
        // 处理 methodSubSignature，如果没有提供则使用空数组或默认值
        const effectiveMethodSubSignature = methodSubSignature || [];
        if (!methodSubSignature) {
            logger.info(`No methodSubSignature provided for function: ${functionName}, using default empty signature`);
        }
        
        // 创建一个临时的 Map 来传递给 FunctionBodyRebuilder
        const tempMethodSubSignatureMap = new Map<string, MethodSubSignatureMap[]>();
        if (effectiveMethodSubSignature.length > 0) {
            tempMethodSubSignatureMap.set(this.irModule.getModuleName(), effectiveMethodSubSignature);
        }
        
        // 提取调用点BasicBlock
        const callsiteBlock = this.extractCallsiteBlock(invokeExpr);
        
        // 为函数创建FunctionBodyRebuilder
        const rebuilder = new FunctionBodyRebuilder(
            this.scene, 
            this.arkClass, 
            copyIrFunction, 
            tempMethodSubSignatureMap, 
            invokeExpr,
            callsiteBlock  // 传递调用点BasicBlock
        );
        
        // 重建函数体
        const rebuiltMethod = rebuilder.rebuildFunctionBody();
        
        // 验证和修复方法参数
        if (!this.validateAndFixMethodParameters(rebuiltMethod)) {
            logger.error(`Failed to validate method parameters for: ${copyIrFunction.getName()}`);
        }
        
        this.rebuiltMethods.push(rebuiltMethod);
        
        logger.info(`Rebuilt function: ${copyIrFunction.getName()} in module: ${this.irModule.getModuleName()}`);
        return rebuiltMethod;
    }

    /**
     * 批量重建多个函数的方法体
     */
    public rebuildMultipleFunctions(
        invokeExprs: (ArkInstanceInvokeExpr | ArkStaticInvokeExpr | ArkPtrInvokeExpr)[],
        methodSubSignatureMap: Map<string, MethodSubSignatureMap[]>
    ): ArkMethod[] {
        const rebuiltMethods: ArkMethod[] = [];

        // 从全局 map 中获取当前模块对应的 methodSubSignature
        const moduleName = this.irModule.getModuleName();
        const moduleMethodSubSignature = methodSubSignatureMap.get(moduleName);
        
        if (!moduleMethodSubSignature) {
            logger.warn(`No methodSubSignature found for module: ${moduleName}, will use empty signature`);
        } else {
            logger.info(`Found methodSubSignature for module: ${moduleName} with ${moduleMethodSubSignature.length} entries`);
        }

        for (const invokeExpr of invokeExprs) {
            // 获取调用表达式的方法名
            let functionName: string;
            if (invokeExpr instanceof ArkInstanceInvokeExpr) {
                functionName = invokeExpr.getMethodSignature().getMethodSubSignature().getMethodName();
                
                // 对于形如 %AM0, %AM1 的方法名，我们需要从其他地方推断真实的函数名
                if (functionName.startsWith('%AM')) {
                    // 尝试从调用表达式的字符串表示中提取函数名
                    const invokeStr = invokeExpr.toString();
                    logger.debug(`Analyzing invoke expression for function name: ${invokeStr}`);
                    
                    // 查找所有可能的函数名（从IR模块中获取可用的函数列表）
                    const availableFunctions = this.irModule.getFunctions().map(f => f.getName());
                    logger.debug(`Available functions in module: ${availableFunctions.join(', ')}`);
                    
                    // 如果只有一个函数，直接使用它
                    if (availableFunctions.length === 1) {
                        functionName = availableFunctions[0];
                        logger.info(`Inferred function name (only one available): ${functionName}`);
                    } else {
                        // 尝试从调用表达式的类型信息中推断
                        const methodSig = invokeExpr.getMethodSignature().toString();
                        for (const funcName of availableFunctions) {
                            if (methodSig.includes(funcName)) {
                                functionName = funcName;
                                logger.info(`Inferred function name from signature: ${functionName}`);
                                break;
                            }
                        }
                        
                        // 如果仍然没有找到，使用base名称作为最后的尝试
                        if (functionName.startsWith('%AM')) {
                            const baseName = invokeExpr.getBase().getName();
                            if (baseName && baseName !== 'this' && availableFunctions.includes(baseName)) {
                                functionName = baseName;
                                logger.info(`Inferred function name from base: ${functionName}`);
                            }
                        }
                    }
                }
            } else if (invokeExpr instanceof ArkStaticInvokeExpr) {
                functionName = invokeExpr.getMethodSignature().getMethodSubSignature().getMethodName();
            } else if (invokeExpr instanceof ArkPtrInvokeExpr) {
                functionName = invokeExpr.getMethodSignature().getMethodSubSignature().getMethodName();
                
                // 对于指针调用，尝试从调用表达式中提取真实的函数名
                if (functionName.startsWith('%AM')) {
                    const invokeStr = invokeExpr.toString();
                    logger.debug(`Analyzing ptr invoke expression for function name: ${invokeStr}`);
                    
                    // 尝试从调用字符串中提取函数名（如 "leak(info)" -> "leak"）
                    const match = invokeStr.match(/(\w+)\s*\(/);
                    if (match && match[1]) {
                        functionName = match[1];
                        logger.info(`Extracted function name from ptr call: ${functionName}`);
                    } else {
                        // 如果无法从字符串提取，查看是否只有一个可用函数
                        const availableFunctions = this.irModule.getFunctions().map(f => f.getName());
                        if (availableFunctions.length === 1) {
                            functionName = availableFunctions[0];
                            logger.info(`Inferred function name for ptr call (only one available): ${functionName}`);
                        }
                    }
                }
            } else {
                logger.warn(`Unknown invoke expression type`);
                continue;
            }

            // 调用重建方法，传递对应的 signature 数组（如果存在的话）
            const rebuiltMethod = this.rebuildFunctionBody(functionName, invokeExpr, moduleMethodSubSignature);
            if (rebuiltMethod) {
                rebuiltMethods.push(rebuiltMethod);
            }
        }

        return rebuiltMethods;
    }

    /**
     * 重建指定函数的方法体（使用特定函数的signature）
     */
    public rebuildFunctionBodyWithSignature(
        functionName: string, 
        invokeExpr: ArkInstanceInvokeExpr | ArkStaticInvokeExpr | ArkPtrInvokeExpr,
        functionSpecificSignature: MethodSubSignatureMap | null = null
    ): ArkMethod | null {
        // 查找对应的IR函数
        const irFunction = this.irModule.getFunctionByName(functionName);
        
        if (!irFunction) {
            logger.warn(`IRFunction not found for: ${functionName} in module: ${this.irModule.getModuleName()}`);
            return null;
        }

        const copyIrFunction = irFunction.copy();
        logger.info(`Found irFunction: ${copyIrFunction.getName()} in module: ${this.irModule.getModuleName()}`);
        
        // 处理特定函数的signature
        let effectiveMethodSubSignature: MethodSubSignatureMap[] = [];
        if (functionSpecificSignature) {
            effectiveMethodSubSignature = [functionSpecificSignature];
            logger.info(`Using function-specific signature for: ${functionName}`);
        } else {
            logger.info(`No function-specific signature provided for: ${functionName}, using empty signature`);
        }
        
        // 创建一个临时的 Map 来传递给 FunctionBodyRebuilder
        const tempMethodSubSignatureMap = new Map<string, MethodSubSignatureMap[]>();
        if (effectiveMethodSubSignature.length > 0) {
            tempMethodSubSignatureMap.set(this.irModule.getModuleName(), effectiveMethodSubSignature);
        }
        
        // 提取调用点BasicBlock
        const callsiteBlock = this.extractCallsiteBlock(invokeExpr);
        
        // 为函数创建FunctionBodyRebuilder
        const rebuilder = new FunctionBodyRebuilder(
            this.scene, 
            this.arkClass, 
            copyIrFunction, 
            tempMethodSubSignatureMap, 
            invokeExpr,
            callsiteBlock  // 传递调用点BasicBlock
        );
        
        // 重建函数体
        const rebuiltMethod = rebuilder.rebuildFunctionBody();
        this.rebuiltMethods.push(rebuiltMethod);
        
        logger.info(`Rebuilt function: ${copyIrFunction.getName()} in module: ${this.irModule.getModuleName()}`);
        return rebuiltMethod;
    }

    /**
     * 批量重建多个函数的方法体（使用函数名到signature的映射）
     */
    public rebuildMultipleFunctionsWithSignatureMap(
        invokeExprs: (ArkInstanceInvokeExpr | ArkStaticInvokeExpr | ArkPtrInvokeExpr)[],
        functionSignatureMap: Map<string, MethodSubSignatureMap> = new Map()
    ): ArkMethod[] {
        const rebuiltMethods: ArkMethod[] = [];

        for (const invokeExpr of invokeExprs) {
            // 获取调用表达式的方法名
            let functionName: string;
            if (invokeExpr instanceof ArkInstanceInvokeExpr) {
                functionName = invokeExpr.getMethodSignature().getMethodSubSignature().getMethodName();
            } else if (invokeExpr instanceof ArkStaticInvokeExpr) {
                functionName = invokeExpr.getMethodSignature().getMethodSubSignature().getMethodName();
            } else if (invokeExpr instanceof ArkPtrInvokeExpr) {
                functionName = invokeExpr.getMethodSignature().getMethodSubSignature().getMethodName();
                
                // 对于指针调用，尝试从调用表达式中提取真实的函数名
                if (functionName.startsWith('%AM')) {
                    const invokeStr = invokeExpr.toString();
                    const match = invokeStr.match(/(\w+)\s*\(/);
                    if (match && match[1]) {
                        functionName = match[1];
                        logger.info(`Extracted function name from ptr call: ${functionName}`);
                    }
                }
            } else {
                logger.warn(`Unknown invoke expression type`);
                continue;
            }

            // 查找特定函数的signature
            const functionSignature = functionSignatureMap.get(functionName) || null;
            
            // 调用重建方法，传递对应的 signature（如果存在的话）
            const rebuiltMethod = this.rebuildFunctionBodyWithSignature(functionName, invokeExpr, functionSignature);
            if (rebuiltMethod) {
                rebuiltMethods.push(rebuiltMethod);
            }
        }

        return rebuiltMethods;
    }

    /**
     * 重建指定函数的方法体（使用CallDetailInfo）
     */
    public rebuildFunctionBodyWithCallDetail(
        functionName: string, 
        callDetail: CallDetailInfo,
        methodSubSignature?: MethodSubSignatureMap[]
    ): ArkMethod | null {
        // 查找对应的IR函数
        const irFunction = this.irModule.getFunctionByName(functionName);
        
        if (!irFunction) {
            logger.warn(`IRFunction not found for: ${functionName} in module: ${this.irModule.getModuleName()}`);
            return null;
        }

        const copyIrFunction = irFunction.copy();
        logger.info(`Found irFunction: ${copyIrFunction.getName()} in module: ${this.irModule.getModuleName()}`);
        
        // 处理 methodSubSignature，如果没有提供则使用空数组或默认值
        const effectiveMethodSubSignature = methodSubSignature || [];
        if (!methodSubSignature) {
            logger.info(`No methodSubSignature provided for function: ${functionName}, using default empty signature`);
        }
        
        // 创建一个临时的 Map 来传递给 FunctionBodyRebuilder
        const tempMethodSubSignatureMap = new Map<string, MethodSubSignatureMap[]>();
        if (effectiveMethodSubSignature.length > 0) {
            tempMethodSubSignatureMap.set(this.irModule.getModuleName(), effectiveMethodSubSignature);
        }
        
        // 使用CallDetail中的callsiteBlock
        const callsiteBlock = callDetail.callsiteBlock || undefined;
        logger.info(`Using callsite block for function: ${functionName}, callsiteBlock: ${callsiteBlock ? 'present' : 'undefined'}`);
        
        // 为函数创建FunctionBodyRebuilder
        const rebuilder = new FunctionBodyRebuilder(
            this.scene, 
            this.arkClass, 
            copyIrFunction, 
            tempMethodSubSignatureMap, 
            callDetail.invokeExpr,
            callsiteBlock  // 使用CallDetail中的callsiteBlock
        );
        
        // 重建函数体
        const rebuiltMethod = rebuilder.rebuildFunctionBody();
        
        // 验证和修复方法参数
        if (!this.validateAndFixMethodParameters(rebuiltMethod)) {
            logger.error(`Failed to validate method parameters for: ${copyIrFunction.getName()}`);
        }
        
        this.rebuiltMethods.push(rebuiltMethod);
        
        logger.info(`Rebuilt function: ${copyIrFunction.getName()} in module: ${this.irModule.getModuleName()}`);
        return rebuiltMethod;
    }

    /**
     * 批量重建多个函数的方法体（使用CallDetailInfo数组）
     */
    public rebuildMultipleFunctionsWithCallDetails(
        callDetails: CallDetailInfo[],
        methodSubSignatureMap: Map<string, MethodSubSignatureMap[]>
    ): ArkMethod[] {
        const rebuiltMethods: ArkMethod[] = [];

        // 从全局 map 中获取当前模块对应的 methodSubSignature
        const moduleName = this.irModule.getModuleName();
        const moduleMethodSubSignature = methodSubSignatureMap.get(moduleName);
        
        if (!moduleMethodSubSignature) {
            logger.warn(`No methodSubSignature found for module: ${moduleName}, will use empty signature`);
        } else {
            logger.info(`Found methodSubSignature for module: ${moduleName} with ${moduleMethodSubSignature.length} entries`);
        }

        for (const callDetail of callDetails) {
            // 获取调用表达式的方法名，优先使用CallDetail中的functionName
            let functionName = callDetail.functionName;
            
            if (!functionName) {
                // 如果CallDetail中没有functionName，从invokeExpr中提取
                const invokeExpr = callDetail.invokeExpr;
                if (invokeExpr instanceof ArkInstanceInvokeExpr) {
                    functionName = invokeExpr.getMethodSignature().getMethodSubSignature().getMethodName();
                    
                    // 对于形如 %AM0, %AM1 的方法名，我们需要从其他地方推断真实的函数名
                    if (functionName.startsWith('%AM')) {
                        // 尝试从调用表达式的字符串表示中提取函数名
                        const invokeStr = invokeExpr.toString();
                        logger.debug(`Analyzing invoke expression for function name: ${invokeStr}`);
                        
                        // 查找所有可能的函数名（从IR模块中获取可用的函数列表）
                        const availableFunctions = this.irModule.getFunctions().map(f => f.getName());
                        logger.debug(`Available functions in module: ${availableFunctions.join(', ')}`);
                        
                        // 如果只有一个函数，直接使用它
                        if (availableFunctions.length === 1) {
                            functionName = availableFunctions[0];
                            logger.info(`Inferred function name (only one available): ${functionName}`);
                        }
                    }
                } else if (invokeExpr instanceof ArkStaticInvokeExpr) {
                    functionName = invokeExpr.getMethodSignature().getMethodSubSignature().getMethodName();
                } else if (invokeExpr instanceof ArkPtrInvokeExpr) {
                    functionName = invokeExpr.getMethodSignature().getMethodSubSignature().getMethodName();
                    
                    // 对于指针调用，尝试从调用表达式中提取真实的函数名
                    if (functionName.startsWith('%AM')) {
                        const invokeStr = invokeExpr.toString();
                        logger.debug(`Analyzing ptr invoke expression for function name: ${invokeStr}`);
                        
                        // 尝试从调用字符串中提取函数名（如 "leak(info)" -> "leak"）
                        const match = invokeStr.match(/(\w+)\s*\(/);
                        if (match && match[1]) {
                            functionName = match[1];
                            logger.info(`Extracted function name from ptr call: ${functionName}`);
                        }
                    }
                }
            }

            if (!functionName) {
                logger.warn(`Unable to determine function name for call detail`);
                continue;
            }

            // 调用重建方法，传递对应的 signature 数组（如果存在的话）
            const rebuiltMethod = this.rebuildFunctionBodyWithCallDetail(functionName, callDetail, moduleMethodSubSignature);
            if (rebuiltMethod) {
                rebuiltMethods.push(rebuiltMethod);
            }
        }

        return rebuiltMethods;
    }

    /**
     * 验证和修复方法参数问题
     */
    private validateAndFixMethodParameters(method: ArkMethod): boolean {
        try {
            const signature = method.getImplementationSignature();
            if (!signature) {
                logger.warn(`Method has no implementation signature: ${method.toString()}`);
                return false;
            }
            
            const subSignature = signature.getMethodSubSignature();
            if (!subSignature) {
                logger.warn(`Method has no sub-signature: ${method.toString()}`);
                return false;
            }
            
            const parameters = subSignature.getParameters();
            if (!parameters || parameters.length === 0) {
                logger.warn(`Method has no parameters, this may cause issues in taint analysis: ${method.toString()}`);
                // 可以选择返回 true 继续处理，或者 false 跳过这个方法
                return true; // 允许无参数的方法
            }
            
            // 验证每个参数是否有效
            for (let i = 0; i < parameters.length; i++) {
                const param = parameters[i];
                if (!param) {
                    logger.error(`Parameter ${i} is undefined in method: ${method.toString()}`);
                    return false;
                }
                
                if (!param.getType()) {
                    logger.warn(`Parameter ${i} has no type in method: ${method.toString()}`);
                    // 可以设置默认类型
                    param.setType(StringType.getInstance());
                }
            }
            
            logger.info(`Method parameters validation passed: ${method.toString()}`);
            return true;
        } catch (error) {
            logger.error(`Error validating method parameters: ${error}`);
            return false;
        }
    }

    /**
     * 获取模块名称
     */
    public getModuleName(): string {
        return this.irModule.getModuleName();
    }

    /**
     * 获取IRModule
     */
    public getIRModule(): IRModule {
        return this.irModule;
    }

    /**
     * 获取ArkFile
     */
    public getArkFile(): ArkFile {
        return this.arkFile;
    }

    /**
     * 获取ArkClass
     */
    public getArkClass(): ArkClass {
        return this.arkClass;
    }

    /**
     * 获取已重建的方法
     */
    public getRebuiltMethods(): ArkMethod[] {
        return [...this.rebuiltMethods];
    }

    /**
     * 获取模块详细信息
     */
    public getModuleDetails(): {
        moduleName: string;
        hapName: string;
        soName: string;
        functionCount: number;
        rebuiltMethodCount: number;
    } {
        return {
            moduleName: this.irModule.getModuleName(),
            hapName: this.irModule.getHapName(),
            soName: this.irModule.getSoName(),
            functionCount: this.irModule.getFunctions().length,
            rebuiltMethodCount: this.rebuiltMethods.length
        };
    }

    /**
     * 打印模块详细信息
     */
    public printDetails(): void {
        const details = this.getModuleDetails();
        logger.info(`Module: ${details.moduleName}`);
        logger.info(`  HAP Name: ${details.hapName}`);
        logger.info(`  SO Name: ${details.soName}`);
        logger.info(`  Functions: ${details.functionCount}`);
        logger.info(`  Rebuilt Methods: ${details.rebuiltMethodCount}`);
        
        this.irModule.getFunctions().forEach((func, index) => {
            logger.info(`    ${index + 1}. Function: ${func.getName()}`);
            logger.info(`       Parameters: ${func.getParameters().size}`);
            logger.info(`       Instructions: ${func.getInstructions().length}`);
        });
    }

    /**
     * 从invokeExpr中提取调用点BasicBlock
     * 这是一个临时实现，实际上应该从CFG遍历中获得
     */
    private extractCallsiteBlock(invokeExpr: ArkInstanceInvokeExpr | ArkStaticInvokeExpr | ArkPtrInvokeExpr): BasicBlock | undefined {
        // 临时实现：尝试从invokeExpr的上下文中获取BasicBlock
        // 在实际的ArkTS框架中，这通常通过CFG遍历来实现
        
        // 方法1: 尝试从Stmt中获取BasicBlock
        try {
            // 如果invokeExpr有关联的语句，我们可以从语句中获取BasicBlock
            // 这需要根据实际的ArkAnalyzer API来实现
            
            // 目前返回undefined，表示暂时无法获取调用点BasicBlock
            // 这种情况下，FunctionBodyRebuilder会跳过调用点变量的处理
            logger.debug("extractCallsiteBlock: Currently unable to extract callsite block from invokeExpr");
            return undefined;
        } catch (error) {
            logger.warn(`Error extracting callsite block: ${error}`);
            return undefined;
        }
    }
}
