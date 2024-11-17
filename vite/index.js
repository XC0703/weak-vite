const http = require('http');
const fs = require('fs');
const path = require('path');
const connect = require('connect');
const esbuild = require('esbuild');
const { init, parse } = require('es-module-lexer');
const MagicString = require('magic-string');
const compileSFC = require('@vue/compiler-sfc');
const compileDom = require('@vue/compiler-dom');

const middlewares = connect();
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

// 用于返回 html 的中间件
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
middlewares.use(indexHtmlMiddleware);

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
