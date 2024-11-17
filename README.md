# 1、前言

Vite 相较于传统的 Webpack、Rollup 的编译方式，采用的是 ESM 混合编译。即在开发环境，使用 Server 动态编译 + 浏览器的 ESM ，实现了开发环境 “0 编译”。在生产环境时，采用了 Rollup 进行打包编译。Vite 的优势便是热更新速度速度快，且易于上手。

本文将带领读者用 100 行代码构建一个简易版 Vite，以便对其原理有基础的认识（更多原理请看源码或者其他博主的文章），相关代码已经上传到仓库[weak-vite](https://github.com/XC0703/weak-vite)。

# 2、初始化项目

```bash
mkdir weak-vite
yarn init
yarn add vue
```

同时新建 src 与 vite 两个子目录，分别存放我们要运行的代码与建议 vite 的实现代码：

![](/md_images/1.png)

其中：

```js
// src\App.vue

<template>
	<h1>{{ msg }}</h1>
</template>

<script>
	import { reactive, toRefs } from 'vue';
	export default {
		setup() {
			const state = reactive({
				msg: 'hello weak-vite !'
			});
			return {
				...toRefs(state)
			};
		}
	};
</script>
```

```js
// src\main.js

import { createApp } from 'vue';
import App from './App.vue';

createApp(App).mount('#app');
```

```html
<!-- index.html -->

<!DOCTYPE html>
<html lang="en">
	<head>
		<meta charset="UTF-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1.0" />
		<title>weak-vite</title>
	</head>
	<body>
		<div id="app"></div>
		<script type="module" src="/src/main.js"></script>
	</body>
</html>
```

上面这三个文件就是功能实现代码，剩下的工作就是去要实现一个 vite 把这三个文件可以正常运行起来并在浏览器上看到效果。

```bash
cd vite
yarn init
yarn add @vue/compiler-sfc connect es-module-lexer esbuild magic-string
```

- `@vue/compiler-sfc`：Vue.js 的单文件组件（Single File Component, SFC）编译器, 将 SFC 文件编译成 json 数据（Vue 组件的模板、脚本和样式）
- `connect`：中间件框架
- `es-module-lexer`：解析 ES 模块的库，获取文件中 import 语句的信息
- `esbuild`：这是一个极快的 JavaScript 构建工具，类似于 Webpack 或 Rollup。它用于编译、打包和优化 JavaScript 代码
- `magic-string`：用来替换第三方包的路径

最后在`vite\index.js`下面初始化我们的 vite server：

```js
// vite\index.js

const http = require('http');
const connect = require('connect');
const middlewares = connect();

// 用于返回 html 的中间件
middlewares.use(indexHtmlMiddleware);

// 处理 js 和 vue 请求的中间件
middlewares.use(transformMiddleware);

// 创建 node 服务
const createServer = async () => {
	// 依赖预构建
	await optimizeDeps();
	http.createServer(middlewares).listen(5173, () => {
		console.log('weak-vite-dev-server start at localhost: 5173!');
	});
};
createServer();
```

其中，中间件函数`indexHtmlMiddleware`没什么好说的，就是读取返回根目录的 `index.html`，这里先进行书写：

```js
// vite\index.js

const indexHtmlMiddleware = (req, res, next) => {
	if (req.url === '/') {
		const htmlPath = path.join(__dirname, '../index.html');
		const htmlContent = fs.readFileSync(htmlPath, 'utf-8');
		res.setHeader('Content-Type', 'text/html');
		res.statusCode = 200;
		return res.end(htmlContent);
	}
	next();
};
```

# 3、依赖预构建

我们在上面的 server 初始化代码中可以看到在创建 node 服务前我们执行了一个**依赖预构建**的工作，那么何为依赖预构建呢，vite 不是 No Bundle 吗？对此，官方文档做出了详细解释：[点此查看原因](https://www.vitejs.net/guide/dep-pre-bundling.html)，简而言之其目的有二：

- 兼容 CommonJS 和 AMD 模块的依赖
- 减少模块间依赖引用导致过多的请求次数

依赖预构建总结：依赖预构建大致的原理是

- 先收集打包的依赖，比如代码中引入了 vue，那么匹配到 vue 后到 node_modules 中找到对应 vue 的 esm 模块 js 然后把 js 都存储到一个对象中（收集依赖的过程也用到了 esbuild build 方法，收集的过程是在一个 esbuild 插件中完成的）
- 得到一个所有依赖的对象后再次用 esbuild 对这些依赖进行编译，编译后的文件存储到.vite 中 下次再使用依赖的时候 直接从.vite 中获取,不需要再次编译。

```js
//  vite\index.js

// 依赖预构建的缓存目录
const cacheDir = path.join(__dirname, '../', 'node_modules/.vite');

// 依赖预构建
const optimizeDeps = async () => {
	if (fs.existsSync(cacheDir)) return false;
	fs.mkdirSync(cacheDir, { recursive: true });
	// 分析依赖时，源码使用了 esbuild 插件去分析，这里为了简化逻辑，直接读取了上级 package.json 的 dependencies 字段
	const deps = Object.keys(require('../package.json').dependencies);
	// 利用 esbuild 的 build 方法去构建依赖
	const result = await esbuild.build({
		entryPoints: deps, // 入口文件
		bundle: true, // 是否打包，表示将所有依赖项打包成一个或多个文件。
		format: 'esm', // 输出文件格式
		logLevel: 'error', // 日志级别
		splitting: true, // 是否拆分，表示将所有依赖项拆分成多个文件
		sourcemap: true, // 是否生成源映射文件
		outdir: cacheDir, // 输出目录
		treeShaking: false, // 是否启用 tree-shaking
		metafile: true, // 是否生成元数据文件
		// 后面三个环境变量不是必须的，只是为了让 esbuild 不报警告
		define: {
			'process.env.NODE_ENV': '"development"',
			__VUE_OPTIONS_API__: 'true',
			__VUE_PROD_DEVTOOLS__: 'false',
			__VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false'
		}
	});
	const outputs = Object.keys(result.metafile.outputs);
	// console.log('outputs:', outputs);
	// 打印结果为：outputs: [ 'node_modules/.vite/vue.js.map', 'node_modules/.vite/vue.js' ]
	const data = {};
	deps.forEach(dep => {
		data[dep] = '/' + outputs.find(output => output.endsWith(`${dep}.js`));
	});
	// 将依赖路径写入 _metadata.json 文件
	const dataPath = path.join(cacheDir, '_metadata.json');
	fs.writeFileSync(dataPath, JSON.stringify(data, null, 2));
};
```

此时运行则会看到发现有打包后的依赖包及依赖映射的 json 文件：![](/md_images/2.png)

# 4、路径重写机制

在讲路径重写之前，我们先简单聊一聊 Vite 这类基于 ESM 的构建工具为何需要进行模块的路径重写。 当我们直接将源码运行在浏览器，而不对 import 路径进行任何处理时，可能会出现如下错误：![](/md_images/3.png)

很显然，这是因为我们对一些依赖的引入（对于本项目来说，就是`main.js`文件的`import`导入）导致的，

```js
import { createApp } from 'vue';
import App from './App.vue';
```

浏览器是无法直接通过上面的路径拿到对应的文件的，这是因为第一个是要获取`node_modules`里面的模块，第二个是相对路径。

```js
// vite\index.js

// 解析 import 语句
const importAnalysis = async code => {
	// es-module-lexer 的 init 必须在 parse 前 Resolve
	await init;
	// 通过 es-module-lexer 分析源 code 中所有的 import 语句
	const [imports] = parse(code);
	// 如果没有 import 语句我们直接返回源 code
	if (!imports || !imports.length) return code;
	// 定义依赖映射的对象
	const metaData = require(path.join(cacheDir, '_metadata.json'));
	// magic-string vite2 源码中使用到的一个工具 主要适用于将源代码中的某些轻微修改或者替换
	let transformCode = new MagicString(code);
	imports.forEach(importer => {
		// n： 表示模块的名称 如 vue
		// s: 模块名称在导入语句中的起始位置
		// e: 模块名称在导入语句中的结束位置
		const { n, s, e } = importer;
		// 得到模块对应预构建后的真实路径  如
		const replacePath = metaData[n] || n;
		// 将模块名称替换成真实路径如/node_modules/.vite
		transformCode = transformCode.overwrite(s, e, replacePath);
	});
	return transformCode.toString();
};

// 处理 js 和 vue 请求的中间件
const transformMiddleware = async (req, res, next) => {
	// 因为预构建我们配置生成了 map 文件所以同样要处理下 map 文件
	if (req.url.endsWith('.js') || req.url.endsWith('.map')) {
		const jsPath = path.join(__dirname, '../', req.url);
		const code = fs.readFileSync(jsPath, 'utf-8');
		res.setHeader('Content-Type', 'application/javascript');
		res.statusCode = 200;
		// map 文件不需要分析 import 语句
		const transformCode = req.url.endsWith('.map') ? code : await importAnalysis(code);
		return res.end(transformCode);
	}
	if (req.url.indexOf('.vue') !== -1) {
		const vuePath = path.join(__dirname, '../', req.url.split('?')[0]);
		// 拿到 vue 文件中的内容
		const vueContent = fs.readFileSync(vuePath, 'utf-8');
		// 通过@vue/compiler-sfc 将 vue 中的内容解析成 AST
		const vueParseContet = compileSFC.parse(vueContent);
		// 得到 vue 文件中 script 内的 code
		const scriptContent = vueParseContet.descriptor.script.content;
		const replaceScript = scriptContent.replace('export default ', 'const __script = ');
		// 得到 vue 文件中 template 内的内容
		const tpl = vueParseContet.descriptor.template.content;
		// 通过@vue/compiler-dom 将其解析成 render 函数
		const tplCode = compileDom.compile(tpl, { mode: 'module' }).code;
		const tplCodeReplace = tplCode.replace(
			'export function render(_ctx, _cache)',
			'__script.render=(_ctx, _cache)=>'
		);
		// 最后 script 内还要再一次进行 import 语句分析替换
		const code = `
			${await importAnalysis(replaceScript)}
			${tplCodeReplace}
			export default __script;
		`;
		res.setHeader('Content-Type', 'application/javascript');
		res.statusCode = 200;
		return res.end(await importAnalysis(code));
	}
	next();
};
```

可以看到，里面的导入路径已经被重写：<Br/>
![](/md_images/4.png)<Br/>
![](/md_images/5.png)<Br/>
![](/md_images/6.png)<Br/>
此时可以看到页面正确地显示了效果：![](/md_images/7.png)

# 5、一点 Vite 的八股

## 5-1 Vite 跟 Webpack 的区别？Vite 有什么优势？

参考博客：

- [简述 Webpack 和 Vite 的区别](https://juejin.cn/post/7229314985044951095)
- [vite 和 webpack 的区别与优缺点](https://juejin.cn/post/7240288077867548730)

它们存在四个主要区别：

1. **热更新效率不同**：Webpack 在开发模式下依然会对所有模块进行打包操作，虽然提供了热更新，但大型项目中依然可能会出现启动和编译缓慢的问题；而 Vite 则采用了基于 ES Module 的开发服务器，只有在需要时才会编译对应的模块，大幅度提升了开发环境的响应速度。
2. **构建产物不同**：Webpack 会生成一个或多个 bundle 文件，这些文件包含了整个项目的代码和依赖关系。而 Vite 在开发环境下生成的是单独的模块文件，而在生产环境下生成的是优化后的静态资源文件。
3. **插件生态不同**：Webpack 的插件生态非常丰富，有大量社区和官方插件可以选择，覆盖了前端开发的各个方面；而 Vite 的插件生态尽管在不断发展，但相比 Webpack 来说还显得较为稀少。
4. **配置复杂度不同**：Webpack 的配置相对复杂，对新手不够友好；而 Vite 在设计上更注重开箱即用，大部分场景下用户无需自己写配置文件。

Vite 的优势便是热更新速度速度快，且易于上手。

## 5-2 Vite 为什么比 Webpack 快？（启动速度与热更新速度）

参考博客：[深入理解 Vite 核心原理](https://juejin.cn/post/7064853960636989454)

- webpack 会先打包，然后启动开发服务器，请求服务器时直接给予打包结果。 而 vite 是直接启动开发服务器，请求哪个模块再对该模块进行实时编译。 由于现代浏览器本身就支持 ES Module，会自动向依赖的 Module 发出请求。vite 充分利用这一点，将开发环境下的模块文件，就作为浏览器要执行的文件，而不是像 webpack 那样进行打包合并。 由于 vite 在启动的时候不需要打包，也就意味着不需要分析模块的依赖、不需要编译，因此启动速度非常快。当浏览器请求某个模块时，再根据需要对模块内容进行编译。这种按需动态编译的方式，极大的缩减了编译时间，项目越复杂、模块越多，vite 的优势越明显。
- 在 HMR（热更新）方面，当改动了一个模块后，仅需让浏览器重新请求该模块即可，不像 webpack 那样需要把该模块的相关依赖模块全部编译一次，效率更高。 当需要打包到生产环境时，vite 使用传统的 rollup（也可以自己手动安装 webpack 来）进行打包，因此，vite 的主要优势在开发阶段。另外，由于 vite 利用的是 ES Module，因此在代码中（除了 vite.config.js 里面，这里是 node 的执行环境）不可以使用 CommonJS

![](/md_images/8.png)

## 5-3 如果想让 Vite 的兼容性更好，应该作什么配置呢？

由于 vite 利用的是 ES Module，因此在代码中（除了 vite.config.js 里面，这里是 node 的执行环境）不可以使用 CommonJS。虽然大部分浏览器能兼容，但是少数如 ie 系浏览器全军覆没，移动端浏览器 uc、baidu 等不支持。

build.target 配置可以选择浏览器版本，参考 esbuild.target 配置，但是还是不支持 ie。

如果要支持低版本浏览器可以使用官方提供的插件 [@vitejs/plugin-legacy](https://link.zhihu.com/?target=https%3A//github.com/vitejs/vite/tree/main/packages/plugin-legacy)

plugin-legacy 会将代码打包两套：

- 如果浏览器支持 `<script type="module">`则使用原生 ESM 加载，引入 `index.[hash].js`，代码里使用 `import` 导入文件
- 如果浏览器不支持 `ESM <script nomodule>`则使用另外一套 `System.import` 的方案，引入 `index-legacy.[hash].js`

## 5-4 Vite 在构建运行之前对第三方库作出了什么操作或者说优化？

参考博客：[Vite 原理学习之按需编译](https://blog.csdn.net/s1879046/article/details/122180170)

当 Vite 启动开发服务器之前会完成依赖预构建工作，这个工作整个流程简单来说是通过入口文件扫描所有源码，并分析相关 import 语句得到使用的第三方依赖包名，之后使用 esbuild 对依赖进行编译，至此完成整个预编译过程。之后会启动开发服务器并在相关端口进行监听。
