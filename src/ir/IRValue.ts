import { Value } from '@ArkAnalyzer/src/core/base/Value';
import { Type, UnknownType, NumberType, StringType, AnyType } from '@ArkAnalyzer/src/core/base/Type';
import { NullConstant, NumberConstant, StringConstant } from '@ArkAnalyzer/src/core/base/Constant';

/**
 * 表示IR中的值的基类
 */
export abstract class IRValue {
    protected name: string;
    protected type: Type;
    protected arktsValue: Value | null = null;

    constructor(name: string, type: Type = UnknownType.getInstance()) {
        this.name = name;
        this.type = type;
    }

    public getName(): string {
        return this.name;
    }

    public getType(): Type {
        return this.type;
    }

    public setType(type: Type): void {
        this.type = type;
    }

    public setArktsValue(value: Value): void {
        this.arktsValue = value;
    }

    public getArktsValue(): Value | null {
        return this.arktsValue;
    }

    public abstract isConstant(): boolean;
    public abstract toString(): string;
}

/**
 * 表示IR中的变量
 */
export class IRVariable extends IRValue {
    constructor(name: string, type: Type = UnknownType.getInstance()) {
        super(name, type);
    }

    public isConstant(): boolean {
        return false;
    }

    public toString(): string {
        return this.name;
    }
}

/**
 * 表示IR中的函数参数
 */
export class IRParameter extends IRVariable {
    private parameterType: string;

    constructor(name: string, parameterType: string, type: Type = UnknownType.getInstance()) {
        super(name, type);
        this.parameterType = parameterType;
    }

    public getParameterType(): string {
        return this.parameterType;
    }
}

/**
 * 表示IR中的常量的基类
 */
export abstract class IRConstant extends IRValue {
    constructor(name: string, type: Type) {
        super(name, type);
    }

    public isConstant(): boolean {
        return true;
    }
}

/**
 * 表示数值常量
 */
export class IRNumberConstant extends IRConstant {
    private value: number;

    constructor(value: number) {
        super(`long ${value}`, NumberType.getInstance());
        this.value = value;
    }

    public getValue(): number {
        return this.value;
    }

    public toString(): string {
        return `long ${this.value}`;
    }

    public static fromString(str: string): IRNumberConstant | null {
        const match = str.match(/^long\s+(-?\d+)$/);
        if (match && match[1]) {
            return new IRNumberConstant(parseInt(match[1], 10));
        }
        return null;
    }
}

/**
 * 表示字符串常量
 */
export class IRStringConstant extends IRConstant {
    private value: string;

    constructor(value: string) {
        super(`char* "${value}"`, StringType.getInstance());
        this.value = value;
    }

    public getValue(): string {
        return this.value;
    }

    public toString(): string {
        return `char* "${this.value}"`;
    }

    public static fromString(str: string): IRStringConstant | null {
        const match = str.match(/^char\*\s*"(.*)"$/);
        if (match && match[1]) {
            return new IRStringConstant(match[1]);
        }
        return null;
    }
}

/**
 * 表示null常量
 */
export class IRNullConstant extends IRConstant {
    constructor() {
        super('null', UnknownType.getInstance()); // Null 类型用 UnknownType 表示
    }

    public toString(): string {
        return 'null';
    }
}

/**
 * 表示top常量（通常用于表示无关或未使用的值）
 */
export class IRTopConstant extends IRConstant {
    constructor() {
        super('top', AnyType.getInstance());
    }

    public toString(): string {
        return 'top';
    }
}

/**
 * IR值工厂，用于创建不同类型的IRValue对象
 */
export class IRValueFactory {
    private static valueCache: Map<string, IRValue> = new Map();

    public static clearCache(): void {
        this.valueCache.clear();
    }

    /**
     * 从字符串创建或获取 IRValue 对象
     * @param value 原始字符串值
     * @returns 对应的 IRValue 对象
     */
    public static createFromString(value: string): IRValue {
        // 如果缓存中已有该值，直接返回
        if (this.valueCache.has(value)) {
            return this.valueCache.get(value)!;
        }

        let irValue: IRValue;

        // 检查是否是常量
        if (value === 'null') {
            irValue = new IRNullConstant();
        } else if (value === 'top') {
            irValue = new IRTopConstant();
        } else if (value.startsWith('long')) {
            const numberConstant = IRNumberConstant.fromString(value);
            if (numberConstant) {
                irValue = numberConstant;
            } else {
                throw new Error(`Invalid number constant: ${value}`);
            }
        } else if (value.startsWith('char*')) {
            const stringConstant = IRStringConstant.fromString(value);
            if (stringConstant) {
                irValue = stringConstant;
            } else {
                throw new Error(`Invalid string constant: ${value}`);
            }
        } else {
            // 默认为变量
            irValue = new IRVariable(value);
        }

        // 将创建的 IRValue 存入缓存
        this.valueCache.set(value, irValue);
        return irValue;
    }

    /**
     * 创建函数参数
     * @param name 参数名
     * @param parameterType 参数类型
     * @param type 类型（可选）
     * @returns 参数对象
     */
    public static createParameter(name: string, parameterType: string, type?: Type): IRParameter {
        if (this.valueCache.has(name)) {
            return this.valueCache.get(name) as IRParameter;
        }

        const parameter = new IRParameter(name, parameterType, type);
        this.valueCache.set(name, parameter);
        return parameter;
    }

    /**
     * 创建变量
     * @param name 变量名
     * @param type 类型（可选）
     * @returns 变量对象
     */
    public static createVariable(name: string, type?: Type): IRVariable {
        if (this.valueCache.has(name)) {
            return this.valueCache.get(name) as IRVariable;
        }

        const variable = new IRVariable(name, type);
        this.valueCache.set(name, variable);
        return variable;
    }
}