# JS AST Analyzer

一个基于 Babel 的 JavaScript AST 分析脚本。它读取目标 JavaScript 文件，遍历语法树，并输出函数声明和可静态识别的函数调用。

## 环境要求

- Node.js 18
- npm

项目使用 Babel 7。Babel 8 要求 Node.js 22.18.0 或更高版本，不能在 Node.js 18 中运行。

## 安装

```bash
npm install
```

## 指定分析文件

默认入口会读取 `igamebuy-js/4306.js`：

```js
const code = fs.readFileSync("./igamebuy-js/4306.js", "utf8");
```

分析其他文件时，将该路径改为目标 JavaScript 文件的相对路径或绝对路径。

## 运行

不传参数时，输出所有可静态识别的函数调用：

```bash
node index.js
```

传入一个或多个函数名时，只输出精确匹配的调用：

```bash
node index.js decrypt
node index.js api.send
node index.js decrypt api.send this.request
```

输出包含调用名称、源码位置和原始调用片段：

```text
发现函数调用: api.send (12:5)
  api.send(payload)
```

如果分析的文件经过压缩，位置通常会显示为第 `1` 行和较大的列号。

## 可识别的调用

| 源码 | 匹配名称 |
| --- | --- |
| `decrypt(data)` | `decrypt` |
| `api.send(data)` | `api.send` |
| `api["send"](data)` | `api.send` |
| `this.request(url)` | `this.request` |
| `api?.send(data)` | `api.send` |

## 分析边界

当前脚本进行的是语法级静态匹配，不执行目标代码。因此以下情况不会被解析为确定的原始函数：

- 动态属性调用：`api[method](data)`
- 函数别名：`const send = api.send; send(data)`
- 运行时生成或修改的函数引用

要处理这些场景，需要进一步基于 Babel scope/binding API 追踪变量绑定和数据流。

## 项目结构

```text
.
├── igamebuy-js/
│   └── 4306.js      # 默认分析目标
├── index.js         # AST 解析、遍历和调用匹配逻辑
├── package.json
└── README.md
```
