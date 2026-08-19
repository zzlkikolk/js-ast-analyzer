import fs from "node:fs";
import path from "node:path";
import * as parser from "@babel/parser";
import traverseModule from "@babel/traverse";
import generateModule from "@babel/generator";

const traverse = traverseModule.default;
const generate = generateModule.default;

const options = parseArgs(process.argv.slice(2));

if (options.showHelp) {
    printHelp();
    process.exit(0);
}

if (!options.field) {
    console.error("缺少 --field 参数。");
    printHelp();
    process.exit(1);
}

const inputFile = path.resolve(options.inputFile || "./igamebuy-js/4306.js");
const code = readInputFile(inputFile);
const ast = parseSource(code, inputFile);

const functionInfosByNode = new Map();
const callsByBinding = new Map();
const sinks = [];

function parseArgs(args) {
    const result = {
        inputFile: null,
        field: null,
        functionName: null,
        maxDepth: 8,
        limit: 20,
        showHelp: false
    };

    for (let index = 0; index < args.length; index++) {
        const arg = args[index];

        if (arg === "--file") {
            result.inputFile = args[++index] || "";
            continue;
        }

        if (arg === "--field") {
            result.field = args[++index] || "";
            continue;
        }

        if (arg === "--function") {
            result.functionName = args[++index] || "";
            continue;
        }

        if (arg === "--depth") {
            result.maxDepth = Number(args[++index]) || result.maxDepth;
            continue;
        }

        if (arg === "--limit") {
            result.limit = Number(args[++index]) || result.limit;
            continue;
        }

        if (arg === "--help" || arg === "-h") {
            result.showHelp = true;
            continue;
        }

        console.error(`未知参数: ${arg}`);
        printHelp();
        process.exit(1);
    }

    return result;
}

function printHelp() {
    console.log(`用法:
  node field-source.js --file <文件> --field <字段名> [选项]

选项:
  --function <函数名>  只分析指定函数内的字段写入
  --depth <层数>       最大回溯层数，默认 8
  --limit <数量>       最多输出多少个字段写入，默认 20
  --help, -h           显示帮助

示例:
  node field-source.js --file roblox/Challenge.js --field sessionID --function tZ
  node field-source.js --file test/field-source-fixture.js --field sessionID`);
}

function readInputFile(filePath) {
    try {
        return fs.readFileSync(filePath, "utf8");
    } catch (error) {
        console.error(`无法读取 JavaScript 文件: ${filePath}`);
        console.error(error.message);
        process.exit(1);
    }
}

function parseSource(source, filePath) {
    try {
        return parser.parse(source, {
            sourceType: "unambiguous"
        });
    } catch (error) {
        console.error(`无法解析 JavaScript 文件: ${filePath}`);
        console.error(error.message);
        process.exit(1);
    }
}

function unwrapExpression(node) {
    if (!node) {
        return node;
    }

    if (node.type === "ParenthesizedExpression") {
        return unwrapExpression(node.expression);
    }

    if (node.type === "SequenceExpression") {
        return unwrapExpression(node.expressions[node.expressions.length - 1]);
    }

    return node;
}

function getStaticPropertyName(node) {
    if (!node || !node.property) {
        return null;
    }

    if (node.computed) {
        if (node.property.type === "StringLiteral" || node.property.type === "NumericLiteral") {
            return String(node.property.value);
        }

        return null;
    }

    return node.property.type === "Identifier" ? node.property.name : null;
}

function getKeyName(node) {
    if (!node) {
        return null;
    }

    if (node.type === "Identifier") {
        return node.name;
    }

    if (node.type === "StringLiteral" || node.type === "NumericLiteral") {
        return String(node.value);
    }

    return null;
}

function getLocation(node) {
    if (!node.loc) {
        return "?:?";
    }

    return `${node.loc.start.line}:${node.loc.start.column + 1}`;
}

function getSnippet(node, maxLength = 180) {
    const snippet = code.slice(node.start, node.end).replace(/\s+/g, " ");

    return snippet.length > maxLength
        ? `${snippet.slice(0, maxLength)}...`
        : snippet;
}

function getFunctionName(path) {
    const node = path.node;

    if (node.id?.name) {
        return node.id.name;
    }

    const parentPath = path.parentPath;

    if (!parentPath) {
        return "<anonymous>";
    }

    if (parentPath.isVariableDeclarator() && parentPath.node.id.type === "Identifier") {
        return parentPath.node.id.name;
    }

    if (parentPath.isAssignmentExpression()) {
        const left = unwrapExpression(parentPath.node.left);

        if (left.type === "Identifier") {
            return left.name;
        }

        if (left.type === "MemberExpression") {
            return getStaticPropertyName(left) || "<anonymous>";
        }
    }

    if (parentPath.isObjectProperty() || parentPath.isObjectMethod()) {
        return getKeyName(parentPath.node.key) || "<anonymous>";
    }

    return "<anonymous>";
}

function getFunctionBinding(path) {
    const node = path.node;

    if (path.isFunctionDeclaration() && node.id?.name) {
        return path.scope.getBinding(node.id.name);
    }

    if (
        path.parentPath?.isVariableDeclarator() &&
        path.parentPath.node.id.type === "Identifier"
    ) {
        return path.parentPath.scope.getBinding(path.parentPath.node.id.name);
    }

    if (
        path.parentPath?.isAssignmentExpression() &&
        path.parentPath.node.left.type === "Identifier"
    ) {
        return path.parentPath.scope.getBinding(path.parentPath.node.left.name);
    }

    return null;
}

function registerFunction(path) {
    if (functionInfosByNode.has(path.node)) {
        return;
    }

    functionInfosByNode.set(path.node, {
        name: getFunctionName(path),
        path,
        binding: getFunctionBinding(path)
    });
}

function getContainingFunctionInfo(path) {
    const functionPath = path.getFunctionParent();

    return functionPath ? functionInfosByNode.get(functionPath.node) || null : null;
}

function functionMatches(path) {
    if (!options.functionName) {
        return true;
    }

    return getContainingFunctionInfo(path)?.name === options.functionName;
}

function getDirectCalleeBinding(path) {
    const callee = unwrapExpression(path.node.callee);

    if (callee?.type !== "Identifier") {
        return null;
    }

    return path.scope.getBinding(callee.name);
}

function addCall(path) {
    const binding = getDirectCalleeBinding(path);

    if (!binding) {
        return;
    }

    if (!callsByBinding.has(binding)) {
        callsByBinding.set(binding, []);
    }

    callsByBinding.get(binding).push(path);
}

function addSink(kind, path, valuePath) {
    if (!functionMatches(path)) {
        return;
    }

    sinks.push({
        kind,
        path,
        valuePath,
        functionInfo: getContainingFunctionInfo(path)
    });
}

function collectSink(path) {
    const keyName = getKeyName(path.node.key);

    if (
        keyName === options.field &&
        path.parentPath?.isObjectExpression()
    ) {
        addSink("对象字段", path, path.get("value"));
    }
}

function collectAssignmentSink(path) {
    const left = unwrapExpression(path.node.left);

    if (
        left?.type !== "MemberExpression" &&
        left?.type !== "OptionalMemberExpression"
    ) {
        return;
    }

    if (getStaticPropertyName(left) !== options.field) {
        return;
    }

    addSink("属性赋值", path, path.get("right"));
}

function buildIndexes() {
    traverse(ast, {
        FunctionDeclaration: registerFunction,
        FunctionExpression: registerFunction,
        ArrowFunctionExpression: registerFunction
    });

    traverse(ast, {
        CallExpression: addCall,
        OptionalCallExpression: addCall,
        ObjectProperty: collectSink,
        AssignmentExpression: collectAssignmentSink
    });
}

function printTrace(level, message) {
    console.log(`${"  ".repeat(level)}- ${message}`);
}

function getNodeKey(node) {
    return `${node.type}:${node.start}:${node.end}`;
}

function getVariableInitPath(binding) {
    if (binding.path.isVariableDeclarator()) {
        return binding.path.get("init");
    }

    if (binding.path.parentPath?.isVariableDeclarator()) {
        return binding.path.parentPath.get("init");
    }

    return null;
}

function getFunctionPathForBinding(binding) {
    return binding.path.findParent(parentPath => parentPath.isFunction()) || null;
}

function getParameterIndex(binding, functionPath) {
    let parameterPath = binding.path;

    while (parameterPath.parentPath && parameterPath.parentPath !== functionPath) {
        parameterPath = parameterPath.parentPath;
    }

    return functionPath.node.params.indexOf(parameterPath.node);
}

function traceParameter(binding, level, state) {
    const functionPath = getFunctionPathForBinding(binding);
    const functionInfo = functionPath
        ? functionInfosByNode.get(functionPath.node)
        : null;
    const parameterIndex = functionPath
        ? getParameterIndex(binding, functionPath)
        : -1;
    const functionName = functionInfo?.name || "<anonymous>";

    printTrace(
        level,
        `参数 ${binding.identifier.name}，属于 ${functionName}`
    );

    if (!functionInfo?.binding || parameterIndex < 0) {
        printTrace(level + 1, "无法解析该参数所属函数的直接调用。");
        return;
    }

    const calls = callsByBinding.get(functionInfo.binding) || [];

    if (!calls.length) {
        printTrace(
            level + 1,
            "未找到直接调用；该参数可能经由成员访问、模块导出或框架状态传入。"
        );
        return;
    }

    for (const callPath of calls.slice(0, 8)) {
        const argumentPath = callPath.get("arguments")[parameterIndex];

        if (!argumentPath?.node) {
            printTrace(
                level + 1,
                `调用 ${functionName} 没有第 ${parameterIndex + 1} 个实参。`
            );
            continue;
        }

        printTrace(
            level + 1,
            `调用 ${functionName} 的第 ${parameterIndex + 1} 个参数: ${getSnippet(argumentPath.node)}`
        );
        traceExpression(argumentPath, level + 2, state);
    }
}

function traceParameterProperty(binding, propertyName, level, state) {
    const functionPath = getFunctionPathForBinding(binding);
    const functionInfo = functionPath
        ? functionInfosByNode.get(functionPath.node)
        : null;
    const parameterIndex = functionPath
        ? getParameterIndex(binding, functionPath)
        : -1;
    const functionName = functionInfo?.name || "<anonymous>";

    printTrace(
        level,
        `属性 ${propertyName} 读取自参数 ${binding.identifier.name}，属于 ${functionName}`
    );

    if (!functionInfo?.binding || parameterIndex < 0) {
        printTrace(level + 1, "无法解析该参数所属函数的直接调用。");
        return;
    }

    const calls = callsByBinding.get(functionInfo.binding) || [];

    if (!calls.length) {
        printTrace(
            level + 1,
            "未找到直接调用；该参数可能经由成员访问、模块导出或框架状态传入。"
        );
        return;
    }

    for (const callPath of calls.slice(0, 8)) {
        const argumentPath = callPath.get("arguments")[parameterIndex];

        if (!argumentPath?.node) {
            continue;
        }

        printTrace(
            level + 1,
            `调用 ${functionName} 的第 ${parameterIndex + 1} 个参数: ${getSnippet(argumentPath.node)}`
        );
        tracePropertyFromExpression(
            argumentPath,
            propertyName,
            level + 2,
            state
        );
    }
}

function traceBinding(binding, level, state) {
    const bindingKey = `${binding.identifier.name}:${binding.scope.uid}`;

    if (state.bindings.has(bindingKey)) {
        printTrace(level, `已回到变量 ${binding.identifier.name}，停止循环追踪。`);
        return;
    }

    state.bindings.add(bindingKey);

    try {
        if (binding.kind === "param") {
            traceParameter(binding, level, state);
            return;
        }

        const initPath = getVariableInitPath(binding);

        if (initPath?.node) {
            printTrace(
                level,
                `变量 ${binding.identifier.name} 的初始化: ${getSnippet(initPath.node)}`
            );
            traceExpression(initPath, level + 1, state);
        }

        const assignments = binding.constantViolations.filter(violation =>
            violation.isAssignmentExpression() &&
            violation.node.operator === "="
        );

        for (const assignmentPath of assignments.slice(0, 8)) {
            const rightPath = assignmentPath.get("right");

            printTrace(
                level,
                `变量 ${binding.identifier.name} 的后续赋值: ${getSnippet(rightPath.node)}`
            );
            traceExpression(rightPath, level + 1, state);
        }

        if (!initPath?.node && !assignments.length) {
            printTrace(
                level,
                `变量 ${binding.identifier.name} 没有可静态解析的初始化来源。`
            );
        }
    } finally {
        state.bindings.delete(bindingKey);
    }
}

function tracePropertyFromObjectExpression(path, propertyName, level, state) {
    const properties = path.get("properties");
    let found = false;

    for (const propertyPath of properties) {
        if (propertyPath.isObjectProperty()) {
            if (getKeyName(propertyPath.node.key) !== propertyName) {
                continue;
            }

            found = true;
            const valuePath = propertyPath.get("value");

            printTrace(
                level,
                `对象字段 ${propertyName}: ${getSnippet(valuePath.node)}`
            );
            traceExpression(valuePath, level + 1, state);
            continue;
        }

        if (propertyPath.isSpreadElement()) {
            found = true;
            const argumentPath = propertyPath.get("argument");

            printTrace(
                level,
                `对象展开可能提供字段 ${propertyName}: ${getSnippet(argumentPath.node)}`
            );
            tracePropertyFromExpression(
                argumentPath,
                propertyName,
                level + 1,
                state
            );
        }
    }

    if (!found) {
        printTrace(
            level,
            `对象字面量中未找到字段 ${propertyName} 的静态定义。`
        );
    }
}

function isNamedCall(node, objectName, propertyName) {
    const callee = unwrapExpression(node.callee);

    return (
        callee?.type === "MemberExpression" &&
        callee.object.type === "Identifier" &&
        callee.object.name === objectName &&
        getStaticPropertyName(callee) === propertyName
    );
}

function isTransparentCall(node) {
    const callee = unwrapExpression(node.callee);

    if (callee?.type === "Identifier") {
        return ["atob", "decodeURIComponent", "String", "Number"].includes(callee.name);
    }

    return isNamedCall(node, "JSON", "parse");
}

function tracePropertyFromExpression(path, propertyName, level, state) {
    if (!path?.node) {
        printTrace(level, `字段 ${propertyName} 的对象来源为空。`);
        return;
    }

    if (state.depth <= 0) {
        printTrace(level, "达到最大回溯深度。");
        return;
    }

    const node = unwrapExpression(path.node);
    const nodeKey = getNodeKey(node);

    if (state.nodes.has(nodeKey)) {
        printTrace(level, "已回到相同表达式，停止循环追踪。");
        return;
    }

    state.nodes.add(nodeKey);
    state.depth -= 1;

    try {
        if (node.type === "ObjectExpression") {
            tracePropertyFromObjectExpression(path, propertyName, level, state);
            return;
        }

        if (node.type === "Identifier") {
            const binding = path.scope.getBinding(node.name);

            if (!binding) {
                printTrace(
                    level,
                    `对象 ${node.name} 是全局或外部值，无法继续静态追踪字段 ${propertyName}。`
                );
                return;
            }

            if (binding.kind === "param") {
                traceParameterProperty(binding, propertyName, level, state);
                return;
            }

            const initPath = getVariableInitPath(binding);

            if (initPath?.node) {
                printTrace(
                    level,
                    `对象变量 ${node.name} 的初始化: ${getSnippet(initPath.node)}`
                );
                tracePropertyFromExpression(
                    initPath,
                    propertyName,
                    level + 1,
                    state
                );
                return;
            }

            printTrace(
                level,
                `对象变量 ${node.name} 没有可静态解析的初始化来源。`
            );
            return;
        }

        if (node.type === "CallExpression" || node.type === "OptionalCallExpression") {
            if (isNamedCall(node, "JSON", "parse")) {
                const inputPath = path.get("arguments")[0];

                printTrace(
                    level,
                    `字段 ${propertyName} 来自 JSON.parse 的运行时结果。`
                );
                if (inputPath?.node) {
                    traceExpression(inputPath, level + 1, state);
                }
                return;
            }

            if (isTransparentCall(node)) {
                const inputPath = path.get("arguments")[0];

                printTrace(
                    level,
                    `字段 ${propertyName} 经过 ${getSnippet(node.callee)} 转换。`
                );
                if (inputPath?.node) {
                    tracePropertyFromExpression(
                        inputPath,
                        propertyName,
                        level + 1,
                        state
                    );
                }
                return;
            }

            printTrace(
                level,
                `字段 ${propertyName} 来自调用结果: ${getSnippet(node)}`
            );
            return;
        }

        if (node.type === "MemberExpression" || node.type === "OptionalMemberExpression") {
            const nestedProperty = getStaticPropertyName(node);
            const objectPath = path.get("object");

            if (nestedProperty) {
                printTrace(
                    level,
                    `先读取属性 ${nestedProperty}: ${getSnippet(node)}`
                );
                tracePropertyFromExpression(
                    objectPath,
                    nestedProperty,
                    level + 1,
                    state
                );
                return;
            }
        }

        printTrace(
            level,
            `无法从 ${node.type} 静态解析字段 ${propertyName}。`
        );
    } finally {
        state.depth += 1;
        state.nodes.delete(nodeKey);
    }
}

function traceExpression(path, level, state) {
    if (!path?.node) {
        printTrace(level, "表达式为空。");
        return;
    }

    if (state.depth <= 0) {
        printTrace(level, "达到最大回溯深度。");
        return;
    }

    const node = unwrapExpression(path.node);
    const nodeKey = getNodeKey(node);

    if (state.nodes.has(nodeKey)) {
        printTrace(level, "已回到相同表达式，停止循环追踪。");
        return;
    }

    state.nodes.add(nodeKey);
    state.depth -= 1;

    try {
        if (node.type === "Identifier") {
            const binding = path.scope.getBinding(node.name);

            if (!binding) {
                printTrace(level, `全局或外部值: ${node.name}`);
                return;
            }

            traceBinding(binding, level, state);
            return;
        }

        if (node.type === "MemberExpression" || node.type === "OptionalMemberExpression") {
            const propertyName = getStaticPropertyName(node);

            if (!propertyName) {
                printTrace(
                    level,
                    `动态属性读取，无法确定字段名: ${getSnippet(node)}`
                );
                return;
            }

            printTrace(level, `读取属性: ${getSnippet(node)}`);
            tracePropertyFromExpression(
                path.get("object"),
                propertyName,
                level + 1,
                state
            );
            return;
        }

        if (node.type === "CallExpression" || node.type === "OptionalCallExpression") {
            const inputPath = path.get("arguments")[0];

            if (isNamedCall(node, "JSON", "parse")) {
                printTrace(level, "JSON.parse 输入:");
                if (inputPath?.node) {
                    traceExpression(inputPath, level + 1, state);
                }
                return;
            }

            if (isTransparentCall(node)) {
                printTrace(level, `经过 ${getSnippet(node.callee)} 转换:`);
                if (inputPath?.node) {
                    traceExpression(inputPath, level + 1, state);
                }
                return;
            }

            printTrace(level, `调用返回值: ${getSnippet(node)}`);
            return;
        }

        if (node.type === "AssignmentExpression") {
            printTrace(level, `赋值右侧: ${getSnippet(node.right)}`);
            traceExpression(path.get("right"), level + 1, state);
            return;
        }

        if (node.type === "AwaitExpression") {
            printTrace(level, "await 的结果:");
            traceExpression(path.get("argument"), level + 1, state);
            return;
        }

        if (node.type === "ConditionalExpression") {
            printTrace(level, "条件表达式的 true 分支:");
            traceExpression(path.get("consequent"), level + 1, state);
            printTrace(level, "条件表达式的 false 分支:");
            traceExpression(path.get("alternate"), level + 1, state);
            return;
        }

        if (node.type === "LogicalExpression") {
            printTrace(level, `逻辑表达式左侧 (${node.operator}):`);
            traceExpression(path.get("left"), level + 1, state);
            printTrace(level, `逻辑表达式右侧 (${node.operator}):`);
            traceExpression(path.get("right"), level + 1, state);
            return;
        }

        if (node.type === "ObjectExpression") {
            printTrace(level, `对象字面量: ${getSnippet(node)}`);
            return;
        }

        if (
            node.type === "StringLiteral" ||
            node.type === "NumericLiteral" ||
            node.type === "BooleanLiteral" ||
            node.type === "NullLiteral" ||
            node.type === "BigIntLiteral"
        ) {
            printTrace(level, `字面量: ${getSnippet(node)}`);
            return;
        }

        if (node.type === "TemplateLiteral") {
            printTrace(level, `模板字符串: ${getSnippet(node)}`);

            for (const expressionPath of path.get("expressions")) {
                traceExpression(expressionPath, level + 1, state);
            }

            return;
        }

        printTrace(level, `未处理的表达式: ${node.type} (${getSnippet(node)})`);
    } finally {
        state.depth += 1;
        state.nodes.delete(nodeKey);
    }
}

function report() {
    buildIndexes();

    console.log(`字段来源查询: ${options.field}`);
    console.log(`分析文件: ${inputFile}`);

    if (options.functionName) {
        console.log(`函数范围: ${options.functionName}`);
    }

    if (!sinks.length) {
        console.log("未找到匹配的字段写入。");
        return;
    }

    for (const [index, sink] of sinks.slice(0, options.limit).entries()) {
        const functionText = sink.functionInfo
            ? `${sink.functionInfo.name} (${getLocation(sink.functionInfo.path.node)})`
            : "<top-level>";

        console.log("");
        console.log(
            `${index + 1}. ${sink.kind} (${getLocation(sink.path.node)})`
        );
        console.log(`  所在函数: ${functionText}`);
        console.log(`  字段写入: ${getSnippet(sink.path.node)}`);
        console.log(`  字段值: ${getSnippet(sink.valuePath.node)}`);
        console.log("  来源:");

        traceExpression(sink.valuePath, 2, {
            depth: options.maxDepth,
            nodes: new Set(),
            bindings: new Set()
        });
    }

    if (sinks.length > options.limit) {
        console.log("");
        console.log(
            `其余 ${sinks.length - options.limit} 个匹配结果因 --limit ${options.limit} 未显示。`
        );
    }
}

report();
