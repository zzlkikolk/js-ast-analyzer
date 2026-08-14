import fs from "node:fs";
import * as parser from "@babel/parser";
import traverseModule from "@babel/traverse";

const traverse = traverseModule.default;

const code = fs.readFileSync("./igamebuy-js/4306.js", "utf8");

// 传入一个或多个目标调用名时，只输出精确匹配的调用。
// 示例：node index.js decrypt api.send this.request
const targetCallees = new Set(process.argv.slice(2));

// JS -> AST
const ast = parser.parse(code, {
    sourceType: "unambiguous"
});

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

/**
 * 输出命中的调用位置与对应的原始源码。
 * 不传目标名称时保留原先“输出全部调用”的行为。
 */
function reportCall(path) {
    const calleeName = getCalleeName(path.node.callee);

    if (!calleeName) {
        return;
    }

    if (targetCallees.size > 0 && !targetCallees.has(calleeName)) {
        return;
    }

    const { start, end, loc } = path.node;
    const location = `${loc.start.line}:${loc.start.column + 1}`;

    console.log(`发现函数调用: ${calleeName} (${location})`);
    console.log(`  ${code.slice(start, end)}`);
}

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
