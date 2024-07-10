const path = require('path');
const { execSync } = require('child_process');

let env =
	execSync('git branch --show-current').toString().trim() == 'main'
		? 'production'
		: 'development';
env = 'production';

module.exports = {
	mode: env,
	entry: {
		'service-call-tile-feature': './src/service-call-tile-feature.ts',
		'service-call-tile-feature-editor':
			'./src/service-call-tile-feature-editor.ts',
	},
	output: {
		path: path.resolve(__dirname, './dist'),
		filename: '[name].min.js',
	},
	resolve: {
		extensions: ['.ts', '.tsx', '.js'],
	},
	module: {
		rules: [
			{
				test: /\.tsx?$/,
				loader: 'ts-loader',
			},
			{
				test: /\.(jsx?|tsx?)$/,
				loader: 'minify-html-literals-loader',
			},
		],
	},
	devtool: env == 'production' ? false : 'eval',
};
