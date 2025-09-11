import { Scene } from '@ArkAnalyzer/src/Scene';
import { ArkFile } from '@ArkAnalyzer/src/core/model/ArkFile';
import { ArkBody, ArkInstanceInvokeExpr, ArkStaticInvokeExpr, ArkPtrInvokeExpr, ModelUtils } from '@ArkAnalyzer/src';
import { BasicBlock } from '@ArkAnalyzer/src/core/graph/BasicBlock';
import { MethodSubSignature } from '@ArkAnalyzer/src/core/model/ArkSignature';
import ConsoleLogger from '@ArkAnalyzer/src/utils/logger';
import { LOG_MODULE_TYPE } from '@ArkAnalyzer/src/utils/logger';
import { MethodSubSignatureMap } from '../ir/JsonObjectInterface';

const logger = ConsoleLogger.getLogger(LOG_MODULE_TYPE.TOOL, 'CrossLanguageCallAnalyzer');

/**
 * 跨语言调用信息（包含调用点BasicBlock）
 */
export interface CrossLanguageCallInfo {
    libraryName: string;
    callDetails: CallDetailInfo[];
}

/**
 * 调用详细信息（包含调用表达式、所在BasicBlock和方法签名）
 */
export interface CallDetailInfo {
    invokeExpr: ArkInstanceInvokeExpr | ArkStaticInvokeExpr | ArkPtrInvokeExpr;
    callsiteBlock: BasicBlock | null;
    functionName?: string; // 函数名（对于具名导入）
    methodSignature?: MethodSubSignature; // 从.d.ts提取的方法签名（已在分析阶段匹配好）
    callsiteStmtIndex?: number; // 调用语句在BasicBlock中的位置索引
}

/**
 * 导入信息
 */
export interface ImportInfo {
    importType: string;
    importClauseName?: string;
    nameBeforeAs?: string;
    from?: string;
}

/**
 * 跨语言调用分析器
 * 负责分析项目中的跨语言调用，包括静态导入和动态导入
 */
export class CrossLanguageCallAnalyzer {
    private scene: Scene;
    private namedImportMap: Map<string, string> = new Map(); // 具名导入映射：函数名 -> 库名
    private dynamicImportMap: Map<string, string> = new Map(); // 动态导入映射：变量名 -> 库名
    private napiCallDetailsMap: Map<string, CallDetailInfo[]> = new Map(); // 新的调用详情映射
    private methodSubSignatureMap: Map<string, MethodSubSignature> = new Map(); // 方法签名映射：函数名 -> 签名

    constructor(scene: Scene, methodSubSignatureMapsByLibrary?: Map<string, MethodSubSignatureMap[]>) {
        this.scene = scene;
        // 初始化方法签名映射
        if (methodSubSignatureMapsByLibrary) {
            for (const [libraryName, methodSubSignatureMapArray] of methodSubSignatureMapsByLibrary) {
                for (const methodSubSignatureMap of methodSubSignatureMapArray) {
                    // 使用库名前缀来区分不同库的函数
                    const qualifiedName = `${libraryName}.${methodSubSignatureMap.name}`;
                    this.methodSubSignatureMap.set(qualifiedName, methodSubSignatureMap.methodSubSignature);
                    // 同时添加不带库名前缀的版本，用于直接匹配
                    this.methodSubSignatureMap.set(methodSubSignatureMap.name, methodSubSignatureMap.methodSubSignature);
                }
            }
            logger.info(`Loaded ${this.methodSubSignatureMap.size} method signatures from .d.ts files across ${methodSubSignatureMapsByLibrary.size} libraries`);
        }
    }

    /**
     * 分析跨语言调用
     */
    public analyzeCrossLanguageCalls(): Map<string, CallDetailInfo[]> {
        logger.info('Starting cross-language call analysis...');
        
        // 清空之前的分析结果
        this.namedImportMap.clear();
        this.dynamicImportMap.clear();
        this.napiCallDetailsMap.clear();

        // 遍历所有arkfile
        for (const arkFile of this.scene.getFiles()) {
            this.analyzeFileImports(arkFile);
        }

        // 验证导入映射
        this.validateImportMappings();

        logger.info(`Cross-language call analysis completed. Found ${this.napiCallDetailsMap.size} libraries with calls.`);
        return new Map(this.napiCallDetailsMap);
    }

    /**
     * 分析单个文件的导入和调用
     */
    private analyzeFileImports(arkFile: ArkFile): void {
        // 解析import信息
        const importInfos = arkFile.getImportInfos();
        const importMap = new Map<string, string>(); // 默认导入映射：变量名 -> 库名
        
        for (const importInfo of importInfos) {
            if (importInfo.getFrom()?.endsWith('.so')) {
                logger.info(`ImportInfo: ${importInfo.toString()}`);
                const importType = importInfo.getImportType();
                const strImportFrom = importInfo.getFrom()?.split('.so')[0] || '';
                const importClauseName = importInfo.getImportClauseName();
                const nameBeforeAs = importInfo.getNameBeforeAs();
                
                // 处理不同类型的导入
                this.processImportInfo({
                    importType,
                    importClauseName,
                    nameBeforeAs,
                    from: strImportFrom
                }, importMap);
            }else if (importInfo.getFrom()?.endsWith('.so&')) {
                // 处理Hapler生成的import中的导入
                logger.info(`ImportInfo: ${importInfo.toString()}`);
                const importType = importInfo.getImportType();
                const strImportFrom = importInfo.getFrom()?.split('&&&')[1].split('.so&')[0] || '';
                const importClauseName = importInfo.getImportClauseName();
                const nameBeforeAs = importInfo.getNameBeforeAs();
                
                // 处理不同类型的导入
                this.processImportInfo({
                    importType,
                    importClauseName,
                    nameBeforeAs,
                    from: strImportFrom
                }, importMap);
            }
        }
        
        // 如果有导入映射，分析调用
        if (importMap.size > 0 || this.namedImportMap.size > 0) {
            this.analyzeFileCalls(arkFile, importMap);
        }
    }

    /**
     * 处理导入信息
     */
    private processImportInfo(importInfo: ImportInfo, importMap: Map<string, string>): void {
        const { importType, importClauseName, nameBeforeAs, from } = importInfo;

        switch (importType) {
            case 'Identifier': 
                // 默认导入：import testEntry from 'libentry.so'
                if (importClauseName && from) {
                    importMap.set(importClauseName, from);
                    logger.info(`Default import: ${importClauseName} from ${from}`);
                }
                break;
                
            case 'NamedImports':
                // 具名导入：import {leak} from 'libleak.so' 或 import {func as alias} from 'libentry.so'
                if (importClauseName && from) {
                    // 处理 propertyName as localName 的情况
                    // importClauseName 是本地名称，nameBeforeAs 是原始名称
                    const originalName = nameBeforeAs || importClauseName;
                    
                    // 为本地名称建立映射
                    this.namedImportMap.set(importClauseName, from);
                    logger.info(`Named import: ${importClauseName} (original: ${originalName}) from ${from}`);
                    
                    // 如果有 as 重命名，也为原始名称建立映射
                    if (nameBeforeAs && nameBeforeAs !== importClauseName) {
                        this.namedImportMap.set(originalName, from);
                        logger.info(`Named import alias: ${originalName} -> ${importClauseName} from ${from}`);
                    }
                }
                break;
                
            case 'NamespaceImport':
                // 命名空间导入：import * as module from 'libentry.so'
                if (importClauseName && from) {
                    importMap.set(importClauseName, from);
                    logger.info(`Namespace import: ${importClauseName} from ${from}`);
                }
                break;
                
            case 'EqualsImport':
                // 等号导入：import module = require('libentry.so')
                if (importClauseName && from) {
                    importMap.set(importClauseName, from);
                    logger.info(`Equals import: ${importClauseName} from ${from}`);
                }
                break;
                
            default:
                // 无导入子句的导入：import 'libentry.so'
                if (from) {
                    logger.info(`Side-effect import from ${from}`);
                }
                break;
        }
    }

    /**
     * 分析文件中的调用
     */
    private analyzeFileCalls(arkFile: ArkFile, importMap: Map<string, string>): void {
        for (const arkClass of ModelUtils.getAllClassesInFile(arkFile)) {
            for (const arkMethod of arkClass.getMethods()) {
                const body = arkMethod.getBody();
                if (body) {
                    this.parseNapiCall(body, importMap);
                    this.parseDynamicNapiCall(body); // 处理动态导入
                }
            }
        }
    }

    /**
     * 解析NAPI调用
     */
    private parseNapiCall(body: ArkBody, importMap: Map<string, string>): void {
        // 遍历body中的所有stmt，同时记录所在BasicBlock
        const cfg = body.getCfg();
        
        // 首先遍历所有BasicBlock
        for (const basicBlock of cfg.getBlocks()) {
            // 遍历BasicBlock中的所有语句，同时记录索引
            const statements = basicBlock.getStmts();
            for (let stmtIndex = 0; stmtIndex < statements.length; stmtIndex++) {
                const threeAddressStmt = statements[stmtIndex];
                if (threeAddressStmt.containsInvokeExpr()) {
                    const invokeExpr = threeAddressStmt.getInvokeExpr();
                    
                    // 处理实例调用（这些可能是node-api的调用，但被错误识别）
                    if (invokeExpr instanceof ArkInstanceInvokeExpr) {
                        this.processInstanceInvokeExpr(invokeExpr, importMap, basicBlock, stmtIndex);
                    }
                    // 处理静态调用（这是node-api的正确调用方式）
                    else if (invokeExpr instanceof ArkStaticInvokeExpr) {
                        this.processStaticInvokeExpr(invokeExpr, basicBlock, stmtIndex);
                    }
                    // 处理指针调用（具名导入的函数调用）
                    else if (invokeExpr instanceof ArkPtrInvokeExpr) {
                        this.processPtrInvokeExpr(invokeExpr, basicBlock, stmtIndex);
                    }
                }
            }
        }
    }

    /**
     * 处理实例调用表达式
     */
    private processInstanceInvokeExpr(invokeExpr: ArkInstanceInvokeExpr, importMap: Map<string, string>, callsiteBlock: BasicBlock, stmtIndex: number): void {
        logger.info(`Instance invokeExpr: ${invokeExpr.toString()}`);
        const base = invokeExpr.getBase();
        const basename = base.getName();
        const methodSignature = invokeExpr.getMethodSignature();
        const methodName = methodSignature.getMethodSubSignature().getMethodName();
        
        logger.debug(`Instance call - base: ${basename}, method: ${methodName}`);
        
        let importFrom: string | undefined;

        // 检查是否为默认导入的模块调用 (module.method)
        if (importMap.has(basename)) {
            importFrom = importMap.get(basename);
            logger.info(`Default import instance call: ${basename}.${methodName} from ${importFrom}`);
            logger.warn(`Instance invoke should be static for node-api: ${methodSignature.toString()}`);
        }
        // 检查是否为动态导入的模块调用
        else if (this.dynamicImportMap.has(basename)) {
            importFrom = this.dynamicImportMap.get(basename);
            logger.info(`Dynamic module instance call: ${basename}.${methodName} from ${importFrom}`);
        }
        // 检查是否为具名导入的函数调用（可能被编译为实例调用）
        else if (this.namedImportMap.has(basename)) {
            importFrom = this.namedImportMap.get(basename);
            logger.info(`Named import as instance call: ${basename} from ${importFrom}`);
            logger.warn(`Named import appears as instance call: ${methodSignature.toString()}`);
        }
        else {
            logger.debug(`Instance call base ${basename} not found in any import maps`);
        }

        if (importFrom) {
            this.addNapiCallDetail(importFrom, invokeExpr, callsiteBlock, methodName, stmtIndex);
        }
    }

    /**
     * 处理静态调用表达式
     */
    private processStaticInvokeExpr(invokeExpr: ArkStaticInvokeExpr, callsiteBlock: BasicBlock, stmtIndex: number): void {
        logger.info(`Static invokeExpr: ${invokeExpr.toString()}`);
        const methodSignature = invokeExpr.getMethodSignature();
        const methodName = methodSignature.getMethodSubSignature().getMethodName();
        
        logger.debug(`Static call method name: ${methodName}`);
        logger.debug(`Named import map has ${this.namedImportMap.size} entries:`, Array.from(this.namedImportMap.entries()));
        
        // 检查是否为具名导入的函数调用
        if (this.namedImportMap.has(methodName)) {
            const importFrom = this.namedImportMap.get(methodName);
            logger.info(`Named import static call: ${methodName} from ${importFrom}`);
            
            if (importFrom) {
                this.addNapiCallDetail(importFrom, invokeExpr, callsiteBlock, methodName, stmtIndex);
            }
        }
        // 检查是否为全局函数调用（如 loadNativeModule）
        else if (methodName === 'loadNativeModule') {
            logger.info(`Global loadNativeModule call: ${invokeExpr.toString()}`);
            // 这将在 parseDynamicNapiCall 中进一步处理
        }
        else {
            logger.debug(`Static call ${methodName} not found in named imports`);
        }
    }

    /**
     * 处理指针调用表达式（具名导入的函数调用）
     */
    private processPtrInvokeExpr(invokeExpr: ArkPtrInvokeExpr, callsiteBlock: BasicBlock, stmtIndex: number): void {
        logger.info(`Ptr invokeExpr: ${invokeExpr.toString()}`);
        
        // 尝试从调用表达式中获取函数名
        // 先尝试从方法签名中获取
        const methodSignature = invokeExpr.getMethodSignature();
        let functionName = methodSignature.getMethodSubSignature().getMethodName();
        
        // 如果是内部标识符（如%AM0），尝试从调用表达式的字符串表示中提取
        if (functionName.startsWith('%AM')) {
            const invokeStr = invokeExpr.toString();
            logger.debug(`Analyzing ptr invoke expression for function name: ${invokeStr}`);
            
            // 尝试从originalText或调用表达式中提取函数名
            // 根据你提供的JSON，我们可以尝试从调用字符串中提取
            const match = invokeStr.match(/(\w+)\s*\(/);
            if (match && match[1]) {
                functionName = match[1];
                logger.info(`Extracted function name from ptr call: ${functionName}`);
            }
        }
        
        logger.debug(`Ptr call function name: ${functionName}`);
        
        // 检查是否为具名导入的函数调用
        if (this.namedImportMap.has(functionName)) {
            const importFrom = this.namedImportMap.get(functionName);
            logger.info(`Named import ptr call: ${functionName} from ${importFrom}`);
            
            if (importFrom) {
                this.addNapiCallDetail(importFrom, invokeExpr, callsiteBlock, functionName, stmtIndex);
            }
        } else {
            logger.debug(`Ptr call ${functionName} not found in named imports`);
        }
    }

    /**
     * 添加NAPI调用详情到映射中（包含调用点BasicBlock和方法签名）
     */
    private addNapiCallDetail(importFrom: string, invokeExpr: ArkInstanceInvokeExpr | ArkStaticInvokeExpr | ArkPtrInvokeExpr, callsiteBlock: BasicBlock | null, functionName?: string, stmtIndex?: number): void {
        // 尝试匹配方法签名
        let methodSignature: MethodSubSignature | undefined;
        if (functionName) {
            // 从库名中提取文件夹名
            const libNameWithoutExtension = importFrom.replace(/\.(so|dll)$/, '').replace(/^lib/, '');
            
            // 尝试多种匹配策略
            const possibleKeys = [
                `${libNameWithoutExtension}.@nodeapiFunction${functionName}`, // 库名.@nodeapiFunction函数名
                `@nodeapiFunction${functionName}`, // @nodeapiFunction函数名
                `${libNameWithoutExtension}.${functionName}`, // 库名.函数名
                functionName // 直接函数名
            ];
            
            for (const key of possibleKeys) {
                methodSignature = this.methodSubSignatureMap.get(key);
                if (methodSignature) {
                    logger.info(`Found method signature for function '${functionName}' using key '${key}': ${methodSignature.toString()}`);
                    break;
                }
            }
            
            if (!methodSignature) {
                logger.warn(`No method signature found for function '${functionName}' in library '${importFrom}'. Tried keys: ${possibleKeys.join(', ')}`);
                // 打印可用的签名，用于调试
                logger.debug(`Available signatures: ${Array.from(this.methodSubSignatureMap.keys()).join(', ')}`);
            }
        }
        
        const existingDetails = this.napiCallDetailsMap.get(importFrom) || [];
        existingDetails.push({
            invokeExpr,
            callsiteBlock,
            functionName,
            methodSignature,
            callsiteStmtIndex: stmtIndex
        });
        this.napiCallDetailsMap.set(importFrom, existingDetails);
    }

    /**
     * 处理动态导入的NAPI调用
     * 包括 loadNativeModule 调用和后续的模块方法调用
     */
    private parseDynamicNapiCall(body: ArkBody): void {
        const cfg = body.getCfg();
        
        // 第一步：查找 loadNativeModule 调用，建立动态导入映射
        for (const basicBlock of cfg.getBlocks()) {
            for (const threeAddressStmt of basicBlock.getStmts()) {
                if (threeAddressStmt.containsInvokeExpr()) {
                    const invokeExpr = threeAddressStmt.getInvokeExpr();
                    
                    if (invokeExpr instanceof ArkStaticInvokeExpr) {
                        const methodName = invokeExpr.getMethodSignature().getMethodSubSignature().getMethodName();
                        
                        // 检查是否为 loadNativeModule 调用
                        if (methodName === 'loadNativeModule') {
                            this.processDynamicImport(invokeExpr, threeAddressStmt);
                        }
                    }
                }
            }
        }
        
        // 第二步：查找动态模块上的方法调用
        for (const basicBlock of cfg.getBlocks()) {
            for (const threeAddressStmt of basicBlock.getStmts()) {
                if (threeAddressStmt.containsInvokeExpr()) {
                    const invokeExpr = threeAddressStmt.getInvokeExpr();
                    
                    if (invokeExpr instanceof ArkInstanceInvokeExpr) {
                        this.processDynamicMethodCall(invokeExpr, basicBlock);
                    }
                }
            }
        }
    }

    /**
     * 处理动态导入
     */
    private processDynamicImport(invokeExpr: ArkStaticInvokeExpr, threeAddressStmt: any): void {
        logger.info(`Found dynamic import: ${invokeExpr.toString()}`);
        
        // 获取参数（库名）
        const args = invokeExpr.getArgs();
        if (args.length > 0) {
            const libraryNameArg = args[0];
            logger.info(`Dynamic import library argument: ${libraryNameArg.toString()}`);
            
            // 尝试从参数中提取库名
            const libraryName = this.extractLibraryName(libraryNameArg.toString());
            if (libraryName) {
                // 查找赋值语句，获取变量名
                const assignedVar = this.findAssignedVariable(threeAddressStmt);
                if (assignedVar) {
                    this.dynamicImportMap.set(assignedVar, libraryName);
                    logger.info(`Dynamic import mapping: ${assignedVar} -> ${libraryName}`);
                }
            }
        }
    }

    /**
     * 处理动态方法调用
     */
    private processDynamicMethodCall(invokeExpr: ArkInstanceInvokeExpr, callsiteBlock: BasicBlock, stmtIndex: number = -1): void {
        const base = invokeExpr.getBase();
        const basename = base.getName();
        const methodName = invokeExpr.getMethodSignature().getMethodSubSignature().getMethodName();
        
        // 检查是否为动态导入的模块变量
        if (this.dynamicImportMap.has(basename)) {
            const importFrom = this.dynamicImportMap.get(basename);
            logger.info(`Dynamic module method call: ${basename}.${methodName} from ${importFrom}`);
            
            if (importFrom) {
                this.addNapiCallDetail(importFrom, invokeExpr, callsiteBlock, methodName, stmtIndex);
            }
        }
    }

    /**
     * 从参数表达式中提取库名
     */
    private extractLibraryName(argString: string): string | null {
        // 移除引号并提取库名
        const match = argString.match(/["']([^"']+)["']/);
        if (match && match[1]) {
            const fullName = match[1];
            // 如果是 .so 文件，移除扩展名
            if (fullName.endsWith('.so')) {
                return fullName.substring(0, fullName.length - 3);
            }
            return fullName;
        }
        return null;
    }
    
    /**
     * 查找被赋值的变量名
     */
    private findAssignedVariable(stmt: any): string | null {
        // 这里需要根据具体的语句结构来查找赋值的左侧变量
        // 这是一个简化版本，实际实现可能需要更复杂的AST遍历
        const stmtString = stmt.toString();
        
        // 查找形如 "var = " 的模式
        const assignMatch = stmtString.match(/(\w+)\s*=/);
        if (assignMatch && assignMatch[1]) {
            return assignMatch[1];
        }
        
        return null;
    }

    /**
     * 验证导入映射的完整性
     */
    private validateImportMappings(): void {
        logger.info(`=== Import Mappings Summary ===`);
        logger.info(`Named imports: ${this.namedImportMap.size} entries`);
        for (const [name, lib] of this.namedImportMap.entries()) {
            logger.info(`  ${name} -> ${lib}`);
        }
        
        logger.info(`Dynamic imports: ${this.dynamicImportMap.size} entries`);
        for (const [name, lib] of this.dynamicImportMap.entries()) {
            logger.info(`  ${name} -> ${lib}`);
        }
        
        logger.info(`NAPI calls found: ${this.napiCallDetailsMap.size} libraries`);
        for (const [lib, details] of this.napiCallDetailsMap.entries()) {
            logger.info(`  ${lib}: ${details.length} calls`);
        }
        logger.info(`=== End Summary ===`);
    }

    /**
     * 获取跨语言调用信息
     */
    public getCrossLanguageCallInfo(): CrossLanguageCallInfo[] {
        const callInfos: CrossLanguageCallInfo[] = [];
        
        for (const [libraryName, callDetails] of this.napiCallDetailsMap.entries()) {
            callInfos.push({
                libraryName,
                callDetails: [...callDetails]
            });
        }
        
        return callInfos;
    }

    /**
     * 获取具名导入映射
     */
    public getNamedImportMap(): Map<string, string> {
        return new Map(this.namedImportMap);
    }

    /**
     * 获取动态导入映射
     */
    public getDynamicImportMap(): Map<string, string> {
        return new Map(this.dynamicImportMap);
    }
    
    /**
     * 获取调用点统计信息 - 直接统计各种调用表达式类型的数量
     */
    public getCallsiteStatistics(): Map<string, number> {
        const callsitesByType = new Map<string, number>();
        
        for (const [moduleName, callDetails] of this.napiCallDetailsMap.entries()) {
            if (callDetails && Array.isArray(callDetails)) {
                callDetails.forEach(detail => {
                    const invokeExpr = detail.invokeExpr;
                    let callType = 'unknown';
                    
                    if (invokeExpr instanceof ArkStaticInvokeExpr) {
                        callType = 'ArkStaticInvokeExpr';
                    } else if (invokeExpr instanceof ArkInstanceInvokeExpr) {
                        callType = 'ArkInstanceInvokeExpr';
                    } else if (invokeExpr instanceof ArkPtrInvokeExpr) {
                        callType = 'ArkPtrInvokeExpr';
                    }
                    
                    callsitesByType.set(callType, (callsitesByType.get(callType) || 0) + 1);
                });
            }
        }
        
        return callsitesByType;
    }
}
