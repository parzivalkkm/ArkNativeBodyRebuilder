import { ArkFile } from '@ArkAnalyzer/src/core/model/ArkFile';
import path from 'path';
import Logger, { LOG_MODULE_TYPE } from '@ArkAnalyzer/src/utils/logger';
import { FunctionType } from '@ArkAnalyzer/src/core/base/Type';
import { MethodSubSignature } from '@ArkAnalyzer/src/core/model/ArkSignature';
import { MethodSubSignatureMap } from './ir/JsonObjectInterface';

export class IndexdtsUtils {

    private static logger = Logger.getLogger(LOG_MODULE_TYPE.TOOL, 'IndexdtsUtils');

    /**
     * Build napi export map from index.d.ts file
     * @param file The ArkFile instance of index.d.ts
     * @param napiExportMap The napi export map to store exports
     */
    public static buildNapiExportMap(file: ArkFile): MethodSubSignatureMap[] {
        const fileName = path.basename(file.getName());
        this.logger.info(`Processing file: ${fileName}`);
        const methodSubSignatureMapArray: MethodSubSignatureMap[] = [];
        
        if (!fileName.endsWith('.d.ts')) {
            this.logger.warn(`Skipping non-d.ts file: ${fileName}`);
            return methodSubSignatureMapArray;
        }

        // 缺一个判断，是否在cpp文件夹中
        if(!file.getName().includes('cpp')){
            this.logger.warn(`Skipping cpp file: ${fileName}`);
            return methodSubSignatureMapArray;
        }

        // 创建一个methodsubsignaturemap数组
        

        // get exportInfoMap
        const exportInfos = file.getExportInfos();
        // export数组
        const exportArray: string[] = [];
        for(const exportInfo of exportInfos){
            exportArray.push(exportInfo.getExportClauseName());
        }
        // 打印exportArray
        this.logger.info(`Export Array: ${exportArray}`);

        // Get the default method from the file
        const defaultArkMethod = file.getDefaultClass().getDefaultArkMethod();
        if (!defaultArkMethod) {
            this.logger.warn(`No default method found in file: ${fileName}`);
            return methodSubSignatureMapArray;
        }

        // 遍历defaultArkMethod的locals
        defaultArkMethod?.getBody()?.getLocals().forEach(local => {
            const name = local.getName();
            if(exportArray.includes(name)){
                this.logger.info(`Local: ${name}`);
                // 获取这个value的type
                const type = local.getType();
                this.logger.info(`Type: ${type}`);
                if(type instanceof FunctionType){
                    this.logger.info(`Function Type: ${type}`);
                    // 获取methodSignature
                    const methodSignature = type.getMethodSignature();
                    this.logger.info(`Method Signature: ${methodSignature}`);
                    const methodSubSignature = methodSignature.getMethodSubSignature();
                    this.logger.info(`Method Sub Signature: ${methodSubSignature}`);
                    // 创建一个新的methodsubsignature
                    const newMethodSubSignature = new MethodSubSignature(
                        "@nodeapiFunction" + name,
                        methodSubSignature.getParameters(),
                        methodSubSignature.getReturnType(),
                        true  // methodSubSignature.isStatic() // 这里其实应该写成static
                    );
                    // 创建一个新的methodsubsignaturemap
                    const newMethodSubSignatureMap: MethodSubSignatureMap = {
                        name: "@nodeapiFunction" + name,
                        methodSubSignature: newMethodSubSignature
                    };
                    // 将newMethodSubSignatureMap添加到methodSubSignatureMapArray中
                    methodSubSignatureMapArray.push(newMethodSubSignatureMap);
                }
            }
        });

        this.logger.info(`Processing default method in file: ${fileName}`);

        // 返回methodSubSignatureMapArray
        return methodSubSignatureMapArray;
    }
}
