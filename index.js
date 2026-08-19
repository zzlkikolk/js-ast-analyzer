import fs from "node:fs";
import path from "node:path";
import * as parser from "@babel/parser";
import traverseModule from "@babel/traverse";

const traverse = traverseModule.default;

const options = parseArgs(process.argv.slice(2));
const inputFile = path.resolve(options.inputFile || "./igamebuy-js/4306.js");
const code = readInputFile(inputFile);

// JS -> AST
const ast = parseSource(code, inputFile);

const functionInfosByNode = new Map();
const functionInfosByName = new Map();
const functionInfosByBinding = new Map();
const moduleIdsByNode = new Map();
const moduleImports = new Map();
const moduleExports = new Map();
const reverseCallEdges = new Map();
const requestHits = [];
const referencesByName = new Map();
let functionId = 0;

/**
 * 将可静态识别的被调用表达式规范化为名称。
 *
 * decrypt(data)       -> decrypt
 * api.send(data)      -> api.send
 * api["send"](data)  -> api.send
 * this.request(url)   -> this.request
 *
 * api[method](data) 无法在语法层面确定 method 的值，因此返回 null。
 */
function getCalleeName(node) {
    node = unwrapExpression(node);

    if (node.type === "Identifier") {
        return node.name;
    }

    if (node.type === "ThisExpression") {
        return "this";
    }

    if (
        node.type === "MemberExpression" ||
        node.type === "OptionalMemberExpression"
    ) {
        const objectName = getCalleeName(node.object);

        if (!objectName) {
            return null;
        }

        if (node.computed) {
            // 仅将 obj["method"] 视为可静态确定的属性访问。
            if (node.property.type !== "StringLiteral") {
                return null;
            }

            return `${objectName}.${node.property.value}`;
        }

        if (node.property.type !== "Identifier") {
            return null;
        }

        return `${objectName}.${node.property.name}`;
    }

    return null;
}

function parseArgs(args) {
    const result = {
        targetCallees: new Set(),
        targetUrl: null,
        chainTarget: null,
        inputFile: null,
        maxDepth: 6
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (arg === "--url") {
            result.targetUrl = args[++i] || "";
            continue;
        }

        if (arg === "--chain") {
            result.chainTarget = args[++i] || "";
            continue;
        }

        if (arg === "--depth") {
            result.maxDepth = Number(args[++i]) || result.maxDepth;
            continue;
        }

        if (arg === "--file") {
            result.inputFile = args[++i] || "";
            continue;
        }

        result.targetCallees.add(arg);
    }

    return result;
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

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripLeadingSlash(value) {
    return value.replace(/^\/+/, "");
}

function urlSourceMatches(source, targetUrl) {
    const url = stripLeadingSlash(targetUrl);

    if (!url) {
        return false;
    }

    // 避免 article_game/role 误命中 article_game/role_list。
    return new RegExp(`${escapeRegExp(url)}(?=$|[^A-Za-z0-9_])`).test(source);
}

function unwrapExpression(node) {
    if (!node) {
        return node;
    }

    if (node.type === "SequenceExpression") {
        return unwrapExpression(node.expressions[node.expressions.length - 1]);
    }

    if (node.type === "ParenthesizedExpression") {
        return unwrapExpression(node.expression);
    }

    return node;
}

function getStaticPropertyName(node) {
    if (!node || !node.property) {
        return null;
    }

    if (node.computed) {
        return node.property.type === "StringLiteral" ? node.property.value : null;
    }

    return node.property.type === "Identifier" ? node.property.name : null;
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

function addToMapList(map, key, value) {
    if (!map.has(key)) {
        map.set(key, []);
    }

    map.get(key).push(value);
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

function isWebpackModulePath(path) {
    if (!path.isObjectMethod()) {
        return false;
    }

    return path.node.key.type === "NumericLiteral" && path.node.params.length >= 3;
}

function getFunctionName(path) {
    const node = path.node;

    if (node.id?.name) {
        return node.id.name;
    }

    if (path.isObjectMethod()) {
        return getKeyName(node.key) || "<anonymous>";
    }

    const parentPath = path.parentPath;

    if (!parentPath) {
        return "<anonymous>";
    }

    if (parentPath.isVariableDeclarator() && parentPath.node.id.type === "Identifier") {
        return parentPath.node.id.name;
    }

    if (parentPath.isObjectProperty() || parentPath.isObjectMethod()) {
        return getKeyName(parentPath.node.key) || "<anonymous>";
    }

    if (parentPath.isAssignmentExpression()) {
        return getCalleeName(parentPath.node.left) || "<anonymous>";
    }

    if (parentPath.isArrayExpression()) {
        const elements = parentPath.node.elements;
        const index = elements.indexOf(node);

        if (index > 0) {
            const label = elements[index - 1];

            if (label?.type === "StringLiteral") {
                return label.value;
            }
        }
    }

    return "<anonymous>";
}

function formatFunction(info) {
    if (!info) {
        return "<top-level>";
    }

    const moduleText = info.moduleId ? `, module ${info.moduleId}` : "";

    return `${info.name} (${info.location}${moduleText})`;
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

    return null;
}

function findModuleId(path) {
    const modulePath = path.findParent(parentPath =>
        moduleIdsByNode.has(parentPath.node)
    );

    return modulePath ? moduleIdsByNode.get(modulePath.node) : null;
}

function registerFunction(path) {
    if (functionInfosByNode.has(path.node)) {
        return;
    }

    const name = isWebpackModulePath(path)
        ? `module ${getKeyName(path.node.key)}`
        : getFunctionName(path);
    const moduleId = isWebpackModulePath(path)
        ? getKeyName(path.node.key)
        : findModuleId(path);
    const info = {
        id: ++functionId,
        name,
        moduleId,
        node: path.node,
        path,
        location: getLocation(path.node)
    };

    functionInfosByNode.set(path.node, info);
    addToMapList(functionInfosByName, name, info);

    const binding = getFunctionBinding(path);

    if (binding) {
        functionInfosByBinding.set(binding, info);
    }
}

function getContainingFunctionInfo(path) {
    const functionPath = path.getFunctionParent();

    return functionPath ? functionInfosByNode.get(functionPath.node) : null;
}

function getContainingNamedFunctionInfo(path) {
    let currentPath = path;

    while (currentPath) {
        const functionPath = currentPath.getFunctionParent();

        if (!functionPath) {
            return null;
        }

        const info = functionInfosByNode.get(functionPath.node);

        if (info && info.name !== "<anonymous>" && !info.name.startsWith("module ")) {
            return info;
        }

        currentPath = functionPath.parentPath;
    }

    return null;
}

function parseModuleImport(path) {
    const node = path.node;

    if (
        node.id.type !== "Identifier" ||
        node.init?.type !== "CallExpression" ||
        node.init.callee.type !== "Identifier" ||
        node.init.callee.name !== "i" ||
        node.init.arguments[0]?.type !== "NumericLiteral"
    ) {
        return;
    }

    const moduleId = findModuleId(path);

    if (!moduleId) {
        return;
    }

    if (!moduleImports.has(moduleId)) {
        moduleImports.set(moduleId, new Map());
    }

    moduleImports.get(moduleId).set(node.id.name, String(node.init.arguments[0].value));
}

function parseModuleExport(path) {
    const node = path.node;

    if (
        node.callee.type !== "MemberExpression" ||
        node.callee.object.type !== "Identifier" ||
        node.callee.object.name !== "i" ||
        getStaticPropertyName(node.callee) !== "d" ||
        node.arguments[1]?.type !== "ObjectExpression"
    ) {
        return;
    }

    const moduleId = findModuleId(path);

    if (!moduleId) {
        return;
    }

    if (!moduleExports.has(moduleId)) {
        moduleExports.set(moduleId, new Map());
    }

    for (const property of node.arguments[1].properties) {
        if (property.type !== "ObjectProperty") {
            continue;
        }

        const exportName = getKeyName(property.key);
        const body = property.value.body;

        if (
            !exportName ||
            property.value.type !== "ArrowFunctionExpression" ||
            body.type !== "Identifier"
        ) {
            continue;
        }

        const binding = path.scope.getBinding(body.name);
        const info = binding ? functionInfosByBinding.get(binding) : null;

        if (info) {
            moduleExports.get(moduleId).set(exportName, info);
        }
    }
}

function resolveWebpackExport(path, memberNode) {
    if (memberNode.object.type !== "Identifier") {
        return null;
    }

    const moduleId = findModuleId(path);
    const imports = moduleId ? moduleImports.get(moduleId) : null;
    const importedModuleId = imports?.get(memberNode.object.name);
    const exportName = getStaticPropertyName(memberNode);

    if (!importedModuleId || !exportName) {
        return null;
    }

    return moduleExports.get(importedModuleId)?.get(exportName) || null;
}

function resolveCalleeFunction(path) {
    const callee = unwrapExpression(path.node.callee);

    if (callee.type === "Identifier") {
        const binding = path.scope.getBinding(callee.name);

        return binding ? functionInfosByBinding.get(binding) : null;
    }

    if (
        callee.type === "MemberExpression" ||
        callee.type === "OptionalMemberExpression"
    ) {
        return resolveWebpackExport(path, callee);
    }

    return null;
}

function addReverseEdge(calleeInfo, callerInfo, callNode) {
    if (!calleeInfo || !callerInfo || calleeInfo.id === callerInfo.id) {
        return;
    }

    if (!reverseCallEdges.has(calleeInfo.id)) {
        reverseCallEdges.set(calleeInfo.id, []);
    }

    reverseCallEdges.get(calleeInfo.id).push({
        caller: callerInfo,
        callNode
    });
}

function isNetworkCallee(name) {
    return [
        "Server.get",
        "Server.post",
        "Server.postJSON",
        "Site.http.get",
        "Site.http.post"
    ].includes(name);
}

function recordCall(path) {
    const callerInfo = getContainingFunctionInfo(path);
    const calleeInfo = resolveCalleeFunction(path);

    addReverseEdge(calleeInfo, callerInfo, path.node);

    const calleeName = getCalleeName(path.node.callee);
    const firstArg = path.node.arguments[0];

    if (!firstArg || !options.targetUrl || !calleeName || !isNetworkCallee(calleeName)) {
        return;
    }

    const urlSource = code.slice(firstArg.start, firstArg.end);

    if (!urlSourceMatches(urlSource, options.targetUrl)) {
        return;
    }

    requestHits.push({
        calleeName,
        callerInfo,
        ownerInfo: getContainingNamedFunctionInfo(path),
        callNode: path.node,
        urlNode: firstArg,
        urlSource
    });
}

function recordMemberReference(path) {
    const propertyName = getStaticPropertyName(path.node);

    if (!propertyName || !functionInfosByName.has(propertyName)) {
        return;
    }

    const parent = path.parentPath;

    if (parent?.isCallExpression() && parent.node.callee === path.node) {
        return;
    }

    addToMapList(referencesByName, propertyName, {
        container: getContainingFunctionInfo(path),
        node: path.node
    });
}

function buildIndexes() {
    traverse(ast, {
        ObjectMethod(path) {
            if (isWebpackModulePath(path)) {
                moduleIdsByNode.set(path.node, getKeyName(path.node.key));
            }

            registerFunction(path);
        },

        FunctionDeclaration: registerFunction,
        FunctionExpression: registerFunction,
        ArrowFunctionExpression: registerFunction
    });

    traverse(ast, {
        VariableDeclarator: parseModuleImport,
        CallExpression: parseModuleExport
    });

    traverse(ast, {
        CallExpression: recordCall,
        OptionalCallExpression: recordCall,
        MemberExpression: recordMemberReference,
        OptionalMemberExpression: recordMemberReference
    });
}

/**
 * 输出命中的调用位置与对应的原始源码。
 * 不传目标名称时保留原先“输出全部调用”的行为。
 */
function reportCall(path) {
    const calleeName = getCalleeName(path.node.callee);

    if (!calleeName) {
        return;
    }

    if (options.targetCallees.size > 0 && !options.targetCallees.has(calleeName)) {
        return;
    }

    console.log(`发现函数调用: ${calleeName} (${getLocation(path.node)})`);
    console.log(`  ${getSnippet(path.node)}`);
}

function getCallChains(targetInfo) {
    const chains = [];

    function walk(info, stack, depth) {
        const edges = reverseCallEdges.get(info.id) || [];
        const nextEdges = edges.filter(edge =>
            !stack.some(item => item.id === edge.caller.id)
        );

        if (!nextEdges.length || depth <= 0) {
            chains.push(stack);
            return;
        }

        for (const edge of nextEdges.slice(0, 20)) {
            walk(edge.caller, [edge.caller, ...stack], depth - 1);
        }
    }

    walk(targetInfo, [targetInfo], options.maxDepth);

    return chains;
}

function findEdge(callerInfo, calleeInfo) {
    const edges = reverseCallEdges.get(calleeInfo.id) || [];

    return edges.find(edge => edge.caller.id === callerInfo.id);
}

function printFunctionSource(info) {
    if (!info) {
        return;
    }

    console.log(`  函数片段: ${getSnippet(info.node, 260)}`);
}

function printReferences(info) {
    const references = (referencesByName.get(info.name) || []).filter(reference =>
        !info.moduleId ||
        !reference.container?.moduleId ||
        reference.container.moduleId === info.moduleId
    );

    if (!references.length) {
        return;
    }

    console.log("  可能入口引用:");

    for (const reference of references.slice(0, 6)) {
        console.log(
            `    - ${formatFunction(reference.container)} 引用 ${getSnippet(reference.node, 120)}`
        );
    }
}

function printCallChains(targetInfo) {
    const chains = getCallChains(targetInfo);

    if (!chains.length) {
        console.log("  未找到上游调用。");
        return;
    }

    console.log("  调用链:");

    for (const [index, chain] of chains.entries()) {
        console.log(`    ${index + 1}. ${chain.map(formatFunction).join(" -> ")}`);

        for (let i = 0; i < chain.length - 1; i++) {
            const edge = findEdge(chain[i], chain[i + 1]);

            if (edge) {
                console.log(`       调用点: ${getSnippet(edge.callNode, 180)}`);
            }
        }

        printReferences(chain[0]);
    }
}

function reportUrlChains() {
    buildIndexes();

    console.log(`URL 查询: ${options.targetUrl}`);

    if (!requestHits.length) {
        console.log("未找到匹配的网络请求。");
        return;
    }

    for (const [index, hit] of requestHits.entries()) {
        console.log("");
        console.log(`${index + 1}. 请求: ${hit.calleeName} (${getLocation(hit.callNode)})`);
        console.log(`  URL 参数: ${getSnippet(hit.urlNode, 160)}`);
        console.log(`  所在函数: ${formatFunction(hit.callerInfo)}`);

        if (hit.ownerInfo && hit.ownerInfo.id !== hit.callerInfo?.id) {
            console.log(`  外层方法: ${formatFunction(hit.ownerInfo)}`);
        }

        printFunctionSource(hit.callerInfo);

        if (hit.callerInfo) {
            printCallChains(hit.callerInfo);
        }

        if (hit.ownerInfo && hit.ownerInfo.id !== hit.callerInfo?.id) {
            console.log("  外层方法追踪:");
            printCallChains(hit.ownerInfo);
        }
    }
}

function reportFunctionChains() {
    buildIndexes();

    const targets = functionInfosByName.get(options.chainTarget) || [];

    console.log(`函数查询: ${options.chainTarget}`);

    if (!targets.length) {
        console.log("未找到同名函数。");
        return;
    }

    for (const [index, info] of targets.entries()) {
        console.log("");
        console.log(`${index + 1}. 函数: ${formatFunction(info)}`);
        printFunctionSource(info);
        printCallChains(info);
    }
}

if (options.targetUrl) {
    reportUrlChains();
} else if (options.chainTarget) {
    reportFunctionChains();
} else {
    // 遍历 AST
    traverse(ast, {
        FunctionDeclaration(path) {
            console.log(
                "发现函数:",
                path.node.id.name
            );
        },

        CallExpression: reportCall,

        // 可选链调用，例如 api?.send() 或 fn?.()。
        OptionalCallExpression: reportCall
    });
}
