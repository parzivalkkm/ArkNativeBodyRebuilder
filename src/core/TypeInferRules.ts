import { ValueType } from '../ir/ValueType';

// 定义 CallInst 的类型推导规则
export const CallInstTypeRules: { [target: string]:{ [ruleType: string]: { [retValue: string]: ValueType }} } = {
    "napi_create_double": {
        "operands": {
            "1": ValueType.Number,
        },
        "rets": {
            "2": ValueType.Number,
        },
    },
    "napi_create_int64": {
        "operands": {
            "1": ValueType.Number,
        },
        "rets": {
            "2": ValueType.Number,
        },
    },
    "napi_create_int32": {
        "operands": {
            "1": ValueType.Number,
        },
        "rets": {
            "2": ValueType.Number,
        },
    },
    "napi_create_uint32": {
        "operands": {
            "1": ValueType.Number,
        },
        "rets": {
            "2": ValueType.Number,
        },
    },
    "napi_create_bigint_int64": {
        "operands": {
            "1": ValueType.BigInt,
        },
        "rets": {
            "2": ValueType.BigInt,
        },
    },
    "napi_create_bigint_uint64": {
        "operands": {
            "1": ValueType.BigInt,
        },
        "rets": {
            "2": ValueType.BigInt,
        },
    },
    "napi_get_value_bool": {
        "operands": {
            "1": ValueType.Boolean,
        },
        "rets": {
            "2": ValueType.Boolean,
        },
    },
    "napi_get_value_double": {
        "operands": {
            "1": ValueType.Number,
        },
        "rets": {
            "2": ValueType.Number,
        },
    },
    "napi_get_value_int64": {
        "operands": {
            "1": ValueType.Number,
        },
        "rets": {
            "2": ValueType.Number,
        },
    },
    "napi_get_value_int32": {
        "operands": {
            "1": ValueType.Number,
        },
        "rets": {
            "2": ValueType.Number,
        },
    },
    "napi_get_value_uint32": {
        "operands": {
            "1": ValueType.Number,
        },
        "rets": {
            "2": ValueType.Number,
        },
    },
    "napi_get_value_bigint_int64": {
        "operands": {
            "1": ValueType.BigInt,
        },
        "rets": {
            "2": ValueType.BigInt,
        },
    },
    "napi_get_value_bigint_uint64": {
        "operands": {
            "1": ValueType.BigInt,
        },
        "rets": {
            "2": ValueType.BigInt,
        },
    },
    "napi_get_prototype": {
        "operands": {
            "1": ValueType.Object,
        },
        "rets": {
            "2": ValueType.Object,
        },
    },
    "napi_create_object": {
        "operands": {
            "1": ValueType.Object,
        },
        "rets": {
            "2": ValueType.Object,
        },
    },
    "napi_get_property_names": {
        "operands": {
            "1": ValueType.Object,
        },
        "rets": {
            "2": ValueType.Array,
        },
    },
    "napi_set_property": {
        "operands": {
            "1": ValueType.Object,
            "2": ValueType.String,
            "3": ValueType.Any, // TODO: AnyType
        },
    },
    "napi_has_property": {
        "operands": {
            "1": ValueType.Object,
            "2": ValueType.String,
        },
        "rets": {
            "3": ValueType.Boolean,
        },
    },
    "napi_get_property": {
        "operands": {
            "1": ValueType.Object,
            "2": ValueType.String,
        },
        "rets": {
            "3": ValueType.Any, // TODO: AnyType
        },
    },
    "napi_delete_property": {
        "operands": {
            "1": ValueType.Object,
            "2": ValueType.String,
        },
        "rets": {
            "3": ValueType.Boolean,
        },
    },
    "napi_has_own_property": {
        "operands": {
            "1": ValueType.Object,
            "2": ValueType.String,
        },
        "rets": {
            "3": ValueType.Boolean,
        },
    },
    "napi_set_named_property": {
        "operands": {
            "1": ValueType.Object,
            "2": ValueType.String,
            "3": ValueType.Any, // TODO: AnyType
        },
    },
    "napi_has_named_property": {
        "operands": {
            "1": ValueType.Object,
            "2": ValueType.String,
        },
        "rets": {
            "3": ValueType.Boolean,
        },
    },
    "napi_get_named_property": {
        "operands": {
            "1": ValueType.Object,
            "2": ValueType.String,
        },
        "rets": {
            "3": ValueType.Any, // TODO: AnyType
        },
    },
    "napi_get_all_property_names": {
        "operands": {
            "1": ValueType.Object,
        },
        "rets": {
            "5": ValueType.Array,
        },
    },
    "napi_create_string_utf8": {
        "operands": {
            "1": ValueType.String,
        },
        "rets": {
            "3": ValueType.String,
        },
    },
    "napi_create_string_utf16": {
        "operands": {
            "1": ValueType.String,
        },
        "rets": {
            "3": ValueType.String,
        },
    },
    "napi_create_string_latin1": {
        "operands": {
            "1": ValueType.String,
        },
        "rets": {
            "3": ValueType.String,
        },
    },
    "napi_get_value_string_utf8": {
        "operands": {
            "1": ValueType.String,
            "2": ValueType.String,
            "3": ValueType.Number,
            "4": ValueType.Number,
        },
        "rets": {
            "2": ValueType.String,
            "4": ValueType.Number,
        },
    },
    "napi_get_value_string_utf16": {
        "operands": {
            "1": ValueType.String,
            "2": ValueType.String,
            "3": ValueType.Number,
            "4": ValueType.Number,
        },
        "rets": {
            "2": ValueType.String,
            "4": ValueType.Number,
        },
    },
    "napi_get_value_string_latin1": {
        "operands": {
            "1": ValueType.String,
            "2": ValueType.String,
            "3": ValueType.Number,
            "4": ValueType.Number,
        },
        "rets": {
            "2": ValueType.String,
            "4": ValueType.Number,
        },
    },
    "napi_coerce_to_bool": {
        "operands": {
            "1": ValueType.Any, // TODO: AnyType
        },
        "rets": {
            "2": ValueType.Boolean,
        },
    },
    "napi_coerce_to_number": {
        "operands": {
            "1": ValueType.Any, // TODO: AnyType
        },
        "rets": {
            "2": ValueType.Number,
        },
    },
    "napi_coerce_to_object": {
        "operands": {
            "1": ValueType.Any, // TODO: AnyType
        },
        "rets": {
            "2": ValueType.Object,
        },
    },
    "napi_coerce_to_string": {
        "operands": {
            "1": ValueType.Any, // TODO: AnyType
        },
        "rets": {
            "2": ValueType.String,
        },
    },
    "napi_get_undefined": {
        "rets": {
            "1": ValueType.Undefined,
        },
    },
    "napi_get_null": {
        "rets": {
            "1": ValueType.Null,
        },
    },
    "napi_get_global": {
        "rets": {
            "1": ValueType.Global, // TODO
        },
    },
    "napi_get_boolean": {
        "rets": {
            "2": ValueType.Boolean,
        },
    },
    "napi_create_array": {
        "rets": {
            "2": ValueType.Array,
        },
    },
    "napi_create_array_with_length": {
        "operands": {
            "1": ValueType.Number,
        },
        "rets": {
            "2": ValueType.Array,
        },
    },
    "napi_is_array" : {
        "operands": {
            "1": ValueType.Array,
        },
        "rets": {
            "2": ValueType.Boolean,
        },
    },
    "napi_get_array_length" : {
        "operands": {
            "1": ValueType.Array,
        },
        "rets": {
            "2": ValueType.Number,
        },
    },
    "napi_set_element" : {
        "operands": {
            "1": ValueType.Array,
            "2": ValueType.Number,
            "3": ValueType.Any, // TODO: AnyType
        },
    },
    "napi_get_element" : {
        "operands": {
            "1": ValueType.Array,
            "2": ValueType.Number,
        },
        "rets": {
            "3": ValueType.Any, // TODO: AnyType
        },
    },
    "napi_has_element" : {
        "operands": {
            "1": ValueType.Array,
            "2": ValueType.Number,
        },
        "rets": {
            "3": ValueType.Boolean,
        },
    },
    "napi_delete_element" : {
        "operands": {
            "1": ValueType.Array,
            "2": ValueType.Number,
        },
        "rets": {
            "3": ValueType.Boolean,
        },
    },
    "operator.new[]" : {
        "operands": {
            "0": ValueType.Number,
        },
        "rets": {
            "-1": ValueType.String,
        },
    },
    "malloc" : {
        "operands": {
            "0": ValueType.Number,
        },
        "rets": {
            "-1": ValueType.String,
        },
    },
    "operator.new" : {
        "operands": {
            "0": ValueType.Number,
        },
        "rets": {
            "-1": ValueType.String,
        },
    },
    "xmalloc" : {
        "operands": {
            "0": ValueType.Number,
        },
        "rets": {
            "-1": ValueType.String,
        },
    },
    


};
