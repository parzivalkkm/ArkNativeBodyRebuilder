import { IRFunction } from './IRFunction';
import { IRInstruction, IRCallInstruction, IRPhiInstruction, IRReturnInstruction } from './IRInstruction';
import { IRValue, IRVariable, IRParameter, IRConstant } from './IRValue';
import { ModuleIR, FunctionIR } from './JsonObjectInterface';
import { Logger } from 'log4js';

/**
 * SumIR打印器 - 将IR转换为人类可读的格式
 */
export class SumIRDumper {
    private logger: Logger;
    private indentLevel: number = 0;
    private indentSize: number = 2;

    constructor(logger?: Logger) {
        this.logger = logger || console as any;
    }

    /**
     * 打印整个模块的IR
     */
    public dumpModule(moduleIR: ModuleIR): string {
        const lines: string[] = [];
        
        lines.push(this.formatHeader("SumIR Module"));
        lines.push(this.formatKeyValue("HAP Name", moduleIR.hap_name));
        lines.push(this.formatKeyValue("SO Name", moduleIR.so_name));
        lines.push(this.formatKeyValue("Module Name", moduleIR.module_name));
        lines.push(this.formatKeyValue("Functions Count", moduleIR.functions.length.toString()));
        lines.push("");

        moduleIR.functions.forEach((func, index) => {
            if (index > 0) lines.push("");
            lines.push(...this.dumpFunctionIR(func));
        });

        return lines.join('\n');
    }

    /**
     * 打印函数的JSON IR表示
     */
    public dumpFunctionIR(functionIR: FunctionIR): string[] {
        const lines: string[] = [];
        
        lines.push(this.formatSubHeader(`Function: ${functionIR.name}`));
        
        // 打印参数
        const paramCount = Object.keys(functionIR.params).length;
        if (paramCount > 0) {
            lines.push(this.formatKeyValue("Parameters", paramCount.toString()));
            this.increaseIndent();
            Object.entries(functionIR.params).forEach(([name, type]) => {
                lines.push(this.formatLine(`${name}: ${type}`));
            });
            this.decreaseIndent();
        } else {
            lines.push(this.formatKeyValue("Parameters", "None"));
        }

        // 打印指令
        lines.push(this.formatKeyValue("Instructions", functionIR.instructions.length.toString()));
        if (functionIR.instructions.length > 0) {
            this.increaseIndent();
            functionIR.instructions.forEach((inst, index) => {
                lines.push(this.formatInstruction(inst, index));
            });
            this.decreaseIndent();
        }

        return lines;
    }

    /**
     * 打印IRFunction对象
     */
    public dumpIRFunction(irFunction: IRFunction): string {
        const lines: string[] = [];
        
        lines.push(this.formatHeader(`IRFunction: ${irFunction.getName()}`));
        
        // 打印参数
        const params = irFunction.getParameters();
        if (params.size > 0) {
            lines.push(this.formatSubHeader("Parameters:"));
            this.increaseIndent();
            for (const [name, param] of params.entries()) {
                lines.push(this.formatParameter(param));
            }
            this.decreaseIndent();
        } else {
            lines.push(this.formatKeyValue("Parameters", "None"));
        }

        // 打印真实参数
        const realArgs = irFunction.getRealArgs();
        if (realArgs.length > 0) {
            lines.push(this.formatSubHeader("Real Arguments:"));
            this.increaseIndent();
            realArgs.forEach((arg, index) => {
                lines.push(this.formatRealArg(arg, index));
            });
            this.decreaseIndent();
        }

        // 打印所有值
        const allValues = irFunction.getAllValues();
        if (allValues.size > 0) {
            lines.push(this.formatSubHeader("All Values:"));
            this.increaseIndent();
            for (const [name, value] of allValues.entries()) {
                lines.push(this.formatValue(value));
            }
            this.decreaseIndent();
        }

        // 打印指令
        const instructions = irFunction.getInstructions();
        if (instructions.length > 0) {
            lines.push(this.formatSubHeader("Instructions:"));
            this.increaseIndent();
            instructions.forEach((inst, index) => {
                lines.push(this.formatIRInstruction(inst, index));
            });
            this.decreaseIndent();
        }

        return lines.join('\n');
    }

    /**
     * 格式化指令（JSON格式）
     */
    private formatInstruction(inst: any, index: number): string {
        const prefix = this.formatLine(`[${index.toString().padStart(3, '0')}] `);
        
        switch (inst.type) {
            case 'Call':
                return this.formatCallInstruction(inst, prefix);
            case 'Ret':
                return this.formatRetInstruction(inst, prefix);
            case 'Phi':
                return this.formatPhiInstruction(inst, prefix);
            default:
                return `${prefix}${inst.type}: ${JSON.stringify(inst)}`;
        }
    }

    /**
     * 格式化调用指令 - 简洁格式
     * CALL 函数名 参数1, 参数2, 参数3 -> 返回位置:返回值, 返回位置:返回值
     */
    private formatCallInstruction(inst: any, prefix: string): string {
        const parts: string[] = [];
        
        // CALL 关键字和函数名
        parts.push(`CALL ${inst.target}`);
        
        // 参数列表
        const allOperands: string[] = [];
        if (inst.operands && inst.operands.length > 0) {
            allOperands.push(...inst.operands);
        }
        if (inst.argsoperands && inst.argsoperands.length > 0) {
            allOperands.push(...inst.argsoperands);
        }
        
        if (allOperands.length > 0) {
            parts.push(` ${allOperands.join(', ')}`);
        }
        
        // 返回值
        const rets = inst.rets || {};
        const retKeys = Object.keys(rets);
        if (retKeys.length > 0) {
            const retStrs = retKeys.map(key => `${key}:${rets[key]}`);
            parts.push(` -> ${retStrs.join(', ')}`);
        }
        
        return `${prefix}${parts.join('')}`;
    }

    /**
     * 格式化返回指令 - 简洁格式
     * RET 参数
     */
    private formatRetInstruction(inst: any, prefix: string): string {
        return `${prefix}RET ${inst.operand || 'void'}`;
    }

    /**
     * 格式化Phi指令 - 简洁格式
     * PHI 参数1, 参数2 -> 返回
     */
    private formatPhiInstruction(inst: any, prefix: string): string {
        const operands = inst.operands || [];
        return `${prefix}PHI ${operands.join(', ')} -> ${inst.ret}`;
    }

    /**
     * 格式化IR指令对象 - 使用简洁格式
     */
    private formatIRInstruction(inst: IRInstruction, index: number): string {
        const prefix = this.formatLine(`[${index.toString().padStart(3, '0')}] `);
        
        if (inst instanceof IRCallInstruction) {
            return this.formatIRCallInstruction(inst, prefix);
        } else if (inst instanceof IRReturnInstruction) {
            return this.formatIRReturnInstruction(inst, prefix);
        } else if (inst instanceof IRPhiInstruction) {
            return this.formatIRPhiInstruction(inst, prefix);
        } else {
            return `${prefix}${inst.getType()}: ${inst.toString()}`;
        }
    }

    /**
     * 格式化IR调用指令 - 简洁格式
     * CALL 函数名 参数1, 参数2 -> 返回位置:返回值, 返回位置:返回值
     */
    private formatIRCallInstruction(inst: IRCallInstruction, prefix: string): string {
        const parts: string[] = [];
        
        // CALL 关键字和函数名
        parts.push(`CALL ${inst.getTarget()}`);
        
        // 参数列表
        const allOperands: string[] = [];
        const operands = inst.getOperands();
        const argsOperands = inst.getArgsOperands();
        
        if (operands.length > 0) {
            allOperands.push(...operands.map(op => `${op.getName()}:${op.getType().toString()}`));
        }
        if (argsOperands.length > 0) {
            allOperands.push(...argsOperands.map(arg => `${arg.getName()}:${arg.getType().toString()}`));
        }
        
        if (allOperands.length > 0) {
            parts.push(` ${allOperands.join(', ')}`);
        }
        
        // 返回值
        const returnValues = inst.getReturnValues();
        if (returnValues.size > 0) {
            const retStrs: string[] = [];
            for (const [key, value] of returnValues.entries()) {
                retStrs.push(`${key}:${value.getName()}:${value.getType().toString()}`);
            }
            parts.push(` -> ${retStrs.join(', ')}`);
        }
        
        return `${prefix}${parts.join('')}`;
    }

    /**
     * 格式化IR返回指令 - 简洁格式
     * RET 参数
     */
    private formatIRReturnInstruction(inst: IRReturnInstruction, prefix: string): string {
        const operand = inst.getOperand();
        if (operand) {
            return `${prefix}RET ${operand.getName()}:${operand.getType().toString()}`;
        } else {
            return `${prefix}RET void`;
        }
    }

    /**
     * 格式化IR Phi指令 - 简洁格式
     * PHI 参数1, 参数2 -> 返回
     */
    private formatIRPhiInstruction(inst: IRPhiInstruction, prefix: string): string {
        const result = inst.getResult();
        const operands = inst.getOperands();
        const opStrs = operands.map(op => `${op.getName()}:${op.getType().toString()}`);
        return `${prefix}PHI ${opStrs.join(', ')} -> ${result.getName()}:${result.getType().toString()}`;
    }

    /**
     * 格式化参数
     */
    private formatParameter(param: IRParameter): string {
        return this.formatLine(`${param.getName()}: ${param.getParameterType()} (${param.getType().toString()})`);
    }

    /**
     * 格式化真实参数
     */
    private formatRealArg(arg: IRVariable, index: number): string {
        return this.formatLine(`[${index}] ${arg.getName()}: ${arg.getType().toString()}`);
    }

    /**
     * 格式化值
     */
    private formatValue(value: IRValue): string {
        const typeStr = value.getType().toString();
        const constantStr = value.isConstant() ? ' (constant)' : '';
        return this.formatLine(`${value.getName()}: ${typeStr}${constantStr}`);
    }

    /**
     * 格式化标题
     */
    private formatHeader(title: string): string {
        const separator = '='.repeat(Math.max(60, title.length + 4));
        return `${separator}\n  ${title}\n${separator}`;
    }

    /**
     * 格式化子标题
     */
    private formatSubHeader(title: string): string {
        return `\n${'-'.repeat(Math.max(40, title.length + 2))}\n${title}\n${'-'.repeat(Math.max(40, title.length + 2))}`;
    }

    /**
     * 格式化键值对
     */
    private formatKeyValue(key: string, value: string): string {
        return `${key.padEnd(20)}: ${value}`;
    }

    /**
     * 格式化行（带缩进）
     */
    private formatLine(content: string): string {
        return ' '.repeat(this.indentLevel * this.indentSize) + content;
    }

    /**
     * 增加缩进
     */
    private increaseIndent(): void {
        this.indentLevel++;
    }

    /**
     * 减少缩进
     */
    private decreaseIndent(): void {
        this.indentLevel = Math.max(0, this.indentLevel - 1);
    }

    /**
     * 打印到控制台
     */
    public printModule(moduleIR: ModuleIR): void {
        const output = this.dumpModule(moduleIR);
        console.log(output);
    }

    /**
     * 打印IRFunction到控制台
     */
    public printIRFunction(irFunction: IRFunction): void {
        const output = this.dumpIRFunction(irFunction);
        console.log(output);
    }

    /**
     * 保存到文件
     */
    public saveToFile(content: string, filename: string): void {
        // 这里可以实现文件保存功能
        // 由于没有fs模块，这里只是一个接口
        if (this.logger && typeof this.logger.info === 'function') {
            this.logger.info(`Would save SumIR dump to file: ${filename}`);
            this.logger.info(content);
        }
    }

    /**
     * 创建摘要统计
     */
    public createSummary(moduleIR: ModuleIR): string {
        const lines: string[] = [];
        
        lines.push(this.formatHeader("SumIR Summary"));
        lines.push(this.formatKeyValue("Module", moduleIR.module_name));
        lines.push(this.formatKeyValue("HAP", moduleIR.hap_name));
        lines.push(this.formatKeyValue("SO", moduleIR.so_name));
        lines.push(this.formatKeyValue("Functions", moduleIR.functions.length.toString()));
        
        // 统计指令数量
        let totalInstructions = 0;
        const instructionTypes: Map<string, number> = new Map();
        
        moduleIR.functions.forEach(func => {
            totalInstructions += func.instructions.length;
            func.instructions.forEach(inst => {
                const count = instructionTypes.get(inst.type) || 0;
                instructionTypes.set(inst.type, count + 1);
            });
        });
        
        lines.push(this.formatKeyValue("Total Instructions", totalInstructions.toString()));
        lines.push("");
        lines.push("Instruction Types:");
        this.increaseIndent();
        for (const [type, count] of instructionTypes.entries()) {
            lines.push(this.formatLine(`${type}: ${count}`));
        }
        this.decreaseIndent();
        
        return lines.join('\n');
    }

    /**
     * 比较两个模块的差异
     */
    public compareModules(module1: ModuleIR, module2: ModuleIR): string {
        const lines: string[] = [];
        
        lines.push(this.formatHeader("Module Comparison"));
        lines.push(this.formatKeyValue("Module 1", module1.module_name));
        lines.push(this.formatKeyValue("Module 2", module2.module_name));
        lines.push("");
        
        // 比较函数数量
        lines.push(this.formatKeyValue("Functions (M1)", module1.functions.length.toString()));
        lines.push(this.formatKeyValue("Functions (M2)", module2.functions.length.toString()));
        
        // 找出函数差异
        const func1Names = new Set(module1.functions.map(f => f.name));
        const func2Names = new Set(module2.functions.map(f => f.name));
        
        const onlyInM1 = [...func1Names].filter(name => !func2Names.has(name));
        const onlyInM2 = [...func2Names].filter(name => !func1Names.has(name));
        const common = [...func1Names].filter(name => func2Names.has(name));
        
        if (onlyInM1.length > 0) {
            lines.push("\nFunctions only in Module 1:");
            this.increaseIndent();
            onlyInM1.forEach(name => lines.push(this.formatLine(name)));
            this.decreaseIndent();
        }
        
        if (onlyInM2.length > 0) {
            lines.push("\nFunctions only in Module 2:");
            this.increaseIndent();
            onlyInM2.forEach(name => lines.push(this.formatLine(name)));
            this.decreaseIndent();
        }
        
        lines.push(`\nCommon functions: ${common.length}`);
        
        return lines.join('\n');
    }
}

/**
 * 便捷的静态方法
 */
export class SumIRUtils {
    /**
     * 快速打印模块
     */
    static printModule(moduleIR: ModuleIR): void {
        const dumper = new SumIRDumper();
        dumper.printModule(moduleIR);
    }

    /**
     * 快速打印IRFunction
     */
    static printIRFunction(irFunction: IRFunction): void {
        const dumper = new SumIRDumper();
        dumper.printIRFunction(irFunction);
    }

    /**
     * 快速创建摘要
     */
    static createSummary(moduleIR: ModuleIR): string {
        const dumper = new SumIRDumper();
        return dumper.createSummary(moduleIR);
    }

    /**
     * 快速比较模块
     */
    static compareModules(module1: ModuleIR, module2: ModuleIR): string {
        const dumper = new SumIRDumper();
        return dumper.compareModules(module1, module2);
    }
}
