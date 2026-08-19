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

使用 `--file` 可以分析任意 JavaScript 文件，无需修改源码。路径支持相对路径和绝对路径：

```bash
node index.js --file roblox/roblox-login.js
node index.js --file /absolute/path/to/script.js
```

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

`--file` 可与函数名筛选组合：

```bash
node index.js --file roblox/roblox-login.js fetch login
```

输出包含调用名称、源码位置和原始调用片段：

```text
发现函数调用: api.send (12:5)
  api.send(payload)
```

如果分析的文件经过压缩，位置通常会显示为第 `1` 行和较大的列号。

## 根据 URL 查请求方法和调用链

如果你只知道接口地址，例如 `/article_game/role`，使用 `--url`：

```bash
node index.js --url /article_game/role
```

分析其他文件中的 URL 时，在 `--url` 前后传入 `--file` 均可：

```bash
node index.js --file roblox/roblox-login.js --url /login
```

脚本会：

- 匹配 `Server.get`、`Server.post`、`Server.postJSON`、`Site.http.get`、`Site.http.post` 的第一个参数；
- 找到包含该 URL 的请求调用；
- 输出请求所在函数；
- 继续反向查找哪些函数调用了这个请求函数；
- 对 Vue render 里常见的事件绑定引用输出“可能入口引用”。

示例输出：

```text
URL 查询: /article_game/role

1. 请求: Server.get (7:25249)
  URL 参数: `article_game/role/${e}`
  所在函数: U (7:25222, module 61717)
  函数片段: function U(e,t,i,s){return Server.get(...)}
  调用链:
    1. getMyRole (7:28618, module 61717) -> U (7:25222, module 61717)
       调用点: U(this.product.id,t,null,this.roleid)
```

如果请求写在 `setTimeout`、`then` 等匿名回调里，输出会额外显示外层命名方法，方便还原业务入口。

## 根据函数名查调用链

如果你已经知道请求封装函数，例如：

```js
function U(e, t, i, s) {
    return Server.get(`article_game/role/${e}`, {
        role_id: s,
        server_id: t?.server_id || "",
        server_name: t?.server_name || "",
        user_id: i || ""
    }).then(e => e);
}
```

可以直接查它的上游调用者：

```bash
node index.js --chain U
```

也可以在指定文件中查询函数调用链：

```bash
node index.js --file roblox/roblox-login.js --chain login
```

打包文件里可能存在多个同名短函数。脚本会使用 Babel scope/binding 尽量区分同名函数，避免把其它模块里的 `U()` 当成同一个函数。

默认最多向上追踪 6 层，可以通过 `--depth` 调整：

```bash
node index.js --chain U --depth 10
```

## 追踪字段来源

`field-source.js` 用于反向追踪某个对象字段写入时的值来源，适合分析请求参数、challenge metadata、token 等字段的静态传递路径。

例如，查找 `sessionID` 被写入请求参数时的来源：

```bash
node field-source.js --file roblox/Challenge.js --field sessionID
```

压缩包通常有多个同名字段。可以用 `--function` 缩小到一个函数：

```bash
node field-source.js --file roblox/Challenge.js --field sessionID --function tZ
```

支持的选项：

```bash
node field-source.js \
  --file roblox/Challenge.js \
  --field sessionID \
  --function tZ \
  --depth 10 \
  --limit 10
```

- `--field`：必填，目标对象字段名，例如 `sessionID`、`challengeMetadata`。
- `--function`：可选，只报告该函数内的字段写入。
- `--depth`：可选，最大回溯层数，默认 `8`。
- `--limit`：可选，最多输出的写入位置数，默认 `20`。

脚本会识别并输出以下静态链路：

- 对象字段值和成员属性赋值；
- 变量初始化和后续 `=` 赋值；
- 函数参数到可静态识别的直接调用实参；
- 对象字面量字段和对象展开；
- `JSON.parse`、`atob`、`decodeURIComponent` 等透明转换的输入；
- 成员读取，例如 `challengeMetadata.sessionId`。

例如测试 fixture：

```bash
node field-source.js --file test/field-source-fixture.js --field sessionID
```

会输出类似的来源链：

```text
sessionID: sessionId
-> 参数 sessionId
-> getPuzzle(challengeMetadata.sessionId)
-> challengeMetadata.sessionId
-> JSON.parse(responseHeaders["rblx-challenge-metadata"])
```

这仍是静态分析，不执行目标代码。模块导出后的成员调用、动态属性、运行时反射、事件总线，以及 React/Vue 的 props、context、state 跨组件传递，可能无法自动解析到最终来源；输出会明确标记为未解析的成员访问或框架状态传递。

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
- 复杂运行时分发：事件总线、字符串拼接出的函数名、框架内部动态调用

当前脚本已经处理了常见 webpack 导出调用，例如 `var c = i(11667)` 和 `(0, c.wO)(...)`。更复杂的跨模块数据流仍需要继续补充专项规则。

## 项目结构

```text
.
├── igamebuy-js/
│   └── 4306.js      # 默认分析目标
├── roblox/
│   └── roblox-login.js
├── index.js         # AST 解析、遍历和调用匹配逻辑
├── field-source.js  # 字段来源追踪
└── test/
    └── field-source.test.js
├── package.json
└── README.md
```
