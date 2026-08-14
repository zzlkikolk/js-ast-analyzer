const fs = require("fs");
const parser = require("@babel/parser");
const traverse = require("@babel/traverse").default;

const code = fs.readFileSync("./igamebuy-js/4306.js", "utf8");

// JS → AST
const ast = parser.parse(code, {
    sourceType: "unambiguous"
});

// 遍历 AST
traverse(ast, {
    FunctionDeclaration(path) {
        console.log(
            "发现函数:",
            path.node.id.name
        );
    },

    CallExpression(path) {
        const callee = path.node.callee;

        if (callee.type === "Identifier") {
            console.log(
                "发现函数调用:",
                callee.name
            );
        }
    }
});